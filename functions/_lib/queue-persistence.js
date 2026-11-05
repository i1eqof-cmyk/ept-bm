export async function persistInvestigationResult(
  database,
  candidateId,
  status,
  report,
  errorMessage,
  now,
) {
  const serializedReport = JSON.stringify(report);
  const current = await database.prepare(
    'SELECT attempt_count FROM investigations WHERE candidate_id = ?',
  ).bind(candidateId).first();
  if (!current) throw new Error(`Investigation ${candidateId} disappeared from the queue.`);
  await database.batch([
    database.prepare(
      `UPDATE investigations
          SET status = ?, report_json = ?, error_message = ?, updated_at = ?,
              analyzed_at = ?, lease_until = NULL
        WHERE candidate_id = ?`,
    ).bind(status, serializedReport, errorMessage, now, status === 'quota_paused' ? null : now, candidateId),
    database.prepare(
      `INSERT INTO investigation_history
        (candidate_id, status, report_json, attempt_count, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(candidateId, status, serializedReport, current.attempt_count, now),
  ]);
}
