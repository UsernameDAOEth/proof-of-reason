"""Shared by the vid tests: paths, the published PASS receipt, an offline fetch, pixel reads."""

from __future__ import annotations

import json
import os
import subprocess
import sys

VID = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(VID)
FIXTURES = os.path.join(VID, "test", "fixtures")
PASS_PATH = os.path.join(VID, "receipts", "pass.json")
# The three takes run live on Monad mainnet on 29 Sep 2026, not screen-recorded. PASS_PATH stays the 25 Sep first receipt.
TAKE_DIR = os.path.join(VID, "receipts", "take-2026-09-29")
TAKE_PATHS = {outcome: os.path.join(TAKE_DIR, f"{outcome.lower()}.json") for outcome in ("PASS", "FAIL", "WAIT")}
if VID not in sys.path:
    sys.path.insert(0, VID)

import frame  # noqa: E402
import provenance  # noqa: E402


def load(path: str) -> dict:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def published() -> dict:
    """What api.proofofreason.com serves for the PASS intent: the receipt minus its provenance."""
    return {key: value for key, value in load(PASS_PATH).items() if key != "provenance"}


def offline_fetch(documents: dict[str, dict]):
    """A fetch that answers only the urls it was given, and refuses the rest like a dead url."""

    def fetch(url: str) -> dict:
        if url not in documents:
            raise provenance.Refused(f"{url} did not answer with a receipt (offline stub)")
        return documents[url]

    return fetch


def pass_fetch():
    receipt = load(PASS_PATH)
    return offline_fetch({receipt["provenance"]["url"]: published()})


def take_published(outcome: str) -> dict:
    """What api.proofofreason.com serves for a 29 Sep take: that receipt minus its provenance."""
    return {key: value for key, value in load(TAKE_PATHS[outcome]).items() if key != "provenance"}


def take_fetch(outcome: str):
    receipt = load(TAKE_PATHS[outcome])
    return offline_fetch({receipt["provenance"]["url"]: take_published(outcome)})


def take_spec(outcome: str) -> dict:
    """The spec for a 29 Sep take, built offline against its own published document."""
    import receipt2spec

    path = TAKE_PATHS[outcome]
    return receipt2spec.spec_from_receipt(load(path), path=path, fetch=take_fetch(outcome))


def rgb_frame(path: str, width: int, height: int, at: float | None = None) -> bytes:
    cmd = [frame.FFMPEG, "-v", "error"]
    if at is not None:
        cmd += ["-ss", f"{at}"]
    cmd += ["-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    data = subprocess.run(cmd, capture_output=True, check=True).stdout
    assert len(data) == width * height * 3, len(data)
    return data


def pixel(data: bytes, width: int, x: int, y: int) -> tuple[int, int, int]:
    offset = (y * width + x) * 3
    return data[offset], data[offset + 1], data[offset + 2]


def hex_rgb(color: str) -> tuple[int, int, int]:
    value = int(color[2:], 16)
    return value >> 16, (value >> 8) & 0xFF, value & 0xFF


def near(actual: tuple[int, int, int], color: str, tolerance: int = 14) -> bool:
    return all(abs(a - b) <= tolerance for a, b in zip(actual, hex_rgb(color)))
