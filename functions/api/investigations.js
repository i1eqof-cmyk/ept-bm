import {
  AI_MODEL,
  DAILY_NEURON_BUDGET,
  ESTIMATED_NEURONS_PER_CALL,
  configuredApprovalThreshold,
  evaluateInvestigation,
  hasIndependentLidarSupport,
  parseModelJson,
} from '../_lib/investigation-policy.js';
import {
  isQueueEnabled,
  isQueueOwner,
  isQuotaExceededError,
  assertAiRunSucceeded,
  recoverQueueStatus,
  acquireProcessingLock,
  releaseProcessingLock,
  stopQueue as persistQueueStop,
  clearPendingForestRunnerCandidates,
} from '../_lib/queue-control.js';
import { persistInvestigationResult } from '../_lib/queue-persistence.js';

const MAX_QUEUE_BATCH = 50;
const MAX_HISTORY_PAGE = 50;
const MAX_APPROVED_PAGE = 500;
const IMAGE_SIZE_LIMIT = 512 * 1024;
const PUBLIC_CONTEXT_SIZE_LIMIT = 128 * 1024;
const LOCK_SECONDS = 16 * 60;
const IMAGE_SERVICE =
  'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage';
const OVERPASS_SERVICE = 'https://overpass-api.de/api/interpreter';
const FIREBASE_JWK_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const EARTH_RADIUS_METERS = 6_378_137;

let firebaseJwks;
let firebaseJwksLoadedAt = 0;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function jsonResponse(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function decodeJsonPart(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

async function loadFirebaseJwks() {
  if (firebaseJwks && Date.now() - firebaseJwksLoadedAt < 60 * 60 * 1000) {
    return firebaseJwks;
  }
  const response = await fetch(FIREBASE_JWK_URL, { cache: 'no-store' });
  if (!response.ok) {
    throw new ApiError(503, `Firebase token keys returned HTTP ${response.status}.`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload.keys)) {
    throw new ApiError(503, 'Firebase token keys have an unexpected format.');
  }
  firebaseJwks = payload.keys;
  firebaseJwksLoadedAt = Date.now();
  return firebaseJwks;
}

async function authenticate(request, env) {
  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new ApiError(503, 'FIREBASE_PROJECT_ID is not configured in Pages.');
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token || token.length > 8192) throw new ApiError(401, 'A Firebase sign-in is required.');

  const parts = token.split('.');
  if (parts.length !== 3) throw new ApiError(401, 'The Firebase sign-in token is invalid.');
  let header;
  let claims;
  try {
    header = decodeJsonPart(parts[0]);
    claims = decodeJsonPart(parts[1]);
  } catch {
    throw new ApiError(401, 'The Firebase sign-in token is invalid.');
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
    throw new ApiError(401, 'The Firebase sign-in token uses an unsupported signature.');
  }
  const key = (await loadFirebaseJwks()).find((entry) => entry.kid === header.kid);
  if (!key) throw new ApiError(401, 'The Firebase sign-in token key is not recognized.');
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    key,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const validSignature = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    decodeBase64Url(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (
    !validSignature ||
    claims.aud !== projectId ||
    claims.iss !== `https://securetoken.google.com/${projectId}` ||
    typeof claims.sub !== 'string' ||
    !claims.sub ||
    claims.sub.length > 128 ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= nowSeconds ||
    !Number.isFinite(claims.iat) ||
    claims.iat > nowSeconds + 60
  ) {
    throw new ApiError(401, 'The Firebase sign-in token is invalid or expired.');
  }
  return { uid: claims.sub };
}

function finite(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function optionalMetric(value, min, max) {
  return finite(value, min, max) ? value : null;
}

function normalizeCandidate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'A candidate must be an object.');
  }
  const { bbox, dimensions } = value;
  if (
    typeof value.id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,120}$/.test(value.id) ||
    !finite(value.latitude, -90, 90) ||
    !finite(value.longitude, -180, 180) ||
    !bbox ||
    !finite(bbox.west, -180, 180) ||
    !finite(bbox.east, -180, 180) ||
    !finite(bbox.south, -90, 90) ||
    !finite(bbox.north, -90, 90) ||
    bbox.west >= bbox.east ||
    bbox.south >= bbox.north ||
    !dimensions ||
    !finite(dimensions.widthMeters, 0, 5000) ||
    !finite(dimensions.lengthMeters, 0, 5000) ||
    !finite(value.score, 0, 100) ||
    !finite(value.pointCount, 0, 100_000_000)
  ) {
    throw new ApiError(400, `Candidate ${String(value.id || '(unknown)')} has invalid coordinates or measurements.`);
  }
  const candidate = {
    id: value.id,
    latitude: value.latitude,
    longitude: value.longitude,
    bbox: {
      west: bbox.west,
      south: bbox.south,
      east: bbox.east,
      north: bbox.north,
    },
    score: value.score,
    confidence: ['High', 'Medium', 'Low'].includes(value.confidence) ? value.confidence : 'Low',
    category: typeof value.category === 'string' ? value.category.slice(0, 100) : 'LiDAR candidate',
    pointCount: Math.floor(value.pointCount),
    dimensions: {
      widthMeters: dimensions.widthMeters,
      lengthMeters: dimensions.lengthMeters,
      areaSquareMeters: optionalMetric(dimensions.areaSquareMeters, 0, 25_000_000),
      aspectRatio: optionalMetric(dimensions.aspectRatio, 0, 100_000),
    },
    evidence: Array.isArray(value.evidence)
      ? value.evidence.filter((entry) => typeof entry === 'string').map((entry) => entry.slice(0, 300)).slice(0, 24)
      : [],
    class6Count: optionalMetric(value.class6Count, 0, 100_000_000) ?? 0,
    classificationCounts: value.classificationCounts && typeof value.classificationCounts === 'object'
      ? Object.fromEntries(
          ['2', '3', '4', '5', '6', 'other']
            .filter((key) => finite(value.classificationCounts[key], 0, 100_000_000))
            .map((key) => [key, Math.floor(value.classificationCounts[key])]),
        )
      : {},
    class6Share: optionalMetric(value.class6Share, 0, 1),
    vegetationShare: optionalMetric(value.vegetationShare, 0, 1),
    groundCoverage: optionalMetric(value.groundCoverage, 0, 1),
    planarCoverage: optionalMetric(value.planarCoverage, 0, 1),
    medianRoughness: optionalMetric(value.medianRoughness, 0, 1_000_000),
    relativeHeightUnits: optionalMetric(value.relativeHeightUnits, -1_000_000, 1_000_000),
    density: optionalMetric(value.density, 0, 1_000_000),
    removed: value.removed === true,
    updatedAt: finite(value.updatedAt, 0, Number.MAX_SAFE_INTEGER) ? value.updatedAt : null,
  };
  if (JSON.stringify(candidate).length > 12_000) {
    throw new ApiError(400, `Candidate ${candidate.id} exceeds the evidence-size limit.`);
  }
  return candidate;
}

