import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { executeScheduledTick } from '../investigation-cron-worker/src/index.js';

test('scheduled AI investigation worker is inert and processes no candidates', () => {
  assert.deepEqual(executeScheduledTick(), { status: 'disabled' });
  assert.equal(typeof worker.scheduled, 'function');
  assert.equal('fetch' in worker, false);
});
