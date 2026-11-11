import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateInvestigation,
  hasIndependentLidarSupport,
  sanitizeAiReport,
} from '../functions/_lib/investigation-policy.js';

const strongLidar = {
  pointCount: 1_200,
  class6Count: 0,
  groundCoverage: 0.8,
  planarCoverage: 0.72,
  vegetationShare: 0.12,
  relativeHeightUnits: 8.4,
  dimensions: {
    widthMeters: 35,
    lengthMeters: 60,
    areaSquareMeters: 1_400,
  },
};

function report(classification, confidence, evidence = {}) {
  return sanitizeAiReport({
    classification,
    confidence,
    description: evidence.description || 'Visible roof and surrounding land are described without inferring occupancy.',
    positive_evidence: evidence.positive || ['A broad, regular roof is visible.'],
    negative_evidence: evidence.negative || [],
    lidar_observations: ['LiDAR returns form a raised, relatively planar footprint.'],
    imagery_observations: evidence.imagery || ['Aerial image shows a large rectangular roof.'],
    rejection_reason: evidence.reason || null,
    recommended_action: 'Retain the evidence for review.',
  });
}

const scenarios = [
  {
    name: 'ordinary suburban house',
    classification: 'residential',
    confidence: 0.97,
    expected: 'rejected',
    context: {},
  },
  {
    name: 'residential subdivision house',
    classification: 'residential',
    confidence: 0.96,
    expected: 'rejected',
    context: { nearbyResidential: true },
  },
  {
    name: 'warehouse',
    classification: 'likely_non_residential',
    confidence: 0.94,
    expected: 'approved',
    context: { directNonResidential: true },
  },
  {
    name: 'large industrial building',
    classification: 'likely_non_residential',
    confidence: 0.97,
    expected: 'approved',
    context: { directNonResidential: true },
  },
  {
    name: 'agricultural building',
    classification: 'likely_non_residential',
    confidence: 0.9,
    expected: 'approved',
    context: {},
  },
  {
    name: 'tree canopy',
    classification: 'not_a_building',
    confidence: 0.91,
    expected: 'rejected',
    context: {},
  },
  {
    name: 'empty cleared lot',
    classification: 'not_a_building',
    confidence: 0.99,
    expected: 'rejected',
    context: {},
  },
  {
    name: 'insufficient imagery',
    classification: 'uncertain',
    confidence: 0.3,
    expected: 'uncertain',
    context: {},
  },
];

for (const scenario of scenarios) {
  test(`conservative gate: ${scenario.name}`, () => {
    const result = evaluateInvestigation(
      strongLidar,
      report(scenario.classification, scenario.confidence),
      0.85,
      scenario.context,
    );
    assert.equal(result.status, scenario.expected);
  });
}

test('residential map context alone does not reject a non-residential building', () => {
  const result = evaluateInvestigation(
    strongLidar,
    report('likely_non_residential', 0.94),
    0.85,
    { nearbyResidential: true, directResidential: false },
  );
  assert.equal(result.status, 'approved');
});

test('missing LiDAR support cannot produce an approved marker', () => {
  assert.equal(
    hasIndependentLidarSupport({ ...strongLidar, relativeHeightUnits: null }),
    false,
  );
  const result = evaluateInvestigation(
    { ...strongLidar, relativeHeightUnits: null },
    report('likely_non_residential', 0.99),
    0.85,
  );
  assert.equal(result.status, 'uncertain');
});

test('direct residential footprint data prevents approval without deleting the report', () => {
  const result = evaluateInvestigation(
    strongLidar,
    report('likely_non_residential', 0.99),
    0.85,
    { directResidential: true },
  );
  assert.equal(result.status, 'uncertain');
  assert.match(result.reason, /OpenStreetMap/);
});
