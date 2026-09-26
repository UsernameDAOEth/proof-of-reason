"""The DJZS transmission frame, as measured.

Every number here is from the djzs-video-publish skill, sections 3 and 6, which were measured
pixel by pixel from the reference set. Nothing in this file is a guess, and nothing in it is
tuned by eye: if a position looks wrong, the skill is the place to change it.

Rendering is ffmpeg only: drawbox for rules, blocks and cursors, drawtext with fontfile and
textfile for every string, as section 7 requires (inline text breaks on escaping). No Playwright,
no Pillow, so the kit runs wherever ffmpeg and a DejaVu Sans Mono TTF exist.

Coordinates are the top left of a text box, matching the absolute positioned divs in section 7.

The geometry is the skill's. The words are not: the rail, the SYS_ID and every other string arrive
in the spec, so this file renders Proof of Reason without a Proof of Reason string in it.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field

import provenance

# Palette, section 3.
BG = "0x0A0A0A"
SCANLINE = "0x0C0D0C"
OUTER = "0x3CFE86"
INNER = "0x162419"
PHOSPHOR = "0x3DFF88"
DIM = "0x8A8A8A"
IDENTITY = "0x6E6E6E"
INK = "0xE6E6E6"
# Thumbnail only, section 6.
THUMB_OUTER = "0x36DB76"
THUMB_SERIES = "0x39EC7E"
THUMB_SUB = "0xB8B8B8"
THUMB_RAIL = "0x6F6F6F"

WIDTH = 1920
HEIGHT = 1080
FPS = 25
THUMB_WIDTH = 1280
THUMB_HEIGHT = 720

# DejaVu Sans Mono advances 0.602 em per character (section 3), which is how every right aligned
# string and every cursor offset in the reference was derived.
ADVANCE = 0.602

FONT_CANDIDATES = (
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts", "DejaVuSansMono.ttf"),
    "/Library/Fonts/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/opt/homebrew/share/fonts/DejaVuSansMono.ttf",
)
FONT_DIR_HINTS = (
    "/Users",
    "/usr/share/fonts",
    "/opt/homebrew/share/fonts",
    "/Library/Fonts",
)


def text_width(text: str, size: float) -> float:
    """Width of a monospace string at a given pixel size."""
    return len(text) * size * ADVANCE


def find_font(bold: bool = False) -> str:
    """DejaVu Sans Mono, or DejaVu Sans Mono Bold. Env overrides win, then a search."""
    env = os.environ.get("DEJAVU_MONO_BOLD" if bold else "DEJAVU_MONO")
    if env and os.path.exists(env):
        return env
    name = "DejaVuSansMono-Bold.ttf" if bold else "DejaVuSansMono.ttf"
    for candidate in FONT_CANDIDATES:
        path = candidate.replace("DejaVuSansMono.ttf", name)
        if os.path.exists(path):
            return path
    for root in FONT_DIR_HINTS:
        if not os.path.isdir(root):
            continue
        for dirpath, _dirnames, filenames in os.walk(root):
            if name in filenames:
                return os.path.join(dirpath, name)
    raise SystemExit(
        f"cannot find {name}. Set DEJAVU_MONO and DEJAVU_MONO_BOLD to the TTF paths."
    )


FFMPEG_DIRS = ("/opt/homebrew/opt/ffmpeg-full/bin", "/usr/local/opt/ffmpeg-full/bin")


def _tool(name: str) -> str | None:
    """FFMPEG_BIN wins, then a keg-only ffmpeg-full (stock Homebrew ffmpeg has no drawtext), then PATH."""
    env = os.environ.get("FFMPEG_BIN")
    for directory in ((env,) if env else ()) + FFMPEG_DIRS:
        path = os.path.join(directory, name)
        if os.access(path, os.X_OK):
            return path
    return shutil.which(name)


FFMPEG = _tool("ffmpeg") or "ffmpeg"
FFPROBE = _tool("ffprobe") or "ffprobe"


def require_ffmpeg() -> None:
    for tool in (FFMPEG, FFPROBE):
        if shutil.which(tool) is None:
            raise SystemExit(f"{tool} is not on PATH; the frame is rendered with ffmpeg")
    filters = subprocess.run([FFMPEG, "-hide_banner", "-filters"], capture_output=True, text=True).stdout
    if " drawtext " not in filters:
        raise SystemExit(f"{FFMPEG} has no drawtext filter; install ffmpeg-full or set FFMPEG_BIN")


@dataclass
class Draw:
    """Accumulates one ffmpeg filter chain. Text goes through files, never inline."""

    tmpdir: str
    regular: str
    bold: str
    filters: list[str] = field(default_factory=list)
    _n: int = 0

    def box(self, x: float, y: float, w: float, h: float, color: str, thickness: str | int = "fill") -> None:
        self.filters.append(
            f"drawbox=x={int(x)}:y={int(y)}:w={int(w)}:h={int(h)}:color={color}@1:t={thickness}"
        )

    def text(self, s: str, x: float, y: float, size: float, color: str, bold: bool = False) -> None:
        if s == "":
            return
        self._n += 1
        path = os.path.join(self.tmpdir, f"t{self._n:03d}.txt")
        # No trailing newline: drawtext would render an empty second line.
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(s)
        font = self.bold if bold else self.regular
        self.filters.append(
            f"drawtext=fontfile={font}:textfile={path}:expansion=none"
            f":x={int(x)}:y={int(y)}:fontsize={int(size)}:fontcolor={color}"
        )

    def text_right(self, s: str, right_edge: float, y: float, size: float, color: str, bold: bool = False) -> None:
        self.text(s, right_edge - text_width(s, size), y, size, color, bold)

    def text_spaced(self, s: str, x: float, y: float, size: float, color: str, em: float, bold: bool = False) -> None:
        """Letter spacing, which drawtext has no option for: one draw per character."""
        step = size * ADVANCE + size * em
        for index, char in enumerate(s):
            if char != " ":
                self.text(char, x + index * step, y, size, color, bold)

    def lines(
        self,
        items: list[tuple[str, str]],
        x: float,
        y: float,
        size: float,
        leading: float,
        bold: bool = False,
    ) -> None:
        for index, (s, color) in enumerate(items):
            self.text(s, x, y + index * leading, size, color, bold)

    def chain(self) -> str:
        return ",".join(self.filters)


def wrap(text: str, width_px: float, size: float) -> list[str]:
    """Greedy wrap to a pixel width, the way a fixed column does it."""
    limit = max(1, int(width_px // (size * ADVANCE)))
    words = text.split()
    if not words:
        return []
    out: list[str] = [words[0]]
    for word in words[1:]:
        if len(out[-1]) + 1 + len(word) <= limit:
            out[-1] = f"{out[-1]} {word}"
        else:
            out.append(word)
    return out


def hanging(text: str, width_px: float, size: float, indent_px: float) -> list[tuple[str, float]]:
    """A law line: first line flush, continuations indented by the hanging indent."""
    limit = max(1, int(width_px // (size * ADVANCE)))
    cont_limit = max(1, int((width_px - indent_px) // (size * ADVANCE)))
    words = text.split()
    rows: list[tuple[str, float]] = []
    current = ""
    for word in words:
        limit_now = limit if not rows else cont_limit
        if current == "":
            current = word
        elif len(current) + 1 + len(word) <= limit_now:
            current = f"{current} {word}"
        else:
            rows.append((current, 0.0 if not rows else indent_px))
            current = word
    if current:
        rows.append((current, 0.0 if not rows else indent_px))
    return rows


# ----------------------------------------------------------------- the 1920x1080 frame


def video_filters(spec: dict, draw: Draw) -> None:
    """Section 3, in order: borders, rail, series, laws, window border, proof, verdict, title, identity."""
    draw.box(20, 20, WIDTH - 40, HEIGHT - 40, OUTER, 2)
    draw.box(30, 30, WIDTH - 60, HEIGHT - 60, INNER, 1)

    draw.text(spec["rail"], 37, 73, 26, PHOSPHOR)
    draw.text(f"SYS_ID: {spec['sys_id']}", 37, 105, 22, DIM)
    draw.text_right(f"STATUS: {spec['status']}", WIDTH - 153, 73, 26, PHOSPHOR)

    series = spec["series"]
    draw.lines([(series[0], PHOSPHOR), (series[1], PHOSPHOR)], 36, 298, 22, 32)

    # Laws: 18 px, 28 px leading, 300 px wide, 32 px hanging indent, at (37,518).
    y = 518.0
    for law in spec["laws"]:
        color = PHOSPHOR if law["on"] else DIM
        for row, indent in hanging(f"{law['code']} {law['name']}", 300, 18, 32):
            draw.text(row, 37 + indent, y, 18, color)
            y += 28

    # The window border sits 2 px above and left of the window, 3 px below and right of it: measured.
    draw.box(467, 261, 987, 558, PHOSPHOR, 2)

    draw.text("PROOF-OF-LOGIC:", 1501, 539, 21, PHOSPHOR)
    proof_rows: list[tuple[str, str]] = []
    for item in spec["proof"]:
        for row in wrap(item, 335, 20) or [""]:
            proof_rows.append((row, DIM))
    draw.lines(proof_rows, 1501, 569, 20, 30)

    verdict = spec.get("verdict") or ""
    if verdict:
        draw.box(1500, 712, 290, 64, PHOSPHOR, "fill")
        # 39 px bold on the block, 26 px of left padding, centred on the block height.
        draw.text(verdict, 1500 + 26, 712 + (64 - 39) / 2 - 2, 39, BG, bold=True)

    title = spec["title"]
    draw.text(title[0], 38, 930, 34, INK, bold=True)
    draw.text(title[1], 36, 974, 26, INK, bold=True)
    run = spec["run"]
    draw.text(run, 37, 1008, 20, PHOSPHOR)
    draw.box(37 + text_width(run, 20) + 8, 1008, 14, 22, PHOSPHOR, "fill")

    draw.lines([(line, IDENTITY) for line in spec["identity"]], 1501, 960, 18, 26)


# ----------------------------------------------------------------- the 1280x720 thumbnail


def thumb_filters(spec: dict, draw: Draw) -> None:
    """Section 6. The same stage, measured at 1280x720."""
    thumb = spec.get("thumb") or {}
    draw.box(23, 23, THUMB_WIDTH - 46, THUMB_HEIGHT - 46, THUMB_OUTER, 2)
    draw.box(35, 35, THUMB_WIDTH - 70, THUMB_HEIGHT - 70, INNER, 2)

    draw.text(f"{spec['rail']} / SYS_ID: {spec['sys_id']}", 56, 67, 23, THUMB_RAIL)
    draw.text_right(f"STATUS: {spec['status']}", THUMB_WIDTH - 54, 67, 23, THUMB_RAIL)

    draw.text(spec["series_thumb"], 56, 142, 30, THUMB_SERIES)
    draw.text(thumb.get("title", ""), 56, 188, 63, INK, bold=True)
    draw.lines([(line, THUMB_SUB) for line in thumb.get("sub", [])], 56, 283, 28, 40)

    verdict = spec.get("verdict") or ""
    if verdict:
        draw.box(56, 412, 700, 216, PHOSPHOR, "fill")
        draw.text_spaced("VERDICT //", 56 + 28, 412 + 24, 33, BG, em=0.17, bold=True)
        draw.text(verdict, 56 + 26, 412 + 70, 150, BG, bold=True)

    draw.text("PROOF-OF-LOGIC:", 801, 443, 20, PHOSPHOR)
    rows: list[tuple[str, str]] = []
    for item in spec["proof"][:3]:
        for row in wrap(item, 440, 20) or [""]:
            rows.append((row, DIM))
    domain = spec["domain"]
    rows.append((domain, DIM))
    draw.lines(rows, 801, 472, 20, 29)
    # Cursor 14x24, 132 px after the domain, on the domain's own row.
    domain_y = 472 + (len(rows) - 1) * 29
    draw.box(801 + text_width(domain, 20) + 132, domain_y, 14, 24, PHOSPHOR, "fill")

    draw.text(f"END_TRANSMISSION. // {spec['ens']}", 56, 644, 23, THUMB_RAIL)


# ----------------------------------------------------------------- encode


def _scanline_bg(width: int, height: int) -> str:
    """bg #0A0A0A with a 1 px #0C0D0C scanline every 4 px, as one expression."""
    return (
        f"color=c={BG}:s={width}x{height}:r={FPS},format=rgb24,"
        "geq=r='if(eq(mod(Y\\,4)\\,0)\\,12\\,10)':"
        "g='if(eq(mod(Y\\,4)\\,0)\\,13\\,10)':"
        "b='if(eq(mod(Y\\,4)\\,0)\\,12\\,10)'"
    )


