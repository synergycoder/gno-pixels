// Computes a center-outward placement order for the 728 logo target
// pixels. Loaded by server.js at startup; kept as its own module so the
// ordering logic (and the board center it assumes) stays visible and
// easy to double check against Bounds() if the board ever expands.
const fs = require("fs");
const path = require("path");

function loadCenterOrderedPixels() {
  const src = fs.readFileSync(path.join(__dirname, "..", "target_pattern.js"), "utf8");
  const TARGET_PATTERN = new Function(src + "\nreturn TARGET_PATTERN;")();

  // Board is 0..63 in both axes (confirmed live via Bounds() at the time
  // this was written) -- center of a 64-wide board sits at 31.5, not on
  // an integer cell, which is fine for a distance sort.
  const CENTER_X = 31.5;
  const CENTER_Y = 31.5;

  const withDist = TARGET_PATTERN.map(([x, y, c]) => ({
    x, y, c,
    dist: Math.hypot(x - CENTER_X, y - CENTER_Y),
  }));
  withDist.sort((a, b) => a.dist - b.dist);
  return withDist.map(({ x, y, c }) => [x, y, c]);
}

module.exports = { loadCenterOrderedPixels };
