#!/bin/bash
# start-deploy-console.command
#
# Double-click this to start the GNO Pixels local deploy console and
# open it in your browser. Leave this Terminal window open while you're
# using it — closing it (or pressing Control+C) stops the local server.

set -e

# Finder-launched scripts often have a bare-bones PATH that doesn't
# include Homebrew's install location, unlike an interactive Terminal —
# add it explicitly so `node` is found either way.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

cd "$(dirname "$0")"

echo "Starting GNO Pixels deploy console..."
node server.js &
SERVER_PID=$!

# Give the server a moment to bind before opening the browser.
sleep 1
open "http://127.0.0.1:4756"

wait "$SERVER_PID"
