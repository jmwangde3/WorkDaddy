'use strict';
/**
 * 行尾规范（发布前稳定性）
 *
 *   node --test test/line-endings.test.js
 *
 * 为什么需要这条：
 *   `examples/automation-packages/*.json` 的哈希被 `workdaddy-automations.json`
 *   钉死（包字节即身份）。同一份提交在 core.autocrlf=true 的 Windows 工作区里
 *   被检出成 CRLF，哈希就与索引里的 sha256 不同 —— 测试在本机红、在 CI 绿，
 *   看起来像 flaky，实际是行尾不统一。
 *
 * 判据来源是 git 自己，而不是再写一套扩展名猜测：
 *   `git ls-files --eol` 会给出 index/工作区两侧的行尾，以及 .gitattributes
 *   判定的属性（-text 表示二进制、text=auto eol=lf 表示文本）。
 *
 * 规则：
 *   * 文本文件：索引与工作区都必须是 LF。
 *   * *.cmd / *.bat：必须是 CRLF（cmd.exe 对裸 LF 的多行 if / goto 会出错）。
 *   * 二进制（-text）：跳过。
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repo = path.join(__dirname, '..');

function gitEol() {
  const r = spawnSync('git', ['ls-files', '--eol'], { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(r.status, 0, 'git ls-files --eol 失败：' + (r.stderr || ''));
  const rows = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // 形如：i/lf    w/crlf  attr/text=auto eol=lf \tpath
    const m = line.match(/^(i\/\S+)\s+(w\/\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    rows.push({ index: m[1].slice(2), worktree: m[2].slice(2), attr: m[3], file: m[4] });
  }
  return rows;
}

function main() {
  const rows = gitEol();
  assert.ok(rows.length > 100, '读到的被跟踪文件太少：' + rows.length);

  const wrongText = [];
  const wrongCmd = [];
  const mixed = [];

  for (const r of rows) {
    if (r.worktree === 'mixed' || r.index === 'mixed') { mixed.push(r.file); continue; }
    // 二进制：git 已判定 -text，内容里出现 \r\n 是正常的
    if (r.attr === '-text' || r.index === '-text') continue;

    const isCmd = /\.(cmd|bat)$/i.test(r.file);
    if (isCmd) {
      if (r.worktree !== 'crlf') wrongCmd.push(r.file + ' (w/' + r.worktree + ')');
      continue;
    }
    if (r.worktree !== 'lf' || r.index !== 'lf') {
      wrongText.push(r.file + ' (i/' + r.index + ' w/' + r.worktree + ')');
    }
  }

  assert.deepEqual(mixed, [], '存在混合行尾的文件：' + mixed.slice(0, 10).join(', '));
  assert.deepEqual(
    wrongText,
    [],
    '文本文件必须是 LF（索引与工作区都要）。修复：删掉文件后 git checkout -- <file>，' +
      '或 git add --renormalize .。共 ' + wrongText.length + ' 个：\n  ' + wrongText.slice(0, 20).join('\n  ')
  );
  assert.deepEqual(
    wrongCmd,
    [],
    '.cmd/.bat 必须是 CRLF（cmd.exe 对裸 LF 的多行 if/goto 会出错）：\n  ' + wrongCmd.slice(0, 20).join('\n  ')
  );

  console.log('  检查了 ' + rows.length + ' 个被跟踪文件：文本全 LF，cmd/bat 全 CRLF');
}

try {
  main();
  console.log('PASS line-endings.test.js');
} catch (error) {
  console.error('FAIL line-endings.test.js:', error);
  process.exitCode = 1;
}
