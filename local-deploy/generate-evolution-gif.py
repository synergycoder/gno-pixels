#!/usr/bin/env python3
# Regenerates the board's full evolution GIF from scratch: fetches
# every successful SetPixel/SetPixels/ImportHistoricalPixel call from
# the sapphire-1 indexer (the same source the site's own frontend uses
# to reconstruct board state, since Snapshot()/Render() both now
# exceed the query-time gas ceiling on this board), replays them in
# chronological order, and renders one frame per individual pixel
# write. Read-only throughout -- no wallet, no gas, nothing broadcast.
#
# Usage: python3 generate-evolution-gif.py [output_path]

import sys
import json
import base64
import re
import ssl
import urllib.request
import urllib.parse
from PIL import Image

# macOS's python.org builds don't wire up the system trust store by
# default, so a plain urlopen() against a real https URL fails with
# CERTIFICATE_VERIFY_FAILED. certifi ships its own CA bundle -- fall
# back to the (possibly broken) default context if it's not installed
# rather than hard-depending on it.
try:
    import certifi
    SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CONTEXT = ssl.create_default_context()

PKG_PATH = "gno.land/r/g188mapat33awn7r9uk08l0jc9my0n07fpmspxel/pixels"
RPC_URL = "https://rpc.sapphire.testnets.gno.land"
INDEXER_URL = "https://indexer.sapphire.testnets.gno.land/graphql/query"
CELL_PX = 4  # 128 cells * 4px = 512x512 final frame size
FRAME_DURATION_MS = 25

REPLAY_FUNCS = ["SetPixel", "SetPixels", "ImportHistoricalPixel"]


def qeval(expr):
    data = base64.b64encode(expr.encode()).decode()
    url = f"{RPC_URL}/abci_query?path=%22vm%2Fqeval%22&data=%22{urllib.parse.quote(data)}%22"
    with urllib.request.urlopen(url, timeout=20, context=SSL_CONTEXT) as r:
        payload = json.load(r)
    raw_b64 = payload["result"]["response"]["ResponseBase"]["Data"]
    if not raw_b64:
        raise RuntimeError(f"qeval failed for {expr!r}: {payload}")
    return base64.b64decode(raw_b64).decode()


def graphql(query):
    req = urllib.request.Request(
        INDEXER_URL,
        data=json.dumps({"query": query}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=90, context=SSL_CONTEXT) as r:
        payload = json.load(r)
    if "errors" in payload:
        raise RuntimeError(f"indexer query failed: {payload['errors']}")
    return payload["data"]["getTransactions"]


def fetch_bounds():
    raw = qeval(f"{PKG_PATH}.Bounds()")
    nums = [int(n) for n in re.findall(r"-?\d+(?= int64\))", raw)]
    min_x, max_x, min_y, max_y = nums
    return min_x, max_x, min_y, max_y


def fetch_palette():
    raw = qeval(f"{PKG_PATH}.PaletteCSV()")
    m = re.search(r'\("((?:[^"\\]|\\.)*)" string\)', raw)
    return m.group(1).split(",")


def build_query(func):
    return f"""query {{
      getTransactions(
        where: {{ success: {{ eq: true }}, messages: {{ value: {{ MsgCall: {{ pkg_path: {{ eq: "{PKG_PATH}" }}, func: {{ eq: "{func}" }} }} }} }} }},
        order: {{ heightAndIndex: ASC }}
      ) {{ block_height index messages {{ value {{ ... on MsgCall {{ func args }} }} }} }}
    }}"""


def fetch_events():
    events = []
    for func in REPLAY_FUNCS:
        txs = graphql(build_query(func))
        for tx in txs:
            msg = (tx["messages"] or [{}])[0].get("value")
            if not msg:
                continue
            height, index = tx["block_height"], tx["index"]
            if func == "SetPixel":
                x, y, c = (int(v) for v in msg["args"])
                events.append((height, index, 0, x, y, c))
            elif func == "SetPixels":
                entries = [e for e in msg["args"][0].split(";") if e]
                for sub, entry in enumerate(entries):
                    x, y, c = (int(v) for v in entry.split(","))
                    events.append((height, index, sub, x, y, c))
            elif func == "ImportHistoricalPixel":
                x, y, c = (int(v) for v in msg["args"][:3])
                events.append((height, index, 0, x, y, c))
    events.sort(key=lambda e: (e[0], e[1], e[2]))
    return events


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "gno_pixels_evolution.gif"

    print("fetching bounds + palette...")
    min_x, max_x, min_y, max_y = fetch_bounds()
    palette_hex = fetch_palette()
    w, h = max_x - min_x + 1, max_y - min_y + 1
    palette_rgb = [tuple(int(hexv[i:i + 2], 16) for i in (1, 3, 5)) for hexv in palette_hex]
    print(f"board: {w}x{h}, {len(palette_hex)} colors")

    print("fetching placement history from the indexer...")
    events = fetch_events()
    print(f"total individual pixel-write events: {len(events)}")
    if not events:
        raise RuntimeError("no placement history found")

    img = Image.new("P", (w, h), 0)
    flat_palette = [c for rgb in palette_rgb for c in rgb]
    flat_palette += [0, 0, 0] * (256 - len(palette_rgb))
    img.putpalette(flat_palette)
    px = img.load()

    frames = []
    for (height, index, sub, x, y, c) in events:
        if x < min_x or x > max_x or y < min_y or y > max_y:
            continue
        px[x - min_x, y - min_y] = c
        frames.append(img.resize((w * CELL_PX, h * CELL_PX), Image.NEAREST))

    print(f"rendered {len(frames)} frames, encoding GIF...")
    frames[0].save(
        out_path,
        save_all=True,
        append_images=frames[1:],
        duration=FRAME_DURATION_MS,
        loop=0,
        optimize=True,
        disposal=1,
    )
    print(f"saved: {out_path}")


if __name__ == "__main__":
    main()
