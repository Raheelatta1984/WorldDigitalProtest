# Operations

How to run, verify and extend a World Digital Protest deployment.

## Deploy

```bash
npm install --omit=dev
npm start                     # or: docker build -t wdp . && docker run -p 3000:3000 -v wdp:/data wdp
```

`server/data/geo.json` (5.2 MB, 69,031 areas in 245 countries) and
`public/assets/data/world.map.json` (54 KB basemap) are committed, so a fresh clone starts without
any dataset download. Rebuild them only if you change the geo sources:

```bash
npm run build:geo             # needs the raw GeoNames sources in server/data/.src-*.json
```

State lives in `var/db.json` (or `$WDP_DATA_DIR/db.json`). It contains protests, anonymous joiners,
pairing codes, breach reports and physical-presence requests — nothing that identifies a person.
Back it up by copying the file; writes are atomic (temp file + rename).

## Verify a deployment

```bash
npm test                      # 27 unit + integration tests
node scripts/smoke.js http://localhost:3000
```

The smoke script walks the whole promise: protocol integrity, peace screening, an online join, an
offline beacon join, signed-envelope sync (accepting a genuine envelope and rejecting a forgery),
KPI consistency, worldwide injection, and the live SSE channel.

## Load characteristics

Measured on a single process:

| Operation | Result |
| --- | --- |
| Inject 100,000 participants | ~2 s |
| KPI snapshot for 450k participants | ~9 ms |
| 450k participants of stored state | ~13 MB (1.8 MB gzipped) |
| Live channel | one coalesced KPI push per protest per second |

Injected test data is aggregated per city with nested gender/age/channel/minute counters, so its
storage cost grows with geographic diversity, not with participant count.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT`, `HOST` | `3000`, `0.0.0.0` | Listen address |
| `WDP_DATA_DIR` | `./var` | State directory |
| `WDP_ENABLE_INJECTION` | `true` | Test injection endpoints |
| `WDP_INJECTION_TOKEN` | *(empty)* | Require `x-injection-token` header for injection |
| `WDP_PAIRING_TTL_MS` | `900000` | Pairing-code lifetime (15 min) |
| `WDP_MAX_JOINERS` | `5000000` | Per-protest capacity guard |
| `YOUTUBE_CHANNEL_URL` | `https://www.youtube.com/@WorldDigitalProtest` | Default channel |

**Production checklist**

- Set `WDP_ENABLE_INJECTION=false` (or require a token) before a real campaign opens.
- Clear seeded test data: `POST /api/test/inject/<protest>/clear` for each protest.
- Put the app behind TLS; the pairing link and beacon carry the origin they were issued from.
- Set `YOUTUBE_CHANNEL_URL` (and optionally `YOUTUBE_CHANNEL_ID`) for your channel.

## Data model (complete)

Per participant, and nothing else:

| Field | Example | Notes |
| --- | --- | --- |
| `name` | `Quiet Willow #4192` | Generated on join, deterministic per device + protest |
| `anonId` | `1o5681f` | Derived hash, not reversible |
| `ageBand` | `25-34` | Exact age is reduced immediately and discarded |
| `gender` | `non-binary` | One of four options including "prefer not to say" |
| `country` / `region` / `city` | `KE` / `Nairobi` / `Nairobi` | For the count only |
| `channel` | `bluetooth` | How they joined |
| `at` | ISO timestamp | For the arrival chart |

Deliberately absent: real name, email, phone, street address, ID, photos, precise coordinates,
contact lists, advertising identifiers, location history.

## Offline and Bluetooth architecture

1. **Beacon** — `GET /api/protests/:id/beacon` returns a `wdp1:` payload (protest id, protocol
   version + hash, 15-minute pairing code), a QR image, and a short join URL. It contains no
   personal data and is safe to print or broadcast.
2. **Offline join** — `POST /api/join/offline` accepts a beacon and joins over any transport that
   eventually reaches the server (hotspot, relayed device, café Wi-Fi).
3. **Signed envelope** — `POST /api/join/offline/envelope` issues an HMAC-signed token bound to the
   pairing code and protocol hash, so a device with no network can join now and sync later.
4. **Sync** — `POST /api/join/offline/sync` verifies each signature before counting it. A relay can
   deliver a genuine join but cannot forge one, inflate a count, reuse an expired code, or change the
   country in the envelope.

## Extending

| Goal | Where |
| --- | --- |
| Add or reword a protocol rule | `server/lib/protocol.js` (bump `protocolVersion` in `server/config.js`) |
| Add a demographic or breakdown | `buildKpi` in `server/lib/store.js` + a panel in `public/protest.html` |
| Change generated name pools | `server/lib/pseudonym.js` |
| Add a join channel | pass a new `channel` value from the client; it is counted automatically |
| Swap storage | `server/lib/store.js` is the only module that touches persistence |
| Custom map styling | `createMap` in `public/assets/js/core.js` |
