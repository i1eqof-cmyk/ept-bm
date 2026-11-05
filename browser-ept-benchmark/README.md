# Global EPT browser benchmark

A configurable browser performance benchmark for public EPT point clouds. The
repository has no default dataset, coordinates, or location-specific results.
It retrieves EPT LAZ nodes progressively, decompresses them in Web Workers, and
renders sampled points in WebGL.

## Privacy

- The EPT URL and projected X/Y center are entered at runtime; they are not
  embedded in the source, stored in the URL or browser storage, or added to the
  downloadable report.
- The browser sends metadata, hierarchy, and point requests directly to the
  EPT host. That host can see the requests and may log them.
- Local result files are ignored by Git. Earlier machine-specific measurements
  have been moved outside the repository. Review `git status --ignored` before
  publishing.
- Use a public EPT source whose CORS policy permits browser requests. Never
  enter credentials or signed URLs into a public page.

## Run locally on Windows

```powershell
Set-Location C:\path\to\global-ept-browser-benchmark
npm.cmd install
npm.cmd run dev
```

Open the printed local URL. Enter the source's HTTPS `ept.json` URL and a
projected X/Y center in the dataset's meter-based horizontal coordinate
reference system, then select a display quality and click **Run all three
tests**. The benchmark requests 100 m, 250 m, and 500 m squares around that
center.

The app requires network access to the EPT host, WebGL, and browser support for
module workers and WebAssembly. Do not serve it with `file://`.

## Measurements

The report includes fetched and in-area point counts, compressed payload bytes,
decompression timing, progressive detail timing, first visible points, WebGL
frame rate, heap usage where exposed, retained typed-array bytes, and UI
heartbeat gaps. The 100k, 500k, and 2M point budgets affect WebGL display
sampling only; the app separately retains the downloaded LAZ payloads for each
test area.

Adaptive quality is a heuristic based on browser-reported memory and core-count
hints. Browser memory APIs do not include every worker, WebAssembly, or GPU
allocation. A benchmark on one computer is not evidence that all visitor
devices will perform similarly. This browser-only version does not claim
equivalence to PDAL.

The app does not infer a dataset's vertical unit or datum. Any Z values must be
treated as LAS Z units until verified.

## Build

```powershell
npm.cmd run build
```

Dependencies:

- `laz-perf` decompresses LAZ data as WebAssembly in browser workers.
- Vite serves the app and builds its JavaScript, worker, and WebAssembly assets.
- Point rendering uses WebGL directly; no point-per-DOM rendering or 3D library
  is used.
