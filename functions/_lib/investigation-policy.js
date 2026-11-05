export const AI_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
export const DAILY_NEURON_BUDGET = 4_000;
export const ESTIMATED_NEURONS_PER_CALL = 200;

const CLASSIFICATIONS = new Set([
  'likely_non_residential',
  'residential',
  'not_a_building',
  'uncertain',
]);

function boundedText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function textList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim().slice(0, 300))
    .filter(Boolean)
    .slice(0, 12);
}

export function sanitizeAiReport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Vision model returned an invalid report object.');
  }
  if (!CLASSIFICATIONS.has(value.classification)) {
    throw new Error('Vision model returned an unsupported classification.');
  }
  if (
    typeof value.confidence !== 'number' ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1
  ) {
    throw new Error('Vision model returned an invalid confidence value.');
  }
  if (typeof value.description !== 'string') {
    throw new Error('Vision model omitted the required description.');
  }
  return {
    classification: value.classification,
    confidence: value.confidence,
    description: boundedText(value.description, 700),
    positive_evidence: textList(value.positive_evidence),
    negative_evidence: textList(value.negative_evidence),
    lidar_observations: textList(value.lidar_observations),
    imagery_observations: textList(value.imagery_observations),
    rejection_reason: boundedText(value.rejection_reason, 500) || null,
    recommended_action: boundedText(value.recommended_action, 300),
  };
}

export function hasIndependentLidarSupport(candidate) {
  const dimensions = candidate?.dimensions || {};
  const area = Number.isFinite(dimensions.areaSquareMeters)
    ? dimensions.areaSquareMeters
    : dimensions.widthMeters * dimensions.lengthMeters;
  const pointCount = candidate?.pointCount;
  const groundCoverage = candidate?.groundCoverage;
  const planarCoverage = candidate?.planarCoverage;
  const vegetationShare = candidate?.vegetationShare;
  const class6Count = candidate?.class6Count;
  const relativeHeight = candidate?.relativeHeightUnits;

  if (
    !Number.isFinite(area) ||
    area < 25 ||
    !Number.isFinite(pointCount) ||
    pointCount < 40 ||
    !Number.isFinite(groundCoverage) ||
    groundCoverage < 0.35 ||
    !Number.isFinite(relativeHeight) ||
    relativeHeight <= 1.5
  ) {
    return false;
  }
  const buildingReturns = Number.isFinite(class6Count) && class6Count >= 10;
  const roofGeometry =
    Number.isFinite(planarCoverage) &&
    planarCoverage >= 0.4 &&
    Number.isFinite(vegetationShare) &&
    vegetationShare < 0.65;
  return buildingReturns || roofGeometry;
}

export function configuredApprovalThreshold(value) {
  const threshold = Number(value);
  return Number.isFinite(threshold) && threshold >= 0.5 && threshold <= 1
    ? threshold
    : 0.85;
}

export function evaluateInvestigation(candidate, report, threshold = 0.85, publicContext = {}) {
  if (report.classification === 'not_a_building' && report.confidence >= 0.65) {
    return { status: 'rejected', reason: report.rejection_reason || 'The imagery review did not identify a building.' };
  }
  if (report.classification === 'residential' && report.confidence >= 0.65) {
    return { status: 'rejected', reason: report.rejection_reason || 'The imagery review identified an ordinary residential structure.' };
  }
  if (publicContext.directResidential === true) {
    return { status: 'uncertain', reason: 'OpenStreetMap tags the nearby target building as residential; this conflicts with any non-residential interpretation.' };
  }
  if (report.classification !== 'likely_non_residential') {
    return { status: 'uncertain', reason: report.rejection_reason || 'The available evidence does not establish a non-residential structure.' };
  }
  if (report.confidence < threshold) {
    return { status: 'uncertain', reason: `Vision confidence ${report.confidence.toFixed(2)} is below the configured ${threshold.toFixed(2)} approval threshold.` };
  }
  if (!report.positive_evidence.length || !report.imagery_observations.length) {
    return { status: 'uncertain', reason: 'Approval requires explicit positive evidence and observations from the aerial image.' };
  }
  if (!hasIndependentLidarSupport(candidate)) {
    return { status: 'uncertain', reason: 'The available LiDAR measurements do not independently support a roof or structure.' };
  }
  return { status: 'approved', reason: null };
}

export function parseModelJson(response) {
  const text =
    typeof response === 'string'
      ? response
      : typeof response?.response === 'string'
        ? response.response
        : '';
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('Vision model did not return a JSON report.');
  }
  try {
    return sanitizeAiReport(JSON.parse(text.slice(start, end + 1)));
  } catch (error) {
    throw new Error(`Vision model report could not be validated: ${error.message}`);
  }
}
