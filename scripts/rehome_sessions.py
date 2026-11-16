#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
rehome_sessions.py — 切换 WorkBuddy 账号后，把本机会话归属 + 分组归属原地改为当前登录账号。

不复制会话、不改会话 ID、不动消息 JSONL / 工作区 / 产物。
接管三件事（单事务）：
  1. sessions.user_id → 当前账号；
  2. spaces 镜像：目标账号缺哪个分组就补一份（新 id，不删原账号那份）；
  3. 会话改挂到自己的同名分组；cwd 落在某分组目录下的 NULL 会话按目录归位。
接管口径：除回收站（deleted_at 非空）外全部接管——含已归档会话与后台自动化任务运行记录。

为什么必须镜像 spaces：客户端只渲染 `spaces.user_id = 当前 uid` 的分组。
只改 sessions.user_id 时，分组仍留在原账号名下 → 切号后「会话还在最近列表、
左侧分组不见了」。镜像按 name 幂等补缺，切回任何账号都能看到同一套分组。

用法：
  python rehome_sessions.py                  # 干跑：只读，打印将影响的行数
  python rehome_sessions.py --apply         # 执行：备份后单事务写入
  python rehome_sessions.py --uid UID       # 显式指定目标 uid（缺省从登录文件读）
  python rehome_sessions.py --db PATH --auth PATH --backup-dir PATH

环境变量（等价于同名命令行参数）：
  WORKBUDDY_DB / WORKBUDDY_AUTH / WORKBUDDY_BACKUP_DIR

挂接方式（任选其一）：
  A. WorkDaddy「自动化」→ 新建任务 → 触发方式「账号切换 / pageReady」→ 执行本脚本 --apply
  B. scripts/daemon.js 切号完成 / pageReady 处 spawn 本脚本 --apply
  C. 手动切号后跑一次
