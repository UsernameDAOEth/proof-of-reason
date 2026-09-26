"""No synthetic receipts on screen.

A receipt reaches a short, a thumbnail or an episode only if it is the receipt the validator
published. Two rules, checked by receipt2spec.py when the spec is built, again by frame.py when
the short or thumbnail is rendered, and again by episode.py on every segment it cuts together:

  1. A file named synthetic-*.json is a test fixture. Whatever the engine generates lives under
     vid/test/fixtures/ with that prefix, and it is refused by name, whatever it contains.
  2. The receipt carries a provenance field whose url is
     https://api.proofofreason.com/receipts/<intentHash>, the hash matches the receipt's own
     intent, and that url answers now with the same document. A url that does not answer, or
     answers with something else, is refused.

Frames with no receipt behind them (open, numbers, end) trace to numbers.json instead and put no
receipt on screen; an episode still needs at least one live receipt segment.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from typing import Callable

SYNTHETIC_PREFIX = "synthetic-"
RECEIPT_URL = re.compile(r"^https://api\.proofofreason\.com/receipts/(0x[0-9a-f]{64})$")

Fetch = Callable[[str], dict]


class Refused(SystemExit):
    """Raised instead of rendering. A SystemExit so a CLI stops with the reason and a non-zero code."""

    def __init__(self, reason: str) -> None:
        super().__init__(f"refused: {reason}")
        self.reason = reason


def fetch_live(url: str) -> dict:
    """GET the published receipt. Any failure to answer is a refusal, never a pass."""
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "por-vid/1"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        raise Refused(f"{url} did not answer with a receipt ({error})") from error


def refuse_synthetic_name(path: str | None) -> None:
    if path and os.path.basename(path).startswith(SYNTHETIC_PREFIX):
        raise Refused(f"{os.path.basename(path)} is a synthetic fixture, not a published receipt")


def receipt_url(document: dict) -> str | None:
    provenance = document.get("provenance")
    if isinstance(provenance, dict):
        return provenance.get("url")
    return None


def _check_url(url: object, intent_hash: str) -> str:
    if not isinstance(url, str) or not url:
        raise Refused("no receipt url in the provenance field")
    match = RECEIPT_URL.match(url)
    if match is None:
        raise Refused(f"{url} is not an api.proofofreason.com receipt url")
    if match.group(1).lower() != intent_hash.lower():
        raise Refused(f"{url} names a different intent than {intent_hash}")
    return url


def require_live_receipt(path: str | None, receipt: dict, fetch: Fetch = fetch_live) -> str:
    """The receipt file itself: name, provenance url, and the live document equal to this one."""
    refuse_synthetic_name(path)
    intent_hash = receipt.get("intent", {}).get("intentHash", "")
    url = _check_url(receipt_url(receipt), intent_hash)
    live = fetch(url)
    local = {key: value for key, value in receipt.items() if key != "provenance"}
    if live != local:
        raise Refused(f"{url} answers with a different receipt than {os.path.basename(path or '')}")
    return url


def require_renderable(trace: dict | None, fetch: Fetch = fetch_live) -> None:
    """A spec's trace, at render time. Receipt frames are re-checked against the live url."""
    if not isinstance(trace, dict):
        raise Refused("the spec has no trace, so nothing says where its numbers came from")
    source = trace.get("source")
    if source == "numbers":
        return
    if source != "receipt":
        raise Refused(f"unknown trace source {source!r}")
    refuse_synthetic_name(trace.get("file"))
    intent_hash = trace.get("intentHash") or ""
    url = _check_url(trace.get("provenance"), intent_hash)
    live = fetch(url)
    live_hash = live.get("intent", {}).get("intentHash", "")
    if live_hash.lower() != intent_hash.lower():
        raise Refused(f"{url} answers with intent {live_hash or 'none'}, not {intent_hash}")
    if trace.get("outcome") and live.get("verdict", {}).get("outcome") != trace["outcome"]:
        raise Refused(f"{url} answers with verdict {live.get('verdict', {}).get('outcome')}, not {trace['outcome']}")
