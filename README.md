# USGS 3DEP LiDAR Explorer

The main page is a map-first browser scanner. Search for a location, draw a
rectangle, and choose **Scan Area**. The browser discovers public USGS 3DEP
coverage, validates EPT resources, progressively downloads intersecting LAZ
nodes, decodes them in Web Workers, and renders actual returned points with
WebGL. Candidate detections enter a persistent investigation queue; only
approved investigations appear as normal map markers. Scan measurements are
available in the optional **Scan Diagnostics** panel. The manual benchmark
remains at `advanced-benchmark.html`.

## Run locally on Windows

```powershell
Set-Location C:\Users\C\Pictures\BuildingLocator\forgh
npm.cmd ci
npm.cmd run dev
```

Open the local URL printed by Vite. Static scanning and the existing benchmark
work locally. The investigation API requires Cloudflare Pages Functions and
its D1/Workers AI bindings; a plain Vite server does not provide those
bindings.

Build the static site for deployment:

```powershell
npm.cmd run build
```

The deployable site is in `dist`. Cloudflare Pages must build from this
directory with `npm run build` and output directory `dist`. Keep the root
`functions/` directory in the connected project so Pages deploys the
investigation API with the static site. A static-only host can still serve the
scanner, but cannot provide the persistent AI investigation service.

## Automatic dataset discovery

Each scan:

1. Queries the official USGS The National Map Access API for `Lidar Point
   Cloud (LPC)` coverage intersecting the drawn WGS84 rectangle.
