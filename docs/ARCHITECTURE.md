# Architecture

## Why this shape

The brief is explicit that previous interventions failed because they assumed
high-bandwidth links. So the constraint is inverted here: every component is
designed around what happens when the network is *absent*, and the good-network
case is treated as an optimisation.

Three consequences shape the whole system:

1. **The client is the source of truth for the student.** Lectures, quizzes,
   and threads live in IndexedDB. Screens read locally and refresh from the
   network. Nothing renders a spinner waiting for a request that may never
   return.
2. **The control plane is separate from media.** A live class sends slide
   indices and poll deltas over a socket — tens of bytes. Media is a separate
   stream the student opts into at a bitrate they chose. A student on 40 kbps
   stays in the room.
3. **Writes are queued, never blocking.** Every student action goes into an
   outbox with a client-generated idempotency key, applies to the local UI
   immediately, and drains when a link appears.

---

## Components

### Student PWA (`web/`)

React + Vite, no UI framework, no web fonts. Built for a 1 GB Android device.

Light, card-based surface with a lilac/amber/sky/mint accent family. The
constraints behind it are the same ones that shaped the rest of the system:

- **No web fonts.** A font file is 30-100 KB the student does not need, so the
  geometric look comes from system UI faces with tight letter-spacing.
- **No raster decoration.** The hero blobs are CSS radial gradients, costing
  bytes in the hundreds rather than the tens of thousands, and they never block
  first paint.
- **Motion limited to opacity and colour.** Entry-level phones drop frames on
  transforms and filters.
- **Dark palette retained** under `prefers-color-scheme`, so a student reading
  outdoors on a cheap LCD, or conserving battery on OLED, still gets it. The
  whole theme is CSS custom properties, so this is one block of overrides
  rather than a second stylesheet.

Connection state is a chip in the top bar rather than a banner across the top:
on a link that flickers all day, a full-width warning becomes noise the student
learns to ignore, but they still need to see at a glance whether their work has
been delivered.

| Module | Responsibility |
|---|---|
| `lib/db.js` | IndexedDB stores: courses, lectures, quizzes, discussion, downloads, outbox |
| `lib/outbox.js` | Offline write queue; push/pull sync with cursors |
| `lib/downloads.js` | Range-resumable chunked downloads, persisted every 512 KB, SHA-256 verified |
| `lib/net.js` | Measured connectivity (RTT-based), not `navigator.onLine` |
| `public/sw.js` | Cache-first shell and media, network-first API reads |

Why RTT rather than a throughput test: a phone attached to a tower with dead
backhaul reports `onLine: true`, and a throughput probe costs the very data the
student is trying to conserve.

### nginx (`nginx/`)

Edge cache and compression. Derived media is immutable and cached for 30 days,
so the origin serves each object roughly once per institute rather than once
per student. `proxy_force_ranges` keeps resumable downloads working through the
cache.

### API Gateway (`server/`)

Express + Socket.IO. Mongo is the only hard dependency; Redis and object
storage degrade rather than fail.

| Route group | Purpose |
|---|---|
| `/api/auth` | Phone + password (no SMS gateway: a recurring cost and an extra failure mode) |
| `/api/lectures` | Upload, manifests with exact byte costs per mode |
| `/media` | Ranged streaming, metered, integrity headers |
| `/api/sync` | Idempotent batch push, cursor-based pull |
| `/api/interactions` | Quizzes, polls, discussion — all routed through the sync applier |
| `/api/credentials` | Issue, revoke, and **publicly** verify |

Online submissions go through the same applier as offline syncs, so there is
exactly one grading path rather than two that can drift.

### Media pipeline (`server/src/services/transcode.js`)

One upload becomes four renditions, committed to the database individually as
they finish — so students can download the audio version while 240p is still
encoding.

| Mode | Encoding | Cost/hour |
|---|---|---|
| `audio` | Opus 24 kbps mono, VoIP profile, silence-trimmed | ~10.5 MB |
| `slides` | Scene-detected WebP (q62, 960px) + audio | ~22 MB |
| `low` | H.264 baseline 144p @ 15 fps | ~90 MB |
| `medium` | H.264 baseline 240p @ 20 fps | ~180 MB |
| `high` | 480p, opt-in only | ~400 MB |

