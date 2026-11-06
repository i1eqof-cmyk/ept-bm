import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-draw';
import 'leaflet-draw/dist/leaflet.draw.css';
import './scanner.css';
import { getCoverageMessage, discoverDatasets } from './discovery.js';
import { googleEarthUrl } from './google-earth.js';
import {
  makeDisplaySample,
  scanDatasets,
} from './scanner-engine.js';
import {
  getCandidateMatch,
  getScanIdToken,
  isReviewOwner,
  listenToCandidateReviews,
  listenToOwnerAuth,
  prepareScannedCandidates,
  saveScannedCandidates,
  removePreviouslyRemovedCandidates,
  setAllCandidateRecordsRemoved,
  setCandidateRemoved,
  signInOwnerWithGoogle,
  signOutOwner,
} from './candidate-reviews.js';
import {
  canManuallyRetry,
} from '../functions/_lib/queue-control.js';

const elements = {
  searchForm: document.querySelector('#search-form'),
  searchInput: document.querySelector('#location-search'),
  clear: document.querySelector('#clear-selection'),
  scan: document.querySelector('#scan-area'),
  cancel: document.querySelector('#cancel-scan'),
  statusTitle: document.querySelector('#status-title'),
  statusDetail: document.querySelector('#status-detail'),
  coverageBadge: document.querySelector('#coverage-badge'),
  progress: document.querySelector('#scan-progress'),
  viewerTitle: document.querySelector('#viewer-title'),
  viewerCount: document.querySelector('#viewer-count'),
  canvas: document.querySelector('#point-canvas'),
  candidateTitle: document.querySelector('#candidate-title'),
  candidateSummary: document.querySelector('#candidate-summary'),
  candidateList: document.querySelector('#candidate-list'),
  diagnostics: document.querySelector('#diagnostics-list'),
  ownerSignIn: document.querySelector('#owner-sign-in'),
  ownerSignOut: document.querySelector('#owner-sign-out'),
  ownerAccountStatus: document.querySelector('#owner-account-status'),
  ownerPanelStatus: document.querySelector('#owner-panel-status'),
  removedCandidateList: document.querySelector('#removed-candidate-list'),
  loadMoreRemovedMarkers: document.querySelector('#load-more-removed-markers'),
  investigationServiceState: document.querySelector('#investigation-service-state'),
  investigationStatus: document.querySelector('#investigation-status'),
  startInvestigationQueue: document.querySelector('#start-investigation-queue'),
  stopInvestigationQueue: document.querySelector('#stop-investigation-queue'),
  clearAllInvestigations: document.querySelector('#clear-all-investigations'),
  clearAllHelp: document.querySelector('#clear-all-help'),
  investigationCronStatus: document.querySelector('#investigation-cron-status'),
  investigationCounts: document.querySelector('#investigation-counts'),
  investigationQuota: document.querySelector('#investigation-quota'),
  investigationError: document.querySelector('#investigation-error'),
  investigationHistory: document.querySelector('#investigation-history'),
  loadMoreInvestigations: document.querySelector('#load-more-investigations'),
};

const diagnostics = {
  requestCount: 0,
  requestLog: [],
  downloadedBytes: 0,
};
const MAX_SCAN_SIDE_METERS = 2000;
const LOCAL_PENDING_QUEUE_KEY = 'lidar-investigation-pending-v1';
let candidateReviews = [];
let candidateSubmissions = [];
let reviewStoreReady = false;
let reviewStoreError = null;
let currentUser = null;
let hasCandidateScan = false;
let candidateStoreUnavailable = false;
let reviewSync = null;
let removedReviewLimit = 50;
let approvedCandidates = [];
let loadedApprovedCount = null;
let investigationSummary = null;
let investigationEntries = [];
let queueSyncRunning = false;
let clearAllInProgress = false;
let queueRetryTimer = null;
let investigationRefreshRunning = false;
const queuedCandidateIds = new Set();
const pendingQueueCandidates = new Map();
const selectionGroup = L.featureGroup();
const class6Group = L.featureGroup();
const roofGroup = L.featureGroup();
const baseStreet = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
});
const baseSatellite = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  {
    maxZoom: 19,
    attribution:
      'Tiles &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  },
);
const map = L.map('map', {
  center: [20, 0],
  zoom: 2,
  layers: [baseSatellite, selectionGroup, class6Group, roofGroup],
  zoomControl: true,
});
L.control
  .layers(
    { Streets: baseStreet, Satellite: baseSatellite },
    {
      'Selection boundary': selectionGroup,
      'AI-approved Class 6 detections': class6Group,
      'AI-approved non-Class-6 roof candidates': roofGroup,
    },
    { collapsed: true },
  )
  .addTo(map);
L.control.scale({ metric: true, imperial: true, maxWidth: 140 }).addTo(map);

let selectionLayer = null;
let selectedBounds = null;
let scanController = null;
let renderer = null;
let tiles = [];
let searchMarker = null;
let searchPending = false;
let displayedPointCount = 0;
let scanHeartbeat = null;

