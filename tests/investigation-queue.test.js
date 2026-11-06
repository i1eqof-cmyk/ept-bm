import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canManuallyRetry,
  acquireProcessingLock,
  assertAiRunSucceeded,
  clearAllInvestigations,
  isQueueEnabled,
  isQueueOwner,
  isQuotaExceededError,
  recoverQueueStatus,
  releaseProcessingLock,
  runQueueSequentially,
  shouldPollQueue,
  stopQueue,
} from '../functions/_lib/queue-control.js';
import { persistInvestigationResult } from '../functions/_lib/queue-persistence.js';
import { OWNER_UID } from '../shared/owner.js';

function makeAtomicLockDatabase() {
  const lock = { leaseId: null, expiresAt: 0 };
  return {
    lock,
    prepare(sql) {
      return {
        async run() {
          if (sql.startsWith('INSERT OR IGNORE INTO investigation_lock')) return {};
          throw new Error(`Unexpected unbound lock SQL: ${sql}`);
        },
        bind(...values) {
          return {
            async run() {
              if (sql.startsWith('INSERT OR IGNORE INTO investigation_lock')) return {};
              if (sql.startsWith('UPDATE investigation_lock SET lease_id = NULL')) {
                if (lock.leaseId === values[0]) {
                  lock.leaseId = null;
                  lock.expiresAt = 0;
                }
                return {};
              }
              throw new Error(`Unexpected lock SQL: ${sql}`);
            },
            async first() {
              if (!sql.startsWith('UPDATE investigation_lock SET lease_id = ?')) {
                throw new Error(`Unexpected lock SQL: ${sql}`);
              }
              const [leaseId, expiresAt, now] = values;
              if (lock.expiresAt > now) return null;
              lock.leaseId = leaseId;
              lock.expiresAt = expiresAt;
              return { lease_id: leaseId };
            },
          };
        },
      };
    },
  };
}

test('queue stays disabled until the owner starts it and the start state survives reloads', () => {
  assert.equal(isQueueOwner({ uid: OWNER_UID }, OWNER_UID), true);
  assert.equal(isQueueOwner({ uid: 'owner' }, 'owner'), true);
  assert.equal(isQueueOwner({ uid: 'visitor' }, 'owner'), false);
  assert.equal(isQueueEnabled(null), false);
  assert.equal(isQueueEnabled({ enabled: 0 }), false);
  assert.equal(isQueueEnabled({ enabled: 1 }), true);
});

test('owner stop action persists the inactive queue state in D1', async () => {
  let binding;
  const database = {
    prepare(sql) {
      assert.match(sql, /INSERT INTO investigation_queue_control/);
      return {
        bind(...values) {
          binding = values;
          return { async run() {} };
        },
      };
    },
  };
  await stopQueue(database, 123);
  assert.deepEqual(binding, [123]);
});

