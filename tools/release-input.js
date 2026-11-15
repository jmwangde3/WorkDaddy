'use strict';
/**
 * 发布输入的严格校验（零依赖）。
 *
 * 为什么单独一个文件：`release.yml` 的 `run:` 脚本不能直接拼接 GitHub 表达式
 * （`${{ github.event.inputs.version }}` 这类值一旦带引号/分号/换行就能改写脚本）。
 * 所以工作流先把输入交给这里做格式校验，校验通过的值才写进 `GITHUB_OUTPUT`，
 * 后续步骤统一以 `env:` 接收。测试直接跑同一份实现，避免「测试过了、发布用的是另一套」。
 *
 * 用法（工作流里）：
 *   node tools/release-input.js --mode build-only --github-output "$env:GITHUB_OUTPUT"
 * 输入取自环境变量：
 *   WD_VERSION / WD_COMMIT / WD_TAG
 */

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const COMMIT_PATTERN = /^[0-9a-fA-F]{40}$/;
const MAX_LENGTH = 64;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

class ReleaseInputError extends Error {}

/** 回显用：控制字符转义，避免把注入串原样打进日志。 */
function quote(value) {
  if (typeof value !== 'string') return String(value);
  const shown = value.length > MAX_LENGTH ? `${value.slice(0, MAX_LENGTH)}…` : value;
  return JSON.stringify(shown);
}

function baseCheck(raw, label) {
  if (typeof raw !== 'string' || raw === '') {
    throw new ReleaseInputError(`${label}不能为空`);
  }
  if (raw.length > MAX_LENGTH) {
    throw new ReleaseInputError(`${label}过长（${raw.length} > ${MAX_LENGTH}）：${quote(raw)}`);
  }
  if (CONTROL_CHARS.test(raw)) {
    throw new ReleaseInputError(`${label}含控制字符（换行/制表等）：${quote(raw)}`);
  }
  if (raw !== raw.trim()) {
    throw new ReleaseInputError(`${label}首尾不能有空白：${quote(raw)}`);
  }
}

/** 版本号：1.3.1 / 1.3.1-rc.1 / 1.3.1-beta / 1.3.1-preview.2 */
function validateVersion(raw, label = '版本号') {
  baseCheck(raw, label);
  if (/^v/i.test(raw)) {
    throw new ReleaseInputError(`${label}不能带 v 前缀（本项目用 1.3.1 这种形式）：${quote(raw)}`);
  }
  if (!VERSION_PATTERN.test(raw)) {
    throw new ReleaseInputError(
      `${label}格式不合法：${quote(raw)}；只接受 x.y.z 或 x.y.z-<预发布标识>（字母数字，可带 . 或 -）`
    );
  }
  return raw;
}

/**
 * Tag：与版本号同一套规则。tag 会进入 `git rev-parse refs/tags/...` 与 `gh release`，
 * 所以既要格式合法，也要挡掉 `v` 前缀、斜杠、空白和 shell 元字符。
 */
function validateTag(raw, label = 'Tag') {
  baseCheck(raw, label);
  if (/^v/i.test(raw)) {
    throw new ReleaseInputError(`${label}不能带 v 前缀（本项目惯例是 1.3.1）：${quote(raw)}`);
  }
  if (!VERSION_PATTERN.test(raw)) {
    throw new ReleaseInputError(`${label}格式不合法：${quote(raw)}；必须与版本号同格式，且不能含 / 或空白`);
  }
  return raw;
}

/** 完整 40 位十六进制 SHA；返回小写。 */
function validateCommit(raw, label = 'Commit') {
  baseCheck(raw, label);
  if (!COMMIT_PATTERN.test(raw)) {
    const hint = /^[0-9a-fA-F]+$/.test(raw) ? `长度应为 40，实际 ${raw.length}` : '含非十六进制字符';
    throw new ReleaseInputError(`${label}不是完整的 40 位 SHA（${hint}）：${quote(raw)}`);
  }
  return raw.toLowerCase();
}

/**
 * 按模式校验并给出后续步骤要用的值。
 * - build-only：version + commit 必填，不需要 tag；
 * - publish：tag 必填（push 事件里就是 ref_name），版本即 tag。
 */
function planRelease(input = {}) {
  const mode = input.mode === 'build-only' ? 'build-only' : 'publish';
  if (mode === 'build-only') {
    const version = validateVersion(input.version);
    const commit = validateCommit(input.commit);
    return { mode, version, commit };
  }
  const tag = validateTag(input.tag);
  return { mode, version: tag, tag };
}

function readOptions(argv) {
  const out = { mode: 'publish', githubOutput: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--mode') out.mode = argv[++i] || '';
    else if (a === '--github-output') out.githubOutput = argv[++i] || '';
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new ReleaseInputError(`未知参数：${a}`);
  }
  if (out.mode !== 'build-only' && out.mode !== 'publish') {
    throw new ReleaseInputError(`--mode 只能是 build-only 或 publish，实际：${quote(out.mode)}`);
  }
  return out;
}

function appendOutput(file, result) {
  const lines = [`mode=${result.mode}`, `version=${result.version}`];
  if (result.commit) lines.push(`commit=${result.commit}`);
  if (result.tag) lines.push(`tag=${result.tag}`);
  const fs = require('node:fs');
  fs.appendFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

function main(argv = process.argv.slice(2), env = process.env) {
  const opts = readOptions(argv);
  if (opts.help) {
    process.stdout.write('用法：node tools/release-input.js --mode <build-only|publish> [--github-output <file>]\n');
    return 0;
  }
  const result = planRelease({
    mode: opts.mode,
    version: env.WD_VERSION || '',
    commit: env.WD_COMMIT || '',
    tag: env.WD_TAG || '',
  });
  for (const line of [`mode=${result.mode}`, `version=${result.version}`]) process.stdout.write(`${line}\n`);
  if (result.commit) process.stdout.write(`commit=${result.commit}\n`);
  if (opts.githubOutput) appendOutput(opts.githubOutput, result);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`[release-input] ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  COMMIT_PATTERN,
  MAX_LENGTH,
  ReleaseInputError,
  VERSION_PATTERN,
  main,
  planRelease,
  validateCommit,
  validateTag,
  validateVersion,
};
