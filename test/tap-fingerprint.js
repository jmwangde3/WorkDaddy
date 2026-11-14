'use strict';
/**
 * TAP 解析 + 失败指纹（给 test/run-ci.js 用，也被 test/run-ci-signature.test.js 直接测）
 *
 * 为什么需要指纹：
 *   只按「文件 + 用例名」匹配历史失败，会把「同名但错误原因完全不同」的新问题
 *   当成已知失败放过去。例如某个 i18n 用例原来因为「缺 zh-CN 词条」失败，现在
 *   因为「读取目录权限不足」失败 —— 名字一模一样，原因毫无关系。
 *   所以要再挂一个规范化后的错误签名，三者全等才算已知失败。
 *
 * 规范化要做的事（都是「同一问题在不同机器上写法不同」的部分）：
 *   - 绝对路径（Windows / POSIX）、临时目录名       → <PATH>
 *   - UUID / git sha / sha256 等长十六进制           → <UUID> / <HEX>
 *   - ISO 时间戳、日期                              → <TIME> / <DATE>
 *   - 端口号                                        → <PORT>
 *   - 6 位以上纯数字（pid、ms 时长、随机 id）        → <NUM>
 *   - stack 里的 `at ...` 帧与前后空白                → 丢弃 / 压缩
 *
 * 明确**不**规范化的：错误类型、错误码、错误文案、实际值/期望值的语义。
 * 那些正是「错误原因」本身，动了就等于把不同错误抹成同一个。
 */

const SIGNATURE_MAX = 400;

/** 匹配 TAP 里 `not ok N - name`（允许前导空白，子测试是缩进的）。 */
const RE_NOT_OK = /^(\s*)not ok \d+ - (.*)$/;
/** `key: value` 形式的 YAML 字段。 */
const RE_YAML_FIELD = /^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/;

/** YAML 块标量标记：`|`、`|-`、`|+`、`>`、`>-`。 */
function isBlockMarker(value) {
  return /^[|>][-+]?$/.test(String(value).trim());
}

/** `error: "ENOENT: ..."` 这种单行标量：优先按 JSON 解，失败就剥引号。 */
function scalarValue(value) {
  const v = String(value).trim();
  if (!v) return '';
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    try { return JSON.parse(v.startsWith("'") ? `"${v.slice(1, -1).replace(/"/g, '\\"')}"` : v); } catch (_) {
      return v.slice(1, -1);
    }
  }
  return v;
}

/**
 * 解析单个测试文件的 TAP 输出。
 * @returns {{tests:number,pass:number,fail:number,skipped:number,
 *            fails:Array<{name:string,signature:string,errorText:string}>,
 *            failNames:string[], scenarios:string[], mismatch:boolean}}
 */
