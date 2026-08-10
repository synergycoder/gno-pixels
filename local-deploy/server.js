// Local-only deploy + prepopulate console for the real `pixels`
// realm on sapphire-1.
//
// Deliberately NOT the same shape as gno-wallet-dashboard/server.js's
// KEYRING_PASSWORD-baked-into-the-file convention -- that's fine for a
// shared throwaway test keyring, but this deploy uses a real wallet with
// real testnet funds, so the password is typed into the page fresh for
// each action, piped straight into gnokey's stdin, and never written to
// disk, logged, or held anywhere past the batch run that used it.
//
// Binds to 127.0.0.1 only -- never reachable from another device on the
// network. Run with: node server.js, then open http://127.0.0.1:4756/
const http = require("http");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const { loadCenterOrderedPixels } = require("./center-order.js");
const { loadOfficialTargetPixels } = require("./official-target.js");
const { loadHistoricalPixels } = require("./historical-source.js");

const PORT = 4756;
const RPC_URL = "https://rpc.sapphire.testnets.gno.land";
const CHAIN_ID = "sapphire-1";
const PKG_DIR = path.join(__dirname, "..", "contract");
const PKG_PATH = "gno.land/r/g188mapat33awn7r9uk08l0jc9my0n07fpmspxel/pixels";
const OWNER_ADDRESS = "g188mapat33awn7r9uk08l0jc9my0n07fpmspxel";
// Just a dry-run ceiling for the simulate step (real broadcast gas-wanted
// is always computed from actual measured usage + GAS_MARGIN, regardless
// of this value) -- raised well past a single SetOfficialTarget batch's
// needs. Each batch gets a bit more expensive as officialTarget's avl
// tree grows (measured: 50 pixels into an empty tree used well under
// 50M gas, the next 50 into a 50-entry tree needed ~60M) but the chain's
// actual MaxGas per block is 3,000,000,000 (checked via consensus_params
// on sapphire-1), so this still leaves a huge margin.
const SIMULATE_GAS_CEILING = "500000000";
const GAS_MARGIN = 0.1; // matches the sibling dashboard's proven simulate-then-broadcast margin
const LOG_PATH = path.join(__dirname, "prepopulate-log.csv");
const LOG_HEADER = "index,x,y,colorIndex,gasUsed,gasWanted,gasFeeUgnot,storageDeltaBytes,storageFeeUgnot,cumulativeUgnot,txHash,timestamp\n";
const TARGET_LOG_PATH = path.join(__dirname, "settarget-log.csv");
const TARGET_LOG_HEADER = "chunkIndex,pixelCount,gasUsed,gasWanted,gasFeeUgnot,storageDeltaBytes,storageFeeUgnot,cumulativeUgnot,txHash,timestamp\n";
const MIGRATE_LOG_PATH = path.join(__dirname, "migrate-log.csv");
const MIGRATE_LOG_HEADER = "index,x,y,colorIndex,placer,originalHeight,gasUsed,gasWanted,gasFeeUgnot,storageDeltaBytes,storageFeeUgnot,cumulativeUgnot,txHash,timestamp\n";

// gnokey splits its output across streams: the GAS WANTED/USED/TX HASH
// summary goes to stdout, but the detailed "--= Error =--" panic trace
// goes to stderr -- execFile captures them separately, so an error
// message built from stdout alone silently drops the actually useful
// part (e.g. "owner-only").
function errText(err) {
  const parts = [err.stdout, err.stderr].filter(Boolean).map((s) => s.toString().trim()).filter(Boolean);
  return parts.length ? parts.join("\n") : (err.message || "unknown error");
}

