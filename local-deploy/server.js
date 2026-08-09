// Local-only deploy console for the real `pixelsandbox` realm on sapphire-1.
//
// Deliberately NOT the same shape as gno-wallet-dashboard/server.js's
// KEYRING_PASSWORD-baked-into-the-file convention -- that's fine for a
// shared throwaway test keyring, but this deploy uses a real wallet with
// real testnet funds, so the password is typed into the page fresh for
// each action, piped straight into gnokey's stdin, and never written to
// disk, logged, or held anywhere past the single request that used it.
//
// Binds to 127.0.0.1 only -- never reachable from another device on the
// network. Run with: node server.js, then open http://127.0.0.1:4756/
const http = require("http");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

const PORT = 4756;
const RPC_URL = "https://rpc.sapphire.testnets.gno.land";
const CHAIN_ID = "sapphire-1";
const PKG_DIR = path.join(__dirname, "..", "contract");
const PKG_PATH = "gno.land/r/g188mapat33awn7r9uk08l0jc9my0n07fpmspxel/pixelsandbox";
const SIMULATE_GAS_CEILING = "50000000";
const GAS_MARGIN = 0.1; // matches the sibling dashboard's proven simulate-then-broadcast margin

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

function baseArgs({ keyringHome }) {
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

async function simulate({ keyringHome, keyName, password }) {
  const { stdout } = await runGnokey(
    [...baseArgs({ keyringHome }), "-gas-fee", "1ugnot", "-gas-wanted", SIMULATE_GAS_CEILING, "-simulate", "only", keyName],
    password,
  );
  const gasUsedMatch = /GAS USED:\s*(\d+)/.exec(stdout);
  if (!gasUsedMatch) throw new Error(`Simulation didn't report gas used -- raw output:\n${stdout}`);
  const storageFeeMatch = /STORAGE FEE:\s*(\d+)/.exec(stdout);
  const gasUsed = Number(gasUsedMatch[1]);
  const gasWanted = Math.ceil(gasUsed * (1 + GAS_MARGIN));
  const gasFeeUgnot = Math.ceil(gasWanted / 1000);
  return {
    gasUsed,
    gasWanted,
    gasFeeUgnot,
    storageFeeUgnot: storageFeeMatch ? Number(storageFeeMatch[1]) : null,
    raw: stdout,
  };
}

async function broadcast({ keyringHome, keyName, password, gasWanted, gasFeeUgnot }) {
  const { stdout } = await runGnokey(
    [
      ...baseArgs({ keyringHome }),
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

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    const html = fs.readFileSync(path.join(__dirname, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (req.method === "GET" && req.url === "/config") {
    sendJson(res, 200, { pkgPath: PKG_PATH, chainId: CHAIN_ID, rpcUrl: RPC_URL });
    return;
  }

  if (req.method === "POST" && (req.url === "/simulate" || req.url === "/broadcast")) {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        sendJson(res, 400, { error: "invalid JSON body" });
        return;
      }
      try {
        const result = req.url === "/simulate"
          ? await simulate(payload)
          : await broadcast(payload);
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 500, { error: (err.stdout || err.stderr || err.message || "unknown error").toString().trim() });
      }
      // Password lived only in the parsed `payload` object for this one
      // request's lifetime; nothing here persists it past this handler.
    });
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`GNO Pixels local deploy console: http://127.0.0.1:${PORT}/`);
  console.log(`Target: ${PKG_PATH} on ${CHAIN_ID}`);
});
