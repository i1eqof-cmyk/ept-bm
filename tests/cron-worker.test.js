import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { executeScheduledTick } from '../investigation-cron-worker/src/index.js';

function makeDatabase(initialEnabled = 0) {
  const state = {
    enabled: initialEnabled,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastStatus: null,
    lastError: null,
    lastCandidateId: null,
    invocationCount: 0,
  };
  return {
    state,
    prepare(sql) {
      return {
        async run() {
          if (sql.includes('INSERT OR IGNORE INTO investigation_cron_state')) return {};
          throw new Error(`Unexpected unbound SQL in cron test: ${sql}`);
        },
        async first() {
          if (sql.includes('SELECT enabled FROM investigation_queue_control')) {
            return { enabled: state.enabled };
          }
          throw new Error(`Unexpected unbound SELECT in cron test: ${sql}`);
        },
        bind(...values) {
          return {
            async run() {
              if (sql.includes('INSERT OR IGNORE INTO investigation_cron_state')) return {};
              if (sql.includes('UPDATE investigation_cron_state') && sql.includes("last_status = 'running'")) {
                state.lastStartedAt = values[0];
                state.lastStatus = 'running';
                state.invocationCount += 1;
                return {};
              }
              if (sql.includes('UPDATE investigation_cron_state')) {
                state.lastFinishedAt = values[0];
                state.lastStatus = values[1];
                state.lastError = values[2] || state.lastError;
                state.lastCandidateId = values[3] || state.lastCandidateId;
                return {};
              }
              throw new Error(`Unexpected SQL in cron test: ${sql}`);
            },
            async first() {
              if (sql.includes('SELECT enabled FROM investigation_queue_control')) {
                return { enabled: state.enabled };
              }
              throw new Error(`Unexpected SELECT in cron test: ${sql}`);
            },
          };
        },
      };
    },
  };
}

test('scheduled invocation processes a candidate directly without a browser session', async () => {
  const DB = makeDatabase(1);
  let processed = 0;
  const result = await executeScheduledTick(
    { DB, AI: {} },
    async () => {
      processed += 1;
      return { status: 'processed', candidateId: 'candidate-1' };
    },
    () => 1_800_000_000_000,
  );

  assert.deepEqual(result, { status: 'processed', candidateId: 'candidate-1' });
  assert.equal(processed, 1);
  assert.equal(DB.state.lastStatus, 'processed');
  assert.equal(DB.state.lastCandidateId, 'candidate-1');
  assert.equal(DB.state.invocationCount, 1);
  assert.equal(typeof worker.scheduled, 'function');
  assert.equal('fetch' in worker, false);
});

test('inactive queue records the cron invocation but does not process a candidate', async () => {
  const DB = makeDatabase(0);
  let processed = 0;
  const result = await executeScheduledTick(
    { DB },
    async () => {
      processed += 1;
      return { status: 'processed' };
    },
    () => 1_800_000_000_000,
  );

  assert.deepEqual(result, { status: 'inactive' });
  assert.equal(processed, 0);
  assert.equal(DB.state.lastStatus, 'inactive');
  assert.equal(DB.state.lastError, null);
});

test('separate cron invocations automatically continue the backlog one candidate each', async () => {
  const DB = makeDatabase(1);
  const backlog = ['candidate-1', 'candidate-2', 'candidate-3'];
  const committed = [];
  for (let index = 0; index < 3; index += 1) {
    const result = await executeScheduledTick(
      { DB },
      async () => {
        const candidateId = backlog.shift();
        committed.push(candidateId);
        return { status: 'processed', candidateId };
      },
      () => 1_800_000_000_000 + index * 60_000,
    );
    assert.equal(result.status, 'processed');
  }
  assert.deepEqual(committed, ['candidate-1', 'candidate-2', 'candidate-3']);
  assert.equal(DB.state.invocationCount, 3);
});

test('scheduled exceptions and recorded candidate errors are visible in D1 telemetry', async () => {
  const DB = makeDatabase(1);
  await assert.rejects(
    executeScheduledTick(
      { DB },
      async () => {
        throw new Error('D1 unavailable');
      },
      () => 1_800_000_000_000,
    ),
    /D1 unavailable/,
  );
  assert.equal(DB.state.lastStatus, 'failed');
  assert.equal(DB.state.lastError, 'D1 unavailable');

  const recordedError = await executeScheduledTick(
    { DB },
    async () => ({ status: 'error', candidateId: 'candidate-2', message: 'Vision model failed' }),
    () => 1_800_000_060_000,
  );
  assert.equal(recordedError.status, 'error');
  assert.equal(DB.state.lastStatus, 'error');
  assert.equal(DB.state.lastError, 'Vision model failed');
});
