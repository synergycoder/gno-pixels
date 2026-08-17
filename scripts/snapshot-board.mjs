// Durable, git-tracked backup of the live board's full state and
// provenance — the spiritual twin of local-deploy/historical-source.js,
// which recovered the OLD pixelsandbox realm's history the same way for
// the migration onto the current realm. Point of this script: if the
// CURRENT realm's chain (sapphire-1) ever gets sunset, whatever this last
// wrote to data/board-snapshot.json is everything local-deploy's existing
// /migrate/start + ImportHistoricalPixel tooling needs to replay the
// community's art onto a new realm on a new chain — the same playbook,
// just run again with a different target. Never depend on sapphire-1
// itself remaining queryable to recover this later; that's the whole risk
// this exists to remove.
//
// Does NOT use Snapshot() the way historical-source.js's old-realm version
// did — confirmed live that Snapshot() now fails outright with "out of gas
// in location: CPUCycles" against the current, much-larger board (reproduced
// against two independent RPC endpoints, so it's the contract call itself,
// not one flaky node). Walks every cell individually via PlacedBy/GetPixel
// instead — more RPC round-trips, but each one is cheap, sidestepping the
// single-call gas ceiling entirely.
//
// Deliberately zero npm dependencies (fetch/fs/path are all Node
// built-ins) and safe to run unattended on a schedule — see
// .github/workflows/snapshot-board.yml.
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, "..", "data", "board-snapshot.json");
const PKG_PATH = "gno.land/r/g188mapat33awn7r9uk08l0jc9my0n07fpmspxel/pixels";
const CONCURRENCY = 20;

// A couple of alternates behind the official endpoint — this backup is
// exactly the kind of thing that must NOT fail just because the official
// RPC is having one of its frequent bad days (see gno.observer's own
// abciQuery fallback, added the same day for the same underlying
// flakiness). Community-run, vetted the same way as gno.observer's list:
// correct chain-id, block data in agreement with the official endpoint,
// a real vm/qeval call executed correctly by the Gno VM. Node's fetch
// doesn't enforce CORS, so (unlike gno.observer's browser-side list) any
// of these are fine to use here regardless of their CORS header hygiene.
const RPC_URLS = [
  "https://rpc.sapphire.testnets.gno.land",
  "https://gnoland-sapphire-rpc.corenodehq.xyz",
  "https://gnoland-sapphire-rpc.hazennetworksolutions.com",
];

async function abciQueryEval(expr) {
  const full = `${PKG_PATH}.${expr}`;
  const dataB64 = Buffer.from(full).toString("base64");
  const qpath = encodeURIComponent('"vm/qeval"');
  const data = encodeURIComponent(`"${dataB64}"`);
  let lastErr;
  for (const rpcUrl of RPC_URLS) {
    try {
      const res = await fetch(`${rpcUrl}/abci_query?path=${qpath}&data=${data}`, {
        signal: AbortSignal.timeout(15000),
      });
      const json = await res.json();
      const rawB64 = json.result?.response?.ResponseBase?.Data;
      return rawB64 ? Buffer.from(rawB64, "base64").toString("utf8") : null;
    } catch (err) {
      lastErr = err;
      // fall through to the next endpoint
    }
  }
  throw new Error(`All ${RPC_URLS.length} RPC endpoints failed for "${expr}": ${lastErr.message}`);
}

function parseGnoString(raw) {
  const m = /\("((?:[^"\\]|\\.)*)"\s+[\w.]+\)/s.exec(raw);
  return m ? m[1] : null;
}

function parseGnoInts(raw) {
  return [...raw.matchAll(/(-?\d+)\s+int64\)/g)].map((m) => Number(m[1]));
}

