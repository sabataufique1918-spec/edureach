# EduReach

**A low-bandwidth virtual classroom for rural institutes, with blockchain-anchored academic credentials.**

Rural diploma colleges rarely have subject lecturers in AI, VLSI, or renewable
energy, and rarely have the bandwidth to import one over a video call. EduReach
brings expert instruction to those campuses over connections that conventional
conferencing tools cannot use, and issues certificates that a third party can
verify without trusting this server.

---

## What makes it work on a bad connection

| Decision | Effect |
|---|---|
| Audio-first by default (Opus, 24 kbps mono) | One hour of lecture costs ~10 MB per student |
| Slides mode: scene-detected WebP images + audio | Visual teaching at ~22 MB/hr instead of ~180 |
| Control plane separated from media | A live class costs only what its audio costs |
| Poll updates sent as deltas | A vote is tens of bytes, not a re-sent object |
| Range-resumable downloads, persisted every 512 KB | A drop at 80% resumes at 80% |
| Offline-first client (IndexedDB + service worker) | Quizzes, reading, and playback work with no signal |
| Idempotent sync queue | Retrying over a flaky link cannot duplicate work |

Measured against the brief, for a one-hour class with 200 students:

| Mode | Per student | Cohort total |
|---|---|---|
| Audio only | ~10.6 MB | ~2.1 GB |
| Slides + audio | ~22 MB | ~4.3 GB |
| Video 144p | ~90 MB | ~18 GB |
| Video 240p | ~180 MB | ~36 GB |

---

## Architecture

```
  Student PWA (React, IndexedDB, Service Worker)
        |  low-bandwidth
        v
  nginx / CDN  --- caches media + compresses JSON
        |
        v
  API Gateway (Node + Express + Socket.IO)
        |
   +----+--------+-------------+
   v             v             v
 MongoDB       Redis        Socket.IO
 app data    cache/queue    realtime
   |
   v
 Object storage (S3 / MinIO) --> FFmpeg worker --> HLS + Opus + WebP
   |
   v
 Blockchain layer (Hyperledger Fabric)   AI / Analytics
 credential hashes, certificate proof,   (Python, pandas,
 academic records, verification           scikit-learn, FastAPI)
```

Detailed component notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Blockchain design and threat model: [docs/BLOCKCHAIN.md](docs/BLOCKCHAIN.md).

---

## Repository layout

```
server/            Node API gateway, media pipeline, sync engine, ledger adapters
  src/services/ledger/   fabricChain.js | localChain.js  (same interface)
  src/workers/           ffmpeg transcode worker
chaincode/         Hyperledger Fabric chaincode (Node contract)
analytics/         FastAPI + pandas + scikit-learn service
web/               React PWA: offline library, live session, quizzes, certificates
nginx/             Edge cache and compression rules
```

---

## Running it

### 1. Infrastructure

```bash
cp .env.example .env
docker compose up -d mongo redis minio minio-init
```

### 2. API and worker

```bash
cd server
npm install
npm run seed      # demo users, courses, quiz attempts, anchored credentials
npm start         # http://localhost:4000
npm run worker    # in a second terminal (needs ffmpeg on PATH)
```

**No Docker?** Build the client once, then one command runs everything against
an ephemeral in-process MongoDB, seeded and ready:

```bash
cd web && npm install && npm run build
cd ../server && npm run sandbox
```

Then open **http://localhost:4000** -- the API serves the built client from the
same origin, so that one address is the whole app. No CORS preflight on any
request, and the service worker registers properly, which it cannot do across
two origins.

Redis and object storage are not started by the sandbox, and the API degrades
accordingly: caching falls through to Mongo, and media upload and playback are
unavailable. Everything else -- auth, courses, quizzes, the offline sync queue,
and the whole credential and verification path -- works.

### 3. Web client

```bash
cd web
npm install
npm run build     # served by the API at http://localhost:4000
npm run dev       # or hot-reload at http://localhost:5173 (proxies to :4000)
```

The API serves `web/dist` at `/` whenever it exists, with client-side routing
so deep links like `/credentials` survive a refresh. `/api` and `/media` are
excluded from that fallback, so a bad API call still returns JSON rather than
an HTML page. Use the dev server while working on the UI; use the built client
for everything else.

### 4. Analytics (optional)

