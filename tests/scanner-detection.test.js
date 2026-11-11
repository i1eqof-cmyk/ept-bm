import test from 'node:test';
import assert from 'node:assert/strict';
import { detectCandidates } from '../src/scanner-engine.js';

function makeTile(points) {
  const positions = new Float32Array(points.length * 3);
  const classifications = new Uint8Array(points.length);
  points.forEach((point, index) => {
    positions[index * 3] = point.x;
    positions[index * 3 + 1] = point.y;
    positions[index * 3 + 2] = point.z;
    classifications[index] = point.classification;
  });
  return { areaPoints: points.length, positions, classifications };
}

function roofScene() {
  const points = [];
  for (let gx = -2; gx <= 5; gx += 1) {
    for (let gy = -2; gy <= 5; gy += 1) {
      if (gx >= 0 && gx <= 3 && gy >= 0 && gy <= 3) {
        for (let index = 0; index < 40; index += 1) {
          points.push({
            x: gx * 2.5 + 0.25 + (index % 4) * 0.1,
            y: gy * 2.5 + 0.25 + Math.floor(index / 4) * 0.1,
            z: 10 + (index % 3) * 0.1,
            classification: 1,
          });
        }
      } else {
        points.push({
          x: gx * 2.5 + 0.5,
          y: gy * 2.5 + 0.5,
          z: 0,
          classification: 2,
        });
      }
    }
  }
  return points;
}

const testBounds = {
  west: -0.001,
  east: 0.001,
  south: -0.001,
  north: 0.001,
};

test('roof-like non-Class-6 returns produce a candidate with explainable scan diagnostics', () => {
  const result = detectCandidates([makeTile(roofScene())], testBounds);

  assert.equal(result.totalCandidateCount, 1);
  assert.equal(result.candidates[0].class6Count, 0);
  assert.equal(result.diagnostics.pointCount, roofScene().length);
  assert.equal(
    Object.values(result.diagnostics.classificationCounts).reduce((sum, count) => sum + count, 0),
    roofScene().length,
  );
  assert.ok(result.diagnostics.elevatedCellCount >= 16);
  assert.ok(result.diagnostics.planarElevatedCellCount >= 16);
  assert.equal(result.diagnostics.roofGeometryGroupCount, 1);
});

test('a tree-canopy scene is reported as vegetation and rejected, not called a roof', () => {
  const points = [];
  for (let gx = -2; gx <= 5; gx += 1) {
    for (let gy = -2; gy <= 5; gy += 1) {
      const canopyCell = gx >= 0 && gx <= 3 && gy >= 0 && gy <= 3;
      for (let index = 0; index < 8; index += 1) {
        points.push({
          x: gx * 2.5 + 0.2 + (index % 4) * 0.4,
          y: gy * 2.5 + 0.2 + Math.floor(index / 4) * 0.4,
          z: canopyCell ? 8 + index * 0.4 : 0,
          classification: canopyCell ? 5 : 2,
        });
      }
    }
  }

  const result = detectCandidates([makeTile(points)], testBounds);

  assert.equal(result.totalCandidateCount, 0);
  assert.ok(result.diagnostics.classificationCounts[5] > 0);
  assert.equal(result.diagnostics.eligibleCellCount, 0);
});

test('planar unclassified roof returns remain detectable beneath dense canopy returns', () => {
  const points = [];
  for (let gx = -2; gx <= 5; gx += 1) {
    for (let gy = -2; gy <= 5; gy += 1) {
      const roofCell = gx >= 0 && gx <= 3 && gy >= 0 && gy <= 3;
      if (roofCell) {
        for (let index = 0; index < 5; index += 1) {
          points.push({
            x: gx * 2.5 + 0.3 + (index % 2) * 0.2,
            y: gy * 2.5 + 0.3 + Math.floor(index / 2) * 0.2,
            z: 10 + (index % 2) * 0.1,
            classification: 1,
          });
        }
        for (let index = 0; index < 20; index += 1) {
          points.push({
            x: gx * 2.5 + 0.1 + (index % 5) * 0.45,
            y: gy * 2.5 + 0.1 + Math.floor(index / 5) * 0.45,
            z: 7 + (index % 7) * 0.8,
            classification: 5,
          });
        }
      } else {
        points.push({
          x: gx * 2.5 + 0.5,
          y: gy * 2.5 + 0.5,
          z: 0,
          classification: 2,
        });
      }
    }
  }

  const result = detectCandidates([makeTile(points)], testBounds);

  assert.equal(result.totalCandidateCount, 1);
  assert.ok(result.candidates[0].vegetationShare >= 0.7);
  assert.ok(result.candidates[0].evidence.some((item) => item.includes('Canopy-supported roof geometry')));
  assert.ok(result.candidates[0].evidence.some((item) => item.includes('80 non-vegetation returns')));
});