function parseTap(out) {
  const res = {
    tests: 0, pass: 0, fail: 0, skipped: 0,
    fails: [], failNames: [], scenarios: [], mismatch: false,
  };
  const lines = String(out).split(/\r?\n/);
  let cur = null;
  let blockIndent = -1;   // >=0 表示正在收 YAML 块
  let blockKey = '';

  const flush = () => {
    if (!cur) return;
    const errorText = (cur.error || cur.stack || '').trim();
    res.fails.push({ name: cur.name, signature: signatureOf(errorText), errorText });
    cur = null;
    blockIndent = -1;
    blockKey = '';
  };

  for (const line of lines) {
    // 顶层统计 / 场景行必须在处理当前失败记录**之前**判断：
    // 最后一个 `not ok` 之后紧跟着 `# tests` / `# fail`，若被当成失败记录的内容
    // 就会漏掉整个统计块（res.fail 一直是 0，mismatch 检查随之失效）。
    let m;
    if ((m = /^# tests (\d+)\s*$/.exec(line))) { res.tests = Number(m[1]); continue; }
    if ((m = /^# pass (\d+)\s*$/.exec(line))) { res.pass = Number(m[1]); continue; }
    if ((m = /^# fail (\d+)\s*$/.exec(line))) { res.fail = Number(m[1]); continue; }
    if ((m = /^# skipped (\d+)\s*$/.exec(line))) { res.skipped = Number(m[1]); continue; }
    if ((m = /^# ok - (.*)$/.exec(line))) { res.scenarios.push(m[1].trim()); continue; }
    if ((m = /^ok - (.*)$/.exec(line))) { res.scenarios.push(m[1].trim()); continue; }

    const notOk = RE_NOT_OK.exec(line);
    if (notOk) {
      flush();
      cur = { name: notOk[2].replace(/\s*#\s*(?:SKIP|TODO)\b.*$/i, '').trim(), error: '', stack: '' };
      continue;
    }
    if (!cur) continue;
    // 当前失败记录内：先看是不是 YAML 块内容。
    if (blockIndent >= 0) {
      const indent = line.length - line.replace(/^\s*/, '').length;
      if (line.trim() === '' || indent > blockIndent) {
        cur[blockKey] = cur[blockKey] ? `${cur[blockKey]}\n${line.trim()}` : line.trim();
        continue;
      }
      blockIndent = -1;
      blockKey = '';
      // 落到下面的字段解析（块结束那一行可能是下一个 key）。
    }
    const field = RE_YAML_FIELD.exec(line);
    if (field) {
      const indent = field[1].length;
      const key = field[2];
      const value = field[3];
      if (key === 'error' || key === 'stack') {
        if (isBlockMarker(value)) {
          blockIndent = indent;
          blockKey = key;
        } else {
          const v = scalarValue(value);
          if (v) cur[key] = cur[key] ? `${cur[key]}\n${v}` : v;
        }
      } else if ((key === 'message' || key === 'cause') && !cur.error) {
        cur.error = scalarValue(value);
      }
      continue;
    }
    // 一行 `...` 表示 YAML 块结束。
    if (/^\s*\.\.\.\s*$/.test(line)) { blockIndent = -1; blockKey = ''; }
  }
  flush();

  res.failNames = Array.from(new Set(res.fails.map((f) => f.name).filter(Boolean)));
  res.scenarios = Array.from(new Set(res.scenarios.filter(Boolean)));
  // TAP 的 # fail 会把「父测试因失败」也计入；解析到的行数应当与之相等。
  // 不等说明有失败行没被匹配到（格式变化），必须报错而不是当没事。
  res.mismatch = res.fail !== res.failNames.length;
  return res;
}

/**
 * 把错误文本规范化成可跨机器比较的签名。
 * @param {string} text
 * @returns {string}
 */
function normalizeSignature(text) {
  let s = String(text == null ? '' : text);
  s = s.replace(/\r\n?/g, '\n');
  // stack 帧（`at fn (path:1:2)`）与 `Object.<anonymous>` 这类纯位置信息全部丢掉：
  // 位置会随无关改动漂移，留着只会制造假「新增失败」。
  s = s
    .split('\n')
    .filter((line) => !/^\s*at\s+/.test(line))
    .filter((line) => !/^\s*[A-Za-z_$][\w$.]*\s+\((?:node:|internal\/)/.test(line))
    .join('\n');

  // Windows 绝对路径（含盘符，允许空格以外的字符）
  s = s.replace(/[A-Za-z]:\\\\?[^\s:'"()]+/g, '<PATH>');
  s = s.replace(/[A-Za-z]:\\[^\s:'"()]+/g, '<PATH>');
  // POSIX 绝对路径（至少两级，避免吃掉单独的 `/`）
  s = s.replace(/\/(?:[^\s:'"()\/]+\/)+[^\s:'"()]*/g, '<PATH>');
  // UUID 必须先于「临时目录名」规则：否则 550e8400-e29b-41d4-a716-446655440000
  // 会被 `xxx-yyyy` 形态误当成 mkdtemp 目录名，前后两半替换得不一致。
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>');
  s = s.replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '<TIME>');
  s = s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<DATE>');
  // 长十六进制（git sha / sha256 / 随机 id）。放在 UUID 之后，因为 UUID 已被替换。
  s = s.replace(/\b[0-9a-f]{12,}\b/gi, '<HEX>');
  // 常见临时目录名（mkdtemp 产生的后缀、wd-deploy-xxx-abc123 之类）。
  // 只替换「后缀带数字或大写」的，避免把 does-not-exist 这类普通短语当成随机名。
  s = s.replace(/\b[A-Za-z][\w.-]*-([A-Za-z0-9]{6,})\b/g, (whole, tail) =>
    (/\d/.test(tail) || /[A-Z]/.test(tail)) ? '<TMPNAME>' : whole);
  // 端口：`:8080` / `127.0.0.1:65535`
  s = s.replace(/:(\d{2,5})\b/g, ':<PORT>');
  // 6 位以上纯数字（pid、耗时毫秒、随机数字 id）
  s = s.replace(/\b\d{6,}\b/g, '<NUM>');

  s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  return s.trim().slice(0, SIGNATURE_MAX);
}

/** 由错误文本算出最终签名；空文本给一个显式占位，避免「空 == 空」掩盖差异。 */
function signatureOf(errorText) {
  const norm = normalizeSignature(errorText);
  return norm || '<no-error-text>';
}

/** 文件级崩溃的签名：只要退出形态一样就算同一个（崩溃本来就没有错误文本）。 */
function crashSignature(status, signal) {
  return `crash:exit=${status == null ? '-' : status};signal=${signal || '-'}`;
}

/** 基线条目兼容三种形态：v1 字符串 / v2-3 {file,name} / v4 {file,name,signature}。 */
function entryKey(entry) {
  if (typeof entry === 'string') return { file: null, name: entry, signature: null };
  if (entry && typeof entry === 'object') {
    return {
      file: entry.file || null,
      name: String(entry.name || ''),
      signature: entry.signature == null ? null : String(entry.signature),
    };
  }
  return { file: null, name: '', signature: null };
}

/**
 * 建立基线索引。
 *   exact      = 文件 + 用例名 + 签名 全等
 *   legacy     = 没有签名的旧条目，只能按 文件+用例名 / 纯用例名 匹配
 *   sigsByName = 用于区分「同名但错误内容变了」与「完全没见过」
 */
function buildBaselineIndex(entries) {
  const knownExact = new Set();
  const sigsByName = new Map();
  const legacyKeys = new Set();
  let legacyStringEntries = 0;
  let legacyNoSignature = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const k = entryKey(entry);
    if (!k.name) continue;
    if (!k.file) legacyStringEntries += 1;
    if (!k.signature) {
      legacyNoSignature += 1;
      legacyKeys.add(k.file ? `${k.file}\u0000${k.name}` : `${k.name}`);
      continue;
    }
    const nameKey = `${k.file || ''}\u0000${k.name}`;
    if (!sigsByName.has(nameKey)) sigsByName.set(nameKey, new Set());
    sigsByName.get(nameKey).add(k.signature);
    knownExact.add(`${nameKey}\u0000${k.signature}`);
  }
  return { knownExact, sigsByName, legacyKeys, legacyStringEntries, legacyNoSignature };
}

/**
 * 判定一条失败是否在基线里。
 * @param {ReturnType<typeof buildBaselineIndex>} index
 * @param {{file:string,name:string,signature:string}} failure
 * @returns {{kind:'exact'|'legacy'|null, reason:'signature-changed'|'name-unknown'|null, previous:string[]}}
 */
function matchFailure(index, failure) {
  const nameKey = `${failure.file || ''}\u0000${failure.name}`;
  if (index.knownExact.has(`${nameKey}\u0000${failure.signature}`)) {
    return { kind: 'exact', reason: null, previous: [] };
  }
  if (index.legacyKeys.has(nameKey) || index.legacyKeys.has(failure.name)) {
    return { kind: 'legacy', reason: null, previous: [] };
  }
  const prev = index.sigsByName.get(nameKey);
  return {
    kind: null,
    reason: prev ? 'signature-changed' : 'name-unknown',
    previous: prev ? Array.from(prev) : [],
  };
}

module.exports = {
  parseTap, normalizeSignature, signatureOf, crashSignature,
  entryKey, buildBaselineIndex, matchFailure, SIGNATURE_MAX,
};
