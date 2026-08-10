// Loads the 843-entry official design from the repo root's
// target_pattern.js -- kept as its own module so server.js doesn't need
// to know that file's on-disk shape, same convention as center-order.js.
const fs = require("fs");
const path = require("path");

function loadOfficialTargetPixels() {
  const src = fs.readFileSync(path.join(__dirname, "..", "target_pattern.js"), "utf8");
  const TARGET_PATTERN = new Function(src + "\nreturn TARGET_PATTERN;")();
  return TARGET_PATTERN; // [[x, y, colorIndex], ...]
}

module.exports = { loadOfficialTargetPixels };