function formatCount(value) {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

async function investigationApi(method, parameters = {}) {
  const token = await getScanIdToken();
  const url = new URL('/api/investigations', window.location.origin);
  const options = {
    method,
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  };
  if (method === 'GET') {
    for (const [key, value] of Object.entries(parameters)) {
      url.searchParams.set(key, String(value));
    }
  } else {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(parameters);
  }
  const response = await fetch(url, options);
  let result;
  try {
    result = await response.json();
  } catch {
    result = null;
  }
  if (!response.ok) {
    throw new Error(result?.error || `Investigation service returned HTTP ${response.status}.`);
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(
      'Investigation API returned an empty or non-JSON response. Configure Cloudflare Pages Functions; a plain Vite server does not provide this API.',
    );
  }
  return result;
}

function setInvestigationError(message) {
  elements.investigationError.textContent = message;
  elements.investigationError.hidden = !message;
  if (message) {
    elements.investigationServiceState.textContent = 'Service error';
    elements.investigationServiceState.dataset.state = 'error';
  }
}

function persistPendingQueueLocally() {
  try {
    localStorage.setItem(
      LOCAL_PENDING_QUEUE_KEY,
      JSON.stringify([...pendingQueueCandidates.values()]),
    );
  } catch (error) {
    setInvestigationError(
      `Could not persist the offline queue in this browser: ${error.message}. Firebase storage or the Cloudflare queue must be available before leaving this page.`,
    );
  }
}

function restorePendingQueueLocally() {
  let saved;
  try {
    saved = localStorage.getItem(LOCAL_PENDING_QUEUE_KEY);
  } catch (error) {
    setInvestigationError(`Could not access the browser's saved investigation queue: ${error.message}.`);
    return;
  }
  if (!saved) return;
  try {
    const records = JSON.parse(saved);
    if (!Array.isArray(records)) throw new Error('Stored queue is not an array.');
    for (const candidate of records) {
      if (candidate?.id && typeof candidate.id === 'string') {
        pendingQueueCandidates.set(candidate.id, candidate);
      }
    }
    if (pendingQueueCandidates.size) {
      elements.investigationStatus.textContent =
        `${formatCount(pendingQueueCandidates.size)} locally saved candidate(s) are waiting to synchronize.`;
    }
  } catch (error) {
    setInvestigationError(
      `The browser's saved investigation queue could not be read: ${error.message}. The damaged local record was left untouched.`,
    );
  }
}

function queueCandidateRecords(candidates) {
  if (clearAllInProgress) return Promise.resolve();
  const activeCandidates = reviewStoreReady
    ? removePreviouslyRemovedCandidates(candidates, candidateReviews)
    : candidates;
  if (reviewStoreReady) {
    for (const [id, candidate] of pendingQueueCandidates) {
      if (!removePreviouslyRemovedCandidates([candidate], candidateReviews).length) {
        pendingQueueCandidates.delete(id);
      }
    }
  }
  for (const candidate of activeCandidates) {
    if (
      candidate?.id &&
      !queuedCandidateIds.has(candidate.id) &&
      !pendingQueueCandidates.has(candidate.id)
    ) {
      pendingQueueCandidates.set(candidate.id, candidate);
    }
  }
  if (pendingQueueCandidates.size || reviewStoreReady) persistPendingQueueLocally();
  return pendingQueueCandidates.size
    ? synchronizeInvestigationQueue()
    : Promise.resolve();
}

async function synchronizeInvestigationQueue() {
  if (clearAllInProgress || queueSyncRunning || !reviewStoreReady || !pendingQueueCandidates.size) return;
  queueSyncRunning = true;
  if (queueRetryTimer) {
    window.clearTimeout(queueRetryTimer);
    queueRetryTimer = null;
  }
  try {
    while (pendingQueueCandidates.size && !clearAllInProgress) {
      const batch = [...pendingQueueCandidates.values()].slice(0, 50);
      await investigationApi('POST', { action: 'queue', candidates: batch });
      for (const candidate of batch) {
        pendingQueueCandidates.delete(candidate.id);
        queuedCandidateIds.add(candidate.id);
      }
      persistPendingQueueLocally();
    }
    setInvestigationError('');
    elements.investigationServiceState.textContent = 'Queue connected';
    elements.investigationServiceState.dataset.state = 'ready';
    await refreshInvestigationData();
  } catch (error) {
    setInvestigationError(
      `Could not persist ${pendingQueueCandidates.size} candidate(s) to the investigation queue: ${error.message}. They remain in Firebase/local scan evidence and will be retried automatically.`,
    );
    queueRetryTimer = window.setTimeout(() => {
      queueRetryTimer = null;
      void synchronizeInvestigationQueue();
    }, 30_000);
  } finally {
    queueSyncRunning = false;
  }
}

function countText(value) {
  return formatCount(Number.isFinite(value) ? value : 0);
}

function renderInvestigationCounts(summary) {
  const owner = isReviewOwner(currentUser);
  elements.startInvestigationQueue.hidden = !owner;
  elements.startInvestigationQueue.disabled = summary.queue.active;
  elements.startInvestigationQueue.textContent = summary.queue.active
    ? 'Queue started · resumes automatically'
    : 'Start investigation queue';
  elements.stopInvestigationQueue.hidden = !owner;
  elements.stopInvestigationQueue.disabled = !summary.queue.active;
  elements.clearAllInvestigations.disabled =
    !owner || !reviewStoreReady || candidateStoreUnavailable || clearAllInProgress;
  elements.clearAllHelp.textContent = owner
    ? 'Clears all D1 investigation records and attempt history, stops the queue, and hides current candidate markers. Original Firebase scan evidence and today’s AI usage budget are retained.'
    : 'Sign in with the owner Google account in the Owner review panel to clear investigations and map markers.';
  const cron = summary.queue.cron;
  if (!cron) {
    elements.investigationCronStatus.textContent =
      'No scheduled Worker run is recorded yet. Deploy the independent Cron Worker and apply the D1 schema.';
  } else {
    const finished = cron.lastFinishedAt
      ? new Date(cron.lastFinishedAt * 1000).toLocaleString()
      : 'still running';
    const candidate = cron.lastCandidateId ? ` · candidate ${cron.lastCandidateId}` : '';
    const failure = cron.lastError ? ` · error: ${cron.lastError}` : '';
    elements.investigationCronStatus.textContent =
      `Last Cron run: ${finished} · ${cron.lastStatus || 'unknown'} · ${countText(cron.invocationCount)} total runs${candidate}${failure}`;
  }
  elements.investigationCounts.replaceChildren();
  for (const [key, label] of [
    ['total', 'Detected total'],
    ['pending', 'Waiting'],
    ['analyzing', 'Analyzing'],
    ['approved', 'Approved'],
    ['rejected', 'Rejected'],
    ['uncertain', 'Uncertain'],
    ['quota_paused', 'Quota paused'],
    ['error', 'Errors'],
  ]) {
    const value = key === 'total' ? summary.total : summary.counts[key];
    const item = document.createElement('div');
    item.className = 'investigation-count';
    const count = document.createElement('strong');
    count.textContent = countText(value);
    const name = document.createElement('span');
    name.textContent = label;
    item.append(count, name);
    elements.investigationCounts.append(item);
  }
  const quota = summary.quota;
  elements.investigationQuota.textContent =
    `${countText(quota.estimatedCallsRemaining)} estimated review(s) remain in this app's daily free-use budget ` +
    `(${countText(quota.estimatedNeuronsRemaining)} of ${countText(quota.dailyBudgetNeurons)} reserved Neurons). ` +
    `Budget resets at ${new Date(Number(quota.resetsAtUtc) * 1000).toISOString()}. ` +
    'Cloudflare free allocation is shared with other workloads on your account.';
  if (summary.counts.quota_paused) {
    elements.investigationStatus.textContent =
      'The queue is safely paused at its daily AI budget. Candidates remain stored and resume after the UTC reset.';
    elements.investigationServiceState.textContent = 'Daily budget reached';
    elements.investigationServiceState.dataset.state = 'paused';
  } else if (!summary.queue.active && summary.counts.pending) {
    elements.investigationStatus.textContent =
      'The backlog is saved. The owner can start it once; candidates will then process sequentially.';
    elements.investigationServiceState.textContent = 'Queue not started';
    elements.investigationServiceState.dataset.state = 'ready';
  } else if (summary.counts.analyzing) {
    elements.investigationStatus.textContent = 'A candidate is being reviewed. Processing is sequential.';
  } else if (summary.counts.pending) {
    elements.investigationStatus.textContent =
      `${countText(summary.counts.pending)} candidate(s) are waiting for sequential review.`;
  } else {
    elements.investigationStatus.textContent =
      'All queued candidates have a saved investigation result. New scans and older Firebase records are synchronized automatically.';
  }
  if (elements.investigationError.hidden && !summary.counts.quota_paused) {
    if (!summary.queue.active) {
      elements.investigationServiceState.textContent = 'Queue stopped';
      elements.investigationServiceState.dataset.state = 'ready';
    } else if (summary.queue.cron?.lastStatus === 'failed') {
      elements.investigationServiceState.textContent = 'Cron execution error';
      elements.investigationServiceState.dataset.state = 'error';
    } else if (!summary.queue.cron) {
      elements.investigationServiceState.textContent = 'Awaiting Cron Worker';
      elements.investigationServiceState.dataset.state = 'ready';
    } else {
      elements.investigationServiceState.textContent = 'Cron Worker connected';
      elements.investigationServiceState.dataset.state = 'ready';
    }
  }
}

function appendReportList(container, heading, entries) {
  if (!Array.isArray(entries) || !entries.length) return;
  const title = document.createElement('strong');
  title.textContent = heading;
  const list = document.createElement('ul');
  for (const detail of entries) {
    const item = document.createElement('li');
    item.textContent = detail;
    list.append(item);
  }
  container.append(title, list);
}

function renderInvestigationReport(entry, body) {
  const candidate = entry.candidate;
  const report = entry.report;
  const dimensions = candidate.dimensions || {};
  const height = candidate.relativeHeightUnits;
  const measurements = document.createElement('p');
  measurements.textContent =
    `${candidate.latitude.toFixed(6)}, ${candidate.longitude.toFixed(6)} · ` +
    `${Number.isFinite(dimensions.widthMeters) && Number.isFinite(dimensions.lengthMeters) ? `${dimensions.widthMeters.toFixed(1)} × ${dimensions.lengthMeters.toFixed(1)} m` : 'dimensions unavailable'} · ` +
    `${countText(candidate.pointCount)} LiDAR points · relative height ${Number.isFinite(height) ? `${height.toFixed(2)} LAS Z units` : 'unavailable'} (vertical reference unverified).`;
  body.append(measurements);
  const classificationCounts = candidate.classificationCounts || {};
  const classifications = document.createElement('p');
  classifications.textContent = `LiDAR classification counts: ${Object.entries(classificationCounts)
    .map(([classification, count]) => `${classification === 'other' ? 'other' : `Class ${classification}`} ${countText(count)}`)
    .join(' · ') || 'unavailable'}.`;
  body.append(classifications);
  appendReportList(body, 'LiDAR evidence', candidate.evidence);
  if (!report) {
    const state = document.createElement('p');
    state.textContent =
      entry.status === 'analyzing'
        ? 'Investigation is currently running.'
        : 'No investigation report has been produced yet.';
    body.append(state);
    return;
  }

  const summary = document.createElement('p');
  summary.textContent =
    `${report.classification || 'unclassified'} · AI confidence ${Number.isFinite(report.confidence) ? `${Math.round(report.confidence * 100)}%` : 'unavailable'}. ` +
    `${report.description || ''}`;
  body.append(summary);
  const processing = document.createElement('p');
  const processingDetails = [
    Number.isFinite(report.processingSeconds)
      ? `Processing time ${report.processingSeconds.toFixed(2)} s`
      : null,
    Number.isFinite(report.imageBytes)
      ? `aerial image payload ${formatBytes(report.imageBytes)}`
      : null,
    Number.isFinite(report.publicContextBytes)
      ? `OpenStreetMap response payload ${formatBytes(report.publicContextBytes)}`
      : null,
    report.aiModel ? `model ${report.aiModel}` : null,
  ].filter(Boolean);
  if (processingDetails.length) {
    processing.textContent = processingDetails.join(' · ');
    body.append(processing);
  }
  if (report.rejection_reason) {
    const reason = document.createElement('p');
    reason.textContent = `Decision reason: ${report.rejection_reason}`;
    body.append(reason);
  }
  appendReportList(body, 'Positive evidence', report.positive_evidence);
  appendReportList(body, 'Negative evidence', report.negative_evidence);
  appendReportList(body, 'LiDAR observations', report.lidar_observations);
  appendReportList(body, 'Imagery observations', report.imagery_observations);
  const context = report.publicContext;
  if (context?.features?.length) {
    appendReportList(
      body,
      'Nearby OpenStreetMap features (not proof on their own)',
      context.features.map((feature) => `${feature.description} · ${feature.distanceMeters ?? 'unknown'} m`),
    );
    if (context.attribution) {
      const attribution = document.createElement('p');
      attribution.textContent = context.attribution;
      body.append(attribution);
    }
  } else if (context?.note) {
    const publicContext = document.createElement('p');
    publicContext.textContent = context.note;
    body.append(publicContext);
  }
  if (report.imagerySource) {
    const source = document.createElement('p');
    source.textContent = `Imagery source: ${report.imagerySource}${report.imageryAttribution ? ` · ${report.imageryAttribution}` : ''}`;
    body.append(source);
  }
  if (report.imageUrl) {
    const image = document.createElement('img');
    image.src = report.imageUrl;
    image.alt = `Aerial image crop for ${entry.candidateId}`;
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    body.append(image);
  }
  if (entry.error || report.error) {
    const error = document.createElement('p');
    error.textContent = `Error: ${entry.error || report.error}`;
    body.append(error);
  }
}

function addInvestigationEntry(entry) {
  const details = document.createElement('details');
  details.className = 'investigation-entry';
  const summary = document.createElement('summary');
  const title = document.createElement('span');
  title.className = 'investigation-entry-title';
  title.textContent =
    `${entry.candidateId} · ${entry.candidate.latitude.toFixed(5)}, ${entry.candidate.longitude.toFixed(5)}`;
  const status = document.createElement('span');
  status.className = 'investigation-status-chip';
  status.dataset.status = entry.status;
  status.textContent = entry.status.replace('_', ' ');
  summary.append(title, status);
  const body = document.createElement('div');
  body.className = 'investigation-entry-body';
  renderInvestigationReport(entry, body);
  details.append(summary, body);

  if (canManuallyRetry(entry.status)) {
    const actions = document.createElement('div');
    actions.className = 'investigation-entry-actions';
    if (isReviewOwner(currentUser)) {
      const retry = document.createElement('button');
      retry.className = 'secondary-button';
      retry.type = 'button';
      retry.textContent = 'Retry investigation';
      retry.addEventListener('click', async () => {
        retry.disabled = true;
        try {
          await investigationApi('POST', { action: 'retry', candidateId: entry.candidateId });
          setInvestigationError('');
          await refreshInvestigationData();
        } catch (error) {
          setInvestigationError(`Could not retry ${entry.candidateId}: ${error.message}`);
          retry.disabled = false;
        }
      });
      actions.append(retry);
    } else {
      const note = document.createElement('span');
      note.textContent = 'Sign in with the configured owner Google account to retry.';
      actions.append(note);
    }
    body.append(actions);
  }
  if (entry.attemptCount > 1) {
    const historyButton = document.createElement('button');
    historyButton.className = 'secondary-button';
    historyButton.type = 'button';
    historyButton.textContent = 'Load previous attempts';
    historyButton.addEventListener('click', async () => {
      historyButton.disabled = true;
      try {
        const result = await investigationApi('GET', {
          action: 'report',
          candidateId: entry.candidateId,
        });
        for (const attempt of result.history.slice(1)) {
          const previous = document.createElement('p');
          previous.textContent =
            `Attempt ${attempt.attemptCount} (${attempt.status}): ${attempt.report.description || attempt.report.rejection_reason || 'No description'}`;
          body.append(previous);
        }
        historyButton.remove();
      } catch (error) {
        setInvestigationError(`Could not load previous attempts: ${error.message}`);
        historyButton.disabled = false;
      }
    });
    body.append(historyButton);
  }
  elements.investigationHistory.append(details);
}

function renderInvestigationHistory() {
  elements.investigationHistory.replaceChildren();
  if (!investigationEntries.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No candidate investigations have been recorded yet.';
    elements.investigationHistory.append(empty);
    return;
  }
  for (const entry of investigationEntries) addInvestigationEntry(entry);
}

function approvedMarkerRecords(result) {
  return result.items.map((entry) => ({
    ...entry.candidate,
    investigationReport: entry.report,
  }));
}

async function loadApprovedCandidates(expectedCount) {
  const loaded = [];
  let offset = 0;
  let page;
  do {
    page = await investigationApi('GET', { action: 'approved', limit: 500, offset });
    loaded.push(...approvedMarkerRecords(page));
    offset += page.items.length;
  } while (page.hasMore);
  approvedCandidates = loaded;
  loadedApprovedCount = expectedCount;
  if (loaded.length !== expectedCount) {
    elements.investigationStatus.textContent =
      `Loaded ${formatCount(loaded.length)} of ${formatCount(expectedCount)} approved investigation record(s); refresh to retry if the counts differ.`;
  }
  renderCandidateLayers();
  if (!candidateStoreUnavailable) {
    showCandidates(approvedCandidates, approvedCandidates.length);
  }
}

async function refreshInvestigationData() {
  if (investigationRefreshRunning) return;
  investigationRefreshRunning = true;
  try {
    const data = await investigationApi('GET', { action: 'list', limit: 25, offset: 0 });
    investigationSummary = data;
    renderInvestigationCounts(data);
    const older = investigationEntries.slice(25);
    const merged = new Map(data.items.map((entry) => [entry.candidateId, entry]));
    for (const entry of older) {
      if (!merged.has(entry.candidateId)) merged.set(entry.candidateId, entry);
    }
    investigationEntries = [...merged.values()];
    elements.loadMoreInvestigations.hidden = data.total <= investigationEntries.length;
    renderInvestigationHistory();
    if (loadedApprovedCount !== data.counts.approved) {
      await loadApprovedCandidates(data.counts.approved);
    }
    setInvestigationError('');
  } catch (error) {
    setInvestigationError(
      `Investigation API is unavailable: ${error.message}. Configure Pages Functions with D1 and Workers AI bindings; unapproved candidates remain hidden.`,
    );
    elements.investigationServiceState.textContent = 'Backend not ready';
    elements.investigationServiceState.dataset.state = 'error';
  } finally {
    investigationRefreshRunning = false;
  }
}

async function loadMoreInvestigations() {
  elements.loadMoreInvestigations.disabled = true;
  try {
    const page = await investigationApi('GET', {
      action: 'list',
      limit: 25,
      offset: investigationEntries.length,
    });
    const existing = new Set(investigationEntries.map((entry) => entry.candidateId));
    investigationEntries.push(...page.items.filter((entry) => !existing.has(entry.candidateId)));
    elements.loadMoreInvestigations.hidden = !page.hasMore;
    renderInvestigationHistory();
  } catch (error) {
    setInvestigationError(`Could not load older investigations: ${error.message}`);
  } finally {
    elements.loadMoreInvestigations.disabled = false;
  }
}

function updateStatus(title, detail) {
  elements.statusTitle.textContent = title;
  elements.statusDetail.textContent = detail;
}

function setCoverageStatus(label, state) {
  elements.coverageBadge.textContent = label;
  elements.coverageBadge.dataset.state = state;
}

function readBounds() {
  if (!selectedBounds) throw new Error('Draw a rectangle on the map first.');
  const rawBounds = {
    west: selectedBounds.getWest(),
    south: selectedBounds.getSouth(),
    east: selectedBounds.getEast(),
    north: selectedBounds.getNorth(),
  };
  if (
    !Object.values(rawBounds).every(Number.isFinite) ||
    rawBounds.west >= rawBounds.east ||
    rawBounds.south >= rawBounds.north
  ) {
    throw new Error('The drawn rectangle has invalid geographic coordinates. Clear it and draw it again.');
  }
  const maxLatitude = 85.0511287798066;
  if (rawBounds.south < -maxLatitude || rawBounds.north > maxLatitude) {
    throw new Error(
      `The rectangle must stay between ${(-maxLatitude).toFixed(3)}° and ${maxLatitude.toFixed(3)}° latitude.`,
    );
  }

  const longitudeCenter = (rawBounds.west + rawBounds.east) / 2;
  const worldOffset = 360 * Math.floor((longitudeCenter + 180) / 360);
  const bounds = {
    ...rawBounds,
    west: rawBounds.west - worldOffset,
    east: rawBounds.east - worldOffset,
  };
  if (bounds.west < -180 || bounds.east > 180) {
    throw new Error(
      'This rectangle crosses the 180° dateline. Draw a smaller rectangle entirely on one side of it.',
    );
  }
  const centerLatitude = (bounds.south + bounds.north) / 2;
  const widthMeters =
    (bounds.east - bounds.west) *
    111_319.49079327358 *
    Math.cos((centerLatitude * Math.PI) / 180);
  const heightMeters = (bounds.north - bounds.south) * 111_319.49079327358;
  if (widthMeters > MAX_SCAN_SIDE_METERS || heightMeters > MAX_SCAN_SIDE_METERS) {
    throw new Error(
      `For browser memory safety, each side of a scan rectangle must be no larger than ${MAX_SCAN_SIDE_METERS.toLocaleString()} m.`,
    );
  }
  return { ...bounds, widthMeters, heightMeters };
}

function updateActions() {
  const scanning = scanController !== null;
  elements.scan.disabled = !selectedBounds || scanning || searchPending;
  elements.clear.disabled = !selectedBounds || scanning;
  elements.cancel.hidden = !scanning;
  elements.searchInput.disabled = scanning || searchPending;
  elements.searchForm.querySelector('button').disabled = scanning || searchPending;
}

function setSelection(layer) {
  if (scanController) return;
  if (selectionLayer) selectionGroup.removeLayer(selectionLayer);
  selectionLayer = layer;
  selectionGroup.addLayer(layer);
  selectedBounds = layer.getBounds();
  clearResults();
  updateActions();
  updateStatus('Area selected', `Select Scan Area to check USGS coverage and retrieve intersecting EPT nodes. Each rectangle side is limited to ${MAX_SCAN_SIDE_METERS.toLocaleString()} m; source-point limits still apply.`);
  setCoverageStatus('Not scanned', 'idle');
}

const drawControl = new L.Control.Draw({
  position: 'topright',
  draw: {
    rectangle: {
      shapeOptions: { color: '#47c7a6', weight: 2, fillOpacity: 0.08 },
      showArea: false,
    },
    polygon: false,
    polyline: false,
    circle: false,
    circlemarker: false,
    marker: false,
  },
  edit: false,
});
map.addControl(drawControl);
map.on(L.Draw.Event.CREATED, (event) => {
  setSelection(event.layer);
});

function clearResults() {
  tiles = [];
  displayedPointCount = 0;
  candidateStoreUnavailable = !reviewStoreReady || Boolean(reviewStoreError);
  renderCandidateLayers();
  elements.viewerTitle.textContent = 'Waiting for real EPT points';
  elements.viewerCount.textContent = '0 points';
  showCandidates(approvedCandidates, approvedCandidates.length);
  elements.diagnostics.replaceChildren();
  appendDiagnostic('Status', 'No scan run');
  if (renderer) renderer.clear();
}

function clearSelection() {
  if (scanController) return;
  if (selectionLayer) selectionGroup.removeLayer(selectionLayer);
  selectionLayer = null;
  selectedBounds = null;
  selectionGroup.clearLayers();
  clearResults();
  elements.progress.removeAttribute('value');
  updateActions();
  updateStatus('Choose an area on the map', 'Use the rectangle tool, then select Scan Area.');
  setCoverageStatus('Not scanned', 'idle');
}

function appendDiagnostic(label, value) {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = String(value);
  elements.diagnostics.append(dt, dd);
}

function setDiagnostics(rows) {
  elements.diagnostics.replaceChildren();
  for (const [label, value] of rows) appendDiagnostic(label, value);
}

function createPointRenderer(canvas) {
  const gl =
    canvas.getContext('webgl2', { antialias: false, alpha: false }) ||
    canvas.getContext('webgl', { antialias: false, alpha: false });
  if (!gl) throw new Error('WebGL is unavailable in this browser.');

  const vertexSource = `
    attribute vec3 a_position;
    attribute float a_class;
    uniform vec2 u_halfSize;
    uniform float u_heightRange;
    uniform float u_heightCenter;
    uniform float u_pointSize;
    varying vec3 v_color;
    void main() {
      gl_Position = vec4(
        a_position.x / u_halfSize.x,
        a_position.y / u_halfSize.y,
        clamp((a_position.z - u_heightCenter) / u_heightRange * 0.08, -0.85, 0.85),
        1.0
      );
      gl_PointSize = u_pointSize;
      float c = a_class;
      if (c == 2.0) v_color = vec3(0.89, 0.73, 0.43);
      else if (c >= 3.0 && c <= 5.0) v_color = vec3(0.55, 0.74, 0.51);
      else if (c == 6.0) v_color = vec3(0.98, 0.46, 0.36);
      else v_color = vec3(0.52, 0.72, 0.88);
    }
  `;
  const fragmentSource = `
    precision mediump float;
    varying vec3 v_color;
    void main() { gl_FragColor = vec4(v_color, 0.94); }
  `;
  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`WebGL shader compilation failed: ${message}`);
    }
    return shader;
  }
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`WebGL program link failed: ${gl.getProgramInfoLog(program)}`);
  }
  const positionAttribute = gl.getAttribLocation(program, 'a_position');
  const classAttribute = gl.getAttribLocation(program, 'a_class');
  const halfSizeUniform = gl.getUniformLocation(program, 'u_halfSize');
  const heightRangeUniform = gl.getUniformLocation(program, 'u_heightRange');
  const heightCenterUniform = gl.getUniformLocation(program, 'u_heightCenter');
  const pointSizeUniform = gl.getUniformLocation(program, 'u_pointSize');
  const positionBuffer = gl.createBuffer();
  const classBuffer = gl.createBuffer();
  let drawCount = 0;
  let halfWidth = 1;
  let halfHeight = 1;
  let zRange = 1;
  let zCenter = 0;

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    }
  }

  function draw() {
    resize();
    gl.clearColor(0.035, 0.047, 0.04, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(program);
    gl.uniform2f(halfSizeUniform, halfWidth, halfHeight);
    gl.uniform1f(heightRangeUniform, zRange);
    gl.uniform1f(heightCenterUniform, zCenter);
    gl.uniform1f(pointSizeUniform, Math.max(1, Math.min(3, window.devicePixelRatio || 1)));
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.enableVertexAttribArray(positionAttribute);
    gl.vertexAttribPointer(positionAttribute, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, classBuffer);
    gl.enableVertexAttribArray(classAttribute);
    gl.vertexAttribPointer(classAttribute, 1, gl.UNSIGNED_BYTE, false, 0, 0);
    gl.drawArrays(gl.POINTS, 0, drawCount);
  }

  function install(sample, bounds) {
    halfWidth = Math.max(1, bounds.widthMeters / 2);
    halfHeight = Math.max(1, bounds.heightMeters / 2);
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let index = 0; index < sample.count; index += 1) {
      const z = sample.positions[index * 3 + 2];
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    zCenter = Number.isFinite(minZ) ? (minZ + maxZ) / 2 : 0;
    zRange = Math.max(1, maxZ - minZ);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, sample.positions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, classBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, sample.classes, gl.DYNAMIC_DRAW);
    drawCount = sample.count;
    draw();
  }

  function clear() {
    drawCount = 0;
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, classBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(0), gl.DYNAMIC_DRAW);
    draw();
  }

  return { draw, install, clear };
}

