"""Render one transmission frame: 1920x1080 video, or the 1280x720 thumbnail from the same spec.

    python3 vid/clipaudit.py vid/out/spec-pass.json vid/out/pass.mp4
    python3 vid/clipaudit.py vid/out/spec-pass.json vid/out/pass.mp4 --thumb
    python3 vid/clipaudit.py vid/out/spec-pass.json vid/out/pass.mp4 --frame 2
    python3 vid/clipaudit.py vid/out/spec-pass.json vid/out/pass.mp4 --clip evidence.mp4 --in 0:12 --out 0:30

The spec says what the frame reads; the window says what plays inside it. With --clip the evidence
is scaled to fit the measured 982x553 window and keeps its own audio. Without one the window is
whatever the spec carries, which for a receipt is the receipt typing itself out.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

import frame
import provenance


def timecode(value: str) -> float:
    """Accepts 12, 0:12, 1:02:03 or 12.5."""
    parts = str(value).split(":")
    seconds = 0.0
    for part in parts:
        seconds = seconds * 60 + float(part)
    return seconds


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(
            "usage: clipaudit.py <spec.json> <out.mp4> [--thumb] [--frame T] "
            "[--clip src --in T --out T] [--dur N]",
            file=sys.stderr,
        )
        return 1
    spec_path, out_path = argv[0], argv[1]
    rest = argv[2:]
    provenance.refuse_synthetic_name(spec_path)
    with open(spec_path, encoding="utf-8") as handle:
        spec = json.load(handle)

    def option(name: str) -> str | None:
        return rest[rest.index(name) + 1] if name in rest else None

    clip = option("--clip")
    duration = float(option("--dur")) if option("--dur") else None
    if clip is not None:
        start = timecode(option("--in") or "0")
        end = option("--out")
        if end is not None:
            duration = timecode(end) - start
        spec["window"] = {"type": "clip", "src": clip, "in": start, "dur": duration or 0}
        if duration is None:
            raise SystemExit("--clip needs --out or --dur so the frame knows how long to run")

    if "--thumb" in rest:
        thumb_path = f"{os.path.splitext(out_path)[0]}-thumb.png"
        frame.render_thumb(spec, thumb_path)
        print(f"wrote {thumb_path} ({frame.THUMB_WIDTH}x{frame.THUMB_HEIGHT})")
        return 0

    if "--frame" in rest:
        # A still out of a short already rendered: the skill's look-at-it check, section 8.
        at = timecode(option("--frame") or "2")
        frame_path = f"{os.path.splitext(out_path)[0]}-frame.png"
        frame.extract_frame(out_path, frame_path, at)
        print(f"wrote {frame_path} at t={at:g}s of {os.path.basename(out_path)}")
        return 0

    frame.render_video(spec, out_path, duration)
    probe = subprocess.run(
        [frame.FFPROBE, "-v", "error", "-show_entries", "stream=codec_name,width,height,r_frame_rate",
         "-of", "default=noprint_wrappers=1:nokey=1", out_path],
        capture_output=True, text=True, check=True,
    )
    print(f"wrote {out_path}: {' '.join(probe.stdout.split())}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
