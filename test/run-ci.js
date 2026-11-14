'use strict';
/**
 * CI 测试入口：逐文件跑完整套件，只对「新增失败」报警。
 *
 * 为什么逐文件跑：
 *   `node --test --test-reporter=tap test/*.test.js` 会把所有文件汇成一条扁平流，
 *   失败行里**没有文件名**。只靠用例名匹配，新文件里一条同名失败会被误判成历史失败。
 *   逐文件跑能拿到 `{文件, 用例名}` 二元组，基线因此可以做到「同文件 + 同名」双匹配。
 *   代价是每个文件一次 node 启动（约 +0.15s/文件），相对 40s 的总时长可以接受。
 *
 * 规则：
 *   - 任一文件退出码非 0 但没有解析到失败 → 视为崩溃（退出码 3）
 *   - 失败不在基线里（按 文件+用例名 双匹配）→ 退出码 2
 *   - 总用例数低于基线记录 → 视为「跑了一半就退了」（退出码 4）
 *   - 解析到的失败数与 TAP `# fail` 不一致 → 解析漏了（退出码 5）
 *
 * 用法：
 *   node test/run-ci.js             跑并比对
 *   node test/run-ci.js --update    人工确认后重写基线
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const testDir = path.join(__dirname);
const baselinePath = path.join(__dirname, 'known-failures.json');
const update = process.argv.includes('--update');
const QUIET = process.argv.includes('--quiet');

function readBaseline() {
  try {
    const raw = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    return {
      schema: Number(raw.schema || 1),
      counts: raw.counts || {},
      fileTests: raw.fileTests || {},
      baseline: Array.isArray(raw.baseline) ? raw.baseline : [],
    };
  } catch (_) {
    return { schema: 1, counts: {}, fileTests: {}, baseline: [] };
  }
}

/** 基线条目兼容两种形态：v1 字符串（只有用例名）/ v2+ {file, name}。 */
function entryKey(entry) {
  if (typeof entry === 'string') return { file: null, name: entry };
  if (entry && typeof entry === 'object') return { file: entry.file || null, name: String(entry.name || '') };
  return { file: null, name: '' };
}