Each video rendition ships as both a faststart MP4 (offline, resumable) and
4-second HLS segments (playback that starts before the file arrives). Four
seconds is deliberate: a dropped connection loses at most that much buffer.

### Single origin

The API serves the built client at `/` when `web/dist` exists, so one address
is the entire app. This is not only convenience:

- No CORS preflight on any request, which on a high-latency rural link is a
  saved round-trip per call.
- The media token never crosses an origin boundary.
- A service worker can only control the origin it is served from, so the
  offline shell requires the client and API to share one.

`/api` and `/media` are excluded from the client-side-routing fallback, so a
bad API call returns JSON rather than an HTML page. nginx still fronts this in
production and takes over static and media caching; the origin behaves the
same either way.

### Media authentication

An `<img>`, `<video>` or `<audio>` tag cannot set an `Authorization` header, so
`/media/*` accepts the same JWT as a `?t=` query parameter in addition to the
header. Consequences that are handled rather than ignored:

- HLS playlists list segments by relative name, so the playlist is rewritten on
  read to stamp the token onto each segment line. Otherwise playback would 401
  partway through a lecture.
- Morgan's `url` token is overridden to redact `t=`, so a usable credential is
  never written to an access log.
- The service worker matches cached media with `ignoreSearch`, so signing in
  again (a new token, new URL) does not silently re-download every saved
  lecture on a metered plan.
- Object-storage connection failures return 503 with `retry: true`, not 500 —
  a download manager should pause and resume, not treat the lecture as broken.

### Shared devices

A phone on a village campus is routinely passed between students, so signing
out wipes the device: all IndexedDB stores and the service worker's API and
media caches. Cached API responses are keyed by URL alone, so without this the
next student would be served the previous one's courses and certificates.

If unsent work is still queued at sign-out, the app tries once more to deliver
it and otherwise names exactly what will be lost before discarding anything.

### Realtime (`server/src/realtime/socket.js`)

30-second heartbeats rather than 25 — across a 200-student cohort on metered
plans, ping frequency is real money. Polling is kept as a transport fallback
because some rural carriers break WebSocket upgrades at their proxies.
Attendance is written on disconnect, so a student who loses signal still has
their time counted.

### Transcode worker (`server/src/workers/`)

Separate process. A 20-minute ffmpeg job must never make the API unresponsive.
Redis list as the queue with a reliable-pop working list; a worker that dies
mid-job leaves its entry for `requeueStale` to recover.

### Analytics (`analytics/`)

FastAPI + pandas + scikit-learn, behind the gateway on a private network.

The at-risk model is unsupervised (KMeans over academic signals) because a new
deployment has no labelled dropouts, and by the time it does, the students it
would have helped are gone. Below six students it falls back to transparent
rules.

**Connectivity features are deliberately excluded from the model.** A student
on audio-only is adapting correctly, not falling behind. Including mode choice
or data usage would train the model to flag poverty instead of difficulty.

### Blockchain (`chaincode/`, `server/src/services/ledger/`)

See [BLOCKCHAIN.md](BLOCKCHAIN.md).

---

## Data flow: a student who was offline all evening

1. Answers a quiz with no signal. Graded locally? No — queued with a
   client-generated `clientOpId` and a local timestamp. The UI says so plainly.
2. Posts a question on the board. Appears instantly, marked *waiting to send*.
3. Next morning, the phone finds a signal. `net.js` probe succeeds.
4. `outbox.flush()` pushes both operations in one batch.
5. The server applies each one, honouring the *original* timestamps, and
   records a `SyncReceipt` keyed by `clientOpId`.
6. A duplicate send — because the response was lost — returns `duplicate` with
   the same result rather than creating a second attempt.
7. `pullChanges` returns only what changed after the stored cursor.

A failure in one operation does not abort the batch: a reply to a deleted
thread should not cost the student their quiz result.