function runGnokey(args, password) {
  return new Promise((resolve, reject) => {
    const child = execFile("gnokey", args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.write(`${password}\n`);
    child.stdin.end();
  });
}

function addPkgArgs({ keyringHome }) {
  return [
    "maketx", "addpkg",
    "-pkgpath", PKG_PATH,
    "-pkgdir", PKG_DIR,
    "-chainid", CHAIN_ID,
    "-remote", RPC_URL,
    "-home", keyringHome,
    "-insecure-password-stdin",
  ];
}

function sendArgs({ keyringHome, toAddress, amountUgnot }) {
  return [
    "maketx", "send",
    "-to", toAddress,
    "-send", `${amountUgnot}ugnot`,
    "-chainid", CHAIN_ID,
    "-remote", RPC_URL,
    "-home", keyringHome,
    "-insecure-password-stdin",
  ];
}

function callArgs({ keyringHome, func, args }) {
  const flat = [];
  for (const a of args) flat.push("-args", String(a));
  return [
    "maketx", "call",
    "-pkgpath", PKG_PATH,
    "-func", func,
    ...flat,
    "-chainid", CHAIN_ID,
    "-remote", RPC_URL,
    "-home", keyringHome,
    "-insecure-password-stdin",
  ];
}

async function simulate(buildArgs, { keyringHome, keyName, password }) {
  const { stdout } = await runGnokey(
    [...buildArgs({ keyringHome }), "-gas-fee", "1ugnot", "-gas-wanted", SIMULATE_GAS_CEILING, "-simulate", "only", keyName],
    password,
  );
  const gasUsedMatch = /GAS USED:\s*(\d+)/.exec(stdout);
  if (!gasUsedMatch) throw new Error(`Simulation didn't report gas used -- raw output:\n${stdout}`);
  const storageFeeMatch = /STORAGE FEE:\s*(\d+)/.exec(stdout);
  const storageDeltaMatch = /STORAGE DELTA:\s*(\d+)/.exec(stdout);
  const gasUsed = Number(gasUsedMatch[1]);
  const gasWanted = Math.ceil(gasUsed * (1 + GAS_MARGIN));
  const gasFeeUgnot = Math.ceil(gasWanted / 1000);
  return {
    gasUsed,
    gasWanted,
    gasFeeUgnot,
    storageDeltaBytes: storageDeltaMatch ? Number(storageDeltaMatch[1]) : null,
    storageFeeUgnot: storageFeeMatch ? Number(storageFeeMatch[1]) : 0,
    raw: stdout,
  };
}

async function broadcast(buildArgs, { keyringHome, keyName, password, gasWanted, gasFeeUgnot }) {
  const { stdout } = await runGnokey(
    [
      ...buildArgs({ keyringHome }),
      "-gas-fee", `${gasFeeUgnot}ugnot`,
      "-gas-wanted", String(gasWanted),
      "-broadcast",
      keyName,
    ],
    password,
  );
  const hashMatch = /TX HASH:\s*(\S+)/.exec(stdout);
  if (!hashMatch) {
    throw new Error(`No tx hash in output -- nothing was likely broadcast:\n${stdout}`);
  }
  return { txHash: hashMatch[1], raw: stdout };
}

// ---------- Prepopulate batch job ----------
//
// Runs detached from any single HTTP request (a 700-pixel batch can take
// tens of minutes) -- /prepopulate/start kicks it off and returns
// immediately, the page polls /prepopulate/status for progress. Only one
// batch job at a time; password is held in the closure only for the
// duration of this run and dropped when it ends.
let batch = {
  running: false,
  completed: 0,
  total: 0,
  cumulativeUgnot: 0,
  cumulativeStorageFeeUgnot: 0,
  cumulativeGasFeeUgnot: 0,
  lastError: null,
  recent: [], // last few log rows, for the page to show live
};

async function fetchChainHeight() {
  const res = await fetch(`${RPC_URL}/status`);
  const data = await res.json();
  return Number(data.result.sync_info.latest_block_height);
}

function appendLogRow(row) {
  if (!fs.existsSync(LOG_PATH)) fs.writeFileSync(LOG_PATH, LOG_HEADER);
  const line = [
    row.index, row.x, row.y, row.colorIndex, row.gasUsed, row.gasWanted, row.gasFeeUgnot,
    row.storageDeltaBytes, row.storageFeeUgnot, row.cumulativeUgnot, row.txHash, row.timestamp,
  ].join(",") + "\n";
  fs.appendFileSync(LOG_PATH, line);
}

// ---------- SetOfficialTarget batch job ----------
//
// Unlike ImportHistoricalPixel (one pixel per call), SetOfficialTarget
// already accepts a whole "x,y,c;x,y,c;..." batch per call -- this job
// just chunks the 843-entry design into affordably-sized transactions
// instead of needing the ~164 GNOT full registration cost upfront in a
// single call. SetOfficialTarget is additive (see contract/pixels.gno),
// so re-running this after a partial failure is safe: already-registered
// entries just get overwritten with the same value, at near-zero extra
// storage cost since no new bytes are added for them.
let targetBatch = {
  running: false,
  completedPixels: 0,
  totalPixels: 0,
  completedChunks: 0,
  totalChunks: 0,
  cumulativeUgnot: 0,
  cumulativeStorageFeeUgnot: 0,
  cumulativeGasFeeUgnot: 0,
  lastError: null,
  recent: [],
};

function appendTargetLogRow(row) {
  if (!fs.existsSync(TARGET_LOG_PATH)) fs.writeFileSync(TARGET_LOG_PATH, TARGET_LOG_HEADER);
  const line = [
    row.chunkIndex, row.pixelCount, row.gasUsed, row.gasWanted, row.gasFeeUgnot,
    row.storageDeltaBytes, row.storageFeeUgnot, row.cumulativeUgnot, row.txHash, row.timestamp,
  ].join(",") + "\n";
  fs.appendFileSync(TARGET_LOG_PATH, line);
}

async function runSetOfficialTargetBatch({ keyringHome, keyName, password, batchSize }) {
  const pixels = loadOfficialTargetPixels();
  const chunks = [];
  for (let i = 0; i < pixels.length; i += batchSize) chunks.push(pixels.slice(i, i + batchSize));

  targetBatch = {
    running: true, completedPixels: 0, totalPixels: pixels.length,
    completedChunks: 0, totalChunks: chunks.length,
    cumulativeUgnot: 0, cumulativeStorageFeeUgnot: 0, cumulativeGasFeeUgnot: 0,
    lastError: null, recent: [],
  };

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const encoded = chunk.map(([x, y, c]) => `${x},${y},${c}`).join(";");
    const buildArgs = (opts) => callArgs({ ...opts, func: "SetOfficialTarget", args: [encoded] });
    try {
      const sim = await simulate(buildArgs, { keyringHome, keyName, password });
      const result = await broadcast(buildArgs, {
        keyringHome, keyName, password,
        gasWanted: sim.gasWanted, gasFeeUgnot: sim.gasFeeUgnot,
      });
      const totalUgnot = sim.gasFeeUgnot + sim.storageFeeUgnot;
      targetBatch.cumulativeUgnot += totalUgnot;
      targetBatch.cumulativeStorageFeeUgnot += sim.storageFeeUgnot;
      targetBatch.cumulativeGasFeeUgnot += sim.gasFeeUgnot;
      targetBatch.completedPixels += chunk.length;
      targetBatch.completedChunks = i + 1;
      const row = {
        chunkIndex: i, pixelCount: chunk.length,
        gasUsed: sim.gasUsed, gasWanted: sim.gasWanted, gasFeeUgnot: sim.gasFeeUgnot,
        storageDeltaBytes: sim.storageDeltaBytes, storageFeeUgnot: sim.storageFeeUgnot,
        cumulativeUgnot: targetBatch.cumulativeUgnot, txHash: result.txHash,
        timestamp: new Date().toISOString(),
      };
      appendTargetLogRow(row);
      targetBatch.recent.push(row);
      if (targetBatch.recent.length > 20) targetBatch.recent.shift();
    } catch (err) {
      targetBatch.lastError = `chunk ${i} (${chunk.length} pixels, starting at index ${i * batchSize}): ` + errText(err);
      targetBatch.running = false;
      return;
    }
  }
  targetBatch.running = false;
}

