import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectForestRunnerCandidates,
  isForestRunnerCandidate,
} from '../src/forest-candidates.js';

test('old Forest Runner category is identified without matching ordinary candidates', () => {
  assert.equal(
    isForestRunnerCandidate({
      category: 'Forest LiDAR candidate (heuristic; 2018 survey)',
    }),
    true,
  );
  assert.equal(isForestRunnerCandidate({ category: 'Warehouse candidate' }), false);
  assert.equal(isForestRunnerCandidate(null), false);
});

test('forest cleanup deduplicates submissions and prefers the shared review record', () => {
  const forestReview = {
    id: 'forest-1',
    category: 'Forest LiDAR candidate (heuristic; 2018 survey)',
    removed: false,
  };
  const candidates = collectForestRunnerCandidates(
    [forestReview],
    [
      { id: 'forest-1', category: 'Forest LiDAR candidate (heuristic; 2018 survey)' },
      { id: 'forest-2', category: 'Forest LiDAR candidate (heuristic; 2018 survey)' },
      { id: 'house-1', category: 'Residential building' },
    ],
  );

  assert.deepEqual(candidates, [
    forestReview,
    { id: 'forest-2', category: 'Forest LiDAR candidate (heuristic; 2018 survey)' },
  ]);
});