function sampleFps(durationMs = 1000) {
  return new Promise((resolve) => {
    const intervals = [];
    let last = performance.now();
    const started = last;
    const frame = (now) => {
      renderer?.draw();
      intervals.push(now - last);
      last = now;
      if (now - started >= durationMs) {
        resolve(Number((intervals.length / ((now - started) / 1000)).toFixed(2)));
      } else {
        requestAnimationFrame(frame);
      }
    };
    requestAnimationFrame(frame);
  });
}

function refreshPointView(bounds, pointBudget) {
  if (!renderer) return;
  const sample = makeDisplaySample(tiles, pointBudget);
  renderer.install(sample, bounds);
  displayedPointCount = sample.count;
  elements.viewerCount.textContent =
    `${formatCount(tiles.reduce((sum, tile) => sum + tile.areaPoints, 0))} in-box points · ` +
    `${formatCount(sample.count)} displayed`;
}

function confidenceColor(candidate) {
  const confidence = candidate.investigationReport?.confidence || 0;
  if (confidence >= 0.95) return '#087c68';
  if (confidence >= 0.9) return '#2878b5';
  return '#e5a331';
}

function makePopup(candidate) {
  const content = document.createElement('div');
  content.className = 'candidate-popup';
  const report = candidate.investigationReport;
  const title = document.createElement('strong');
  title.textContent = `${candidate.id} · ${candidate.category}`;
  const coords = document.createElement('span');
  coords.textContent =
    `${candidate.latitude.toFixed(6)}, ${candidate.longitude.toFixed(6)}`;
  const score = document.createElement('span');
  score.textContent =
    `${report.classification} · ${Math.round(report.confidence * 100)}% AI confidence · ` +
    `LiDAR heuristic ${candidate.score}/100`;
  const description = document.createElement('span');
  description.textContent = report.description;
  content.append(title, coords, score, description);
  appendReportList(content, 'Positive evidence', report.positive_evidence);
  appendReportList(content, 'Negative evidence', report.negative_evidence);
  appendReportList(content, 'LiDAR observations', report.lidar_observations);
  appendReportList(content, 'Imagery observations', report.imagery_observations);
  if (report.imageUrl) {
    const image = document.createElement('img');
    image.src = report.imageUrl;
    image.alt = `Aerial imagery for ${candidate.id}`;
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    image.style.maxWidth = '240px';
    image.style.height = 'auto';
    content.append(image);
  }
  const actions = document.createElement('div');
  actions.className = 'candidate-popup-actions';
  const earthLink = document.createElement('a');
  earthLink.href = googleEarthUrl(candidate);
  earthLink.target = '_blank';
  earthLink.rel = 'noopener noreferrer';
  earthLink.textContent = 'View in Google Earth 3D';
  actions.append(earthLink);
  content.append(actions);
  return content;
}

