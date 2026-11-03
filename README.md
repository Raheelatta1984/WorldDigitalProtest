# World Digital Protest

A platform for one worldwide protest at one shared moment — from any country, city or suburb,
**without physical presence**, on **the same protocol for everyone**, and over **any connection**
(internet, nearby Wi-Fi hotspot, Bluetooth beacon, scanned code, or completely offline).

Every protest shows only what it needs to: the **headline**, the **reason**, and **who is joining**
by country, city and area, by gender and by age — live, all the way to the finish. Nothing else is
collected. Participants are never asked for personal information: each joiner is given an
auto-generated protester name when they join; the only inputs are an age and a gender.

Physical presence, if ever required, is a separate, optional layer: request → verification →
selection across areas → scheduled time window. It is never automatic and never a requirement.

- **One protocol** — 8 articles, identical for every protest in every country, acceptance is the entry requirement
- **No travel required** — digital presence is full participation
- **No personal data** — generated names only; age range, gender, and the country/city/area used for the count
- **Live worldwide KPIs** — country, city, area, region, continent, gender, age, join channel, velocity
- **Live stream per protest** — YouTube live slot + a transparent KPI overlay for broadcast software
- **Test injection** — validate worldwide numbers before launch; injected participants are always labelled and separated

---

## Quick start

```bash
npm install
npm run build:geo     # once: builds the offline geo dataset (already committed, see below)
npm run seed          # optional: 4 sample protests + a realistic global baseline
npm start             # http://localhost:3000
npm test              # 27 protocol + integration tests
node scripts/smoke.js # end-to-end check against a running instance
```

Requires Node.js 20+. No database, no external services, no API keys.

| Command | What it does |
| --- | --- |
| `npm start` | Run the platform (`PORT`, `HOST` honoured) |
| `npm run dev` | Same, with file watching |
| `npm test` | Protocol + full API integration suite (Node test runner) |
| `npm run seed` | Create sample protests and a labelled global test baseline |
| `npm run seed -- --reset` | Wipe everything, then reseed |
| `npm run build:geo` | Rebuild `server/data/geo.json` from GeoNames sources |

---

## How it works

### 1. One protocol for every protest

`server/lib/protocol.js` is the single source of truth. It is served to clients at
`GET /api/protocol` with a content hash, and it is a **wire contract** too: an offline join
envelope records the protocol version and hash it was created under, so queued data cannot be
replayed under different rules.

| # | Article | What it means in practice |
| --- | --- | --- |
| 1 | Peace is the method | No violence, threats, weapons or property damage; disengage and report |
| 2 | One protocol, everywhere | No country or organiser can amend, waive or localise the rules |
| 3 | Nobody has to travel | Digital presence is full participation |
| 4 | Nothing personal, by design | No name, ID, address, email or phone — ever |
| 5 | Numbers must be honest | Injected test data is always labelled and separated |
| 6 | Protect other people | No doxxing, no targeting, no coordinated confrontation |
| 7 | Lawful conduct, always | Local law applies; nothing here coordinates an assembly or obstruction |
| 8 | Enforcement is automatic | Violent language is blocked at creation; breaches are reportable and removed |

**Enforcement is real, not decorative:**

- A join without all four agreements is rejected (`consent_required`) and not counted.
- A join carrying a stale protocol version is rejected (`protocol_version_mismatch`).
- Protest headlines/reasons that contain calls to violence are refused at publish time, and the
  response lists the exact flagged phrases (`violent_language_blocked`).
- Breaches can be reported from any protest page and are queued for review.

### 2. Joining from anywhere, on any connection

| Channel | How it works | `channel` value |
| --- | --- | --- |
| Internet | Direct join from any browser | `web` |
| Shared link | Someone shares the join URL | `internet-link` |
| Nearby Wi-Fi hotspot | One connected device shares its hotspot; others join in range | `wifi-hotspot` |
| Scanned/printed code | QR on a poster, wall or screen | `beacon-qr` |
| Bluetooth beacon | A beacon broadcasts the protest packet; the phone joins | `bluetooth` |
| Fully offline | Join signed on-device, queued, relayed and synced later | `offline-queue` |

A **beacon** (`GET /api/protests/:id/beacon`) contains the protest id, protocol version + hash and a
**15-minute pairing code** — never personal data. It is emitted as a `wdp1:` payload, a rendered QR
code and a short join URL.