def _window_inputs(window: dict, duration: float) -> tuple[list[str], str, bool]:
    """The evidence source: its ffmpeg inputs, the filter that fits it to 982x553, and whether it has audio."""
    kind = window.get("type", "none")
    fit = (
        "scale=982:553:force_original_aspect_ratio=decrease,"
        "pad=982:553:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=25"
    )
    if kind == "clip":
        args = ["-ss", str(window["in"]), "-t", f"{duration:.3f}", "-i", window["src"]]
        return args, fit, True
    if kind == "image":
        args = ["-loop", "1", "-t", f"{duration:.3f}", "-i", window["src"]]
        return args, fit, False
    # typed and none both start from a flat panel; typed draws onto it.
    args = ["-f", "lavfi", "-t", f"{duration:.3f}", "-i", f"color=c={BG}:s=982x553:r={FPS}"]
    return args, "setsar=1,fps=25", False


def _typed_filters(window: dict, draw: Draw) -> str:
    """Section 5 typed mode: claim in bold, then lines revealed one by one, then a blinking cursor."""
    step = float(window.get("step", 1.4))
    lines = window["lines"]
    parts: list[str] = []
    y = 40.0
    for index, item in enumerate(lines):
        text = item["text"] if isinstance(item, dict) else str(item)
        bold = bool(item.get("bold")) if isinstance(item, dict) else False
        color = item.get("color", INK) if isinstance(item, dict) else INK
        size = float(item.get("size", 22)) if isinstance(item, dict) else 22.0
        for row in wrap(text, 900, size) or [""]:
            draw._n += 1
            path = os.path.join(draw.tmpdir, f"w{draw._n:03d}.txt")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(row)
            font = draw.bold if bold else draw.regular
            at = index * step
            parts.append(
                f"drawtext=fontfile={font}:textfile={path}:expansion=none:x=40:y={int(y)}"
                f":fontsize={int(size)}:fontcolor={color}:enable='gte(t\\,{at:.2f})'"
            )
            y += size * 1.45
        y += 6
    reveal = len(lines) * step
    parts.append(
        f"drawbox=x=40:y={int(y)}:w=12:h=22:color={PHOSPHOR}@1:t=fill"
        f":enable='gte(t\\,{reveal:.2f})*lt(mod(t\\,1)\\,0.5)'"
    )
    return ",".join(parts)