function addCandidateToMap(candidate) {
  const color = confidenceColor(candidate);
  const targetGroup = candidate.class6Count > 0 ? class6Group : roofGroup;
  const rectangle = L.rectangle(
    [
      [candidate.bbox.south, candidate.bbox.west],
      [candidate.bbox.north, candidate.bbox.east],
    ],
    { color, weight: 1.5, fillColor: color, fillOpacity: 0.1 },
  );
  const marker = L.circleMarker([candidate.latitude, candidate.longitude], {
    radius: 5,
    color: '#f5f2e9',
    weight: 1,
    fillColor: color,
    fillOpacity: 0.95,
  });
  rectangle.bindPopup(makePopup(candidate));
  marker.bindPopup(makePopup(candidate));
  rectangle.addTo(targetGroup);
  marker.addTo(targetGroup);
}

function renderCandidateLayers() {
  class6Group.clearLayers();
  roofGroup.clearLayers();
  if (candidateStoreUnavailable) return;
  const visible = new Map();
  for (const candidate of approvedCandidates) {
    const review = getCandidateMatch(candidate, candidateReviews);
    if (!review?.removed) visible.set(candidate.id, candidate);
  }
  for (const candidate of visible.values()) addCandidateToMap(candidate);
}

function addCandidateRow(candidate) {
  const article = document.createElement('article');
  article.className = 'candidate-card';
  const heading = document.createElement('div');
  heading.className = 'candidate-card-heading';
  const title = document.createElement('h3');
  title.textContent = `${candidate.id} · ${candidate.category}`;
  const badge = document.createElement('span');
  badge.className = 'confidence-chip';
  const confidence = candidate.investigationReport.confidence;
  badge.dataset.confidence = confidence >= 0.95 ? 'high' : confidence >= 0.9 ? 'medium' : 'low';
  badge.textContent = `${Math.round(confidence * 100)}% AI · LiDAR ${candidate.score}/100`;
  heading.append(title, badge);
  const summary = document.createElement('p');
  summary.textContent =
    `${candidate.latitude.toFixed(6)}, ${candidate.longitude.toFixed(6)} · ` +
    `${candidate.dimensions.widthMeters.toFixed(1)} × ${candidate.dimensions.lengthMeters.toFixed(1)} m · ` +
    `${formatCount(candidate.pointCount)} points`;
  const evidence = document.createElement('ul');
  evidence.className = 'evidence-list';
  for (const detail of candidate.evidence) {
    const item = document.createElement('li');
    item.textContent = detail;
    evidence.append(item);
  }
  const height = document.createElement('p');
  height.className = 'candidate-height';
  height.textContent =
    candidate.relativeHeightUnits === null
      ? 'Ground-relative height: not estimated (no nearby Class 2 ground samples).'
      : `Median height over nearby Class 2 ground: ${candidate.relativeHeightUnits.toFixed(2)} LAS Z units (vertical units/reference unverified).`;
  article.append(heading, summary, height, evidence);
  if (isReviewOwner(currentUser)) {
    const removeButton = document.createElement('button');
    removeButton.className = 'candidate-remove-button';
    removeButton.type = 'button';
    removeButton.textContent = 'Remove shared marker';
    removeButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      removeButton.disabled = true;
      try {
        await setCandidateRemoved(candidate, true);
        elements.ownerPanelStatus.textContent = 'Marker removed for all visitors and will stay removed after rescans.';
      } catch (error) {
        elements.ownerPanelStatus.textContent = `Could not remove marker: ${error.message}`;
        removeButton.disabled = false;
      }
    });
    article.append(removeButton);
  }
  article.addEventListener('click', () => {
    map.fitBounds(
      [
        [candidate.bbox.south, candidate.bbox.west],
        [candidate.bbox.north, candidate.bbox.east],
      ],
      { maxZoom: 19, padding: [40, 40] },
    );
  });
  elements.candidateList.append(article);
}

