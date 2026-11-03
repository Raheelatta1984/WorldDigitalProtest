/**
 * Live event hub (Server-Sent Events).
 *
 * Every protest has its own channel so a dashboard, a stream overlay, a phone
 * and a projector all see the same numbers at the same time. Updates are
 * coalesced per protest: a worldwide spike of a hundred thousand joiners still
 * produces one KPI snapshot per second instead of a hundred thousand messages.
 */

const clients = new Map(); // protestId -> Set<res>
const dirty = new Set();
let flushTimer = null;
let kpiProvider = null;
let summaryProvider = null;
let snapshotFn = null;

export function attachProviders({ kpi, summary, snapshot }) {
  kpiProvider = kpi;
  summaryProvider = summary;
  snapshotFn = snapshot;
}

function roomOf(protestId) {
  if (!clients.has(protestId)) clients.set(protestId, new Set());
  return clients.get(protestId);
}

function write(res, event, data) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

/** Per-protest counter: push an event that carries the new running totals. */
export function publishJoin(protestId, joiner) {
  const kpi = kpiProvider ? kpiProvider(protestId) : null;
  publish(protestId, 'join', {
    protestId,
    name: joiner.name,
    country: joiner.country,
    countryName: joiner.countryName,
    city: joiner.city,
    region: joiner.region,
    gender: joiner.gender,
    ageBand: joiner.ageBand,
    channel: joiner.channel,
    injected: Boolean(joiner.injected),
    at: joiner.at,
    total: kpi ? kpi.total : null,
    countryCount: kpi ? kpi.countryCount : null,
    cityCount: kpi ? kpi.cityCount : null,
  });
}

export function subscribe(protestId, res, { replay = true } = {}) {
  const room = roomOf(protestId);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Tell EventSource to reconnect after 3s and disable proxy buffering.
  res.write('retry: 3000\n\n');
  room.add(res);

  if (replay && kpiProvider) {
    write(res, 'snapshot', {
      protestId,
      kpi: kpiProvider(protestId),
      summary: summaryProvider ? summaryProvider(protestId) : null,
      snapshot: snapshotFn ? snapshotFn(protestId) : null,
    });
  }
  write(res, 'hello', { protestId, at: new Date().toISOString(), clients: room.size });

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* cleaned up by the close handler */
    }
  }, 25000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  const cleanup = () => {
    clearInterval(heartbeat);
    room.delete(res);
    if (room.size === 0) clients.delete(protestId);
  };
  res.on('close', cleanup);
  res.on('error', cleanup);

  return cleanup;
}

export function publish(protestId, event, data) {
  const room = clients.get(protestId);
  if (!room || room.size === 0) return 0;
  let sent = 0;
  for (const res of [...room]) {
    if (write(res, event, data)) sent += 1;
  }
  return sent;
}

/**
 * Mark a protest's KPI as changed. A single 1s timer pushes one snapshot per
 * protest, so a spike of 100k joiners produces ~1 message/second, not 100k.
 */
export function markDirty(protestId) {
  if (!protestId || !kpiProvider || !clients.has(protestId)) return;
  dirty.add(protestId);
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    if (dirty.size === 0) {
      clearInterval(flushTimer);
      flushTimer = null;
      return;
    }
    const ids = [...dirty];
    dirty.clear();
    for (const id of ids) {
      const kpi = kpiProvider(id);
      if (!kpi) continue;
      publish(id, 'kpi', {
        protestId: id,
        kpi,
        summary: summaryProvider ? summaryProvider(id) : null,
      });
    }
  }, 1000);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

export function clientCount(protestId) {
  return (clients.get(protestId) || new Set()).size;
}

export function totalClients() {
  let total = 0;
  for (const room of clients.values()) total += room.size;
  return total;
}

export function peerCounts() {
  const out = {};
  for (const [id, room] of clients) out[id] = room.size;
  return out;
}
