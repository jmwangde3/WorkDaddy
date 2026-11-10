'use strict';
/**
 * Regression test for scripts/rehome-watcher.js
 *
 *   node test/rehome-watcher.test.js
 *
 * Simulates auth-file account changes (client-internal login / seamless login),
 * the path that never goes through /api/switch.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAccountWatcher, readUid, writeDisplay } = require('../scripts/rehome-watcher.js');

const A = 'aaaaaaaa-1111-1111-1111-111111111111';
const B = 'bbbbbbbb-2222-2222-2222-222222222222';
const C = 'cccccccc-3333-3333-3333-333333333333';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeAuth(file, uid) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ account: { uid, nickname: { $wbEncrypted: 1 } }, auth: {} }) + '\n');
  fs.renameSync(tmp, file); // 原子替换，与客户端真实写入方式一致
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rehome-watcher-test-'));
  const auth = path.join(tmp, 'workbuddy-desktop.info');
  writeAuth(auth, A);
  assert.equal(readUid(auth), A, 'readUid reads plaintext account.uid');

  const switches = [];
  const watcher = createAccountWatcher({
    authPath: auth,
    dataDir: tmp,
    intervalMs: 40,
    enableDisplay: false,
    log: () => {},
    onSwitch: async (newUid, prevUid) => {
      switches.push([newUid, prevUid]);
      return { ok: true, affected: 7 };
    },
  });

  watcher.start();
  await sleep(120);
  assert.deepEqual(switches, [], 'startup must not trigger a rehome');
  assert.equal(watcher.current(), A, 'baseline uid recorded');

  writeAuth(auth, B);
  await sleep(120);
  assert.equal(switches.length, 1, 'one switch detected');
  assert.deepEqual(switches[0], [B, A], 'newUid/prevUid correct');

  // same uid repeatedly must not re-trigger
  writeAuth(auth, B);
  await sleep(120);
  assert.equal(switches.length, 1, 'repeated same uid is a no-op');

  writeAuth(auth, C);
  await sleep(120);
  assert.equal(switches.length, 2, 'second switch detected');
  assert.deepEqual(switches[1], [C, B], 'second switch chain correct');

  watcher.stop();

  // display override persists plaintext nickname for listAccounts
  const d = writeDisplay(tmp, { uid: A, nickname: '王冠林michael', type: 'personal', editionType: 'free' });
  assert.equal(d.nickname, '王冠林michael', 'display written');
  const all = JSON.parse(fs.readFileSync(path.join(tmp, 'account-display.json'), 'utf8'));
  assert.equal(all[A].nickname, '王冠林michael', 'display file readable');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('PASS rehome-watcher.test.js — switches=' + switches.length +
    ' path=' + path.join(tmp, '(cleaned)'));
}

main().catch((error) => {
  console.error('FAIL rehome-watcher.test.js:', error);
  process.exitCode = 1;
});
