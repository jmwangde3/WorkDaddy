#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
rehome_sessions.py — 切换 WorkBuddy 账号后，把本机会话归属原地改为当前登录账号。

不复制会话、不改会话 ID、不动消息 JSONL / 工作区 / 产物。只 UPDATE sessions.user_id。
接管口径：除回收站（deleted_at 非空）外全部接管——含已归档会话与后台自动化任务运行记录。

用法：
  python rehome_sessions.py                  # 干跑：只读，打印将影响的行数
  python rehome_sessions.py --apply         # 执行：SQLite Backup API 备份后单事务 UPDATE
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
WHERE = "deleted_at IS NULL"

# 去重口径：只动人工会话（含归档），跳过后台任务运行记录（真实执行历史，不是副本）。
WHERE_DEDUPE = "deleted_at IS NULL AND COALESCE(is_background_automation, 0) = 0"


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


def main() -> None:
    ap = argparse.ArgumentParser(description="切号后原地接管本机会话归属")
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
    finally:
        con.close()

    print("数据库        : %s" % db)
    print("当前账号 uid  : %s" % uid)
    print("会话总数      : %d" % total)
    print("接管范围内按账号分布：")
    for u, n in by_uid:
        print("  %s  %d" % (u, n))
    print("将改归属      : %d 条" % affected)

    if not args.apply:
        print("[干跑] 未写入任何数据。确认后加 --apply 执行。")
        return
    if affected == 0:
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
        cur = con.execute(
            "UPDATE sessions SET user_id = ? WHERE " + WHERE + " AND user_id <> ?",
            (uid, uid),
        )
        n = cur.rowcount
        con.commit()
        print("已接管        : %d 条（单事务提交）" % n)
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


if __name__ == "__main__":
    main()
