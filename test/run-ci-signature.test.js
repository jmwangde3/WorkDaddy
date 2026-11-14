'use strict';
/**
 * 失败指纹回归测试（配套 test/tap-fingerprint.js 与 test/run-ci.js 的 schema 4）
 *
 *   node --test test/run-ci-signature.test.js
 *
 * 重点在负例：**同一个文件、同一个用例名、换了错误原因**必须算新增失败。
 * 旧基线只比「文件 + 名字」，这种情况会被当成历史失败放过去 —— 正是要堵的洞。
 */
const assert = require('node:assert/strict');
const {
  parseTap, normalizeSignature, signatureOf, crashSignature,
  buildBaselineIndex, matchFailure,
} = require('./tap-fingerprint');

function test(name, fn) {
  try {
    fn();
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
  console.log(`ok - ${name}`);
}

/** 造一段最小 TAP：一个失败用例 + 统计块。 */
function tapWith(failLines, stats = { tests: 1, fail: 1 }) {
  return [
    'TAP version 13',
    ...failLines,
    `# tests ${stats.tests}`,
    `# pass ${stats.pass == null ? 0 : stats.pass}`,
    `# fail ${stats.fail}`,
    '# skipped 0',
  ].join('\n');
}

function main() {
  test('解析 error 块标量（|-）：错误文本进签名，stack 帧不进', () => {
    const tap = tapWith([
      'not ok 1 - block error case',
      '  ---',
      "  location: 'C:\\\\repo\\\\test\\\\x.test.js:10:3'",
      '  failureType: testCodeFailure',
      '  error: |-',
      '    AssertionError: expected 2 but got 0',
      '        at Object.<anonymous> (C:\\repo\\test\\x.test.js:12:7)',
      '  code: ERR_ASSERTION',
      '  ...',
    ]);
    const r = parseTap(tap);
    assert.equal(r.fail, 1);
    assert.equal(r.mismatch, false);
    assert.equal(r.fails.length, 1);
    assert.equal(r.fails[0].name, 'block error case');
    assert.ok(r.fails[0].errorText.includes('expected 2 but got 0'), r.fails[0].errorText);
    assert.ok(!r.fails[0].signature.includes('at Object'), 'stack 帧必须被丢掉');
    assert.ok(r.fails[0].signature.includes('expected 2 but got 0'));
  });

  test('解析单行 error 标量（JSON 字符串）', () => {
    const tap = tapWith([
      'not ok 1 - scalar error case',
      '  ---',
      '  error: "ENOENT: no such file or directory, open \'C:\\\\\\\\tmp\\\\\\\\a.txt\'"',
      '  ...',
    ]);
    const r = parseTap(tap);
    assert.equal(r.fails.length, 1);
    assert.match(r.fails[0].signature, /^ENOENT: no such file or directory, open '<PATH>'$/);
  });

  test('统计块必须被解析到（回归：最后一个失败记录会吞掉尾部统计）', () => {
    const tap = tapWith([
      'not ok 1 - tail case',
      '  ---',
      '  error: |-',
      '    boom',
      '  ...',
    ], { tests: 7, pass: 6, fail: 1 });
    const r = parseTap(tap);
    assert.equal(r.tests, 7);
    assert.equal(r.fail, 1);
    assert.equal(r.mismatch, false);
  });

  test('同一问题在不同机器上签名相同（路径/临时名/UUID/时间/端口/长数字）', () => {
    const a = signatureOf([
      'AssertionError: boom',
      "  at /tmp/wd-deploy-pristine-9Kd8Qa/scripts/daemon.js:12:3",
      'saved /home/runner/work/repo/dist/app.js ok',
      'id=550e8400-e29b-41d4-a716-446655440000',
      'started 2026-11-14T10:00:00.000Z',
      'listening on 127.0.0.1:8080 pid 123456',
    ].join('\n'));
    const b = signatureOf([
      'AssertionError: boom',
      "  at C:\\Users\\jmwan\\AppData\\Local\\Temp\\wd-deploy-y-1Ab2Cd\\scripts\\daemon.js:9:1",
      'saved D:\\a\\b\\dist\\app.js ok',
      'id=6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      'started 2025-01-02T03:04:05Z',
      'listening on 127.0.0.1:65535 pid 999999',
    ].join('\n'));
    assert.equal(a, b, `两条签名应一致：\nA=${a}\nB=${b}`);
  });

  test('不同错误原因签名不同（ENOENT vs EACCES）', () => {
    const a = signatureOf("ENOENT: no such file or directory, open '/tmp/x/a.txt'");
    const b = signatureOf("EACCES: permission denied, open '/tmp/x/a.txt'");
    assert.notEqual(a, b);
  });

  test('同一路径下不同断言值不被抹平（actual/expected 属错误原因）', () => {
    const a = signatureOf("AssertionError [ERR_ASSERTION]: expected 2 but got 0 at /tmp/x/a.js:1:1");
    const b = signatureOf("AssertionError [ERR_ASSERTION]: expected 2 but got 1 at /tmp/x/a.js:1:1");
    assert.notEqual(a, b);
  });

  test('空错误文本用显式占位，不会和别的空文本混同', () => {
    assert.equal(signatureOf(''), '<no-error-text>');
    assert.equal(signatureOf('   \n  '), '<no-error-text>');
  });

  test('负例：同文件同用例名但错误内容变了 → 必须判为新增失败', () => {
    const index = buildBaselineIndex([
      { file: 'i18n.test.js', name: 'README language switch links are reciprocal', signature: "ENOENT: no such file or directory, open '<PATH>'" },
    ]);
    const hit = matchFailure(index, {
      file: 'i18n.test.js', name: 'README language switch links are reciprocal',
      signature: "ENOENT: no such file or directory, open '<PATH>'",
    });
    assert.equal(hit.kind, 'exact', '三项全等应命中原条目');

    const miss = matchFailure(index, {
      file: 'i18n.test.js', name: 'README language switch links are reciprocal',
      signature: "EACCES: permission denied, scandir '<PATH>'",
    });
    assert.equal(miss.kind, null, '同名不同错误不得命中');
    assert.equal(miss.reason, 'signature-changed');
    assert.deepEqual(miss.previous, ["ENOENT: no such file or directory, open '<PATH>'"]);
  });

  test('负例：文件不同但同名同签名 → 不算命中（文件名参与匹配）', () => {
    const index = buildBaselineIndex([
      { file: 'a.test.js', name: 'same name', signature: 'boom' },
    ]);
    const miss = matchFailure(index, { file: 'b.test.js', name: 'same name', signature: 'boom' });
    assert.equal(miss.kind, null);
    assert.equal(miss.reason, 'name-unknown');
  });

  test('没有签名的旧条目只按名字匹配，并计入告警计数', () => {
    const index = buildBaselineIndex([
      { file: 'legacy.test.js', name: 'old entry' },
      'very old entry',
    ]);
    assert.equal(index.legacyNoSignature, 2);
    assert.equal(index.legacyStringEntries, 1);
    assert.equal(matchFailure(index, { file: 'legacy.test.js', name: 'old entry', signature: 'x' }).kind, 'legacy');
    assert.equal(matchFailure(index, { file: 'whatever.test.js', name: 'very old entry', signature: 'x' }).kind, 'legacy');
  });

  test('文件级崩溃签名区分退出形态', () => {
    assert.notEqual(crashSignature(1, null), crashSignature(2, null));
    assert.notEqual(crashSignature(1, null), crashSignature(1, 'SIGTERM'));
    assert.equal(crashSignature(1, null), crashSignature(1, null));
  });

  test('TAP 失败行数少于 # fail 时标记 mismatch（不能被当成通过）', () => {
    const tap = [
      'not ok 1 - only one parsed',
      '  ---',
      '  error: |-',
      '    boom',
      '  ...',
      '# tests 2',
      '# fail 2',
    ].join('\n');
    const r = parseTap(tap);
    assert.equal(r.failNames.length, 1);
    assert.equal(r.mismatch, true);
  });

  test('签名长度有上限，不会把整段文档塞进基线', () => {
    const long = `${'x'.repeat(5000)}`;
    assert.ok(normalizeSignature(long).length <= 400);
  });
}

try {
  main();
  console.log('PASS run-ci-signature.test.js');
} catch (error) {
  console.error('FAIL run-ci-signature.test.js:', error);
  process.exitCode = 1;
}
