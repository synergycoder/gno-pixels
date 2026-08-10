// Reads REAL historical placements off the old pixelsandbox realm (the
// scratch deployment this project redeployed away from -- see
// contract/pixels.gno's header comment) via direct RPC queries, so
// migration preserves each cell's real original placer address and
// block height through ImportHistoricalPixel. This is deliberately
// separate from official-target.js / center-order.js, which both
// describe the owner-curated DESIGN, not who actually placed what.
//
// Caches to historical-pixels-cache.json next to this file after the
// first fetch -- discovering provenance means one PlacedBy(x,y) RPC
// call per occupied cell (644 of them at last count), and the old
// realm is deprecated/unlinked so its state won't change underneath us.
const fs = require("fs");
const path = require("path");

const OLD_RPC_URL = "https://rpc.sapphire.testnets.gno.land";
const OLD_PKG_PATH = "gno.land/r/g188mapat33awn7r9uk08l0jc9my0n07fpmspxel/pixelsandbox";
const CACHE_PATH = path.join(__dirname, "historical-pixels-cache.json");
const CONCURRENCY = 20;

async function abciQueryEval(expr) {
  const full = `${OLD_PKG_PATH}.${expr}`;
  const dataB64 = Buffer.from(full).toString("base64");
  const path_ = encodeURIComponent('"vm/qeval"');
  const data = encodeURIComponent(`"${dataB64}"`);
  const res = await fetch(`${OLD_RPC_URL}/abci_query?path=${path_}&data=${data}`);
  const json = await res.json();
  const rawB64 = json.result?.response?.ResponseBase?.Data;
  if (!rawB64) return null;
  return Buffer.from(rawB64, "base64").toString("utf8");
}

function parseGnoString(raw) {
  const m = /\("((?:[^"\\]|\\.)*)"\s+[\w.]+\)/s.exec(raw);
  return m ? m[1] : null;
}

function parseGnoInts(raw) {
  return [...raw.matchAll(/(-?\d+)\s+int64\)/g)].map((m) => Number(m[1]));
}

async function fetchBounds() {
  const raw = await abciQueryEval("Bounds()");
  const [minX, maxX, minY, maxY] = parseGnoInts(raw);
  return { minX, maxX, minY, maxY };
}

async function fetchSnapshot() {
  const raw = await abciQueryEval("Snapshot()");
  return parseGnoString(raw);
}

async function fetchPlacedBy(x, y) {
  const raw = await abciQueryEval(`PlacedBy(${x},${y})`);
  const addr = parseGnoString(raw);
  const [height] = parseGnoInts(raw);
  return { placer: addr, height };
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Loads real historical pixels, ordered nearest-to-board-center first
// (same convention as center-order.js) so a budget-capped partial run
// still reads as a recognizable partial logo. Uses the cache file if
// present; pass forceRefresh to re-fetch from chain.
async function loadHistoricalPixels({ forceRefresh = false, onProgress } = {}) {
  if (!forceRefresh && fs.existsSync(CACHE_PATH)) {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  }

  const bounds = await fetchBounds();
  const snapshot = await fetchSnapshot();
  const width = bounds.maxX - bounds.minX + 1;

  const occupied = [];
  for (let i = 0; i < snapshot.length; i++) {
    const c = Number(snapshot[i]);
    if (c === 0) continue;
    const x = bounds.minX + (i % width);
    const y = bounds.minY + Math.floor(i / width);
    occupied.push({ x, y, c });
  }

  let done = 0;
  const withProvenance = await mapWithConcurrency(occupied, CONCURRENCY, async (cell) => {
    const { placer, height } = await fetchPlacedBy(cell.x, cell.y);
    done++;
    if (onProgress) onProgress(done, occupied.length);
    return { ...cell, placer, height };
  });

  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  withProvenance.sort((a, b) => {
    const da = Math.hypot(a.x - centerX, a.y - centerY);
    const db = Math.hypot(b.x - centerX, b.y - centerY);
    return da - db;
  });

  fs.writeFileSync(CACHE_PATH, JSON.stringify(withProvenance));
  return withProvenance;
}

module.exports = { loadHistoricalPixels, fetchBounds, fetchSnapshot, fetchPlacedBy };
