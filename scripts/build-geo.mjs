/**
 * build-geo.mjs
 * ------------
 * Produces the compact offline geodata bundle used by the platform to attribute
 * every joiner to a country -> region (admin1) -> city -> area entry.
 *
 * Sources (dev-time only, not shipped):
 *   - geonamescache cities15000 / cities5000 (GeoNames, CC BY 4.0)
 *   - geonamescache countries (GeoNames, CC BY 4.0)
 *   - world-atlas countries-110m (Natural Earth, public domain) for the live map
 *
 * Output:
 *   server/data/geo.json        countries + regions + city/area index + spatial grid
 *   public/assets/data/world.map.json  simplified world land polygons for the KPI map
 *
 * Run: node scripts/build-geo.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'server', 'data');

const readJson = (f) => JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));

// ---------------------------------------------------------------------------
// 1. Countries (with ISO2/ISO3, continent and display names)
// ---------------------------------------------------------------------------
const CONTINENTS = {
  AF: 'Africa', AS: 'Asia', EU: 'Europe', NA: 'North America',
  SA: 'South America', OC: 'Oceania', AN: 'Antarctica',
};

const rawCountries = readJson('.src-countries.json');
const countries = {};
for (const raw of Object.values(rawCountries)) {
  const iso2 = raw.iso;
  if (!iso2 || iso2.length !== 2) continue;
  countries[iso2] = {
    iso2,
    iso3: raw.iso3,
    name: raw.name,
    continent: CONTINENTS[raw.continentcode] || 'Other',
    continentCode: raw.continentcode,
    population: raw.population || 0,
    areaKm2: raw.areakm2 || 0,
    capital: raw.capital || '',
  };
}

// ---------------------------------------------------------------------------
// 2. Regions (admin1) - localised names where we have them
// ---------------------------------------------------------------------------
const admin1 = readJson('.src-admin1.json');
const regionNames = new Map(); // "AD.06" -> "Sant Julià de Loria"
for (const row of admin1) regionNames.set(row.code, row.name);

const usStates = new Map();
for (const row of Object.values(readJson('.src-us-states.json'))) {
  usStates.set(row.code, row.name);
}

// ---------------------------------------------------------------------------
// 3. Cities / areas
// ---------------------------------------------------------------------------
const merge = (primary, secondary) => {
  const seen = new Set();
  const out = [];
  for (const city of [...primary, ...secondary]) {
    const key = `${city.name}|${city.countrycode}|${city.admin1code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(city);
  }
  return out;
};

// Large + medium cities give global coverage: every country has at least one,
// and mid-size towns become the "area / suburb" layer.
const rawCities = merge(
  Object.values(readJson('.src-cities15000.json')),
  Object.values(readJson('.src-cities5000.json'))
);

const cityList = [];
const seenCity = new Set();
for (const city of rawCities) {
  const cc = city.countrycode;
  if (!cc || !countries[cc]) continue;
  if (!Number.isFinite(city.latitude) || !Number.isFinite(city.longitude)) continue;
  const id = `${cc}-${city.geonameid}`;
  if (seenCity.has(id)) continue;
  seenCity.add(id);

  const regionCode = city.admin1code ? `${cc}.${city.admin1code}` : '';
  const regionName =
    usStates.get(city.admin1code) || regionNames.get(regionCode) || '';

  cityList.push({
    id,
    name: city.name,
    cc,
    lat: Math.round(city.latitude * 1e4) / 1e4,
    lng: Math.round(city.longitude * 1e4) / 1e4,
    pop: city.population || 0,
    region: regionName,
    tz: city.timezone || '',
  });
}

cityList.sort((a, b) => b.pop - a.pop);

// Population-weighted centroid per country, used to place map bubbles.
const centroidAcc = {};
for (const city of cityList) {
  const acc = centroidAcc[city.cc] || (centroidAcc[city.cc] = { x: 0, y: 0, w: 0 });
  const weight = Math.max(1, Math.sqrt(city.pop));
  acc.x += city.lng * weight;
  acc.y += city.lat * weight;
  acc.w += weight;
}
for (const [cc, acc] of Object.entries(centroidAcc)) {
  if (!countries[cc] || !acc.w) continue;
  countries[cc].lat = Math.round((acc.y / acc.w) * 100) / 100;
  countries[cc].lng = Math.round((acc.x / acc.w) * 100) / 100;
}

// ---------------------------------------------------------------------------
// 4. Spatial grid so point lookups stay O(1) at runtime
//    Buckets are 1 degree; each bucket keeps the nearest few candidate ids.
// ---------------------------------------------------------------------------
const GRID = 1; // degrees
const grid = new Map();
const bucketKey = (lat, lng) => `${Math.floor(lat / GRID)}:${Math.floor(lng / GRID)}`;

cityList.forEach((city, index) => {
  const k = bucketKey(city.lat, city.lng);
  let bucket = grid.get(k);
  if (!bucket) {
    bucket = [];
    grid.set(k, bucket);
  }
  bucket.push(index);
});

const compactGrid = {};
for (const [k, ids] of grid) {
  // Cap bucket size: keep the most populous candidates (they win tie-breaks).
  compactGrid[k] = ids.slice(0, 60);
}

// Every country needs a fallback anchor (largest city) for users in territories
// without a mapped city row.
const countryAnchor = {};
for (const city of cityList) {
  if (!countryAnchor[city.cc]) countryAnchor[city.cc] = city.id;
}

// Region (admin1) metadata, derived from cities, used for the KPI breakdown.
const regions = new Map();
for (const city of cityList) {
  if (!city.region) continue;
  const key = `${city.cc}|${city.region}`;
  if (!regions.has(key)) {
    regions.set(key, { cc: city.cc, name: city.region, cities: 0, population: 0 });
  }
  const r = regions.get(key);
  r.cities += 1;
  r.population += city.pop;
}

const geo = {
  version: 1,
  generatedAt: new Date().toISOString(),
  attribution:
    'City and country data from GeoNames (CC BY 4.0); basemap from Natural Earth (public domain).',
  gridSize: GRID,
  countries,
  regions: [...regions.values()].sort((a, b) => b.population - a.population),
  cities: cityList.map((c) => [c.id, c.name, c.cc, c.lat, c.lng, c.pop, c.region]),
  countryAnchor,
  grid: compactGrid,
};

fs.writeFileSync(path.join(dataDir, 'geo.json'), JSON.stringify(geo));
const sizeMb = (fs.statSync(path.join(dataDir, 'geo.json')).size / 1048576).toFixed(2);
console.log(`geo.json  ${cityList.length} cities / ${Object.keys(countries).length} countries / ${regions.size} regions  (${sizeMb} MB)`);

// ---------------------------------------------------------------------------
// 5. World basemap for the KPI map (TopoJSON land -> simplified GeoJSON polygons)
//
// The dashboard map uses an equirectangular projection cropped to the inhabited
// latitudes (LAT_MAX..LAT_MIN). Antarctica is excluded and rings that cross the
// antimeridian are split, otherwise the fill would streak across the whole map.
// ---------------------------------------------------------------------------
const topo = JSON.parse(
  fs.readFileSync(path.join(root, 'node_modules', 'world-atlas', 'land-110m.json'), 'utf8')
);

const LAT_MAX = 84;
const LAT_MIN = -58;

const decodeArc = (index) => {
  const { scale, translate } = topo.transform;
  const arc = topo.arcs[index < 0 ? ~index : index];
  let x = 0;
  let y = 0;
  return arc.map(([dx, dy]) => {
    x += dx;
    y += dy;
    return [
      Math.round((x * scale[0] + translate[0]) * 10) / 10,
      Math.round((y * scale[1] + translate[1]) * 10) / 10,
    ];
  });
};

const ringPoints = (ring) => {
  const points = [];
  for (const idx of ring) {
    const arc = decodeArc(idx);
    const slice = points.length ? arc.slice(1) : arc;
    points.push(...slice);
  }
  return points;
};

/** Split a ring wherever it jumps across the antimeridian. */
const splitAntimeridian = (ring) => {
  const segments = [];
  let current = [];
  let previous = null;
  for (const point of ring) {
    if (previous && Math.abs(point[0] - previous[0]) > 180) {
      if (current.length >= 4) segments.push(current);
      current = [point];
    } else {
      current.push(point);
    }
    previous = point;
  }
  if (current.length >= 4) segments.push(current);
  return segments;
};