function showCandidates(candidates, totalCandidateCount = candidates.length) {
  approvedCandidates = candidates;
  hasCandidateScan = true;
  renderCandidateLayers();
  elements.candidateList.replaceChildren();
  const high = candidates.filter((candidate) => candidate.investigationReport?.confidence >= 0.95).length;
  const medium = candidates.filter(
    (candidate) =>
      candidate.investigationReport?.confidence >= 0.9 &&
      candidate.investigationReport.confidence < 0.95,
  ).length;
  const low = candidates.length - high - medium;
  elements.candidateTitle.textContent = totalCandidateCount
    ? `${formatCount(totalCandidateCount)} AI-approved structure(s)`
    : 'No investigations have been approved';
  elements.candidateSummary.replaceChildren();
  for (const [label, value] of [
    ['High', high],
    ['Medium', medium],
    ['Low', low],
  ]) {
    const chip = document.createElement('span');
    chip.className = 'summary-chip';
    chip.dataset.confidence = label.toLowerCase();
    chip.textContent = `${label}: ${value}`;
    elements.candidateSummary.append(chip);
  }
  if (!candidates.length) {
    const message = document.createElement('p');
    message.className = 'muted';
    message.textContent =
      'No candidate has passed both the conservative visual-confidence threshold and independent LiDAR evidence gate. Rejected, uncertain, and pending records remain in the investigation history.';
    elements.candidateList.append(message);
    return;
  }
  for (const candidate of candidates) {
    addCandidateRow(candidate);
  }
  if (totalCandidateCount > candidates.length) {
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = `${formatCount(totalCandidateCount - candidates.length)} candidate(s) have not passed investigation and remain off the map.`;
    elements.candidateList.append(note);
  }
}

function showCandidateStoreUnavailable(message) {
  approvedCandidates = [];
  loadedApprovedCount = null;
  hasCandidateScan = true;
  candidateStoreUnavailable = true;
  renderCandidateLayers();
  elements.candidateTitle.textContent = 'Shared candidate markers unavailable';
  elements.candidateSummary.replaceChildren();
  elements.candidateList.replaceChildren();
  const notice = document.createElement('p');
  notice.className = 'muted';
  notice.textContent =
    `Candidate detections are hidden so removed markers cannot reappear. ${message}`;
  elements.candidateList.append(notice);
}

