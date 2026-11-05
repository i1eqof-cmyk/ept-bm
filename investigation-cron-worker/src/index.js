import { processNextCandidate } from '../../functions/api/investigations.js';
import { runScheduledInvocation } from '../../functions/_lib/cron-runner.js';

export function executeScheduledTick(env, processor = processNextCandidate) {
  return runScheduledInvocation(env, processor);
}

export default {
  async scheduled(_controller, env, context) {
    context.waitUntil(
      executeScheduledTick(env).catch((error) => {
        console.error('Scheduled investigation invocation failed.', error);
      }),
    );
  },
};