"""
import argparse
import json
import os
import sqlite3
import sys
import time
import uuid
from pathlib import Path

HOME = Path.home()
LOCALAPPDATA = Path(os.environ.get("LOCALAPPDATA", str(HOME / "AppData" / "Local")))

DEFAULT_DB = Path(os.environ.get("WORKBUDDY_DB", str(HOME / ".workbuddy" / "workbuddy.db")))
DEFAULT_AUTH = Path(os.environ.get(
    "WORKBUDDY_AUTH",
    str(LOCALAPPDATA / "CodeBuddyExtension" / "Data" / "Public" / "auth" / "workbuddy-desktop.info"),
))
DEFAULT_BACKUP_DIR = Path(os.environ.get(
    "WORKBUDDY_BACKUP_DIR", str(HOME / ".workbuddy" / "rehome-backups")
))

# 接管口径：除回收站（deleted_at 非空）外全部接管——含已归档会话、
# 后台自动化任务运行记录。归档是翻历史的入口，必须跨账号可见。
# 「未删除」有两种编码：local 用 NULL，cloud 用 -1（客户端主动判定原文：
# (transport='local' AND deleted_at IS NULL) OR (transport='cloud' AND deleted_at = -1)）
NOT_DELETED = "(deleted_at IS NULL OR deleted_at = -1)"
WHERE = NOT_DELETED

# 去重口径：只动人工会话（含归档），跳过后台任务运行记录（真实执行历史，不是副本）。
WHERE_DEDUPE = NOT_DELETED + " AND COALESCE(is_background_automation, 0) = 0"

SPACE_ACTIVE = "COALESCE(status, 'active') = 'active' AND (deleted_at IS NULL OR deleted_at = -1)"


def current_uid(auth_path: Path) -> str:
    """account.uid 在 WorkBuddy 5.9.3 登录文件里是明文（token 才是加密信封）。"""
    data = json.loads(auth_path.read_text(encoding="utf-8"))
    acct = data.get("account")
    if not isinstance(acct, dict):
        accounts = data.get("accounts")
        acct = accounts[0] if isinstance(accounts, list) and accounts else None
    if not isinstance(acct, dict) or not acct.get("uid"):
        raise RuntimeError("登录文件中没有明文 account.uid：%s" % auth_path)
    return str(acct["uid"])


def ro_uri(path: Path) -> str:
    return "file:%s?mode=ro" % str(path).replace("?", "%3f").replace("#", "%23")


def norm(p) -> str:
    return str(p or "").replace("\\", "/").rstrip("/").lower()


def plan_spaces(con, uid):
    """返回 spaces 镜像计划；库里没有 spaces 表时返回 None（老库）。"""
    if not con.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'spaces'"
    ).fetchone():
        return None
    cols = [r[1] for r in con.execute("PRAGMA table_info(spaces)")]
    rows = con.execute(
        "SELECT id, user_id, device_id, name, primary_folder_path, create_folder_path,"
        " pinned, sort_order, status, transport, conversation_origin, source_kind, created_at"
        " FROM spaces WHERE " + SPACE_ACTIVE +
        " ORDER BY COALESCE(sort_order, 999999) ASC, created_at ASC"
    ).fetchall()
    keys = ["id", "user_id", "device_id", "name", "primary_folder_path", "create_folder_path",
            "pinned", "sort_order", "status", "transport", "conversation_origin",
            "source_kind", "created_at"]
    records = [dict(zip(keys, r)) for r in rows]

    # 同一 name 多账号各一份：统一取最早创建的那份当模板，结果与切号顺序无关。
    templates = {}
    for rec in records:
        name = str(rec["name"] or "")
        if not name:
            continue
        cur = templates.get(name)
        if cur is None or int(rec["created_at"] or 0) < int(cur["created_at"] or 0):
            templates[name] = rec

    mine = {str(r["name"]): r for r in records if str(r["user_id"]) == uid}

    inserts, remaps, own = [], [], []
    for name, tpl in templates.items():
        own_rec = mine.get(name)
        target_id = str(own_rec["id"]) if own_rec else str(uuid.uuid4())
        if own_rec is None:
            inserts.append({"template": tpl, "id": target_id, "name": name})
        own.append({"id": target_id, "name": name})
        src_ids = [str(r["id"]) for r in records
                   if str(r["name"]) == name and str(r["user_id"]) != uid and str(r["id"]) != target_id]
        if src_ids:
            remaps.append({"name": name, "target_id": target_id, "src_ids": src_ids})

    # 改挂计数
    remap_total, remap_detail = 0, []
    for rm in remaps:
        marks = ",".join("?" * len(rm["src_ids"]))
        n = con.execute(
            "SELECT COUNT(*) FROM sessions WHERE user_id = ? AND space_id IN (%s)" % marks,
            [uid] + rm["src_ids"],
        ).fetchone()[0]
        if n:
            remap_detail.append({"name": rm["name"], "sessions": n})
        remap_total += n

    # 按 cwd 归位：有些会话只改了 user_id 没挂分组，仍散在「最近列表」。
    adopt, adopt_detail, root = [], [], None
    anchored = con.execute(
        "SELECT s.cwd, sp.name FROM sessions s JOIN spaces sp ON sp.id = s.space_id"
        " WHERE s.space_id IS NOT NULL AND s.cwd IS NOT NULL AND s.cwd <> ''"
    ).fetchall()
    roots = {}
    for cwd, name in anchored:
        c, nm = norm(cwd), str(name or "").lower()
        if not nm:
            continue
        idx = c.rfind("/" + nm)
        if idx <= 0:
            continue
        roots[c[:idx]] = roots.get(c[:idx], 0) + 1
    if roots:
        root = max(roots.items(), key=lambda kv: kv[1])[0]
        loose = con.execute(
            "SELECT id, cwd FROM sessions WHERE user_id = ? AND space_id IS NULL"
            " AND cwd IS NOT NULL AND cwd <> ''", (uid,)
        ).fetchall()
        groups = {}
        for sid, cwd in loose:
            c = norm(cwd)
            hit = None
            for sp in own:
                nm = str(sp["name"] or "").lower()
                if not nm:
                    continue
                if c == root + "/" + nm or c.startswith(root + "/" + nm + "/"):
                    if hit is None or len(nm) > len(str(hit["name"]).lower()):
                        hit = sp
            if hit is None:
                continue
            groups.setdefault(hit["id"], {"space_id": hit["id"], "name": hit["name"], "ids": []})
            groups[hit["id"]]["ids"].append(str(sid))
        adopt = list(groups.values())
        adopt_detail = [{"name": g["name"], "sessions": len(g["ids"])} for g in adopt]

    return {
        "cols": cols,
        "templates": len(templates),
        "inserts": inserts,
        "remaps": remaps,
        "remap_total": remap_total,
        "remap_detail": remap_detail,
        "adopt": adopt,
        "adopt_total": sum(len(g["ids"]) for g in adopt),
        "adopt_detail": adopt_detail,
        "root": root,
    }


def space_insert(insert, uid, now):
    tpl = insert["template"]
    cols = ["id", "user_id", "device_id", "name", "primary_folder_path", "create_folder_path",
            "pinned", "sort_order", "status", "transport", "conversation_origin",
            "deleted_at", "created_at", "updated_at", "source_kind"]
    vals = [
        insert["id"], uid, tpl["device_id"] or "", insert["name"],
        tpl["primary_folder_path"], tpl["create_folder_path"],
        int(tpl["pinned"] or 0), tpl["sort_order"], tpl["status"] or "active",
        tpl["transport"] or "local", tpl["conversation_origin"], -1, now, now,
        tpl["source_kind"] if tpl["source_kind"] is not None else "seed",
    ]
    sql = "INSERT INTO spaces (%s) VALUES (%s)" % (", ".join(cols), ", ".join("?" * len(cols)))
    return sql, vals


def main() -> None:
    ap = argparse.ArgumentParser(description="切号后原地接管本机会话与分组归属")
    ap.add_argument("--apply", action="store_true", help="真正写入；缺省为干跑")
    ap.add_argument("--uid", help="目标账号 uid，缺省从登录文件读取")
    ap.add_argument("--db", default=str(DEFAULT_DB))
    ap.add_argument("--auth", default=str(DEFAULT_AUTH))
    ap.add_argument("--backup-dir", default=str(DEFAULT_BACKUP_DIR))
    args = ap.parse_args()

    db, auth = Path(args.db), Path(args.auth)
    for p, label in ((db, "数据库"), (auth, "登录文件")):
        if not p.is_file():
            sys.exit("[错误] %s不存在：%s" % (label, p))

    try:
        uid = args.uid or current_uid(auth)
    except Exception as exc:
        sys.exit("[错误] 读取当前账号失败：%s" % exc)

    con = sqlite3.connect(ro_uri(db), uri=True)
    try:
        total = con.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
        by_uid = con.execute(
            "SELECT user_id, COUNT(*) FROM sessions WHERE " + WHERE + " GROUP BY user_id ORDER BY 2 DESC"
        ).fetchall()
        affected = con.execute(
            "SELECT COUNT(*) FROM sessions WHERE " + WHERE + " AND user_id <> ?", (uid,)
        ).fetchone()[0]
        plan = plan_spaces(con, uid)
    finally:
        con.close()

    print("数据库        : %s" % db)
    print("当前账号 uid  : %s" % uid)
    print("会话总数      : %d" % total)
    print("接管范围内按账号分布：")
    for u, n in by_uid:
        print("  %s  %d" % (u, n))
    print("将改归属      : %d 条" % affected)
    if plan is None:
        print("分组镜像      : 跳过（库中没有 spaces 表）")
    else:
        print("分组模板      : %d 个；目标账号缺 %d 个 → 将新建：%s"
              % (plan["templates"], len(plan["inserts"]),
                 "、".join(i["name"] for i in plan["inserts"]) or "(无)"))
        print("改挂分组      : %d 条 %s" % (plan["remap_total"], plan["remap_detail"]))
        print("按目录归位    : %d 条（根 %s）%s"
              % (plan["adopt_total"], plan["root"], plan["adopt_detail"]))

    if not args.apply:
        print("[干跑] 未写入任何数据。确认后加 --apply 执行。")
        return

    space_writes = 0 if plan is None else (
        len(plan["inserts"]) + plan["remap_total"] + plan["adopt_total"])
    if affected == 0 and space_writes == 0:
        print("[跳过] 无需改动。")
        return

    backup_dir = Path(args.backup_dir)
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup = backup_dir / ("workbuddy-%s.db" % time.strftime("%Y%m%d-%H%M%S"))
    # WAL 模式下不能直接 copy 主库文件；用 SQLite Backup API 取一致性快照。
    src = sqlite3.connect(ro_uri(db), uri=True)
    dst = sqlite3.connect(str(backup))
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    print("已备份        : %s" % backup)

    con = sqlite3.connect(str(db), timeout=30)
    try:
        con.execute("PRAGMA busy_timeout=30000")
        con.execute("BEGIN IMMEDIATE")
        n = 0
        if affected:
            cur = con.execute(
                "UPDATE sessions SET user_id = ? WHERE " + WHERE + " AND user_id <> ?",
                (uid, uid),
            )
            n = cur.rowcount
        if plan is not None:
            now = int(time.time() * 1000)
            for insert in plan["inserts"]:
                sql, vals = space_insert(insert, uid, now)
                con.execute(sql, vals)
            for rm in plan["remaps"]:
                marks = ",".join("?" * len(rm["src_ids"]))
                con.execute(
                    "UPDATE sessions SET space_id = ? WHERE user_id = ? AND space_id IN (%s)" % marks,
                    [rm["target_id"], uid] + rm["src_ids"],
                )
            for group in plan["adopt"]:
                marks = ",".join("?" * len(group["ids"]))
                con.execute(
                    "UPDATE sessions SET space_id = ? WHERE id IN (%s) AND space_id IS NULL" % marks,
                    [group["space_id"]] + group["ids"],
                )
        con.commit()
        print("已接管会话    : %d 条（单事务提交）" % n)
        if plan is not None:
            print("已新建分组    : %d 个" % len(plan["inserts"]))
            print("已改挂分组    : %d 条" % plan["remap_total"])
            print("已按目录归位  : %d 条" % plan["adopt_total"])
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


if __name__ == "__main__":
    main()