function renderRemovedReviews() {
  elements.removedCandidateList.replaceChildren();
  if (!isReviewOwner(currentUser)) {
    elements.loadMoreRemovedMarkers.hidden = true;
    return;
  }
  const removed = candidateReviews
    .filter((review) => review.removed)
    .sort((first, second) => second.updatedAt - first.updatedAt);
  if (!removed.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No removed markers. Remove a candidate from the results list to add it here.';
    elements.removedCandidateList.append(empty);
    elements.loadMoreRemovedMarkers.hidden = true;
    return;
  }
  const heading = document.createElement('h3');
  heading.textContent =
    `Removed markers (${formatCount(removed.length)} total; showing ${formatCount(Math.min(removed.length, removedReviewLimit))})`;
  elements.removedCandidateList.append(heading);
  for (const review of removed.slice(0, removedReviewLimit)) {
    const row = document.createElement('div');
    row.className = 'removed-candidate-row';
    const details = document.createElement('span');
    details.textContent =
      `${review.id} · ${review.latitude.toFixed(6)}, ${review.longitude.toFixed(6)} · ` +
      `${review.confidence} ${review.score}/100`;
    const restore = document.createElement('button');
    restore.className = 'secondary-button';
    restore.type = 'button';
    restore.textContent = 'Restore';
    restore.addEventListener('click', async () => {
      restore.disabled = true;
      try {
        await setCandidateRemoved(review, false);
        elements.ownerPanelStatus.textContent = 'Marker restored for all visitors.';
      } catch (error) {
        elements.ownerPanelStatus.textContent = `Could not restore marker: ${error.message}`;
        restore.disabled = false;
      }
    });
    row.append(details, restore);
    elements.removedCandidateList.append(row);
  }
  elements.loadMoreRemovedMarkers.hidden = removed.length <= removedReviewLimit;
}

function renderOwnerPanel() {
  const owner = isReviewOwner(currentUser);
  elements.ownerSignIn.hidden = owner;
  elements.ownerSignOut.hidden = !owner;
  if (owner) {
    elements.ownerAccountStatus.textContent =
      `Owner signed in${currentUser.displayName ? ` as ${currentUser.displayName}` : ''}.`;
  } else if (currentUser?.isAnonymous) {
    elements.ownerAccountStatus.textContent =
      'Anonymous scan identity ready; your scans are saved to shared markers.';
  } else if (currentUser) {
    elements.ownerAccountStatus.textContent =
      'Signed in; scans are saved to shared markers. Use the owner account to remove or restore markers.';
  } else {
    elements.ownerAccountStatus.textContent =
      'Scans save automatically. Sign in with the owner Google account to remove or restore markers.';
  }
  elements.ownerPanelStatus.textContent = reviewStoreError
    ? `Shared marker storage unavailable: ${reviewStoreError}. Check the Realtime Database rules and enable Anonymous Authentication.`
    : reviewStoreReady
      ? `${formatCount(candidateSubmissions.length)} shared scan candidate(s) and ${formatCount(candidateReviews.filter((review) => review.removed).length)} removed marker(s) loaded.`
      : 'Connecting to shared marker storage…';
  if (reviewStoreReady) queueCandidateRecords(candidateSubmissions);
  renderRemovedReviews();
  if (loadedApprovedCount !== null && !candidateStoreUnavailable) {
    showCandidates(approvedCandidates, approvedCandidates.length);
  }
  renderInvestigationHistory();
}

async function waitForReviewStore(timeoutMs) {
  let timeout;
  const result = await Promise.race([
    reviewSync.ready,
    new Promise((resolve) => {
      timeout = window.setTimeout(
        () =>
          resolve({
            ok: false,
            error: new Error('Timed out waiting for shared marker storage.'),
          }),
        timeoutMs,
      );
    }),
  ]);
  if (timeout) window.clearTimeout(timeout);
  return result;
}

function getHeapBytes() {
  if (performance.memory && Number.isFinite(performance.memory.usedJSHeapSize)) {
    return {
      usedJSHeapSize: performance.memory.usedJSHeapSize,
      api: 'Chromium performance.memory; excludes some worker/WASM/GPU memory.',
    };
  }
  return { usedJSHeapSize: null, api: 'Browser heap measurement unavailable.' };
}

function startHeartbeat() {
  const state = { lastTime: performance.now(), maxGapMs: 0, stalled: false };
  const resetForVisibility = () => {
    state.lastTime = performance.now();
  };
  document.addEventListener('visibilitychange', resetForVisibility);
  const timer = window.setInterval(() => {
    const now = performance.now();
    const gap = now - state.lastTime;
    state.maxGapMs = Math.max(state.maxGapMs, gap);
    if (!document.hidden && gap >= 2000) state.stalled = true;
    state.lastTime = now;
  }, 100);
  return {
    state,
    stop() {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', resetForVisibility);
    },
  };
}

function makeDiagnostics(discovery, scan, candidates, bounds, scanElapsedMs, fps) {
  const compressedBytesRetained = tiles.reduce(
    (sum, tile) => sum + tile.rawLaz.byteLength,
    0,
  );
  const payloadBytes =
    compressedBytesRetained + (scan.typedArrayBytesBeforeAnalysis || 0);
  const heap = getHeapBytes();
  const rejected = discovery.rejected.length
    ? discovery.rejected.map((item) => `${item.id}: ${item.reason}`).join(' | ')
    : 'None';
  setDiagnostics([
    ['Coverage', getCoverageMessage(discovery)],
    ['USGS coverage products', discovery.coverage.total ?? 'unavailable'],
    ['EPT surveys selected', discovery.datasets.length],
    ['EPT items / spatial index', `${discovery.catalogItemCount} / ${discovery.indexItemCount}`],
    ['Spatial index generated', discovery.indexGeneratedAt],
    ['Spatial index current', discovery.indexIsCurrent ? 'Yes' : 'No; regenerate before deployment'],
    ['Rejected EPT items', rejected],
    ['Horizontal CRS', discovery.datasets.map((dataset) => dataset.horizontalCrs).join(', ') || 'None'],
    ['Selection dimensions', `${bounds.widthMeters.toFixed(1)} × ${bounds.heightMeters.toFixed(1)} approximate metres`],
    ['Requests (USGS data; excludes map tiles/search)', diagnostics.requestCount],
    ['Total data received', formatBytes(diagnostics.downloadedBytes)],
    ['Compressed LAZ data', formatBytes(scan.compressedBytes)],
    ['Hierarchy files', scan.hierarchyFiles],
    ['Intersecting EPT nodes', scan.nodes.length],
    ['Source records decoded', formatCount(scan.downloadedPoints)],
    ['Points inside geographic box', formatCount(scan.pointsInSelection)],
    ['Points displayed (downsampled sample)', formatCount(displayedPointCount)],
    ['Class 6 in-box points', formatCount(scan.class6PointCount || 0)],
    ['LAZ decompression (worker sum)', `${scan.decodeMs.toFixed(0)} ms`],
    ['Node download (worker sum)', `${scan.downloadMs.toFixed(0)} ms`],
    ['Time to first points', scan.firstPointsMs === null ? 'no points returned' : `${scan.firstPointsMs.toFixed(0)} ms`],
    ['Time to full detail', `${scan.timing.fullDetailMs.toFixed(0)} ms`],
    ['Total scan time', `${scanElapsedMs.toFixed(0)} ms`],
    ['Render frame rate', renderer ? `${fps} fps` : 'WebGL unavailable'],
    ['Adaptive decoder workers', scan.profile.workers],
    ['Adaptive display budget', formatCount(scan.profile.displayPoints)],
    ['LAZ / point-array payload', `${formatBytes(payloadBytes)} measured; LAZ retained, analysis arrays released after worker transfer`],
    ['Browser JavaScript heap', heap.usedJSHeapSize === null ? heap.api : formatBytes(heap.usedJSHeapSize)],
    ['Maximum UI heartbeat gap', `${scanHeartbeat.state.maxGapMs.toFixed(1)} ms`],
    ['UI stall threshold reached', scanHeartbeat.state.stalled ? 'Yes (≥ 2,000 ms gap)' : 'No'],
    ['Candidate confidence', 'Explainable heuristic only; not independently validated or a building confirmation.'],
    ['Height values', 'LAS Z units only; vertical units and reference remain unverified.'],
    ['Download/storage policy', 'Shared candidate marker metadata and removal flags are stored in Firebase; raw LiDAR points and full scan rectangles are not.'],
    ['Point evidence', `${formatCount(scan.pointsInSelection)} actual decoded LiDAR points; no points are synthesized.`],
    ['Potential candidates found', scan.totalCandidateCount],
    ['Candidates displayed', candidates.length],
    ['Scan source point estimate', `${formatCount(scan.expectedPoints)} intersecting-node records; full records were downloaded.`],
    ['Browser guardrail', `Maximum ${formatCount(scan.profile.maxSourcePoints)} intersecting node records for this device profile.`],
  ]);
}