/**
 * Sutherland-Hodgman clip of a polygon ring against a latitude band. Clipping
 * (rather than clamping) keeps the coastline shape at the top and bottom edges
 * instead of drawing a straight cut line across the map.
 */
const clipToLatBand = (ring, minLat, maxLat) => {
  const clipEdge = (points, keep, intersect) => {
    const out = [];
    for (let i = 0; i < points.length; i += 1) {
      const current = points[i];
      const previous = points[(i + points.length - 1) % points.length];
      const currentIn = keep(current);
      const previousIn = keep(previous);
      if (currentIn) {
        if (!previousIn) out.push(intersect(previous, current));
        out.push(current);
      } else if (previousIn) {
        out.push(intersect(previous, current));
      }
    }
    return out;
  };

  const latAt = (a, b, lat) => {
    const t = (lat - a[1]) / (b[1] - a[1]);
    return [a[0] + t * (b[0] - a[0]), lat];
  };

  let result = clipEdge(ring, (p) => p[1] <= maxLat, (a, b) => latAt(a, b, maxLat));
  if (!result.length) return [];
  result = clipEdge(result, (p) => p[1] >= minLat, (a, b) => latAt(a, b, minLat));
  return result;
};

const polygons = [];
const pushPolygon = (ring) => {
  const clipped = clipToLatBand(ring, LAT_MIN, LAT_MAX);
  if (clipped.length < 4) return;
  const xs = clipped.map((p) => p[0]);
  const ys = clipped.map((p) => p[1]);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  // Skip anything sub-pixel at dashboard scale (keeps the basemap light).
  if (width < 1.2 && height < 1.2) return;
  polygons.push({
    rings: [clipped.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10])],
  });
};

