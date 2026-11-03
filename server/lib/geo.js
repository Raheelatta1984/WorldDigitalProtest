import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';

/**
 * Geo attribution.
 *
 * The platform only ever stores the country, region, city and area a joiner is
 * counted in. There is no street address, no GPS trace, no device location
 * history: a coordinate (when the browser offers one, which is optional) is
 * immediately reduced to the nearest known city and then discarded.
 */

let geo = null;
let cityById = new Map();
let citiesByCountry = new Map();
let sortedCityIndex = null;

function load() {
  if (geo) return geo;
  const file = path.join(config.dataDir, 'geo.json');
  if (!fs.existsSync(file)) {
    throw new Error(
      'Geo dataset missing. Run `npm run build:geo` before starting the server.'
    );
  }
  geo = JSON.parse(fs.readFileSync(file, 'utf8'));
  cityById = new Map();
  citiesByCountry = new Map();
  sortedCityIndex = geo.cities.map((row) => {
    const city = {
      id: row[0],
      name: row[1],
      cc: row[2],
      lat: row[3],
      lng: row[4],
      pop: row[5],
      region: row[6] || '',
    };
    cityById.set(city.id, city);
    if (!citiesByCountry.has(city.cc)) citiesByCountry.set(city.cc, []);
    citiesByCountry.get(city.cc).push(city);
    return city;
  });
  return geo;
}

export function geodbStats() {
  load();
  return {
    countries: Object.keys(geo.countries).length,
    cities: geo.cities.length,
    regions: geo.regions.length,
    version: geo.version,
    generatedAt: geo.generatedAt,
    gridSize: geo.gridSize,
  };
}

export function listCountries() {
  load();
  return Object.values(geo.countries)
    .map((c) => ({
      ...c,
      cityCount: (citiesByCountry.get(c.iso2) || []).length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getCountry(iso2) {
  load();
  return geo.countries[String(iso2 || '').toUpperCase()] || null;
}

export function getCity(id) {
  load();
  return cityById.get(String(id || '')) || null;
}

export function getCountryAnchor(iso2) {
  load();
  return cityById.get(geo.countryAnchor[String(iso2 || '').toUpperCase()]) || null;
}

export function searchCountries(query, limit = 20) {
  load();
  const q = String(query || '').trim().toLowerCase();
  const all = listCountries();
  if (!q) return all.slice(0, limit);
  return all
    .filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.iso2.toLowerCase() === q ||
        c.iso3.toLowerCase() === q
    )
    .slice(0, limit);
}

export function searchCities(query, { country, limit = 25 } = {}) {
  load();
  const q = String(query || '').trim().toLowerCase();
  const cc = country ? String(country).toUpperCase() : null;
  const pool = cc ? citiesByCountry.get(cc) || [] : sortedCityIndex;
  if (!q) return pool.slice(0, limit);
  const results = [];
  for (const city of pool) {
    if (city.name.toLowerCase().startsWith(q)) {
      results.push(city);
      if (results.length >= limit) break;
    }
  }
  if (results.length < limit) {
    for (const city of pool) {
      if (!city.name.toLowerCase().includes(q)) continue;
      if (results.includes(city)) continue;
      results.push(city);
      if (results.length >= limit) break;
    }
  }
  return results.map((c) => ({ ...c, countryName: geo.countries[c.cc]?.name || c.cc }));
}

export function listRegions(country) {
  load();
  const cc = String(country || '').toUpperCase();
  if (!cc) return [];
  return geo.regions.filter((r) => r.cc === cc);
}

export function listCitiesInCountry(country, { region, limit = 60 } = {}) {
  load();
  const cc = String(country || '').toUpperCase();
  const pool = (citiesByCountry.get(cc) || []).filter(
    (c) => !region || c.region.toLowerCase() === String(region).toLowerCase()
  );
  return pool.slice(0, limit);
}

const R = 6371.0088; // km
const toRad = (deg) => (deg * Math.PI) / 180;

export function distanceKm(aLat, aLng, bLat, bLng) {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Nearest known city for a coordinate, searched outward from the containing grid
 * bucket so lookups stay fast even for a very large city index.
 */
export function nearestCity(lat, lng) {
  load();
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  const g = geo.gridSize;
  const baseI = Math.floor(lat / g);
  const baseJ = Math.floor(lng / g);
  let best = null;
  let bestDistance = Infinity;

  for (let ring = 0; ring <= 30; ring += 1) {
    let found = false;
    for (let di = -ring; di <= ring; di += 1) {
      for (let dj = -ring; dj <= ring; dj += 1) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== ring) continue;
        const bucket = geo.grid[`${baseI + di}:${baseJ + dj}`];
        if (!bucket) continue;
        found = true;
        for (const index of bucket) {
          const city = sortedCityIndex[index];
          if (!city) continue;
          const d = distanceKm(lat, lng, city.lat, city.lng);
          // Smaller populations lose ties to larger ones within 5 km, so a
          // suburb never swallows the metro area it sits inside.
          const adjusted = d + (d < 5 ? -Math.min(4, city.pop / 250000) : 0);
          if (adjusted < bestDistance) {
            bestDistance = adjusted;
            best = city;
          }
        }
      }
    }
    // Once we have a hit, one extra ring is enough to confirm the minimum.
    if (best && ring > 0 && bestDistance < ring * g * 60) break;
  }

  if (!best) return null;
  return { ...best, distanceKm: Math.round(bestDistance * 10) / 10 };
}

/**
 * Resolve whatever the client gave us into a stored location. The output never
 * contains the raw coordinate.
 */
export function resolveLocation(input = {}) {
  const country = input.country ? String(input.country).toUpperCase() : '';
  let city = null;

  if (input.cityId) city = getCity(input.cityId);
  if (!city && Number.isFinite(Number(input.lat)) && Number.isFinite(Number(input.lng))) {
    city = nearestCity(Number(input.lat), Number(input.lng));
  }
  if (!city && country) city = getCountryAnchor(country);

  if (!city) {
    // Absolute last resort: unknown location is still counted, but separately.
    return {
      country: country || 'ZZ',
      countryName: 'Unknown',
      continent: 'Other',
      region: '',
      city: String(input.city || '').slice(0, 80),
      area: '',
      cityId: '',
      source: 'unknown',
    };
  }

  const meta = geo.countries[city.cc];
  return {
    country: city.cc,
    countryName: meta?.name || city.cc,
    continent: meta?.continent || 'Other',
    region: city.region || '',
    city: city.name,
    area: city.region ? `${city.name}, ${city.region}` : city.name,
    cityId: city.id,
    source: input.cityId ? 'selected' : input.city ? 'named' : 'coordinate',
  };
}

export const geoStats = geodbStats;