async function analyzeCandidates(bounds) {
  if (!tiles.length) return [];
  const typedArrayBytes = tiles.reduce(
    (sum, tile) => sum + tile.positions.byteLength + tile.classifications.byteLength,
    0,
  );
  const class6Points = tiles.reduce(
    (sum, tile) =>
      sum +
      tile.classifications.reduce(
        (count, classification) => count + (classification === 6 ? 1 : 0),
        0,
      ),
    0,
  );
  const analysisTiles = tiles.map((tile) => ({
    areaPoints: tile.areaPoints,
    positions: tile.positions,
    classifications: tile.classifications,
  }));
  const transfer = [];
  for (const tile of analysisTiles) {
    transfer.push(tile.positions.buffer, tile.classifications.buffer);
  }
  const worker = new Worker(new URL('./detection-worker.js', import.meta.url), {
    type: 'module',
  });
  try {
    const result = await new Promise((resolve, reject) => {
      worker.addEventListener(
        'message',
        (event) => {
          if (event.data.type === 'complete') resolve(event.data.result);
          else reject(new Error(event.data.message || 'Candidate analysis failed.'));
        },
        { once: true },
      );
      worker.addEventListener(
        'error',
        (event) => reject(new Error(event.message || 'Candidate analysis worker failed.')),
        { once: true },
      );
      worker.postMessage({ tiles: analysisTiles, bounds }, transfer);
    });
    for (const tile of tiles) {
      tile.positions = new Float32Array(0);
      tile.classifications = new Uint8Array(0);
    }
    return { ...result, typedArrayBytes, class6Points };
  } finally {
    worker.terminate();
  }
}

async function scanArea() {
  if (scanController) return;
  let bounds;
  try {
    bounds = readBounds();
  } catch (error) {
    updateStatus('Cannot start scan', error.message);
    return;
  }

  clearResults();
  Object.assign(diagnostics, {
    requestCount: 0,
    requestLog: [],
    downloadedBytes: 0,
  });
  elements.progress.removeAttribute('value');
  elements.scan.disabled = true;
  elements.clear.disabled = true;
  scanController = new AbortController();
  updateActions();
  setCoverageStatus('Checking coverage', 'loading');
  updateStatus('Discovering USGS data', 'Querying official LiDAR coverage and spatially matching real EPT survey footprints.');
  const scanStarted = performance.now();
  scanHeartbeat = startHeartbeat();
  let discovery = null;
  let scan = null;
  let candidates = [];
  let rendererError = null;

  try {
    try {
      renderer = createPointRenderer(elements.canvas);
    } catch (error) {
      renderer = null;
      rendererError = error.message;
      elements.viewerTitle.textContent = 'WebGL unavailable';
    }

    discovery = await discoverDatasets(
      bounds,
      scanController.signal,
      diagnostics,
      (message) => updateStatus('Discovering USGS data', message),
    );
    const coverageMessage = getCoverageMessage(discovery);
    const hasCoverage = discovery.coverage.total > 0 || discovery.datasets.length > 0;
    setCoverageStatus(
      discovery.datasets.length
        ? 'EPT available'
        : discovery.coverage.total > 0
          ? 'LiDAR found · no EPT'
          : discovery.coverage.total === 0
            ? 'No LiDAR found'
            : 'Coverage unverified',
      discovery.datasets.length ? 'available' : hasCoverage ? 'partial' : 'none',
    );
    if (!discovery.datasets.length) {
      updateStatus('Discovery complete', coverageMessage);
      elements.viewerTitle.textContent = 'No validated EPT points for this area';
      setDiagnostics([
        ['Coverage', coverageMessage],
        ['USGS coverage products', discovery.coverage.total ?? 'unavailable'],
        ['EPT items checked', discovery.catalogItemCount],
        ['Spatial index current', discovery.indexIsCurrent ? 'Yes' : 'No'],
        ['EPT items rejected', discovery.rejected.map((item) => `${item.id}: ${item.reason}`).join(' | ') || 'None'],
        ['Requests (USGS data; excludes map tiles/search)', diagnostics.requestCount],
        ['Data received', formatBytes(diagnostics.downloadedBytes)],
        ['Interpretation', 'Coverage found without validated EPT is different from no listed LiDAR coverage.'],
      ]);
      return;
    }
    if (!discovery.indexIsCurrent) {
      updateStatus('Warning: spatial index is stale', 'The EPT catalog has a different number of items than the bundled index; results may omit recently added surveys.');
    } else {
      updateStatus('EPT coverage found', coverageMessage);
    }
    if (discovery.rejected.length) {
      const rejectedSummary = discovery.rejected
        .map((item) => `${item.id}: ${item.reason}`)
        .join('; ');
      elements.statusDetail.textContent += ` Rejected resources: ${rejectedSummary}`;
    }
    elements.viewerTitle.textContent = `Preparing ${discovery.datasets.length} validated EPT survey(s)`;
    scan = await scanDatasets(
      discovery.datasets,
      bounds,
      diagnostics,
      scanController.signal,
      (message, completed, total) => {
        if (Number.isFinite(completed) && Number.isFinite(total)) {
          elements.progress.max = total;
          elements.progress.value = completed;
        } else {
          elements.progress.removeAttribute('value');
        }
        updateStatus('Scanning LiDAR', message);
      },
      (tile, dataset, progress) => {
        tiles.push(tile);
        elements.viewerTitle.textContent = `LiDAR points · ${dataset.itemId}`;
        if (renderer && (progress.nodes.length === 1 || progress.nodes.length % 20 === 0)) {
          refreshPointView(bounds, scan?.profile.displayPoints || 100_000);
        }
        const downloaded = progress.downloadedPoints.toLocaleString();
        const inBox = progress.pointsInSelection.toLocaleString();
        updateStatus(
          'Scanning LiDAR',
          `${downloaded} source records decoded; ${inBox} points fall inside the selected geographic rectangle.`,
        );
      },
      scanStarted,
    );
    if (elements.progress.max !== 0) {
      elements.progress.value = elements.progress.max;
    }
    if (renderer) refreshPointView(bounds, scan.profile.displayPoints);
    updateStatus('Analyzing point evidence', 'Grouping actual in-box returns and comparing elevated cells with nearby Class 2 ground samples.');
    const analysis = await analyzeCandidates(bounds);
    candidates = analysis.candidates;
    const prepared = prepareScannedCandidates(analysis.candidates, candidateReviews);
    scan.typedArrayBytesBeforeAnalysis = analysis.typedArrayBytes;
    scan.class6PointCount = analysis.class6Points;
    scan.detectedCandidateCount = analysis.totalCandidateCount;
    scan.totalCandidateCount = analysis.totalCandidateCount;
    const reviewState = await waitForReviewStore(10_000);
    if (!reviewState.ok || reviewStoreError || !reviewStoreReady) {
      await queueCandidateRecords(prepared.detected);
      const storageMessage =
        reviewStoreError || reviewState.error?.message || 'Shared marker storage is not ready.';
      showCandidateStoreUnavailable(storageMessage);
      const fps = renderer ? await sampleFps() : null;
      const scanElapsedMs = performance.now() - scanStarted;
      elements.viewerTitle.textContent = rendererError
        ? `Points decoded; rendering unavailable: ${rendererError}`
        : 'Actual USGS EPT points rendered';
      updateStatus(
        'Scan complete · marker storage unavailable',
        `${formatCount(scan.pointsInSelection)} actual points decoded and ${formatCount(analysis.totalCandidateCount)} candidate(s) were submitted for investigation. Shared Firebase evidence could not be updated; candidates remain off the map.`,
      );
      makeDiagnostics(discovery, scan, candidates, bounds, scanElapsedMs, fps);
      return;
    }

    const saved = await saveScannedCandidates(analysis.candidates, candidateReviews);
    await queueCandidateRecords(saved.detected);
    const submissionsById = new Map(
      candidateSubmissions.map((candidate) => [candidate.id, candidate]),
    );
    for (const candidate of saved.visible) {
      submissionsById.set(candidate.id, candidate);
    }
    candidateSubmissions = [...submissionsById.values()];
    renderCandidateLayers();
    renderRemovedReviews();
    scan.totalCandidateCount = analysis.totalCandidateCount;
    showCandidates(approvedCandidates, approvedCandidates.length);
    const fps = renderer ? await sampleFps() : null;
    const scanElapsedMs = performance.now() - scanStarted;
    elements.viewerTitle.textContent = rendererError
      ? `Points decoded; rendering unavailable: ${rendererError}`
      : 'Actual USGS EPT points rendered';
    const markerPersistence = analysis.totalCandidateCount
      ? `${analysis.totalCandidateCount} candidate(s) were stored for sequential investigation; none are shown as normal markers before approval.`
      : 'No LiDAR candidates were detected in this scan.';
    updateStatus(
      'Scan complete',
      `${formatCount(scan.pointsInSelection)} actual points decoded inside the selection; ${formatCount(analysis.totalCandidateCount)} heuristic candidate(s). ${markerPersistence} No structure is confirmed by this scan.`,
    );
    makeDiagnostics(discovery, scan, candidates, bounds, scanElapsedMs, fps);
  } catch (error) {
    if (error.name === 'AbortError') {
      updateStatus('Scan cancelled', 'Any partial point data was discarded. You can draw a smaller area and scan again.');
      setCoverageStatus('Cancelled', 'idle');
      clearResults();
    } else {
      updateStatus('Scan failed', error.message);
      setCoverageStatus('Scan error', 'error');
      setDiagnostics([
        ['Error', error.message],
        ['Requests before failure', diagnostics.requestCount],
        ['Data received before failure', formatBytes(diagnostics.downloadedBytes)],
        ['Vertical reference', 'Unverified; all Z values remain LAS Z units.'],
      ]);
    }
  } finally {
    scanHeartbeat.stop();
    scanController = null;
    updateActions();
    if (!elements.progress.hasAttribute('value')) {
      elements.progress.value = 1;
      elements.progress.max = 1;
    }
  }
}