// ---------- Real historical-pixel migration batch job ----------
//
// Unlike runPrepopulateBatch (which repaints the owner-curated DESIGN,
// attributed entirely to OWNER_ADDRESS), this migrates REAL placements
// off the old pixelsandbox realm -- each cell's actual original placer
// address and block height, sourced live via historical-source.js. Runs
// nearest-to-center first, and stops on whichever limit comes first:
// maxPixels, or cumulative spend reaching targetBudgetUgnot (a spend cap
// is more useful here than a pixel count, since real per-pixel cost
// varies and this is meant to be run in affordable installments).
let migrateBatch = {
  running: false,
  completed: 0,
  total: 0,
  cumulativeUgnot: 0,
  cumulativeStorageFeeUgnot: 0,
  cumulativeGasFeeUgnot: 0,
  lastError: null,
  stoppedReason: null,
  recent: [],
};

function appendMigrateLogRow(row) {
  if (!fs.existsSync(MIGRATE_LOG_PATH)) fs.writeFileSync(MIGRATE_LOG_PATH, MIGRATE_LOG_HEADER);
  const line = [
    row.index, row.x, row.y, row.colorIndex, row.placer, row.originalHeight,
    row.gasUsed, row.gasWanted, row.gasFeeUgnot,
    row.storageDeltaBytes, row.storageFeeUgnot, row.cumulativeUgnot, row.txHash, row.timestamp,
  ].join(",") + "\n";
  fs.appendFileSync(MIGRATE_LOG_PATH, line);
}