```text
wdp1.<base64url(beacon json)>        beacon: BLE / QR / print
body.sig                             signed offline join envelope
body = { t:"wdp-join", v:"1.0", h:<protocol hash>, p:<protest id>,
         c:<pairing code>, iat, exp, nonce }
sig  = HMAC-SHA256(body, sha256("wdp:" + pairingCode + ":" + protocolHash))
```

The server verifies every signature on sync (`/api/join/offline/sync`), so a relay can deliver a
genuine join but cannot forge one, inflate a count, reuse an expired code, or move a joiner to
another country.

### 3. What is measured, and what is never asked

Collected at join time, and nothing else:

- an **age range** (e.g. `25-34`) — the exact age is reduced immediately and discarded
- a **gender** selection (or "prefer not to say")
- a **country, city and area** for the count (from a picked city, a rounded approximate position
  that is resolved to a city and then discarded, or a 6-character code)
- a **channel** label, and a generated **protester name** such as `Quiet Willow #4192`

Never collected: real name, email, phone number, street address, ID documents, photos, contact
lists, advertising identifiers, or precise location history.

### 4. The KPI payload

`GET /api/protests/:id/kpi` returns a consistent, self-checking snapshot:

```jsonc
{
  "total": 4205, "real": 5, "injected": 4200, "target": 1000000, "progress": 0.4,
  "countries":  [{ "code": "CN", "name": "China", "continent": "Asia",
                   "lat": 32.41, "lng": 112.34, "count": 687,
                   "real": 0, "injected": 687, "share": 16.3 }],
  "countryCount": 240, "cities": [...], "cityCount": 1872,
  "regions": [...], "regionCount": 1182, "continents": [...],
  "genders": [...], "ages": [...], "channels": [...],
  "velocity": { "last5": 228, "last60": 2795, "perMinute": 45.6 },
  "minuteSeries": [ ... 60 buckets ... ]
}
```

Invariants (asserted in the test suite): country, gender and age breakdowns each sum to `total`,
`real + injected === total`, and every country carries map coordinates.

### 5. Live streaming and the overlay

- Each protest can carry a YouTube live video id (`PATCH /api/protests/:id` with `youtube.videoId`);
  the protest page embeds the stream and keeps the KPI panel on screen until the protest finishes.
- `overlay.html?id=<protestId>` is a transparent, broadcast-safe KPI overlay for OBS/browser
  sources: headline, big numbers, top countries, gender and age bars, and a live arrival ticker.
- Live updates use **Server-Sent Events** (`GET /api/protests/:id/stream`) with a polling fallback,
  so numbers never freeze behind a buffering proxy. KPI snapshots are coalesced to one per protest
  per second — a 100k-participant spike does not become 100k messages.

### 6. Physical presence — separated, verified, scheduled

`physical.html` and `POST /api/protests/:id/physical-request`. Every request enters
`verificationStatus: "pending"`; nothing is scheduled automatically. Selection rules: small capped
group size, participants drawn from different areas, explicit consent from each person, the same
protocol signed by every scheduled group, and cancellation always available. Declining never
affects digital participation.

### 7. Test injection — validating the world before launch

Injected participants are how the global panels get validated before a real campaign opens. They
are written with `injected: true`, counted separately in every KPI (`real` vs `injected`), shown
with a `test` label in the live ticker, and can be cleared in one call.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/test/inject/:id` | Inject `count` participants, population-weighted by country, spread over N minutes |
| `POST /api/test/inject/:id/worldwide` | Inject the same number in **every** supported country |
| `POST /api/test/inject/:id/clear` | Remove every injected participant |

`testlab.html` wraps these with a **validation panel** (8 automated checks) and a live snapshot.

```bash
curl -X POST localhost:3000/api/test/inject/climate-clock \
  -H 'content-type: application/json' -d '{"count": 50000, "spreadMinutes": 60}'

curl -X POST localhost:3000/api/test/inject/climate-clock/worldwide \
  -H 'content-type: application/json' -d '{"perCountry": 25}'