// PlacedBy's address return renders as `( .uverse.address)` (a bare space,
// no quotes) for a cell that's never been placed on — parseGnoString's
// quoted-string pattern deliberately doesn't match that, so this returns
// null for it rather than an empty string that could be confused with a
// real (if malformed) address.
function parseGnoAddress(raw) {
  const m = /\("([^"]*)"\s+\.uverse\.address\)/.exec(raw);
  return m && m[1] ? m[1] : null;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
      done++;
      if (done % 100 === 0 || done === items.length) {
        console.log(`  provenance: ${done}/${items.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchBounds() {
  const raw = await abciQueryEval("Bounds()");
  const [minX, maxX, minY, maxY] = parseGnoInts(raw);
  return { minX, maxX, minY, maxY };
}

// Snapshot() builds and returns the ENTIRE board as one string in a
// single call — confirmed live that this now fails outright with "out of
// gas in location: CPUCycles" (reproduced against two independent RPC
// endpoints, so it's the contract call itself, not one flaky node). The
// board has simply grown too large for that single-call approach to
// afford anymore. Walking every cell individually via PlacedBy — cheap
// per call, since it does no board-wide work — sidesteps this entirely,
// at the cost of one RPC round-trip per cell instead of one for the whole
// board. PlacedBy conveniently gives color-agnostic placer/height AND
// occupancy in one call (an empty cell's address parses to null), so this
// also replaces the old Snapshot()-then-PlacedBy two-pass with one pass;
// GetPixel (for color) is only needed for the cells this finds occupied.
async function fetchPlacedBy(x, y) {
  const raw = await abciQueryEval(`PlacedBy(${x},${y})`);
  const placer = parseGnoAddress(raw);
  const [height] = parseGnoInts(raw);
  return { placer, height };
}

async function fetchColor(x, y) {
  const [c] = parseGnoInts(await abciQueryEval(`GetPixel(${x},${y})`));
  return c;
}

// The chain height this snapshot was taken at — lets a consumer (the live
// site) treat this JSON as an authoritative base layer and only replay
// indexer events for heights AFTER this one, instead of the indexer's full
// history from block 0 (which is both slow and, per the indexer's own
// confirmed data gaps, occasionally wrong). Uses /status, a plain
// Tendermint/CometBFT RPC endpoint (not abci_query), so it needs its own
// fallback loop; the official endpoint 403s on /status specifically even
// though every other path on it works fine, so this can't skip that.
async function fetchLatestHeight() {
  let lastErr;
  for (const rpcUrl of RPC_URLS) {
    try {
      const res = await fetch(`${rpcUrl}/status`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const height = Number(json.result?.sync_info?.latest_block_height);
      if (Number.isFinite(height) && height > 0) return height;
      throw new Error("missing/invalid latest_block_height in response");
    } catch (err) {
      lastErr = err;
      // fall through to the next endpoint
    }
  }
  throw new Error(`All ${RPC_URLS.length} RPC endpoints failed for /status: ${lastErr.message}`);
}

async function fetchCommunityDesigns() {
  const csv = parseGnoString(await abciQueryEval("ListCommunityDesigns()")) || "";
  if (!csv) return [];
  const rows = csv.split(";").filter(Boolean).map((entry) => {
    const [id, name, count] = entry.split(",");
    return { id, name, count: Number(count) };
  });
  return mapWithConcurrency(rows, CONCURRENCY, async (r) => {
    const encoded = parseGnoString(await abciQueryEval(`GetCommunityDesign(${JSON.stringify(r.id)})`)) || "";
    const pixels = encoded ? encoded.split(";").filter(Boolean).map((e) => e.split(",").map(Number)) : [];
    return { ...r, pixels };
  });
}

async function main() {
  console.log(`=== snapshotting ${PKG_PATH} ===`);

  // Captured BEFORE the sweep starts (which takes a while — thousands of
  // RPC round-trips): a lower bound on every cell read below is exactly
  // what a consumer replaying "everything since atHeight" needs, since it
  // guarantees no write that happened during the sweep itself gets missed
  // by both this snapshot AND the catch-up replay.
  const atHeight = await fetchLatestHeight();
  console.log(`chain height at snapshot start: ${atHeight}`);

  const bounds = await fetchBounds();
  const allCells = [];
  for (let x = bounds.minX; x <= bounds.maxX; x++) {
    for (let y = bounds.minY; y <= bounds.maxY; y++) allCells.push({ x, y });
  }
  console.log(`board: ${allCells.length} total cells within bounds ${JSON.stringify(bounds)} — sweeping via PlacedBy`);

  const swept = await mapWithConcurrency(allCells, CONCURRENCY, async (cell) => {
    const { placer, height } = await fetchPlacedBy(cell.x, cell.y);
    return placer ? { ...cell, placer, height } : null;
  });
  const occupied = swept.filter(Boolean);
  console.log(`board: ${occupied.length} occupied cells — fetching color for each`);

  const withProvenance = await mapWithConcurrency(occupied, CONCURRENCY, async (cell) => {
    const c = await fetchColor(cell.x, cell.y);
    return { ...cell, c };
  });

  const communityDesigns = await fetchCommunityDesigns();
  console.log(`community designs: ${communityDesigns.length}`);

  const output = {
    generatedAt: new Date().toISOString(),
    atHeight,
    pkgPath: PKG_PATH,
    bounds,
    pixels: withProvenance,
    communityDesigns,
  };

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log(`wrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
