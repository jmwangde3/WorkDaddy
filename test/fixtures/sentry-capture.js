#!/usr/bin/env node
/**
 * 拦截 Sentry 的最终 HTTP 请求体，用来断言「真正发出去的东西」里没有凭证。
 *
 * 为什么要在子进程里、并且 patch https.request：
 * - sendEvent 是内部函数，没有导出；唯一可靠的观测点是网络层。
 * - 在测试进程里直接 patch 会影响同进程的其他用例，所以独立进程 + 输出 JSON。
 *
 * 用法：node sentry-capture.js <sharedDataDir>
 * 输出：{"captured":"<envelope 原文>","result":{...captureMessage 返回值}}
 */
'use strict';

const https = require('https');
const { EventEmitter } = require('events');
const path = require('path');

const sharedDataDir = process.argv[2];
if (!sharedDataDir) {
  process.stderr.write('missing sharedDataDir\n');
  process.exit(2);
}

let captured = '';
https.request = function fakeRequest(options, callback) {
  const request = new EventEmitter();
  request.write = (chunk) => { if (chunk) captured += String(chunk); return true; };
  request.end = (chunk) => {
    if (chunk) captured += String(chunk);
    const response = new EventEmitter();
    response.statusCode = 200;
    response.resume = () => {};
    process.nextTick(() => {
      callback(response);
      response.emit('end');
    });
  };
  request.destroy = () => {};
  request.setTimeout = () => request;
  return request;
};

// 强制开启：telemetry 默认关时 captureEvent 会直接返回 { disabled: true }，什么都不会发。
process.env.WORKDADDY_TELEMETRY = '1';
process.env.WBSWITCH_SHARED_DATA_DIR = sharedDataDir;
delete process.env.WORKDADDY_SENTRY_DSN;

const reporter = require(path.join(__dirname, '..', '..', 'scripts', 'sentry-report.js'));

const FAKE = {
  bearer: 'FAKE_BEARER_SECRET_123',
  apiKey: 'FAKE_API_KEY_456',
  refresh: 'FAKE_REFRESH_TOKEN_789',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJGQUtFLVNVQkpFQ1QtNDU2In0.FAKE_SIGNATURE_789',
  cookie: 'FAKE_SESSION_COOKIE_321',
  password: 'FAKE_PASSWORD_654',
  basic: 'FAKE_BASIC_BLOB_987',
};

const message = [
  'failed to call upstream',
  `Authorization: Bearer ${FAKE.bearer}`,
  `Authorization: Basic ${FAKE.basic}`,
  `x-api-key: ${FAKE.apiKey}`,
  `refresh_token=${FAKE.refresh}`,
  `Cookie: sid=${FAKE.cookie}`,
  `Set-Cookie: sid=${FAKE.cookie}; HttpOnly`,
  `https://api.example.com/v1/data?token=${FAKE.bearer}&api_key=${FAKE.apiKey}&ok=1`,
  `node scripts/daemon.js --password ${FAKE.password}`,
  FAKE.jwt,
].join(' | ');

reporter.captureMessage(message, {
  stage: 'capture-test',
  tags: {
    note: `Bearer ${FAKE.bearer}`,
    'x-api-key': FAKE.apiKey,
  },
  extra: {
    // 刻意用各种形状塞进去：头部样式、key=value、数组、嵌套对象、异常 stack
    headers: {
      authorization: `Bearer ${FAKE.bearer}`,
      'x-api-key': FAKE.apiKey,
      cookie: `sid=${FAKE.cookie}`,
    },
    access_token: FAKE.refresh,
    list: [`token=${FAKE.refresh}`, `api_key=${FAKE.apiKey}`],
    nested: { deeper: { value: `password=${FAKE.password}` } },
    cmdline: `daemon.js --password ${FAKE.password} --token ${FAKE.bearer}`,
    url: `https://api.example.com/cb?access_token=${FAKE.refresh}&sig=${FAKE.apiKey}`,
    jwt: FAKE.jwt,
    path: path.join(sharedDataDir, 'accounts', 'sample.info'),
  },
}).then((result) => {
  process.stdout.write(JSON.stringify({ captured, result }) + '\n');
}).catch((error) => {
  process.stderr.write(String((error && error.stack) || error) + '\n');
  process.exitCode = 1;
});