2. Loads the public [USGS EPT STAC catalog](https://s3-us-west-2.amazonaws.com/usgs-lidar-stac/ept/catalog.json)
   and a compact spatial index derived from its item documents.
3. Fetches the actual intersecting STAC item documents, checks their geographic
   footprint against the drawn rectangle, reads the item’s actual `ept.json`
   asset URL, then validates the EPT metadata, point dimensions, and CRS.
4. Transforms the selection into each validated dataset CRS, traverses only
   intersecting EPT hierarchy nodes, downloads and decodes the corresponding
   LAZ data in browser workers, and filters decoded points back to the exact
   geographic rectangle.

The interface distinguishes **no listed LiDAR point-cloud coverage** from
**LiDAR coverage listed but no matching validated public EPT resource**. A USGS
coverage API outage is reported as unverified coverage, not as “no LiDAR.”
Static catalog item matching uses actual STAC item footprints and assets, not
project-name-derived EPT URLs.

`public/ept-spatial-index.json` contains WGS84 bounding boxes and item IDs/links
for the 2,283 items in the USGS EPT catalog when generated. It does not contain
point data or hardcode a scan location. Regenerate it when the catalog changes:

```powershell
python .\scripts\build-ept-index.py
npm.cmd run build
```

The index builder uses Python’s standard library and fetches the catalog’s item
documents. Ordinary scans only load this small index and then request
intersecting item documents; they do not fetch all survey point clouds.

## Point display and candidate evidence

- The scan retains the compressed LAZ node payloads and all decoded
  in-selection coordinates/classifications in browser memory during analysis.
  WebGL display sampling is separate and does not limit the downloaded point
  records.
- Adaptive quality chooses decoder worker count and a display-only point budget
  from browser-reported core/memory hints.
- Class 6 returns are kept as a separate evidence category. Other candidates
  require connected elevated cells and roof-like geometry; class 3–5 vegetation
  share reduces confidence. Ground-relative checks use nearby Class 2 samples
  in a local grid, not a fabricated ground surface.
- The candidate grid is 2.5 m. A cell is considered elevated only when its
  non-ground mean exceeds the median nearby Class 2 cell elevation by more than
  1.5 LAS Z units. A planar cell has a non-ground Z range no greater than 0.75
  LAS Z units. Class 2 search extends three grid cells. Non-Class-6 candidates
  also require at least 25 m², 40 returns, 35% local ground coverage, 40%
  planar elevated cells, and less than 70% vegetation returns. Class 6
  components require 10 such returns in at least two connected cells.
- Scores add evidence for local ground support (up to 20), planar elevated
  cells (up to 25), compact geometry (up to 15), footprint area (10), density
  (10), and Class 6 (up to 15); substantial vegetation subtracts 10 or 25.
  Scores are capped at 44 when local ground coverage is below 35%. High is
  75–100, medium is 50–74, and low is below 50. All generated candidate
  records are sent in bounded batches to the investigation queue; the browser
  does not silently drop candidates after the first 500.
- Per-candidate LiDAR evidence includes total point count, counts for Classes
  2–6 and other classes, Class 6 and vegetation shares, ground coverage,
  planar coverage, roughness, density, and ground-relative height. Missing
  fields in older stored records remain unknown rather than being inferred.
- Every candidate shows its score components, point count, approximate
  dimensions, and local Class 2 support. Scores are heuristic and unvalidated;
  they are not building confirmations. A missing candidate does not prove a
  building is absent; a structure with no useful roof or wall returns in the
  selected LiDAR data cannot be reliably recovered by this scanner.
- Height and relative-height values remain **LAS Z units**. The app does not
  assume the vertical unit or reference.
- For browser memory safety, each rectangle side is limited to 2,000 m. Before
  downloading any LAZ nodes, the scanner estimates intersecting source records
  and stops if they exceed the device profile's point limit: 8,000,000 on
  standard/lower-capability profiles and up to 40,000,000 when the browser
  reports more than 8 logical cores and more than 8 GiB device memory. These
  browser hints are approximate, not a guarantee of available RAM. The larger
  profile may require well over 1 GiB of browser memory and substantial
  download/time, depending on LAZ compression and point density. Draw a smaller
  box or use a desktop point-cloud workflow when a scan exceeds its limit. The
  scanner never silently truncates a completed scan to meet its display budget.

## Persistent AI investigations

The Cloudflare Pages Function at `functions/api/investigations.js` stores the
queue, current status, reports, and prior attempts in D1. Existing Firebase
scan records are retained and synchronized into D1 when the site is visited;
new detections are saved to Firebase and queued in batches. A small
`localStorage` backup retains unsent batches if the Pages API is unavailable.
and synchronized into D1 when the site is visited; run a scan or open the
website to synchronize new Firebase records. The independent
`investigation-cron-worker/` Worker uses a `* * * * *` Cron Trigger and the
same D1 database and Workers AI binding. After the configured owner starts the
queue once in the website, that Worker processes at most one candidate per
scheduled invocation. The website and browser can be closed.

The owner can start or stop the persistent queue in the website. Other visitors
can contribute candidate records but cannot start/stop the queue or invoke AI.
Each result (including its attempt-history row) is committed in one awaited D1
batch before the invocation returns. The D1 atomic global lock prevents
overlapping Pages/Cron processors, and a 16-minute lease protects work across
the maximum Cron wall-time window. Expired `analyzing` records are recovered.
Completed `approved`, `rejected`, `uncertain`, and `error` candidates are not
automatically selected again; only the owner retry action can queue an
`uncertain` or `error` record again. A crash after the external model call but
before D1 commits can repeat that unfinished call; exactly-once remote
inference cannot be guaranteed.

The app's 4,000-Neuron daily cap and Cloudflare quota errors pause the backlog
in D1; the Cron Worker resumes quota-paused records after the next UTC reset.
The website's investigation panel displays the last scheduled run, status,
candidate, invocation count, saved errors, queue counts, and remaining app
budget. A candidate-level error is saved and does not stop later Cron runs.

The visual model is Cloudflare Workers AI
`@cf/meta/llama-3.2-11b-vision-instruct`, called only through the server-side
`AI` binding. It receives a bounded 512 × 512 USGS/USDA NAIP image export plus
the LiDAR measurements/classification counts and nearby OpenStreetMap
Overpass building/land-use context. Nearby houses alone do not reject a
candidate; absent map tags are not positive evidence. An unavailable image
produces an uncertain report rather than a made-up visual assessment.

Approval requires all of the following:

- The model classifies the target as `likely_non_residential` and its
  confidence meets `AI_APPROVAL_CONFIDENCE` (default 0.85).
- The report includes positive evidence and observations from the image.
- Independent LiDAR evidence has at least 40 points, 25 m² estimated footprint,
  35% local Class 2 ground coverage, and more than 1.5 LAS Z units relative
  height, plus either at least 10 Class 6 returns or at least 40% planar
  coverage with less than 65% vegetation share.
- Direct residential map-tag conflict blocks approval. Nearby residential
  context alone does not.

These are conservative heuristics, not proof of property use. The project
never assesses occupancy, vacancy, abandonment, ownership, or safety. A
structure with no useful LiDAR roof or wall returns cannot be reliably detected.
LiDAR Z units and vertical datum remain unverified.

### Cloudflare Pages setup

1. In Pages project settings, set the project root to `forgh`, the build command
   to `npm run build`, and the build output directory to `dist`.
2. Use the existing D1 database. In its SQL console, run `functions/schema.sql`
   to safely add any missing queue and Cron telemetry tables. Do not create a
   second D1 database. `IF NOT EXISTS` retains existing investigation history.
3. In **Workers & Pages → your Pages project → Settings → Bindings**, add a D1
   binding named `DB` and select that database.
4. In the same **Bindings** screen, add a **Workers AI** binding named `AI`.
   Select both Production and Preview environments as applicable, then
   redeploy. The function intentionally returns a configuration error if this
   binding is absent; there is no frontend token and no alternate paid model.
5. Add these Pages Function environment variables in the applicable
   Production/Preview environments:

   | Variable | Value |
   | --- | --- |
   | `FIREBASE_PROJECT_ID` | `dep-lidar-scan` |
   | `INVESTIGATION_OWNER_UID` | `6yr5pHdQccbW9551O853mpiax8O2` |
   | `AI_APPROVAL_CONFIDENCE` | `0.85` |

   The project ID and owner UID are identifiers, not Cloudflare API secrets.
   The function validates Firebase ID-token signatures; do not add a Cloudflare
   API token to browser code.
6. Review Meta's Llama 3.2 license and acceptable-use policy. Cloudflare
   requires a one-time initial request to this model with prompt `agree`.
   Explicitly do this in Cloudflare's Workers AI Playground only after
   accepting those terms. The application does not accept a license on your
   behalf. If the terms have not been accepted, the candidate receives an
   error report and can be retried after setup.
7. Keep the Cloudflare account on the **Workers Free** plan and do not enable
   paid usage or add an automatic billing fallback. Cloudflare currently
   documents 10,000 free Neurons per account per UTC day; this project reserves
   at most 4,000 estimated Neurons per UTC day (about 20 bounded image reviews
   at its current estimate) and pauses the queue when its budget or Cloudflare
   quota is exhausted. The account allocation is shared with other workloads;
   they may consume it first. On the Free plan, excess operations fail rather
   than switching to another model. A Workers Paid account can incur charges
   beyond its free allocation, so do not upgrade if zero billing is required.
8. Keep Firebase Anonymous and Google Authentication enabled and add the
   deployed Pages domain to Firebase's authorized domains. Sign in with the
   configured owner Google account and click **Start investigation queue**
   once. The active state persists in D1; the website need not stay open.

### Deploy the independent Cron Worker

The checked-in configuration is
`investigation-cron-worker/wrangler.toml`. Before deployment, replace
`REPLACE_WITH_EXISTING_D1_DATABASE_NAME` and
`REPLACE_WITH_EXISTING_D1_DATABASE_ID` with the name and ID of the same D1
database bound to Pages. Find the database ID in the Cloudflare dashboard under
**Workers & Pages → D1 SQL Database → your existing database → Overview**.
The configuration binds that database as `DB`, binds Workers AI as `AI`, and
sets the required `* * * * *` schedule. `workers_dev = false` and the absence
of a `fetch` handler mean the Worker has no public HTTP endpoint.

From PowerShell:

```powershell
Set-Location C:\Users\C\Pictures\BuildingLocator\forgh\investigation-cron-worker
npx wrangler login
npx wrangler deploy
```

Deploy this Worker independently from the Pages build. If the account does not
allow AI bindings from Wrangler configuration, add the Workers AI binding
named `AI` to the Worker in **Workers & Pages → your Worker → Settings →
Bindings**, then redeploy. Verify **Settings → Triggers → Cron Triggers** shows
`* * * * *`; trigger changes can take several minutes to propagate. No
Cloudflare API token, paid Queue, Workflow, Durable Object, second database,
or paid inference fallback is used.

Cloudflare's current Workers Free limits allow 10 ms CPU per Cron invocation
and 15 minutes wall time per Cron invocation. The handler makes only one
candidate attempt, uses asynchronous fetch/AI binding calls, caps the image
payload at 512 KiB, and caps public-map context parsing at 128 KiB. CPU is the
main practical constraint: if one invocation consistently exceeds 10 ms of
JavaScript CPU, Cloudflare will terminate it regardless of the wall-time
allowance. This code keeps the per-invocation image/context bounds small, but
actual Cloudflare CPU measurements must be checked in Workers invocation
logs after deployment. If an invocation is interrupted, its 16-minute D1 lease
expires and the unfinished candidate is retried. One invocation per minute is
at most 1,440 Cron requests/day, below the 100,000 Free daily Worker request
limit. D1 Free currently allows 100,000 row writes/day; this single-candidate
schedule is below that allowance under normal queue use.

Cloudflare setup and current quota/model terms were checked against its
[Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/),
[Llama vision model](https://developers.cloudflare.com/workers-ai/models/llama-3.2-11b-vision-instruct/),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[Pages Functions bindings](https://developers.cloudflare.com/pages/functions/bindings/),
and [Workers AI bindings](https://developers.cloudflare.com/workers-ai/configuration/bindings/)
documentation. The bounded NAIP imagery endpoint is USGS/USDA public-domain
orthophotography; reports identify its source. OpenStreetMap context is
attributed in the report and treated as incomplete evidence. Reports also
show investigation elapsed time and the downloaded image and map-context
payload sizes; these are payload sizes, not a measure of compressed network
traffic.

### Testing

Run local deterministic approval-gate tests and the production build:

```powershell
Set-Location C:\Users\C\Pictures\BuildingLocator\forgh
npm.cmd ci
npm.cmd test
npm.cmd run build
```

The queue-control tests also cover persistent start state, sequential
save-before-next ordering, continuing after a recorded error, recovery of
expired analysis leases, quota recovery at UTC rollover, and exclusion of
completed records from automatic retries.

The tests cover an ordinary house, a subdivision house, warehouse, industrial
building, agricultural building, tree canopy, cleared lot, insufficient
imagery, nearby residential context, missing LiDAR support, and conflicting
direct residential tags. They validate the approval gate with fixed reports;
they do not simulate a live vision model or prove real-world model accuracy.
After Cloudflare bindings and the model license are configured, scan labeled
known examples and inspect each report before relying on approvals.

Queue and Cron tests exercise owner start/stop state, browserless scheduled
processing, inactive queues, sequential subsequent invocations, D1 result
commit ordering, recorded errors, duplicate lock rejection, expired-lease
recovery, quota pause, and next-day recovery.

## Diagnostics and privacy

Diagnostics report coverage status, requests, bytes received, compressed LAZ
size, EPT node and point counts, time to first points, total loading and decode
time, WebGL frame rate, adaptive worker/display settings, and memory estimates
where exposed. Browser heap APIs omit some worker, WebAssembly, and GPU memory;
the app reports those limits.

Candidate metadata (coordinates, approximate footprint, score, return counts,
classification counts, and evidence summary) is shared through Firebase
Realtime Database after every visitor's scan and copied to the D1 investigation
queue. Investigation reports are stored in D1; bounded NAIP imagery is
requested for visual review but raw image bytes and LiDAR points are not stored.
Raw LiDAR points and full scan rectangles are not stored in Firebase. All
visitors can read candidate records. Only AI-approved records appear as normal
map markers. Scans are authenticated with Firebase Anonymous
Authentication by default; each signed-in identity can write only its own
`scanCandidates/{uid}` records. The configured owner UID alone can write
`candidateReviews`, which stores removal/restoration decisions. Removed
locations are matched to new detections within approximately 8 metres and
remain suppressed until restored in the Owner review panel. Candidate scoring
and spatial matching are heuristic; a nearby, distinct structure may also be
suppressed, so review restored markers carefully.

The investigation panel has an owner-only **Clear all investigations and
markers** action. After confirmation, it stops the queue, marks currently known
candidate locations removed in Firebase so they stay hidden and are not
re-queued, and deletes all D1 investigation and attempt-history rows. Original
Firebase scan evidence and today's AI usage accounting are retained. The owner
must be signed in and confirm the action in the deployed site.

Before deploying, apply the rules in `database.rules.json` to the Realtime
Database. If the project already has other data/rules, merge both the
`candidateReviews` and `scanCandidates` branches instead of replacing existing
rules. Enable **Anonymous** and **Google** under Firebase Authentication →
Sign-in method, and add the website’s deployment domain to Authorized
domains. The owner must sign in with the Google account whose UID is configured
in `src/firebase.js` to remove or restore markers. The site does not require the
Firebase Admin SDK or a service-account key.

Because scan records are shared and the database is client-accessible, an
authenticated user can submit many candidate records under their own UID.
Realtime Database rules validate ownership and basic record fields but cannot
reliably rate-limit writes. Monitor Firebase usage; a trusted server with
quotas/rate limiting is needed if the app becomes public at scale.

USGS catalog/coverage/EPT requests, map imagery, and place searches go
directly to their public providers, which may log them. The
OpenStreetMap Nominatim search provider receives the typed place query. The
map uses Esri World Imagery by default and OpenStreetMap streets as an
alternate. Opening a candidate in Google Earth sends its coordinates in the
URL.

## Dependencies

- **Cloudflare Pages Functions and D1** — same-origin authenticated API and
  durable queue/report storage; provisioned through the Pages dashboard.
- **Cloudflare Workers AI** — server-side vision inference through the `AI`
  binding. The queue-processing endpoint is restricted to the configured
  owner. No AI SDK or npm package is added.
- **USGS/USDA NAIP ImageServer and OpenStreetMap Overpass API** — bounded aerial
  image exports and optional public footprint/context evidence. No map tiles
  are scraped for AI.
- **Leaflet** — interactive map and basemap display.
- **Leaflet Draw** — rectangle selection tool.
- **proj4** — conversion between WGS84 map coordinates and each EPT dataset’s
  advertised horizontal CRS.
- **Turf boolean-intersects/helpers** — exact STAC footprint/selection
  intersection checks.
- **laz-perf** — LAZ decompression in browser Web Workers using WebAssembly.
- **Firebase app/auth/database modules** — anonymous scan identity, Google
  owner sign-in, and shared candidate evidence; Firestore and the Admin SDK are
  not used, and the LiDAR point cloud is not uploaded.
- **Vite** — local development and static production builds.

The point cloud is drawn in WebGL buffers; points are never rendered as
individual HTML elements. LiDAR retrieval and decoding run in the visitor’s
browser; only the bounded candidate image review and queue API run in Pages
Functions.