test('clear all stops the queue and deletes investigation rows and history', async () => {
  const state = {
    enabled: 1,
    investigations: 3,
    history: 5,
  };
  const database = {
    prepare(sql) {
      const statement = {
        async run() {
          if (sql.includes('DELETE FROM investigation_history')) {
            const deleted = state.history;
            state.history = 0;
            return { meta: { changes: deleted } };
          }
          if (sql === 'DELETE FROM investigations') {
            const deleted = state.investigations;
            state.investigations = 0;
            return { meta: { changes: deleted } };
          }
          throw new Error(`Unexpected cleanup SQL: ${sql}`);
        },
        bind(...values) {
          return {
            async run() {
              if (sql.includes('INSERT INTO investigation_queue_control')) {
                state.enabled = 0;
                return { meta: { changes: 1 } };
              }
              throw new Error(`Unexpected cleanup SQL: ${sql}`);
            },
          };
        },
      };
      return statement;
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };

  const result = await clearAllInvestigations(database, 456);

  assert.deepEqual(result, {
    deletedHistoryCount: 5,
    deletedInvestigationCount: 3,
  });
  assert.equal(state.enabled, 0);
  assert.equal(state.investigations, 0);
  assert.equal(state.history, 0);
});

test('interrupted analysis recovers after its persisted lease expires', () => {
  assert.equal(
    recoverQueueStatus(
      { status: 'analyzing', lease_until: 99, updated_at: 50 },
      100,
      0,
    ),
    'pending',
  );
  assert.equal(
    recoverQueueStatus(
      { status: 'analyzing', lease_until: 101, updated_at: 50 },
      100,
      0,
    ),
    'analyzing',
  );
});

test('atomic D1 lease prevents duplicate execution and allows recovery after expiry', async () => {
  const database = makeAtomicLockDatabase();
  const [first, overlapping] = await Promise.all([
    acquireProcessingLock(database, 'run-1', 100, 1060),
    acquireProcessingLock(database, 'run-2', 100, 1060),
  ]);
  assert.ok(first || overlapping);
  assert.equal(Boolean(first) + Boolean(overlapping), 1);

  const recovered = await acquireProcessingLock(database, 'run-3', 1060, 2020);
  assert.deepEqual(recovered, { lease_id: 'run-3' });
  await releaseProcessingLock(database, 'run-1');
  assert.equal(database.lock.leaseId, 'run-3');
  await releaseProcessingLock(database, 'run-3');
  assert.equal(database.lock.leaseId, null);
});

test('quota-paused work recovers only after the next UTC day begins', () => {
  assert.equal(
    recoverQueueStatus(
      { status: 'quota_paused', updated_at: 199 },
      250,
      200,
    ),
    'pending',
  );
  assert.equal(
    recoverQueueStatus(
      { status: 'quota_paused', updated_at: 200 },
      250,
      200,
    ),
    'quota_paused',
  );
});

test('free AI quota exhaustion messages pause the queue without matching ordinary failures', () => {
  assert.equal(isQuotaExceededError('Daily allocation exhausted'), true);
  assert.equal(isQuotaExceededError(new Error('Workers AI daily usage limit exceeded')), true);
  assert.equal(isQuotaExceededError({ status: 429, message: 'Too many requests' }), true);
  assert.equal(isQuotaExceededError(new Error('rate limit exceeded')), true);
  assert.equal(isQuotaExceededError(new Error('Model input is too long')), false);
  assert.equal(isQuotaExceededError(new Error('Invalid image content type')), false);
});

test('Workers AI error payloads are raised so quota errors enter the pause path', () => {
  assert.throws(
    () => assertAiRunSucceeded({
      success: false,
      errors: [{ code: 429, status: 429, message: 'Daily free allocation exhausted' }],
    }),
    (error) => error.status === 429 && /Daily free allocation/.test(error.message),
  );
  assert.deepEqual(assertAiRunSucceeded({ success: true, response: '{"ok":true}' }), {
    success: true,
    response: '{"ok":true}',
  });
});

test('saved terminal results are never automatically requeued', () => {
  for (const status of ['approved', 'rejected', 'uncertain', 'error']) {
    assert.equal(
      recoverQueueStatus({ status, lease_until: 0, updated_at: 0 }, 100, 50),
      status,
    );
  }
  assert.equal(canManuallyRetry('error'), true);
  assert.equal(canManuallyRetry('uncertain'), true);
  assert.equal(canManuallyRetry('approved'), false);
  assert.equal(canManuallyRetry('rejected'), false);
});

test('active queue polling recovers pending, interrupted, and quota-paused work only', () => {
  assert.equal(
    shouldPollQueue({
      queue: { active: true },
      counts: { pending: 2 },
    }),
    true,
  );
  assert.equal(
    shouldPollQueue({
      queue: { active: true },
      counts: { analyzing: 1 },
    }),
    true,
  );
  assert.equal(
    shouldPollQueue({
      queue: { active: true },
      counts: { quota_paused: 2 },
    }),
    true,
  );
  assert.equal(
    shouldPollQueue({
      queue: { active: false },
      counts: { pending: 2 },
    }),
    false,
  );
  assert.equal(
    shouldPollQueue({
      queue: { active: true },
      counts: { approved: 10, rejected: 2, uncertain: 1, error: 1 },
    }),
    false,
  );
});

test('sequential runner waits for each durable result before processing the next candidate', async () => {
  const events = [];
  const results = [
    { status: 'processed', candidateId: 'candidate-1' },
    { status: 'error', candidateId: 'candidate-2' },
    { status: 'processed', candidateId: 'candidate-3' },
    { status: 'idle' },
  ];
  const database = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            sql,
            values,
            async first() {
              return { attempt_count: 1 };
            },
          };
        },
      };
    },
    async batch(statements) {
      const candidateId = statements[0].values[5];
      events.push(`commit:${candidateId}`);
    },
  };

  const finalResult = await runQueueSequentially(
    async () => {
      const result = results.shift();
      if (result.candidateId) {
        await persistInvestigationResult(
          database,
          result.candidateId,
          result.status === 'error' ? 'error' : 'approved',
          { classification: 'likely_non_residential' },
          null,
          100,
        );
        events.push(`return:${result.candidateId}`);
      }
      return result;
    },
    async () => {},
    async () => {},
  );

  assert.deepEqual(events, [
    'commit:candidate-1',
    'return:candidate-1',
    'commit:candidate-2',
    'return:candidate-2',
    'commit:candidate-3',
    'return:candidate-3',
  ]);
  assert.deepEqual(finalResult, { status: 'idle' });
});

test('a result and its history are both committed before persistence resolves', async () => {
  const events = [];
  const database = {
    prepare(sql) {
      return {
        bind() {
          return {
            async first() {
              events.push('load-attempt');
              return { attempt_count: 2 };
            },
          };
        },
        sql,
      };
    },
    async batch(statements) {
      assert.equal(statements.length, 2);
      events.push('commit-result-and-history');
    },
  };

  await persistInvestigationResult(
    database,
    'candidate-1',
    'approved',
    { classification: 'likely_non_residential' },
    null,
    100,
  );
  events.push('next-candidate');

  assert.deepEqual(events, [
    'load-attempt',
    'commit-result-and-history',
    'next-candidate',
  ]);
});
