#!/usr/bin/env python3
"""Build the compact visual fingerprint index used by the screenshot importer.

The generated file contains no icon images. Each entry stores a perceptual hash
and a tiny colour signature calculated from Albion's official render service.
"""

from __future__ import annotations

import argparse
import http.client
import io
import json
import math
import re
import time
import threading
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
from PIL import Image


ITEMS_URL = "https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/formatted/items.json"
MARKET_IDS_URL = "https://raw.githubusercontent.com/mazurwiktor/albion-online-addons/master/assets/item_ids.txt"
RENDER_URL = "https://render.albiononline.com/v1/item/{item}.png?quality=1&size=64"
USER_AGENT = "AlbionMarketPocket-visual-index/1.0"
THREAD_STATE = threading.local()


def fetch(url: str, timeout: int = 20) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def fetch_render(item_id: str, timeout: int = 15) -> bytes:
    connection = getattr(THREAD_STATE, "render_connection", None)
    if connection is None:
        connection = http.client.HTTPSConnection("render.albiononline.com", timeout=timeout)
        THREAD_STATE.render_connection = connection
    path = f"/v1/item/{urllib.parse.quote(item_id, safe='')}.png?quality=1&size=64"
    try:
        connection.request("GET", path, headers={"User-Agent": USER_AGENT, "Connection": "keep-alive"})
        response = connection.getresponse()
        data = response.read()
        if response.status != 200:
            raise RuntimeError(f"render status {response.status}")
        return data
    except Exception:
        try:
            connection.close()
        finally:
            THREAD_STATE.render_connection = None
        raise


def base_id(value: str) -> str:
    return re.sub(r"@\d+$", "", value or "")


def catalog_ids(market_only: bool = True) -> list[str]:
    if market_only:
        rows = fetch(MARKET_IDS_URL).decode("utf-8").splitlines()
        result = {base_id(line.split(",", 1)[1].strip()) for line in rows if "," in line}
        return sorted(item_id for item_id in result if item_id)

    raw = json.loads(fetch(ITEMS_URL))
    rows = raw if isinstance(raw, list) else raw.get("items", raw.get("Items", []))
    result: set[str] = set()
    for row in rows:
        value = row.get("UniqueName") or row.get("uniqueName") or row.get("Index") or row.get("index")
        item_id = base_id(str(value or ""))
        if not item_id or "_UNTRADEABLE" in item_id or "_NONTRADABLE" in item_id:
            continue
        result.add(item_id)
    return sorted(result)


def dct_matrix(size: int = 32) -> np.ndarray:
    matrix = np.empty((size, size), dtype=np.float32)
    for frequency in range(size):
        scale = math.sqrt(1 / size) if frequency == 0 else math.sqrt(2 / size)
        for coordinate in range(size):
            matrix[frequency, coordinate] = scale * math.cos(
                math.pi * (2 * coordinate + 1) * frequency / (2 * size)
            )
    return matrix


DCT = dct_matrix()


def fingerprint(data: bytes) -> tuple[str, str, str]:
    image = Image.open(io.BytesIO(data)).convert("RGBA")
    backdrop = Image.new("RGBA", image.size, (44, 50, 54, 255))
    image = Image.alpha_composite(backdrop, image).convert("RGB")

    # The outer frame changes with item quality. The inner 76% preserves the
    # item artwork and is much more stable across screenshots and UI scales.
    inset_x = round(image.width * 0.12)
    inset_y = round(image.height * 0.12)
    image = image.crop((inset_x, inset_y, image.width - inset_x, image.height - inset_y))

    grey = np.asarray(image.resize((32, 32), Image.Resampling.LANCZOS).convert("L"), dtype=np.float32)
    coefficients = DCT @ grey @ DCT.T
    low = coefficients[:8, :8].reshape(-1)
    threshold = float(np.median(low[1:]))
    bits = 0
    for value in low:
        bits = (bits << 1) | int(value >= threshold)
    perceptual_hash = f"{bits:016x}"

    colours = np.asarray(image.resize((4, 4), Image.Resampling.BILINEAR), dtype=np.uint8).reshape(-1)
    colour_signature = "".join(format(min(15, int(value) // 16), "x") for value in colours)
    details = np.asarray(image.resize((12, 12), Image.Resampling.LANCZOS).convert("L"), dtype=np.uint8).reshape(-1)
    detail_signature = "".join(format(min(15, int(value) // 16), "x") for value in details)
    return perceptual_hash, colour_signature, detail_signature


def process_item(item_id: str) -> list[str] | None:
    for attempt in range(2):
        try:
            data = fetch_render(item_id)
            perceptual_hash, colour_signature, detail_signature = fingerprint(data)
            return [item_id, perceptual_hash, colour_signature, detail_signature]
        except Exception:
            if attempt == 0:
                time.sleep(0.2)
    return None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="item-visual-index.json")
    parser.add_argument("--workers", type=int, default=24)
    parser.add_argument("--all-catalog", action="store_true", help="Include non-market game assets too.")
    parser.add_argument("--limit", type=int, default=0, help="Only build the first N entries (for testing).")
    args = parser.parse_args()

    ids = catalog_ids(market_only=not args.all_catalog)
    if args.limit > 0:
        ids = ids[: args.limit]

    records: list[list[str]] = []
    failures = 0
    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = {pool.submit(process_item, item_id): item_id for item_id in ids}
        for completed, future in enumerate(as_completed(futures), start=1):
            result = future.result()
            if result is None:
                failures += 1
            else:
                records.append(result)
            if completed % 250 == 0 or completed == len(ids):
                print(f"{completed}/{len(ids)} · {len(records)} indexed · {failures} skipped", flush=True)

    records.sort(key=lambda row: row[0])
    payload = {
        "version": 2,
        "source": "Albion Online Render Service",
        "count": len(records),
        "records": records,
    }
    Path(args.output).write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    elapsed = time.monotonic() - started
    print(f"Wrote {args.output} ({len(records)} entries) in {elapsed:.1f}s")


if __name__ == "__main__":
    main()
