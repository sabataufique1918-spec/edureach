# Blockchain layer

## The problem it actually solves

A diploma from a rural polytechnic is worth what a verifier believes it is
worth. Today, checking one means emailing a registrar and hoping for a reply.
That asymmetry is a real cost borne by exactly the students this platform
exists to serve.

Anchoring a credential on a ledger changes the question from *"do you trust
this college's server?"* to *"does this fingerprint appear on the ledger?"* —
which anyone can answer, including after this server is switched off.

## What is deliberately *not* on the chain

**No personal data ever reaches the ledger.** Not names, not phone numbers, not
marks.

A ledger is append-only and replicated to every peer organisation. That makes
it precisely the wrong place for student data: it cannot be corrected, cannot
be deleted, and is visible to every participant. Student references on the
chain are keyed HMACs of internal IDs, so the ledger cannot be mined for a
student roster even by a participating organisation.

What is stored per credential:

```json
{
  "credentialId": "CC-M2K9X1-A4F27B0E",
  "type": "course_completion",
  "payloadHash": "9f2c...e10a",
  "studentRef": "hmac-derived, 32 hex chars",
  "courseRef":  "hmac-derived",
  "issuerRef":  "hmac-derived",
  "institute": "Govt. Polytechnic, Latur",
  "issuedAt": "2026-03-14T09:00:00.000Z",
  "issuerMsp": "Org1MSP",
  "revoked": false
}
```

The real credential — with the student's name and grade — stays in the
institute's own database.

## How verification works

1. The holder presents the credential file (`GET /api/credentials/:id`, saved
   as JSON from the app).
2. The verifier's copy is canonicalised: JSON with keys sorted at every depth,
   so the byte string is reproducible by anyone.
3. SHA-256 of those bytes must equal `payloadHash`.
4. `payloadHash` must resolve on the ledger and not be revoked.

Changing a single character of the name or the grade changes the digest, and
step 3 or 4 fails. That is the whole security property, and it does not depend
on trusting this API — a verifier with ledger access can perform steps 2–4
independently.

`POST /api/credentials/verify` with a payload does exactly this, recomputing
rather than looking up. The `GET` form (by ID) is a convenience that trusts the
server's stored copy; the `POST` form is the one that detects forgery.

## Two backends, one interface

`server/src/services/ledger/index.js` picks an adapter at startup. Both expose
`issueCredential`, `revokeCredential`, `getCredential`, `getHistory`,
`verifyByHash`, and `verifyChain`.

### `local-hashchain` (default)

An append-only hash chain in MongoDB. Each block stores `prevHash`, and its own
hash covers the record plus that link. Editing any historical row invalidates
every hash after it; `verifyChain()` walks the chain and reports where it
broke.

This exists because of a constraint in the brief: the solution must be
financially sustainable for a resource-constrained institute. Requiring a
college to stand up and *operate* a Fabric network — orderers, CAs, peers,
channel config — to issue certificates would make the feature dead on arrival.
This runs on the same ₹1,000/month VPS as everything else.

**What it gives up:** no multi-organisation consensus. A sufficiently
determined administrator with database access could rewrite the entire chain
from genesis. It is *tamper-evident*, not *tamper-proof*.

### `fabric`

Hyperledger Fabric via `@hyperledger/fabric-gateway`, running the chaincode in
[`chaincode/edureach-cc`](../chaincode/edureach-cc).

This is what makes the property actually hold: with peers at several colleges
and a university board, rewriting history requires collusion across
organisations rather than one person with a database password. Endorsement
policy decides how many must agree before a certificate is valid.

The chaincode enforces what the application cannot:

- A payload hash maps to exactly one credential — no ambiguous verification.
- **Only the issuing MSP may revoke.** Without this, any college on the channel
  could invalidate another's certificates.
- Timestamps come from the transaction proposal, never `Date.now()`, which
  would differ between endorsing peers and break endorsement.

Switch with `FABRIC_ENABLED=true`. If Fabric is enabled and unreachable, the
service **fails to start rather than silently downgrading** — an institute that
asked for consortium-backed credentials must not be handed weaker ones without
being told.

## Failure handling

Issuing is two-phase: the credential is persisted off-chain first, then
anchored. Anchoring can fail on a bad uplink, so the credential is left
`pending` and swept every ten minutes by `retryPending()`. `ALREADY_EXISTS`
from the ledger is treated as success — it means a previous attempt committed
and only the local status update was lost.

This ordering is deliberate: a credential that exists locally but is not yet
anchored can be fixed. One that was anchored but never stored cannot.

## Deploying the chaincode

Using the Fabric samples test network:

```bash
cd fabric-samples/test-network
./network.sh up createChannel -c edureachchannel -ca
./network.sh deployCC -c edureachchannel \
  -ccn edureach-cc \
  -ccp /path/to/Edureach/chaincode/edureach-cc \
  -ccl javascript
```

Then point the API at it:

```bash
FABRIC_ENABLED=true
FABRIC_CHANNEL=edureachchannel
FABRIC_CHAINCODE=edureach-cc
FABRIC_MSP_ID=Org1MSP
FABRIC_PEER_ENDPOINT=localhost:7051
FABRIC_TLS_CERT_PATH=.../tlsca.org1.example.com-cert.pem
FABRIC_CERT_PATH=.../User1@org1.example.com/msp/signcerts/cert.pem
FABRIC_KEY_PATH=.../User1@org1.example.com/msp/keystore/priv_sk
```

Install the SDK in the API container:

```bash
npm install @hyperledger/fabric-gateway @grpc/grpc-js
```

They are optional dependencies so that a hash-chain deployment does not have to
build grpc.

## Honest limitations

- A ledger proves a credential was issued and not altered. It cannot prove the
  student earned it. Garbage in, immutably preserved garbage out.
- The local hash chain is tamper-*evident* only. Deployments that need a
  stronger guarantee should run Fabric with peers at more than one organisation.
- Anchoring costs one transaction per credential. Bulk issuance at the end of a
  semester is the expensive moment, which is why it is a background sweep and
  not a blocking request.
