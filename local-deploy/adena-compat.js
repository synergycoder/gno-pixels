// Deliberately empty. Adena's content script computes its own asset path
// via document.currentScript.src (always empty for a content script) and
// falls back to scanning the host page's own <script src="..."> tags for
// any absolute http(s) URL -- with none present, it throws before ever
// setting window.adena. This file's own content doesn't matter, only that
// a real <script src="adena-compat.js"> tag exists on the page. See the
// "Adena" entries in ~/gno-land-dev-notes.md (originally root-caused in
// gno-observer) for the full writeup.