```

Injection can be disabled with `WDP_ENABLE_INJECTION=false`, and locked with
`WDP_INJECTION_TOKEN` (sent as `x-injection-token`).

---

## Pages

| Page | Purpose |
| --- | --- |
| `index.html` | What the platform is, worldwide totals, open protests |
| `protests.html` | All protests with live counts and progress |
| `protest.html?id=…` | **Live dashboard**: map, KPIs, breakdowns, stream, reports |
| `join.html?p=…` | The join flow: protocol, two questions, area, consent |
| `offline.html` | Bluetooth / hotspot / QR / fully-offline joining, relay and sync |
| `physical.html` | Request physical presence and see the verification pipeline |
| `protocol.html` | The full protocol, wire contract, live language screening |
| `create.html` | Publish a protest (violent language is blocked) |
| `testlab.html` | Inject worldwide test data and validate every panel |
| `overlay.html?id=…` | Transparent KPI overlay for the YouTube live stream |

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/healthz` | Liveness + protocol + geo coverage |
| GET | `/api/protocol` | Protocol articles, consent keys, age bands, hash |
| POST | `/api/protocol/screen` | Screen text for calls to violence |
| GET | `/api/status` | Platform totals, viewers, geo coverage |
| GET | `/api/geo/countries` · `/api/geo/countries/:code` | Countries, regions and cities |
| GET | `/api/geo/cities?q=&country=` | City / area search |
| POST | `/api/geo/resolve` | Reduce a coordinate to a country/region/city (not stored) |
| GET | `/api/protests` | Protest list with totals |
| POST | `/api/protests` | Publish a protest (peace-screened) |
| GET | `/api/protests/:id` | Protest detail incl. full KPI |
| PATCH | `/api/protests/:id` | Update fields, status, YouTube video id |
| POST | `/api/protests/:id/end` | Close a protest |
| GET | `/api/protests/:id/kpi` | KPI snapshot |
| GET | `/api/protests/:id/joiners` | Recent joiners (generated names only) |
| GET | `/api/protests/:id/stream` | **SSE** live channel |
| GET | `/api/protests/:id/beacon` | Beacon payload, QR codes, join URL, pairing code |
| POST | `/api/protests/:id/join` | Online join |
| POST | `/api/join/offline` | Join from a beacon / pairing code |
| POST | `/api/join/offline/envelope` | Issue a signed offline envelope |
| POST | `/api/join/offline/sync` | Verify and accept a batch of envelopes |
| POST | `/api/join/inspect` | Decode a scanned code without joining |
| POST | `/api/protests/:id/report` | Report a protocol breach |
| POST | `/api/protests/:id/physical-request` | Request physical presence (→ verification) |
| GET | `/api/protests/:id/physical-requests` | Requests for a protest |
| POST | `/api/test/inject/:id` · `/worldwide` · `/clear` | Test data |

## Data and attribution

- **Geo dataset**: `server/data/geo.json` — 69,031 cities/areas in 245 countries with 3,734
  regions, built by `scripts/build-geo.mjs` from GeoNames (`cities15000`, `cities5000`, `countries`,
  CC BY 4.0) plus admin1 names from the `cities.json` dataset. The raw sources (46 MB) are **not**
  committed; the built bundle (5.2 MB) is.
- **Basemap**: `public/assets/data/world.map.json` — Natural Earth 110m country polygons
  (public domain), simplified for the live KPI map.
- **App state**: `var/db.json` (git-ignored). Protests, anonymous joiners, pairing codes, reports
  and physical requests. Set `WDP_DATA_DIR` to relocate it.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address |
| `WDP_DATA_DIR` | `./var` | State directory |
| `WDP_ENABLE_INJECTION` | `true` | Enable test injection endpoints |
| `WDP_INJECTION_TOKEN` | *(empty)* | Require `x-injection-token` on injection |
| `WDP_PAIRING_TTL_MS` | `900000` | Pairing-code lifetime (15 min) |
| `YOUTUBE_CHANNEL_URL` | `https://www.youtube.com/@WorldDigitalProtest` | Default channel |
| `WDP_MAX_JOINERS` | `5000000` | Per-protest capacity guard |

## Self-hosting

The app is a single Node process with two runtime dependencies (`express`, `qrcode`) and no
external services, telemetry or third-party scripts. It is designed to run on a small VPS, in a
container, or behind any reverse proxy — including behind restrictive networks where participants
can only reach a local hotspot.

## Scope and safety notes

This platform coordinates **digital** participation and deliberately does **not** coordinate
physical assemblies, marches, blockades or occupations. Article 7 stands: local law always applies.
Physical presence is a separate, verified, optional layer. Peaceful conduct is an enforced entry
requirement, and the platform's own text screening blocks calls to violence at creation time.

## Documentation

- [`docs/STREAMING.md`](docs/STREAMING.md) — attach a protest to a YouTube live stream, add the KPI
  overlay in OBS, and what the overlay shows.
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — deploy, verify, load characteristics, complete data
  model, offline/Bluetooth architecture, and where to extend.

## Licence

GPL-3.0-or-later. See `LICENSE`.
