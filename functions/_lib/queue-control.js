const CONTINUE_STATUSES = new Set(['processed', 'error', 'busy']);
const MANUALLY_RETRYABLE_STATUSES = new Set(['error', 'uncertain']);

export function isQueueEnabled(control) {
  return control?.enabled === 1;
}

export async function stopQueue(database, now) {
  await database.prepare(
    `INSERT INTO investigation_queue_control (id, enabled, updated_at) VALUES (1, 0, ?)
     ON CONFLICT(id) DO UPDATE SET enabled = 0, updated_at = excluded.updated_at`,
  ).bind(now).run();
}

export async function clearAllInvestigations(database, now) {
  const results = await database.batch([
    database.prepare(
      `INSERT INTO investigation_queue_control (id, enabled, updated_at) VALUES (1, 0, ?)
       ON CONFLICT(id) DO UPDATE SET enabled = 0, updated_at = excluded.updated_at`,
    ).bind(now),
    database.prepare(
      'DELETE FROM investigation_history',
    ),
    database.prepare('DELETE FROM investigations'),
  ]);
  return {
    deletedHistoryCount: results[1]?.meta?.changes || 0,
    deletedInvestigationCount: results[2]?.meta?.changes || 0,
  };
}

export async function acquireProcessingLock(database, leaseId, now, expiresAt) {
  await database.prepare(
    'INSERT OR IGNORE INTO investigation_lock (id, lease_id, expires_at) VALUES (1, NULL, 0)',
  ).run();
  return database.prepare(
    `UPDATE investigation_lock SET lease_id = ?, expires_at = ?
      WHERE id = 1 AND expires_at <= ? RETURNING lease_id`,
  ).bind(leaseId, expiresAt, now).first();
}

export async function releaseProcessingLock(database, leaseId) {
  await database.prepare(
    'UPDATE investigation_lock SET lease_id = NULL, expires_at = 0 WHERE id = 1 AND lease_id = ?',
  ).bind(leaseId).run();
}

export function isQueueOwner(user, ownerUid) {
  return Boolean(ownerUid && user?.uid === ownerUid);
}

export function recoverQueueStatus(record, now, dayStart) {
  if (
    record.status === 'analyzing' &&
    Number.isFinite(record.lease_until) &&
    record.lease_until <= now
  ) {
    return 'pending';
  }
  if (
    record.status === 'quota_paused' &&
    Number.isFinite(record.updated_at) &&
    record.updated_at < dayStart
  ) {
    return 'pending';
  }
  return record.status;
}

export function shouldContinueQueue(resultStatus) {
  return CONTINUE_STATUSES.has(resultStatus);
}

export function canManuallyRetry(status) {
  return MANUALLY_RETRYABLE_STATUSES.has(status);
}

export function isQuotaExceededError(error) {
  const status = Number(error?.status ?? error?.statusCode);
  if (status === 429) return true;
  const message = typeof error === 'string'
    ? error
    : `${error?.message || ''} ${error?.cause?.message || ''} ${error?.code || ''}`;
  return /quota|too many requests|rate.?limit|\b429\b|daily.{0,40}(?:limit|allowance|allocation|budget|usage)|(?:free|usage).{0,40}(?:limit|allowance|allocation|budget|exhaust)|(?:neuron|credit).{0,40}(?:limit|allowance|allocation|exhaust)|(?:exceed|exhaust|insufficient).{0,40}(?:limit|allowance|allocation|budget|quota|neuron|credit)/i.test(message);
}

export function assertAiRunSucceeded(result) {
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  if (result?.success === false || errors.length) {
    const message = errors
      .map((error) => typeof error?.message === 'string' ? error.message : String(error?.code || ''))
      .filter(Boolean)
      .join('; ') || 'Workers AI returned an unsuccessful response.';
    const error = new Error(message);
    const status = errors.find((entry) => Number.isFinite(entry?.status))?.status;
    if (Number.isFinite(status)) error.status = status;
    throw error;
  }
  return result;
}

export function shouldPollQueue(summary) {
  if (!summary?.queue?.active) return false;
  return Boolean(
    summary.counts?.pending ||
    summary.counts?.analyzing ||
    summary.counts?.quota_paused
  );
}

export async function runQueueSequentially(processOne, afterEach, wait) {
  while (true) {
    const result = await processOne();
    await afterEach(result);
    if (!shouldContinueQueue(result.status)) return result;
    await wait(result.status === 'busy' ? 1500 : 350);
  }
}