async function runHistoricalMigrationBatch({ keyringHome, keyName, password, maxPixels, targetBudgetUgnot }) {
  const allPixels = await loadHistoricalPixels();
  const pixels = maxPixels ? allPixels.slice(0, maxPixels) : allPixels;

  migrateBatch = {
    running: true, completed: 0, total: pixels.length,
    cumulativeUgnot: 0, cumulativeStorageFeeUgnot: 0, cumulativeGasFeeUgnot: 0,
    lastError: null, stoppedReason: null, recent: [],
  };

  for (let i = 0; i < pixels.length; i++) {
    const { x, y, c, placer, height } = pixels[i];
    const buildArgs = (opts) => callArgs({
      ...opts, func: "ImportHistoricalPixel",
      args: [x, y, c, placer, height],
    });
    try {
      const sim = await simulate(buildArgs, { keyringHome, keyName, password });
      const result = await broadcast(buildArgs, {
        keyringHome, keyName, password,
        gasWanted: sim.gasWanted, gasFeeUgnot: sim.gasFeeUgnot,
      });
      const totalUgnot = sim.gasFeeUgnot + sim.storageFeeUgnot;
      migrateBatch.cumulativeUgnot += totalUgnot;
      migrateBatch.cumulativeStorageFeeUgnot += sim.storageFeeUgnot;
      migrateBatch.cumulativeGasFeeUgnot += sim.gasFeeUgnot;
      migrateBatch.completed = i + 1;
      const row = {
        index: i, x, y, colorIndex: c, placer, originalHeight: height,
        gasUsed: sim.gasUsed, gasWanted: sim.gasWanted, gasFeeUgnot: sim.gasFeeUgnot,
        storageDeltaBytes: sim.storageDeltaBytes, storageFeeUgnot: sim.storageFeeUgnot,
        cumulativeUgnot: migrateBatch.cumulativeUgnot, txHash: result.txHash,
        timestamp: new Date().toISOString(),
      };
      appendMigrateLogRow(row);
      migrateBatch.recent.push(row);
      if (migrateBatch.recent.length > 20) migrateBatch.recent.shift();
      if (targetBudgetUgnot && migrateBatch.cumulativeUgnot >= targetBudgetUgnot) {
        migrateBatch.stoppedReason = `reached the ${(targetBudgetUgnot / 1e6).toFixed(2)} GNOT budget after ${migrateBatch.completed} pixels`;
        break;
      }
    } catch (err) {
      migrateBatch.lastError = `pixel ${i} (${x},${y}): ` + errText(err);
      migrateBatch.running = false;
      return;
    }
  }
  migrateBatch.running = false;
}

