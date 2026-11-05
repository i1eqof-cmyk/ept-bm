export const FOREST_RUNNER_CATEGORY_PREFIX = 'Forest LiDAR candidate';

export function isForestRunnerCandidate(candidate) {
  return (
    typeof candidate?.category === 'string' &&
    candidate.category.startsWith(FOREST_RUNNER_CATEGORY_PREFIX)
  );
}

export function collectForestRunnerCandidates(reviews, submissions) {
  const reviewsById = new Map(
    reviews
      .filter((review) => typeof review?.id === 'string')
      .map((review) => [review.id, review]),
  );
  const forestRecords = new Map();

  for (const review of reviews) {
    if (isForestRunnerCandidate(review)) forestRecords.set(review.id, review);
  }
  for (const submission of submissions) {
    if (!isForestRunnerCandidate(submission)) continue;
    forestRecords.set(submission.id, reviewsById.get(submission.id) || submission);
  }

  return [...forestRecords.values()];
}