async function searchLocation(event) {
  event.preventDefault();
  const query = elements.searchInput.value.trim();
  if (!query || searchPending) return;
  searchPending = true;
  updateActions();
  updateStatus('Searching location', 'Requesting one place result from the public OpenStreetMap Nominatim service.');
  try {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.search = new URLSearchParams({
      q: query,
      format: 'jsonv2',
      limit: '1',
    }).toString();
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`Place search returned HTTP ${response.status}.`);
    }
    const results = await response.json();
    if (!Array.isArray(results) || !results.length) {
      throw new Error('No matching place was found.');
    }
    const result = results[0];
    const latitude = Number(result.lat);
    const longitude = Number(result.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error('Place search returned invalid coordinates.');
    }
    map.setView([latitude, longitude], 16);
    if (searchMarker) map.removeLayer(searchMarker);
    const label = document.createElement('span');
    label.textContent = result.display_name;
    searchMarker = L.marker([latitude, longitude]).addTo(map).bindPopup(label);
    searchMarker.openPopup();
    updateStatus('Location found', 'Draw a rectangle around the area you want to scan.');
  } catch (error) {
    updateStatus('Location search failed', error.message);
  } finally {
    searchPending = false;
    updateActions();
  }
}

elements.searchForm.addEventListener('submit', searchLocation);
elements.clear.addEventListener('click', clearSelection);
elements.scan.addEventListener('click', scanArea);
elements.cancel.addEventListener('click', () => scanController?.abort());
elements.loadMoreInvestigations.addEventListener('click', loadMoreInvestigations);
elements.loadMoreRemovedMarkers.addEventListener('click', () => {
  removedReviewLimit += 50;
  renderRemovedReviews();
});
elements.startInvestigationQueue.addEventListener('click', async () => {
  elements.startInvestigationQueue.disabled = true;
  try {
    await investigationApi('POST', { action: 'start' });
    setInvestigationError('');
    await refreshInvestigationData();
  } catch (error) {
    setInvestigationError(`Could not start the investigation queue: ${error.message}`);
    elements.startInvestigationQueue.disabled = false;
  }
});
elements.stopInvestigationQueue.addEventListener('click', async () => {
  elements.stopInvestigationQueue.disabled = true;
  try {
    await investigationApi('POST', { action: 'stop' });
    setInvestigationError('');
    await refreshInvestigationData();
  } catch (error) {
    setInvestigationError(`Could not stop the investigation queue: ${error.message}`);
    elements.stopInvestigationQueue.disabled = false;
  }
});
elements.ownerSignIn.addEventListener('click', async () => {
  elements.ownerSignIn.disabled = true;
  elements.ownerPanelStatus.textContent = 'Opening Google sign-in…';
  try {
    await signInOwnerWithGoogle();
  } catch (error) {
    elements.ownerPanelStatus.textContent = `Google sign-in failed: ${error.message}`;
  } finally {
    elements.ownerSignIn.disabled = false;
  }
});
elements.ownerSignOut.addEventListener('click', async () => {
  elements.ownerSignOut.disabled = true;
  try {
    await signOutOwner();
    elements.ownerPanelStatus.textContent = 'Signed out.';
  } catch (error) {
    elements.ownerPanelStatus.textContent = `Sign-out failed: ${error.message}`;
  } finally {
    elements.ownerSignOut.disabled = false;
  }
});
elements.clearAllInvestigations.addEventListener('click', async () => {
  if (!isReviewOwner(currentUser) || !reviewStoreReady || candidateStoreUnavailable) return;
  const confirmed = window.confirm(
    'Clear all investigations and attempt history from D1, stop the queue, and hide every currently known candidate marker? ' +
      'Original Firebase scan evidence and today’s AI usage budget will be retained. This cannot be undone.',
  );
  if (!confirmed) return;

  clearAllInProgress = true;
  elements.clearAllInvestigations.disabled = true;
  elements.investigationStatus.textContent = 'Clearing investigations and hiding candidate markers…';
  if (queueRetryTimer) {
    window.clearTimeout(queueRetryTimer);
    queueRetryTimer = null;
  }
  try {
    while (queueSyncRunning) {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    await investigationApi('POST', { action: 'stop' });
    const removedRecords = await setAllCandidateRecordsRemoved(
      candidateReviews,
      candidateSubmissions,
      approvedCandidates,
    );
    const removedById = new Map(removedRecords.map((record) => [record.id, record]));
    candidateReviews = [
      ...candidateReviews.filter((review) => !removedById.has(review.id)),
      ...removedRecords,
    ];
    renderCandidateLayers();
    renderRemovedReviews();
    const cleared = await investigationApi('POST', { action: 'clearAll' });
    pendingQueueCandidates.clear();
    queuedCandidateIds.clear();
    persistPendingQueueLocally();
    approvedCandidates = [];
    loadedApprovedCount = 0;
    investigationEntries = [];
    setInvestigationError('');
    await refreshInvestigationData();
    elements.investigationStatus.textContent =
      `Cleared ${formatCount(cleared.deletedInvestigationCount)} investigation(s) and ` +
      `${formatCount(cleared.deletedHistoryCount)} history record(s). The queue is stopped; current map markers are hidden.`;
  } catch (error) {
    setInvestigationError(`Could not complete the clear-all operation: ${error.message}`);
    elements.investigationStatus.textContent =
      'Clear all did not fully complete. The queue may already be stopped; review the error and retry.';
  } finally {
    clearAllInProgress = false;
    renderOwnerPanel();
    if (investigationSummary) renderInvestigationCounts(investigationSummary);
  }
});

try {
  renderer = createPointRenderer(elements.canvas);
} catch (error) {
  elements.viewerTitle.textContent = `WebGL unavailable: ${error.message}`;
}

window.addEventListener('resize', () => {
  map.invalidateSize();
  renderer?.draw();
});
map.whenReady(() => window.setTimeout(() => map.invalidateSize(), 0));
setCoverageStatus('Not scanned', 'idle');
updateActions();
restorePendingQueueLocally();
void synchronizeInvestigationQueue();
reviewSync = listenToCandidateReviews(
  ({ reviews, submissions }) => {
    candidateReviews = reviews;
    candidateSubmissions = submissions;
    reviewStoreReady = true;
    reviewStoreError = null;
    candidateStoreUnavailable = false;
    renderCandidateLayers();
    renderOwnerPanel();
  },
  (error) => {
    reviewStoreReady = false;
    reviewStoreError = error.message;
    candidateReviews = [];
    candidateStoreUnavailable = true;
    renderCandidateLayers();
    if (hasCandidateScan) {
      showCandidateStoreUnavailable(
        'Live shared marker data was lost. Reconnect before showing candidates.',
      );
    }
    renderOwnerPanel();
  },
);
listenToOwnerAuth((user, error) => {
  currentUser = user;
  if (error) {
    elements.ownerPanelStatus.textContent = `Firebase sign-in state unavailable: ${error.message}`;
  }
  renderOwnerPanel();
  renderInvestigationHistory();
  void refreshInvestigationData();
});

window.setInterval(() => {
  if (reviewStoreReady) queueCandidateRecords(candidateSubmissions);
  void refreshInvestigationData();
}, 60_000);