async function runPrepopulateBatch({ keyringHome, keyName, password, maxPixels }) {
  const pixels = loadCenterOrderedPixels().slice(0, maxPixels);
  const height = await fetchChainHeight();

  batch = {
    running: true, completed: 0, total: pixels.length,
    cumulativeUgnot: 0, cumulativeStorageFeeUgnot: 0, cumulativeGasFeeUgnot: 0,
    lastError: null, recent: [],
  };

  for (let i = 0; i < pixels.length; i++) {
    const [x, y, c] = pixels[i];
    const buildArgs = (opts) => callArgs({
      ...opts, func: "ImportHistoricalPixel",
      args: [x, y, c, OWNER_ADDRESS, height],
    });
    try {
      const sim = await simulate(buildArgs, { keyringHome, keyName, password });
      const result = await broadcast(buildArgs, {
        keyringHome, keyName, password,
        gasWanted: sim.gasWanted, gasFeeUgnot: sim.gasFeeUgnot,
      });
      const totalUgnot = sim.gasFeeUgnot + sim.storageFeeUgnot;
      batch.cumulativeUgnot += totalUgnot;
      batch.cumulativeStorageFeeUgnot += sim.storageFeeUgnot;
      batch.cumulativeGasFeeUgnot += sim.gasFeeUgnot;
      batch.completed = i + 1;
      const row = {
        index: i, x, y, colorIndex: c,
        gasUsed: sim.gasUsed, gasWanted: sim.gasWanted, gasFeeUgnot: sim.gasFeeUgnot,
        storageDeltaBytes: sim.storageDeltaBytes, storageFeeUgnot: sim.storageFeeUgnot,
        cumulativeUgnot: batch.cumulativeUgnot, txHash: result.txHash,
        timestamp: new Date().toISOString(),
      };
      appendLogRow(row);
      batch.recent.push(row);
      if (batch.recent.length > 20) batch.recent.shift();
    } catch (err) {
      batch.lastError = `pixel ${i} (${x},${y}): ` + errText(err);
      batch.running = false;
      return;
    }
  }
  batch.running = false;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    const html = fs.readFileSync(path.join(__dirname, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (req.method === "GET" && req.url === "/config") {
    sendJson(res, 200, {
      pkgPath: PKG_PATH, chainId: CHAIN_ID, rpcUrl: RPC_URL,
      totalTargetPixels: loadCenterOrderedPixels().length,
      totalOfficialTargetPixels: loadOfficialTargetPixels().length,
    });
    return;
  }

  if (req.method === "GET" && req.url === "/migrate/config") {
    try {
      const pixels = await loadHistoricalPixels();
      sendJson(res, 200, { totalHistoricalPixels: pixels.length });
    } catch (err) {
      sendJson(res, 500, { error: errText(err) });
    }
    return;
  }

  if (req.method === "POST" && (req.url === "/simulate" || req.url === "/broadcast")) {
    try {
      const payload = await readBody(req);
      const result = req.url === "/simulate"
        ? await simulate(addPkgArgs, payload)
        : await broadcast(addPkgArgs, payload);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { error: errText(err) });
    }
    return;
  }

  // Plain bank send (gnokey maketx send) -- for moving GNOT to the
  // project wallet on sapphire-1 when the sending wallet's UI (e.g.
  // Adena) has no preset for this chain and can't be pointed at a
  // custom RPC from its own send screen. Same local-signing pattern as
  // the addpkg deploy above: password typed fresh, piped to gnokey's
  // stdin, never persisted.
  if (req.method === "POST" && (req.url === "/send/simulate" || req.url === "/send/broadcast")) {
    try {
      const payload = await readBody(req);
      if (!payload.toAddress || !payload.amountUgnot) {
        sendJson(res, 400, { error: "toAddress and amountUgnot are required" });
        return;
      }
      const buildArgs = (opts) => sendArgs({ ...opts, toAddress: payload.toAddress, amountUgnot: payload.amountUgnot });
      const result = req.url === "/send/simulate"
        ? await simulate(buildArgs, payload)
        : await broadcast(buildArgs, payload);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { error: errText(err) });
    }
    return;
  }

  if (req.method === "GET" && req.url === "/bounds") {
    try {
      const expr = `${PKG_PATH}.Bounds()`;
      const data = Buffer.from(expr).toString("base64");
      const url = `${RPC_URL}/abci_query?path=%22vm%2Fqeval%22&data=%22${encodeURIComponent(data)}%22`;
      const rpcRes = await fetch(url);
      const json = await rpcRes.json();
      const raw = Buffer.from(json.result.response.ResponseBase.Data, "base64").toString("utf8");
      const nums = [...raw.matchAll(/-?\d+(?=\s+int64\))/g)].map((m) => Number(m[0]));
      const [minX, maxX, minY, maxY] = nums;
      sendJson(res, 200, { minX, maxX, minY, maxY, width: maxX - minX + 1, height: maxY - minY + 1 });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/forceexpand") {
    try {
      const payload = await readBody(req);
      if (!payload.keyringHome || !payload.keyName || !payload.password) {
        sendJson(res, 400, { error: "keyringHome, keyName, and password are required" });
        return;
      }
      const buildArgs = (opts) => callArgs({ ...opts, func: "ForceExpand", args: [] });
      const sim = await simulate(buildArgs, payload);
      const result = await broadcast(buildArgs, { ...payload, gasWanted: sim.gasWanted, gasFeeUgnot: sim.gasFeeUgnot });
      sendJson(res, 200, { ...sim, ...result });
    } catch (err) {
      sendJson(res, 500, { error: errText(err) });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/prepopulate/start") {
    try {
      const payload = await readBody(req);
      if (batch.running) {
        sendJson(res, 409, { error: "a batch is already running" });
        return;
      }
      if (!payload.keyringHome || !payload.keyName || !payload.password) {
        sendJson(res, 400, { error: "keyringHome, keyName, and password are required" });
        return;
      }
      const maxPixels = Math.max(1, Math.min(Number(payload.maxPixels) || 728, 728));
      runPrepopulateBatch({ ...payload, maxPixels }); // fire and forget -- polled via /prepopulate/status
      sendJson(res, 200, { started: true, maxPixels });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (req.method === "GET" && req.url === "/prepopulate/status") {
    sendJson(res, 200, batch);
    return;
  }

  if (req.method === "POST" && req.url === "/settarget/start") {
    try {
      const payload = await readBody(req);
      if (targetBatch.running) {
        sendJson(res, 409, { error: "a settarget batch is already running" });
        return;
      }
      if (!payload.keyringHome || !payload.keyName || !payload.password) {
        sendJson(res, 400, { error: "keyringHome, keyName, and password are required" });
        return;
      }
      const batchSize = Math.max(1, Math.min(Number(payload.batchSize) || 50, 200));
      runSetOfficialTargetBatch({ ...payload, batchSize }); // fire and forget -- polled via /settarget/status
      sendJson(res, 200, { started: true, batchSize });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (req.method === "GET" && req.url === "/settarget/status") {
    sendJson(res, 200, targetBatch);
    return;
  }

  if (req.method === "POST" && req.url === "/migrate/start") {
    try {
      const payload = await readBody(req);
      if (migrateBatch.running) {
        sendJson(res, 409, { error: "a migration batch is already running" });
        return;
      }
      if (!payload.keyringHome || !payload.keyName || !payload.password) {
        sendJson(res, 400, { error: "keyringHome, keyName, and password are required" });
        return;
      }
      const maxPixels = payload.maxPixels ? Math.max(1, Number(payload.maxPixels)) : null;
      const targetBudgetUgnot = payload.targetBudgetGnot ? Math.round(Number(payload.targetBudgetGnot) * 1e6) : null;
      if (!maxPixels && !targetBudgetUgnot) {
        sendJson(res, 400, { error: "set either a pixel limit or a GNOT budget" });
        return;
      }
      runHistoricalMigrationBatch({ ...payload, maxPixels, targetBudgetUgnot }); // fire and forget -- polled via /migrate/status
      sendJson(res, 200, { started: true, maxPixels, targetBudgetUgnot });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (req.method === "GET" && req.url === "/migrate/status") {
    sendJson(res, 200, migrateBatch);
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`GNO Pixels local deploy console: http://127.0.0.1:${PORT}/`);
  console.log(`Target: ${PKG_PATH} on ${CHAIN_ID}`);
});
