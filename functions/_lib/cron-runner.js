function errorText(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1000);
}

async function beginCronRun(database, startedAt) {
  await database.prepare(
    `INSERT OR IGNORE INTO investigation_cron_state
      (id, last_started_at, last_finished_at, last_status, last_error,
       last_candidate_id, invocation_count)
     VALUES (1, NULL, NULL, NULL, NULL, NULL, 0)`,
  ).run();
  await database.prepare(
    `UPDATE investigation_cron_state
        SET last_started_at = ?, last_status = 'running',
            invocation_count = invocation_count + 1
      WHERE id = 1`,
  ).bind(startedAt).run();
}

async function finishCronRun(database, fields) {
  await database.prepare(
    `UPDATE investigation_cron_state
        SET last_finished_at = ?, last_status = ?,
            last_error = COALESCE(?, last_error),
            last_candidate_id = COALESCE(?, last_candidate_id)
      WHERE id = 1`,
  ).bind(fields.finishedAt, fields.status, fields.error, fields.candidateId).run();
}

export async function runScheduledInvocation(env, processCandidate, clock = Date.now) {
  const startedAt = Math.floor(clock() / 1000);
  await beginCronRun(env.DB, startedAt);

  try {
    const control = await env.DB.prepare(
      'SELECT enabled FROM investigation_queue_control WHERE id = 1',
    ).first();
    const result = control?.enabled === 1
      ? await processCandidate(env)
      : { status: 'inactive' };
    const finishedAt = Math.floor(clock() / 1000);
    await finishCronRun(env.DB, {
      finishedAt,
      status: result.status,
      error: result.status === 'error' ? errorText(result.message) : null,
      candidateId: result.candidateId || null,
    });
    return result;
  } catch (error) {
    const finishedAt = Math.floor(clock() / 1000);
    const message = errorText(error);
    await finishCronRun(env.DB, {
      finishedAt,
      status: 'failed',
      error: message,
      candidateId: null,
    });
    throw error;
  }
}