/** 解析单个文件的 TAP 输出。 */
function parseTap(out) {
  const res = {
    tests: 0, pass: 0, fail: 0, skipped: 0,
    fails: [], scenarios: [], mismatch: false,
  };
  for (const line of String(out).split(/\r?\n/)) {
    let m;
    if ((m = /^# tests (\d+)\s*$/.exec(line))) res.tests = Number(m[1]);
    else if ((m = /^# pass (\d+)\s*$/.exec(line))) res.pass = Number(m[1]);
    else if ((m = /^# fail (\d+)\s*$/.exec(line))) res.fail = Number(m[1]);
    else if ((m = /^# skipped (\d+)\s*$/.exec(line))) res.skipped = Number(m[1]);
    // 嵌套子测试在 TAP 里会带缩进，必须容忍前导空白，否则会漏掉真实失败。
    else if ((m = /^\s*not ok \d+ - (.*)$/.exec(line))) res.fails.push(m[1].replace(/\s*#.*$/, '').trim());
    else if ((m = /^# ok - (.*)$/.exec(line))) res.scenarios.push(m[1].trim());
    else if ((m = /^ok - (.*)$/.exec(line))) res.scenarios.push(m[1].trim());
  }
  res.fails = Array.from(new Set(res.fails.filter(Boolean)));
  res.scenarios = Array.from(new Set(res.scenarios.filter(Boolean)));
  // TAP 的 # fail 会把「父测试因失败」也计入；解析到的行数应当与之相等。
  // 不等说明有失败行没被匹配到（格式变化），必须报错而不是当没事。
  res.mismatch = res.fail !== res.fails.length;
  return res;
}

function runFile(file) {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', path.join('test', file)], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000,
  });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const parsed = parseTap(out);
  return {
    file,
    status: r.status,
    signal: r.signal,
    out,
    ...parsed,
  };
}

function main() {
  const started = Date.now();
  const files = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.js')).sort();
  const baseline = readBaseline();

  const results = [];
  const tapParts = [];
  for (const file of files) {
    const r = runFile(file);
    results.push(r);
    tapParts.push(`# ---- ${file} (exit=${r.status}) ----`, r.out);
    if (!QUIET) process.stdout.write(`  ${r.fail || r.status ? '✗' : '✓'} ${file}  tests=${r.tests} fail=${r.fail} 场景=${r.scenarios.length}\n`);
  }
  fs.writeFileSync(path.join(testDir, 'last-run.tap'), tapParts.join('\n'));

  const totals = results.reduce((acc, r) => ({
    tests: acc.tests + r.tests,
    pass: acc.pass + r.pass,
    fail: acc.fail + r.fail,
    skipped: acc.skipped + r.skipped,
    scenarios: acc.scenarios + r.scenarios.length,
  }), { tests: 0, pass: 0, fail: 0, skipped: 0, scenarios: 0 });

  // 逐文件失败清单：{file, name}
  const failures = [];
  const crashes = [];
  const mismatches = [];
  for (const r of results) {
    if (r.mismatch) mismatches.push(`${r.file}: fail=${r.fail} parsed=${r.fails.length}`);
    if (r.status !== 0 && r.fails.length === 0) {
      crashes.push({ file: r.file, status: r.status, signal: r.signal || null });
      failures.push({ file: r.file, name: '<file-crash>' });
      continue;
    }
    for (const name of r.fails) failures.push({ file: r.file, name });
  }

  const knownKeys = new Set();
  let legacyStringEntries = 0;
  for (const entry of baseline.baseline) {
    const k = entryKey(entry);
    if (!k.name) continue;
    if (!k.file) legacyStringEntries += 1;
    knownKeys.add(k.file ? `${k.file}\u0000${k.name}` : `\u0000${k.name}`);
  }
  const isKnown = (f) => knownKeys.has(`${f.file}\u0000${f.name}`) || knownKeys.has(`\u0000${f.name}`);
  const fresh = failures.filter((f) => !isKnown(f));
  const known = failures.filter((f) => isKnown(f));
  const fixed = baseline.baseline
    .map((e) => entryKey(e))
    .filter((e) => e.name && !failures.some((f) => f.name === e.name && (!e.file || f.file === e.file)));

  const floor = Number(baseline.counts && baseline.counts.tests) || 0;
  const fileTests = {};
  for (const r of results) fileTests[r.file] = r.tests;

  console.log('==============================================');
  console.log(' WorkDaddy 测试汇总（逐文件）');
  console.log('==============================================');
  console.log(` 文件: ${files.length}   用例: ${totals.tests}  通过: ${totals.pass}  失败: ${totals.fail}  跳过: ${totals.skipped}`);
  console.log(` 子断言: ${totals.scenarios}（测试文件自己 print 的 ok 行，不计入 TAP 用例数）`);
  console.log(` 已知失败(基线): ${known.length}    新增失败: ${fresh.length}    基线已修复: ${fixed.length}`);
  if (floor) {
    const delta = totals.tests - floor;
    console.log(` 基线用例: ${floor}   本次: ${totals.tests}   差: ${delta >= 0 ? '+' : ''}${delta}`);
  }
  console.log(` 耗时: ${((Date.now() - started) / 1000).toFixed(1)}s   TAP: test/last-run.tap`);

  if (fresh.length) {
    console.log('\n[X] 新增失败（必须修，或显式 --update 承认）：');
    for (const f of fresh) console.log(`  - ${f.file} :: ${f.name}`);
  }
  if (mismatches.length) {
    console.log('\n[X] TAP 解析不一致（有失败行未被识别，不能当作通过）：');
    for (const m of mismatches) console.log(`  - ${m}`);
  }
  if (crashes.length) {
    console.log('\n[X] 文件级崩溃（退出非 0 且没有失败用例）：');
    for (const c of crashes) console.log(`  - ${c.file} exit=${c.status} signal=${c.signal || '-'}`);
  }
  if (legacyStringEntries) {
    console.log(`\n[!] 基线里有 ${legacyStringEntries} 条旧格式（只有用例名，没有文件名），这些只能按名字匹配，判定会比新格式宽。--update 会写成新格式。`);
  }
  if (fixed.length) {
    console.log('\n[+] 基线中已不再失败（可 --update 收紧基线）：');
    for (const f of fixed.slice(0, 20)) console.log(`  - ${f.file || '?'} :: ${f.name}`);
    if (fixed.length > 20) console.log(`  … 另有 ${fixed.length - 20} 条`);
  }
  // 新文件 / 消失的文件：解释用例数变化从哪来。
  const baseFiles = Object.keys(baseline.fileTests);
  if (baseFiles.length) {
    const addedFiles = files.filter((f) => !(f in baseline.fileTests));
    const goneFiles = baseFiles.filter((f) => !files.includes(f));
    if (addedFiles.length) console.log(`\n[+] 新增测试文件 ${addedFiles.length} 个（每个文件在 TAP 里至少算 1 条用例）：${addedFiles.join(', ')}`);
    if (goneFiles.length) console.log(`\n[!] 基线里这些文件已不存在：${goneFiles.join(', ')}`);
  }

  if (update) {
    const payload = {
      schema: 3,
      note: 'CI 基线：按「文件 + 用例名」双匹配。这些失败在本次改造前就存在（环境/平台相关），不阻塞 CI；新增失败仍会报错。',
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      counts: {
        tests: totals.tests, pass: totals.pass, fail: totals.fail, skipped: totals.skipped,
        scenarios: totals.scenarios, files: files.length,
      },
      fileTests,
      baseline: failures.slice().sort((a, b) => (a.file + a.name).localeCompare(b.file + b.name)),
    };
    fs.writeFileSync(baselinePath, JSON.stringify(payload, null, 2) + '\n');
    console.log(`\n已写入基线: ${baselinePath} (${failures.length} 条，schema 3)`);
    return 0;
  }

  if (mismatches.length) return 5;
  if (fresh.length) return 2;
  if (crashes.length) return 3;
  if (floor && totals.tests < floor) {
    console.log(`\n[X] 只跑了 ${totals.tests} 条用例，低于基线 ${floor} —— 有文件没跑完，不能判通过。`);
    return 4;
  }
  console.log('\nPASS 没有新增失败');
  return 0;
}

process.exitCode = main();