def render_video(
    spec: dict,
    out_path: str,
    duration: float | None = None,
    fetch: provenance.Fetch = provenance.fetch_live,
) -> None:
    provenance.require_renderable(spec.get("trace"), fetch)
    require_ffmpeg()
    window = spec.get("window") or {"type": "none"}
    dur = duration if duration is not None else float(window.get("dur", 6))
    tmpdir = tempfile.mkdtemp(prefix="djzs-frame-")
    try:
        draw = Draw(tmpdir=tmpdir, regular=find_font(False), bold=find_font(True))
        video_filters(spec, draw)
        win_args, win_fit, has_audio = _window_inputs(window, dur)
        # typed reveals line by line; none draws its h1 and lines at once (step 0).
        if window.get("type") in ("typed", "none") and window.get("lines"):
            win_fit = f"{win_fit},{_typed_filters(window, draw)}"

        graph = (
            f"[1:v]{win_fit}[win];"
            f"[0:v][win]overlay=469:263:shortest=1[base];"
            f"[base]{draw.chain()}[v0];[v0]format=yuv420p[v]"
        )
        cmd = [
            FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-t", f"{dur:.3f}", "-i", _scanline_bg(WIDTH, HEIGHT),
            *win_args,
        ]
        if has_audio:
            cmd += ["-filter_complex", graph, "-map", "[v]", "-map", "1:a?"]
        else:
            # Every segment carries audio so a straight cut concat never has to invent one.
            cmd += [
                "-f", "lavfi", "-t", f"{dur:.3f}", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
                "-filter_complex", graph, "-map", "[v]", "-map", "2:a",
            ]
        # The trace rides in the container so episode.py can re-check every segment it cuts in.
        cmd += [
            "-metadata", f"comment={json.dumps(spec['trace'], separators=(',', ':'))}",
            "-t", f"{dur:.3f}", "-r", str(FPS),
            "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
            "-movflags", "+faststart", out_path,
        ]
        subprocess.run(cmd, check=True)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def segment_trace(path: str) -> dict | None:
    """The trace render_video wrote into the container's comment tag, or None if nothing is there."""
    probe = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format_tags=comment", "-of", "json", path],
        capture_output=True, text=True, check=True,
    )
    comment = json.loads(probe.stdout).get("format", {}).get("tags", {}).get("comment")
    try:
        return json.loads(comment) if comment else None
    except json.JSONDecodeError:
        return None