function utcDay(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function mapDatabaseRow(row) {
  let candidate;
  let report = null;
  try {
    candidate = JSON.parse(row.candidate_json);
    report = row.report_json ? JSON.parse(row.report_json) : null;
  } catch {
    throw new ApiError(500, `Stored investigation ${row.candidate_id} contains invalid JSON.`);
  }
  return {
    candidateId: row.candidate_id,
    candidate,
    status: row.status,
    report,
    error: row.error_message,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    analyzedAt: row.analyzed_at,
  };
}

async function queueCandidates(env, body) {
  if (!Array.isArray(body.candidates) || body.candidates.length > MAX_QUEUE_BATCH) {
    throw new ApiError(400, `Queue requests must contain between 1 and ${MAX_QUEUE_BATCH} candidates.`);
  }
  if (!body.candidates.length) return { inserted: 0, alreadyQueued: 0 };
  const now = Math.floor(Date.now() / 1000);
  const candidates = body.candidates.map(normalizeCandidate);
  const statements = candidates.map((candidate) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO investigations
        (candidate_id, candidate_json, status, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, ?)`,
    ).bind(candidate.id, JSON.stringify(candidate), now, now),
  );
  const results = await env.DB.batch(statements);
  const inserted = results.reduce((sum, result) => sum + (result.meta?.changes || 0), 0);
  return { inserted, alreadyQueued: candidates.length - inserted };
}

async function readSummary(env) {
  const [countsResult, usage, queueControl, cronState] = await Promise.all([
    env.DB.prepare('SELECT status, COUNT(*) AS count FROM investigations GROUP BY status').all(),
    env.DB.prepare('SELECT estimated_neurons, actual_neurons, call_count FROM ai_daily_usage WHERE day_utc = ?')
      .bind(utcDay())
      .first(),
    env.DB.prepare('SELECT enabled FROM investigation_queue_control WHERE id = 1').first(),
    env.DB.prepare(
      `SELECT last_started_at, last_finished_at, last_status, last_error,
              last_candidate_id, invocation_count
         FROM investigation_cron_state WHERE id = 1`,
    ).first(),
  ]);
  const counts = Object.fromEntries(
    ['pending', 'analyzing', 'approved', 'rejected', 'uncertain', 'quota_paused', 'error'].map((status) => [status, 0]),
  );
  for (const row of countsResult.results || []) counts[row.status] = row.count;
  const usedNeurons = Math.max(usage?.estimated_neurons || 0, usage?.actual_neurons || 0);
  return {
    counts,
    total: Object.values(counts).reduce((sum, value) => sum + value, 0),
    queue: {
      active: isQueueEnabled(queueControl),
      cron: cronState ? {
        lastStartedAt: cronState.last_started_at,
        lastFinishedAt: cronState.last_finished_at,
        lastStatus: cronState.last_status,
        lastError: cronState.last_error,
        lastCandidateId: cronState.last_candidate_id,
        invocationCount: cronState.invocation_count,
      } : null,
    },
    quota: {
      dailyBudgetNeurons: DAILY_NEURON_BUDGET,
      estimatedNeuronsUsed: usedNeurons,
      estimatedNeuronsRemaining: Math.max(0, DAILY_NEURON_BUDGET - usedNeurons),
      estimatedCallsRemaining: Math.floor(Math.max(0, DAILY_NEURON_BUDGET - usedNeurons) / ESTIMATED_NEURONS_PER_CALL),
      callsToday: usage?.call_count || 0,
      resetsAtUtc: `${new Date(`${utcDay()}T00:00:00.000Z`).getTime() / 1000 + 86_400}`,
      model: AI_MODEL,
      appBudgetNote: 'Application cap is 4,000 estimated Neurons per UTC day. Cloudflare usage shared with other account workloads may be lower.',
    },
    approvalThreshold: configuredApprovalThreshold(env.AI_APPROVAL_CONFIDENCE),
    configured: Boolean(env.DB && env.AI && env.FIREBASE_PROJECT_ID),
  };
}

async function listInvestigations(env, url, onlyApproved = false) {
  const limit = Math.max(1, Math.min(
    Number.parseInt(url.searchParams.get('limit') || (onlyApproved ? '500' : '25'), 10) || 25,
    onlyApproved ? MAX_APPROVED_PAGE : MAX_HISTORY_PAGE,
  ));
  const offset = Math.max(0, Math.min(Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0, 100_000));
  const statusFilter = onlyApproved ? "WHERE status = 'approved'" : '';
  const result = await env.DB.prepare(
    `SELECT candidate_id, candidate_json, status, report_json, error_message,
            attempt_count, created_at, updated_at, analyzed_at
       FROM investigations ${statusFilter}
      ORDER BY updated_at DESC, candidate_id LIMIT ? OFFSET ?`,
  ).bind(limit, offset).all();
  return {
    items: (result.results || []).map(mapDatabaseRow),
    limit,
    offset,
    hasMore: (result.results || []).length === limit,
  };
}

async function getInvestigationReport(env, candidateId) {
  if (!candidateId || candidateId.length > 120) throw new ApiError(400, 'A valid candidateId is required.');
  const row = await env.DB.prepare(
    `SELECT candidate_id, candidate_json, status, report_json, error_message,
            attempt_count, created_at, updated_at, analyzed_at
       FROM investigations WHERE candidate_id = ?`,
  ).bind(candidateId).first();
  if (!row) throw new ApiError(404, 'Investigation was not found.');
  const history = await env.DB.prepare(
    `SELECT status, report_json, attempt_count, created_at
       FROM investigation_history WHERE candidate_id = ? ORDER BY created_at DESC, id DESC`,
  ).bind(candidateId).all();
  return {
    ...mapDatabaseRow(row),
    history: (history.results || []).map((entry) => ({
      status: entry.status,
      report: JSON.parse(entry.report_json),
      attemptCount: entry.attempt_count,
      createdAt: entry.created_at,
    })),
  };
}

async function retryInvestigation(env, body, user) {
  if (!isQueueOwner(user, env.INVESTIGATION_OWNER_UID)) {
    throw new ApiError(403, 'Only the configured owner can retry an investigation.');
  }
  const candidateId = typeof body.candidateId === 'string' ? body.candidateId : '';
  const result = await env.DB.prepare(
    `UPDATE investigations
        SET status = 'pending', error_message = NULL, updated_at = ?, lease_until = NULL
      WHERE candidate_id = ? AND status IN ('error', 'uncertain')
      RETURNING candidate_id`,
  ).bind(Math.floor(Date.now() / 1000), candidateId).first();
  if (!result) throw new ApiError(409, 'Only an error or uncertain investigation can be retried.');
  await env.DB.prepare(
    `INSERT INTO investigation_queue_control (id, enabled, updated_at) VALUES (1, 1, ?)
     ON CONFLICT(id) DO UPDATE SET enabled = 1, updated_at = excluded.updated_at`,
  ).bind(Math.floor(Date.now() / 1000)).run();
  return { candidateId, status: 'pending' };
}

async function startQueue(env, user) {
  if (!isQueueOwner(user, env.INVESTIGATION_OWNER_UID)) {
    throw new ApiError(403, 'Only the configured owner can start the AI investigation queue.');
  }
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO investigation_queue_control (id, enabled, updated_at) VALUES (1, 1, ?)
     ON CONFLICT(id) DO UPDATE SET enabled = 1, updated_at = excluded.updated_at`,
  ).bind(now).run();
  return { active: true };
}

function projectToWebMercator(longitude, latitude) {
  const x = (longitude * Math.PI * EARTH_RADIUS_METERS) / 180;
  const clampedLatitude = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const y =
    EARTH_RADIUS_METERS *
    Math.log(Math.tan(Math.PI / 4 + (clampedLatitude * Math.PI) / 360));
  return { x, y };
}

function imageRequestUrl(candidate) {
  const center = projectToWebMercator(candidate.longitude, candidate.latitude);
  const width = candidate.dimensions.widthMeters;
  const length = candidate.dimensions.lengthMeters;
  const halfSize = Math.max(60, Math.min(250, Math.max(width, length) * 0.75 + 35));
  const parameters = new URLSearchParams({
    bbox: [center.x - halfSize, center.y - halfSize, center.x + halfSize, center.y + halfSize].join(','),
    bboxSR: '3857',
    imageSR: '3857',
    size: '512,512',
    format: 'jpg',
    f: 'image',
  });
  return `${IMAGE_SERVICE}?${parameters}`;
}

async function readBoundedBody(response, limit) {
  if (!response.body) throw new Error('Imagery service returned an empty response.');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error(`Imagery response exceeded the ${limit}-byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function readBoundedText(response, limit) {
  const bytes = await readBoundedBody(response, limit);
  return new TextDecoder().decode(bytes);
}

async function fetchAerialImage(candidate) {
  const url = imageRequestUrl(candidate);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(12_000),
    headers: { Accept: 'image/jpeg' },
  });
  if (!response.ok) {
    if (response.status < 500) return { available: false, reason: `USGS NAIP imagery returned HTTP ${response.status}.`, url };
    throw new Error(`USGS NAIP imagery returned HTTP ${response.status}.`);
  }
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'image/jpeg' && contentType !== 'image/png' && contentType !== 'image/webp') {
    return { available: false, reason: 'USGS NAIP imagery returned no usable image for this location.', url };
  }
  const bytes = await readBoundedBody(response, IMAGE_SIZE_LIMIT);
  if (!bytes.length) return { available: false, reason: 'USGS NAIP imagery was empty.', url };
  return { available: true, bytes, contentType, url };
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function distanceMeters(first, second) {
  const latitudeRadians = (first.latitude * Math.PI) / 180;
  const deltaLatitude = ((second.latitude - first.latitude) * Math.PI) / 180;
  const deltaLongitude = ((second.longitude - first.longitude) * Math.PI) / 180;
  const haversine =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(latitudeRadians) *
      Math.cos((second.latitude * Math.PI) / 180) *
      Math.sin(deltaLongitude / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function residentialBuilding(tags) {
  return ['house', 'detached', 'semidetached_house', 'semi_detached_house', 'terrace', 'apartments', 'residential', 'dormitory', 'bungalow'].includes(
    String(tags.building || '').toLowerCase(),
  );
}

function nonResidentialBuilding(tags) {
  return ['warehouse', 'industrial', 'commercial', 'retail', 'office', 'farm', 'barn', 'stable', 'hangar', 'church', 'school', 'hospital', 'service'].includes(
    String(tags.building || '').toLowerCase(),
  );
}

function publicFeatureDescription(element) {
  const tags = element.tags || {};
  const label = tags.name || tags.building || tags.landuse || tags.amenity || tags.shop || 'mapped feature';
  return `${element.type} ${String(label).slice(0, 80)}${tags.landuse ? `; landuse=${String(tags.landuse).slice(0, 40)}` : ''}`;
}

async function fetchPublicContext(candidate) {
  const radius = Math.max(80, Math.min(200, Math.hypot(candidate.dimensions.widthMeters, candidate.dimensions.lengthMeters) / 2 + 40));
  const query = `[out:json][timeout:8];(nwr(around:${Math.ceil(radius)},${candidate.latitude},${candidate.longitude})["building"];nwr(around:${Math.ceil(radius)},${candidate.latitude},${candidate.longitude})["landuse"];nwr(around:${Math.ceil(radius)},${candidate.latitude},${candidate.longitude})["amenity"];nwr(around:${Math.ceil(radius)},${candidate.latitude},${candidate.longitude})["shop"];);out center tags 50;`;
  const response = await fetch(OVERPASS_SERVICE, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ data: query }),
  });
  if (!response.ok) throw new Error(`OpenStreetMap Overpass returned HTTP ${response.status}.`);
  const responseText = await readBoundedText(response, PUBLIC_CONTEXT_SIZE_LIMIT);
  const responseBytes = new TextEncoder().encode(responseText).byteLength;
  const payload = JSON.parse(responseText);
  if (!Array.isArray(payload.elements)) throw new Error('OpenStreetMap Overpass returned an unexpected response.');
  const targetRadius = Math.max(20, Math.hypot(candidate.dimensions.widthMeters, candidate.dimensions.lengthMeters) / 2 + 12);
  const features = payload.elements.map((element) => {
    const latitude = Number(element.lat ?? element.center?.lat);
    const longitude = Number(element.lon ?? element.center?.lon);
    const distance = Number.isFinite(latitude) && Number.isFinite(longitude)
      ? distanceMeters(candidate, { latitude, longitude })
      : Infinity;
    return { element, distance, tags: element.tags || {} };
  }).sort((a, b) => a.distance - b.distance);
  const direct = features.filter((feature) => feature.distance <= targetRadius);
  const directResidential = direct.some((feature) => residentialBuilding(feature.tags));
  const directNonResidential = direct.some((feature) => nonResidentialBuilding(feature.tags));
  const nearbyResidential = features.some((feature) => residentialBuilding(feature.tags));
  const summaries = features.slice(0, 8).map((feature) => ({
    description: publicFeatureDescription(feature.element),
    distanceMeters: Number.isFinite(feature.distance) ? Number(feature.distance.toFixed(1)) : null,
    tags: feature.tags,
    directTargetMatch: feature.distance <= targetRadius,
  }));
  return {
    source: 'OpenStreetMap Overpass API',
    attribution: '© OpenStreetMap contributors',
    available: true,
    directResidential,
    directNonResidential,
    nearbyResidential,
    features: summaries,
    responseBytes,
    note: 'Nearby residential features are context only. Missing map features are not evidence that a site is non-residential.',
  };
}

function analysisPrompt(candidate, context) {
  const dimensions = candidate.dimensions;
  const evidence = {
    candidateId: candidate.id,
    coordinatesWgs84: {
      latitude: candidate.latitude,
      longitude: candidate.longitude,
      precision: 'Stored coordinates are rounded by the LiDAR grid; not a survey-grade footprint.',
    },
    footprint: {
      widthMeters: dimensions.widthMeters,
      lengthMeters: dimensions.lengthMeters,
      areaSquareMeters: dimensions.areaSquareMeters,
      aspectRatio: dimensions.aspectRatio,
    },
    lidar: {
      pointCount: candidate.pointCount,
      classificationCounts: candidate.classificationCounts,
      class6Count: candidate.class6Count,
      class6Share: candidate.class6Share,
      vegetationShare: candidate.vegetationShare,
      localClass2GroundCoverage: candidate.groundCoverage,
      planarElevatedCellCoverage: candidate.planarCoverage,
      medianRoofRoughnessLasZUnits: candidate.medianRoughness,
      medianGroundRelativeHeightLasZUnits: candidate.relativeHeightUnits,
      verticalUnitsAndDatum: 'Unverified; all Z and relative heights remain LAS Z units.',
      densityPointsPerSquareMeter: candidate.density,
      heuristicEvidence: candidate.evidence,
    },
    publicMapContext: context,
  };
  return `You are a conservative aerial-image investigator. The attached image is a USGS/USDA NAIP aerial crop centered on a LiDAR candidate; the candidate's approximate footprint is described in the JSON but is not drawn on the image. Treat any map tags as fallible context, and never treat nearby houses alone as proof that the target is residential. Do not infer ownership, vacancy, abandonment, occupancy, or safety. Describe only observable evidence. Classify the target as likely_non_residential, residential, not_a_building, or uncertain. Use uncertain if the image is obscured, insufficient, ambiguous, or contradictory. A non-residential class requires positive visual evidence of a commercial, industrial, agricultural, institutional, utility, or infrastructure structure. Return only one JSON object with exactly these fields: classification, confidence (number 0 to 1), description (string), positive_evidence (string array), negative_evidence (string array), lidar_observations (string array), imagery_observations (string array), rejection_reason (string or null), recommended_action (string). Confidence is your visual classification confidence, not proof.\n\nCandidate evidence JSON:\n${JSON.stringify(evidence)}`;
}

function imageryUnavailableReport(candidate, reason, imageUrl) {
  return {
    classification: 'uncertain',
    confidence: 0,
    description: 'No usable aerial image was available for visual investigation, so the structure cannot be classified from imagery.',
    positive_evidence: [],
    negative_evidence: [],
    lidar_observations: candidate.evidence,
    imagery_observations: [reason],
    rejection_reason: 'Insufficient or unavailable imagery; this is not evidence that the site is empty or not a structure.',
    recommended_action: 'Retry when USGS NAIP imagery is available.',
    imagerySource: 'USGS/USDA NAIP public-domain orthophotography',
    imageryAttribution: 'USGS, USDA, The National Map.',
    imageUrl,
    publicContext: null,
    lidarSupport: false,
    approvalThreshold: null,
  };
}

function resultWithDecision(aiReport, candidate, image, publicContext, threshold) {
  const decision = evaluateInvestigation(candidate, aiReport, threshold, publicContext);
  return {
    ...aiReport,
    rejection_reason: decision.status === 'approved' ? null : decision.reason,
    imagerySource: 'USGS/USDA National Agricultural Imagery Program (NAIP)',
    imageryAttribution: 'USGS, USDA, The National Map.',
    imageUrl: image.url,
    publicContext,
    lidarSupport: {
      supported: hasIndependentLidarSupport(candidate),
      pointCount: candidate.pointCount,
      class6Count: candidate.class6Count,
      groundCoverage: candidate.groundCoverage,
      planarCoverage: candidate.planarCoverage,
      vegetationShare: candidate.vegetationShare,
      relativeHeightUnits: candidate.relativeHeightUnits,
      verticalReference: 'Unverified; LAS Z units only.',
    },
    approvalThreshold: threshold,
    decisionReason: decision.reason,
    recommended_action: aiReport.recommended_action || (
      decision.status === 'approved' ? 'Review the approved candidate and evidence.' : 'Keep out of the normal map markers unless further evidence becomes available.'
    ),
    status: decision.status,
  };
}

function quotaExceeded(error) {
  return isQuotaExceededError(error);
}

async function updateInvestigation(env, candidateId, status, report, errorMessage = null) {
  const now = Math.floor(Date.now() / 1000);
  await persistInvestigationResult(env.DB, candidateId, status, report, errorMessage, now);
}

async function pauseQueueForQuota(env, candidateId, message) {
  const now = Math.floor(Date.now() / 1000);
  if (candidateId) {
    const report = {
      classification: 'uncertain',
      confidence: 0,
      description: 'Analysis is paused because the configured free-use budget is exhausted.',
      positive_evidence: [],
      negative_evidence: [],
      lidar_observations: [],
      imagery_observations: [],
      rejection_reason: message,
      recommended_action: 'Wait for the daily UTC reset; the candidate will remain queued.',
    };
    await updateInvestigation(env, candidateId, 'quota_paused', report, message);
  }
  await env.DB.prepare(
    `UPDATE investigations SET status = 'quota_paused', updated_at = ?
      WHERE status = 'pending'`,
  ).bind(now).run();
}

async function reserveAiBudget(env) {
  const day = utcDay();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO ai_daily_usage (day_utc, estimated_neurons, actual_neurons, call_count)
     VALUES (?, 0, 0, 0)`,
  ).bind(day).run();
  return env.DB.prepare(
    `UPDATE ai_daily_usage
        SET estimated_neurons = estimated_neurons + ?, call_count = call_count + 1
      WHERE day_utc = ?
        AND MAX(estimated_neurons, actual_neurons) + ? <= ?
      RETURNING estimated_neurons, actual_neurons, call_count`,
  ).bind(
    ESTIMATED_NEURONS_PER_CALL,
    day,
    ESTIMATED_NEURONS_PER_CALL,
    DAILY_NEURON_BUDGET,
  ).first();
}

async function addActualUsage(env, result) {
  const neurons = result?.usage?.neurons;
  if (!Number.isFinite(neurons) || neurons <= 0) return;
  await env.DB.prepare(
    `UPDATE ai_daily_usage SET actual_neurons = actual_neurons + ? WHERE day_utc = ?`,
  ).bind(Math.ceil(neurons), utcDay()).run();
}

async function stopInvestigationQueue(env, user) {
  if (!isQueueOwner(user, env.INVESTIGATION_OWNER_UID)) {
    throw new ApiError(403, 'Only the configured owner can stop the AI investigation queue.');
  }
  await persistQueueStop(env.DB, Math.floor(Date.now() / 1000));
  return { active: false };
}

async function clearForestRunnerBacklog(env, user) {
  if (!isQueueOwner(user, env.INVESTIGATION_OWNER_UID)) {
    throw new ApiError(403, 'Only the configured owner can clear old forest-runner investigations.');
  }
  return {
    active: false,
    ...(await clearPendingForestRunnerCandidates(env.DB, Math.floor(Date.now() / 1000))),
  };
}

export async function processNextCandidate(env) {
  const now = Math.floor(Date.now() / 1000);
  const dayStart = Math.floor(Date.parse(`${utcDay()}T00:00:00Z`) / 1000);
  const leaseId = crypto.randomUUID();
  const lease = await acquireProcessingLock(env.DB, leaseId, now, now + LOCK_SECONDS);
  if (!lease) return { status: 'busy' };

  try {
    const queueControl = await env.DB.prepare(
      'SELECT enabled FROM investigation_queue_control WHERE id = 1',
    ).first();
    if (!isQueueEnabled(queueControl)) return { status: 'stopped' };

    const recoveryRows = await env.DB.prepare(
      `SELECT candidate_id, status, lease_until, updated_at FROM investigations
        WHERE status IN ('analyzing', 'quota_paused')`,
    ).all();
    const recovered = (recoveryRows.results || []).filter(
      (row) => recoverQueueStatus(row, now, dayStart) === 'pending',
    );
    if (recovered.length) {
      await env.DB.batch(
        recovered.map((row) =>
          env.DB.prepare(
            `UPDATE investigations
                SET status = 'pending', lease_until = NULL, updated_at = ?
              WHERE candidate_id = ? AND status = ?`,
          ).bind(now, row.candidate_id, row.status),
        ),
      );
    }
    const row = await env.DB.prepare(
      `SELECT candidate_id, candidate_json FROM investigations
        WHERE status = 'pending' ORDER BY created_at, candidate_id LIMIT 1`,
    ).first();
    if (!row) return { status: 'idle' };
    const candidate = JSON.parse(row.candidate_json);
    const claimed = await env.DB.prepare(
      `UPDATE investigations
          SET status = 'analyzing', attempt_count = attempt_count + 1,
              updated_at = ?, lease_until = ?
        WHERE candidate_id = ? AND status = 'pending'
        RETURNING candidate_id, candidate_json, attempt_count`,
    ).bind(now, now + LOCK_SECONDS, row.candidate_id).first();
    if (!claimed) return { status: 'busy' };
    const processingStartedAt = Date.now();
    let imageBytes = 0;
    let publicContextBytes = 0;
    let modelUsed = false;

    try {
      const image = await fetchAerialImage(candidate);
      if (!image.available) {
        const report = imageryUnavailableReport(candidate, image.reason, image.url);
        report.processingSeconds = Number(((Date.now() - processingStartedAt) / 1000).toFixed(2));
        report.imageBytes = 0;
        report.publicContextBytes = 0;
        report.aiModel = null;
        await updateInvestigation(env, candidate.id, 'uncertain', report);
        return { status: 'processed', candidateId: candidate.id, result: 'uncertain' };
      }
      imageBytes = image.bytes.byteLength;

      let publicContext;
      try {
        publicContext = await fetchPublicContext(candidate);
      } catch (error) {
        publicContext = {
          source: 'OpenStreetMap Overpass API',
          available: false,
          directResidential: false,
          directNonResidential: false,
          nearbyResidential: false,
          features: [],
          responseBytes: 0,
          attribution: '© OpenStreetMap contributors',
          note: `Public map context unavailable (${error.message}); missing map data is not evidence of non-residential use.`,
        };
      }
      publicContextBytes = publicContext.responseBytes || 0;

      const budget = await reserveAiBudget(env);
      if (!budget) {
        await pauseQueueForQuota(env, candidate.id, 'The application daily free-use budget has been reached.');
        return { status: 'quota_paused', candidateId: candidate.id };
      }
      const threshold = configuredApprovalThreshold(env.AI_APPROVAL_CONFIDENCE);
      const prompt = analysisPrompt(candidate, publicContext);
      modelUsed = true;
      const aiResult = assertAiRunSucceeded(await env.AI.run(AI_MODEL, {
        messages: [
          { role: 'system', content: 'Return a single valid JSON object, without Markdown fences.' },
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: { url: `data:${image.contentType};base64,${bytesToBase64(image.bytes)}` },
              },
            ],
          },
        ],
        max_tokens: 512,
        temperature: 0.1,
        seed: 42017,
      }));
      await addActualUsage(env, aiResult);
      const aiReport = parseModelJson(aiResult);
      const report = resultWithDecision(aiReport, candidate, image, publicContext, threshold);
      report.processingSeconds = Number(((Date.now() - processingStartedAt) / 1000).toFixed(2));
      report.imageBytes = imageBytes;
      report.publicContextBytes = publicContextBytes;
      report.aiModel = AI_MODEL;
      await updateInvestigation(env, candidate.id, report.status, report);
      return { status: 'processed', candidateId: candidate.id, result: report.status };
    } catch (error) {
      if (quotaExceeded(error)) {
        await pauseQueueForQuota(env, candidate.id, error.message);
        return { status: 'quota_paused', candidateId: candidate.id };
      }
      const report = {
        classification: 'uncertain',
        confidence: 0,
        description: 'The investigation could not be completed. No classification or approval was inferred.',
        positive_evidence: [],
        negative_evidence: [],
        lidar_observations: candidate.evidence,
        imagery_observations: [],
        rejection_reason: error.message,
        recommended_action: 'Retry this investigation when the service is available.',
        error: error.message,
        processingSeconds: Number(((Date.now() - processingStartedAt) / 1000).toFixed(2)),
        imageBytes,
        publicContextBytes,
        aiModel: modelUsed ? AI_MODEL : null,
      };
      await updateInvestigation(env, candidate.id, 'error', report, error.message);
      return { status: 'error', candidateId: candidate.id, message: error.message };
    }
  } finally {
    await releaseProcessingLock(env.DB, leaseId);
  }
}

async function handleGet(request, env, user) {
  const url = new URL(request.url);
  const action = url.searchParams.get('action') || 'status';
  if (action === 'status') return { ...(await readSummary(env)) };
  if (action === 'list') return { ...(await readSummary(env)), ...(await listInvestigations(env, url)) };
  if (action === 'approved') return listInvestigations(env, url, true);
  if (action === 'report') return getInvestigationReport(env, url.searchParams.get('candidateId'));
  throw new ApiError(400, `Unsupported investigation action: ${action}.`);
}

async function handlePost(request, env, user) {
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > 256_000) throw new ApiError(413, 'Investigation request is too large.');
  let body;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, 'Request body must be valid JSON.');
  }
  if (body.action === 'queue') return queueCandidates(env, body);
  if (body.action === 'retry') return retryInvestigation(env, body, user);
  if (body.action === 'start') {
    if (!env.AI) throw new ApiError(503, 'Workers AI binding AI is not configured.');
    return startQueue(env, user);
  }
  if (body.action === 'stop') return stopInvestigationQueue(env, user);
  if (body.action === 'clearForestRunnerBacklog') {
    return clearForestRunnerBacklog(env, user);
  }
  throw new ApiError(400, `Unsupported investigation action: ${String(body.action)}.`);
}

export async function onRequest({ request, env }) {
  try {
    if (!env.DB) throw new ApiError(503, 'D1 binding DB is not configured.');
    const user = await authenticate(request, env);
    let result;
    if (request.method === 'GET') {
      result = await handleGet(request, env, user);
    } else if (request.method === 'POST') {
      result = await handlePost(request, env, user);
    } else {
      throw new ApiError(405, 'Method not allowed.');
    }
    return jsonResponse(result);
  } catch (error) {
    if (error instanceof ApiError) return jsonResponse({ error: error.message }, error.status);
    console.error('Investigation API failed.', error);
    return jsonResponse({ error: error.message || 'Investigation API failed.' }, 500);
  }
}
