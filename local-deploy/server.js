// Local-only deploy + prepopulate console for the real `pixelsandbox`
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

const PORT = 4756;
const RPC_URL = "https://rpc.sapphire.testnets.gno.land";
const CHAIN_ID = "sapphire-1";
const PKG_DIR = path.join(__dirname, "..", "contract");
const PKG_PATH = "gno.land/r/g188mapat33awn7r9uk08l0jc9my0n07fpmspxel/pixelsandbox";
const OWNER_ADDRESS = "g188mapat33awn7r9uk08l0jc9my0n07fpmspxel";
const SIMULATE_GAS_CEILING = "50000000";
const GAS_MARGIN = 0.1; // matches the sibling dashboard's proven simulate-then-broadcast margin
const LOG_PATH = path.join(__dirname, "prepopulate-log.csv");
const LOG_HEADER = "index,x,y,colorIndex,gasUsed,gasWanted,gasFeeUgnot,storageDeltaBytes,storageFeeUgnot,cumulativeUgnot,txHash,timestamp\n";

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
    sendJson(res, 200, { pkgPath: PKG_PATH, chainId: CHAIN_ID, rpcUrl: RPC_URL, totalTargetPixels: loadCenterOrderedPixels().length });
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

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`GNO Pixels local deploy console: http://127.0.0.1:${PORT}/`);
  console.log(`Target: ${PKG_PATH} on ${CHAIN_ID}`);
});
