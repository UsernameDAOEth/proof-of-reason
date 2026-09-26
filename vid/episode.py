"""Concatenate the transmission into one episode, straight cuts, no transitions.

    python3 vid/episode.py vid/out/episode.mp4 vid/out/open.mp4 vid/out/pass.mp4 vid/out/numbers.mp4 vid/out/end.mp4

Every segment clipaudit.py writes carries a stereo 48 kHz audio track, silent when the window has
no sound of its own, so the concat never has to invent one and the cut lands frame accurate.

Every segment also carries the trace of the spec it was rendered from, in its comment tag. A
segment with no trace, a synthetic-* segment, or a receipt segment whose provenance url no longer
answers with that intent is refused, and an episode with no live receipt segment is refused.
"""

from __future__ import annotations

import os
import subprocess
import sys

import frame
import provenance


# frame.py writes the trace into the container, so it is the one that reads it back.
segment_trace = frame.segment_trace


def require_segments(segments: list[str], fetch: provenance.Fetch = provenance.fetch_live) -> None:
    receipts = 0
    for path in segments:
        provenance.refuse_synthetic_name(path)
        trace = segment_trace(path)
        try:
            provenance.require_renderable(trace, fetch)
        except provenance.Refused as refused:
            raise provenance.Refused(f"{os.path.basename(path)}: {refused.reason}") from None
        receipts += trace.get("source") == "receipt"
    if receipts == 0:
        raise provenance.Refused("no segment carries a live api.proofofreason.com receipt")


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print("usage: episode.py <out.mp4> <segment.mp4> <segment.mp4> ...", file=sys.stderr)
        return 1
    out_path, segments = argv[0], argv[1:]
    missing = [path for path in segments if not os.path.exists(path)]
    if missing:
        raise SystemExit(f"missing segments: {', '.join(missing)}")
    frame.require_ffmpeg()
    require_segments(segments)

    cmd = [frame.FFMPEG, "-y", "-hide_banner", "-loglevel", "error"]
    for path in segments:
        cmd += ["-i", path]
    streams = "".join(f"[{i}:v][{i}:a]" for i in range(len(segments)))
    cmd += [
        "-filter_complex", f"{streams}concat=n={len(segments)}:v=1:a=1[v][a]",
        "-map", "[v]", "-map", "[a]",
        "-r", str(frame.FPS),
        "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
        "-movflags", "+faststart", out_path,
    ]
    subprocess.run(cmd, check=True)
    probe = subprocess.run(
        [frame.FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", out_path],
        capture_output=True, text=True, check=True,
    )
    print(f"wrote {out_path} from {len(segments)} segments, {float(probe.stdout.strip()):.2f} s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
