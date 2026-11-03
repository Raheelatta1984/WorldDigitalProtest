# Third-party data and licences

The application code in this repository is licensed under GPL-3.0-or-later (see `LICENSE`).

Bundled data assets are derived from the following sources:

## GeoNames — CC BY 4.0

- `server/data/geo.json` (generated)
- Source: <https://www.geonames.org/> via the `geonamescache` dataset
  (`cities15000`, `cities5000`, `countries`, `us_states`).
- Used for: country names, ISO codes, continents, city/area coordinates, populations and
  admin-1 region codes.
- Licence: Creative Commons Attribution 4.0 — <https://creativecommons.org/licenses/by/4.0/>
- Attribution text (also embedded in `geo.json`):
  "City and country data from GeoNames (CC BY 4.0)."

## cities.json admin-1 names — MIT

- `server/data/geo.json` (generated, region display names)
- Source: <https://github.com/lutangar/cities.json>
- Licence: MIT.

## Natural Earth — public domain

- `public/assets/data/world.map.json` (generated)
- Source: Natural Earth 110m land polygons via the `world-atlas` package
  (<https://github.com/topojson/world-atlas>).
- Licence: public domain — <https://www.naturalearthdata.com/about/terms-of-use/>

## Runtime dependencies

| Package | Licence | Used for |
| --- | --- | --- |
| `express` | MIT | HTTP server and routing |
| `qrcode` | MIT | Pairing-code QR images |

`world-atlas` is a dev-only dependency used by `npm run build:geo`.

The raw source datasets are not committed; only the generated bundles are, so the app starts with
no network access. `npm run build:geo` documents exactly how they are produced.