```bash
cd analytics
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Or run everything at once with `docker compose up -d` (includes ffmpeg in the
API image).

### Demo logins

The login screen lists these and signs you in with one tap, so nobody has to
type them. The panel is served by `GET /api/auth/demo-accounts`, which returns
nothing unless **both** guards pass: `NODE_ENV` is not `production`, and the
seeded demo users actually exist. A real deployment satisfies neither, so the
panel cannot appear there.

| Role | Phone | Password |
|---|---|---|
| Teacher | `9000000001` | `teach1234` |
| Student | `9000000011` | `learn1234` |
| Student (at risk, for the analytics view) | `9000000013` | `learn1234` |

---

## The blockchain layer

Academic credentials are anchored on a ledger so that a certificate can be
checked by an employer or another college **without trusting this server**.

The ledger stores a SHA-256 fingerprint of the credential and nothing else. No
student names, phone numbers, or marks ever reach the chain — the institute
keeps the record, and the chain only makes altering one detectable.

Two interchangeable backends behind one interface:

- **`local-hashchain`** (default) — append-only hash chain in MongoDB. Every
  block commits to its predecessor, so editing history breaks every hash after
  it. No Fabric network required, which means the feature works on a ₹1,000/mo
  VPS from day one.
- **`fabric`** — Hyperledger Fabric via `@hyperledger/fabric-gateway`, running
  the chaincode in [`chaincode/`](chaincode/). Adds multi-organisation
  consensus and endorsement policies for a university consortium.

Switching is a config change, not a rewrite:

```bash
FABRIC_ENABLED=true
```

Try it:

```bash
# Public verification, no account needed
curl "http://localhost:4000/api/credentials/verify?credentialId=CC-..."

# Chain integrity check
curl http://localhost:4000/api/credentials/ledger/status
```

The web client exposes the same at `/verify`, including file-based
verification that re-hashes a certificate the holder presents — which is what
catches a forged one.

---

## Cost

Sized for a resource-constrained institute, per the brief:

| Component | Monthly |
|---|---|
| Server (2 GB VPS) | ₹1,000 – 2,000 |
| Object storage (10–50 GB) | ₹500 – 1,000 |
| CDN / transfer (with edge caching) | ₹1,000 – 3,000 |
| Maintenance | ₹5,000 – 10,000 |

Every dependency is open-source. There are no per-seat licences and no
specialised hardware.

---

## Tests

```bash
cd server && npm test                 # 40 tests: ledger, offline sync, media auth
cd analytics && python test_risk.py   # 8 tests: at-risk model
```

These run without any infrastructure — the models are exercised against
in-memory stores, so the logic under test is exactly the code that ships.

What they cover:

- **Ledger** — canonical hashing is order-independent; any altered field
  changes the digest; blocks link to their predecessors; editing a stored
  record breaks `verifyChain`; recomputing a block hash to hide an edit still
  breaks the *next* block's link; deleting a block is detected; 25 concurrent
  issuances produce no duplicate block index.
- **Sync** — grading; resending an operation three times records it once and
  returns the original result; offline timestamps are preserved, not
  overwritten with the sync time; one bad operation does not discard the rest
  of the batch; 4xx failures are marked non-retryable so the client stops
  burning data on them.
- **At-risk model** — students who work offline on audio-only score no higher
  than academically identical students on good connections; connectivity never
  enters the feature set; students in genuine difficulty rank top.
- **Media auth** — the query-string token path accepts only tokens signed with
  this secret, rejects expired ones, rejects an array of values, and the normal
  API guard still refuses a token supplied in the URL.

### Verified by running it

The stack has been run and driven end-to-end (API sandbox + PWA in a headless
browser at phone viewport):

- Login, course list, quiz delivery (answer keys confirmed stripped from the
  student payload -- 746 bytes for a 3-question quiz).
- **Offline cycle**: network cut at the browser, a post written while offline
  appears instantly marked *waiting to send*, the status bar reads
  `Offline | 1 to sync`, and on reconnect the outbox drains to `All synced`.
  The post lands server-side with `postedOffline: true`.
- **Sync idempotency**: the same 3-operation batch sent three times produced
  `applied: 2` then `duplicates: 2, duplicates: 2` -- one attempt in the
  database, and the 404 marked `retryable: false`.
- An offline attempt answered at 21:30 the previous day kept that timestamp
  through the sync, rather than being stamped with the sync time.
- **Credentials**: bulk issuance skipped a student below the pass mark;
  the canonical payload re-hashed independently to the anchored digest;
  a payload with `averagePercent` edited from 78 to 95 was rejected with
  *hash is not present on the ledger*; revocation flipped verification to
  false and appended block #3 rather than rewriting block #2; the chain
  reported `intact: true` throughout.
- Zero console errors and zero failed requests on every screen.

### Not run

The **media pipeline** (upload, ffmpeg transcode, HLS/range delivery) has not
been exercised against a real video file -- it needs MinIO and Redis, which
need Docker. Docker Desktop will not start on this machine because WSL is not
installed:

```powershell
wsl --install     # requires a reboot
```

then `docker compose up -d` and `npm run seed` for the full path.
