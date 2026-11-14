'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskState } = require('../scripts/automation-runtime');
const {
  SCHEMA_VERSION,
  executeTask,
  isSupportedTaskSchema,
  validateTask,
} = require('../scripts/automation');

test('automation v2 remains backward compatible and exposes generic runtime metadata', async () => {
  assert.equal(SCHEMA_VERSION, 3);
  assert.equal(isSupportedTaskSchema({ schemaVersion: 1 }), true);
  assert.equal(isSupportedTaskSchema({ schemaVersion: 2 }), true);
  assert.equal(isSupportedTaskSchema({ schemaVersion: 4 }), false);

  const task = validateTask({
    schemaVersion: 2,
    id: 'runtime-context',
    name: 'runtime-context',
    concurrency: { policy: 'skip' },
    steps: [
      { op: 'value.uuid', saveAs: 'eventId' },
      { op: 'time.now', format: 'epochMs', saveAs: 'stepTime' },
      { op: 'value.number', operator: 'subtract', values: [8, 3], min: 0, saveAs: 'remaining' },
      { op: 'vars.set', key: 'runId', value: '{{runtime.run.id}}' },
      { op: 'vars.set', key: 'today', value: '{{runtime.time.localDate}}' },
      { op: 'vars.set', key: 'stamp', value: '{{runtime.time.iso}}' },
      { op: 'vars.set', key: 'trigger', value: '{{runtime.trigger.type}}' },
    ],
  });
  // runtime.time.localDate 的契约是「本机本地日历日」（实现用 getFullYear /
  // getMonth / getDate），同一时间戳在 UTC+8 与 UTC 下得到不同日期：
  // 1789574400123 = 2026-09-16T16:00:00.123Z，UTC+8 是 09-17，UTC 是 09-16。
  // 所以期望值按同一条规则算，否则这个用例只能在 UTC+ 的机器上通过；
  // 时区无关的部分（UTC ISO）仍然钉死成固定字符串。
  const startedAt = 1789574400123;
  const startedDate = new Date(startedAt);
  const expectedLocalDate = [
    startedDate.getFullYear(),
    String(startedDate.getMonth() + 1).padStart(2, '0'),
    String(startedDate.getDate()).padStart(2, '0'),
  ].join('-');
  const result = await executeTask(task, {
    now: startedAt,
    runId: 'run-test-1',
    event: { type: 'panelOpened' },
  });
  assert.match(result.context.vars.eventId, /^[0-9a-f-]{36}$/);
  assert.equal(result.context.vars.stepTime, startedAt);
  assert.equal(result.context.vars.remaining, 5);
  assert.equal(result.context.vars.runId, 'run-test-1');
  assert.equal(result.context.vars.today, expectedLocalDate);
  assert.match(result.context.vars.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(result.context.vars.stamp, '2026-09-16T16:00:00.123Z');
  assert.equal(result.context.vars.trigger, 'panelOpened');
});

test('automation v2 state TTL is generic and expired values disappear', async () => {
  let now = 1000;
  let db = {};
  const state = createTaskState('daily', () => structuredClone(db), (value) => { db = value; }, () => now);
  await state.set('account', 'u1', 'done', true, { ttlMs: 500 });
  assert.equal(await state.get('account', 'u1', 'done'), true);
  now = 1501;
  assert.equal(await state.get('account', 'u1', 'done'), undefined);
  assert.equal(Object.keys(db).length, 0);
});

test('v2-only fields are rejected by v1 tasks and accepted by v2 tasks', () => {
  assert.throws(() => validateTask({
    schemaVersion: 1,
    id: 'old',
    name: 'old',
    concurrency: { policy: 'skip' },
    steps: [],
  }), /V2/);
  assert.doesNotThrow(() => validateTask({
    schemaVersion: 2,
    id: 'new',
    name: 'new',
    concurrency: { policy: 'skip' },
    steps: [{ op: 'state.set', key: 'cache', value: true, ttlMs: 1000 }],
  }));
});
