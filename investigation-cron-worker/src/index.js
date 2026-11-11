export function executeScheduledTick() {
  return { status: 'disabled' };
}

export default {
  scheduled() {
    console.info('AI candidate investigation is disabled; no candidates were processed.');
  },
};