def extract_frame(
    video_path: str,
    out_path: str,
    at: float,
    fetch: provenance.Fetch = provenance.fetch_live,
) -> None:
    """One frame of a rendered short as a PNG, for the look-at-it check the skill asks for.

    A still is a rendered output like any other, so it is held to the same rule: the short it comes
    from has to carry a trace, and that trace has to still answer.
    """
    require_ffmpeg()
    provenance.refuse_synthetic_name(video_path)
    provenance.require_renderable(segment_trace(video_path), fetch)
    subprocess.run(
        [FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{at:.3f}",
         "-i", video_path, "-frames:v", "1", out_path],
        check=True,
    )


def render_thumb(spec: dict, out_path: str, fetch: provenance.Fetch = provenance.fetch_live) -> None:
    provenance.require_renderable(spec.get("trace"), fetch)
    require_ffmpeg()
    tmpdir = tempfile.mkdtemp(prefix="djzs-thumb-")
    try:
        draw = Draw(tmpdir=tmpdir, regular=find_font(False), bold=find_font(True))
        thumb_filters(spec, draw)
        cmd = [
            FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", _scanline_bg(THUMB_WIDTH, THUMB_HEIGHT),
            "-vf", draw.chain(), "-frames:v", "1", out_path,
        ]
        subprocess.run(cmd, check=True)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