for (const geometry of topo.objects.land.geometries || [topo.objects.land]) {
  const shapes = geometry.type === 'Polygon' ? [geometry.arcs] : geometry.arcs || [];
  for (const shape of shapes) {
    const outer = ringPoints(shape[0]);
    // Antarctica and the sub-antarctic islands are outside the inhabited band.
    const meanLat = outer.reduce((sum, p) => sum + p[1], 0) / outer.length;
    if (meanLat < LAT_MIN + 2) continue;
    for (const segment of splitAntimeridian(outer)) pushPolygon(segment);
  }
}

const worldMap = { polygons, latMax: LAT_MAX, latMin: LAT_MIN };
fs.writeFileSync(
  path.join(root, 'public', 'assets', 'data', 'world.map.json'),
  JSON.stringify(worldMap)
);
console.log(
  `world.map.json  ${polygons.length} land polygons  (${(
    fs.statSync(path.join(root, 'public', 'assets', 'data', 'world.map.json')).size / 1024
  ).toFixed(0)} KB)`
);

// ---------------------------------------------------------------------------
// 6. Sanity checks
// ---------------------------------------------------------------------------
const uniqueCountries = new Set(cityList.map((c) => c.cc));
if (uniqueCountries.size < 200) {
  throw new Error(`Expected >= 200 countries with cities, got ${uniqueCountries.size}`);
}
if (!geo.countryAnchor.AU || !geo.countryAnchor.US) {
  throw new Error('Country anchors missing for AU/US');
}
console.log(`coverage: ${uniqueCountries.size} countries, ${cityList.length} areas`);
