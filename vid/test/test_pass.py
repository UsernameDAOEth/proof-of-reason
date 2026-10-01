"""The PASS short, built from the published receipt with the typed window standing in.

Proves the laws mapping, the proof lines, the frame geometry and the thumbnail. The window stays
typed from the receipt: the 29 Sep takes were run live and not screen-recorded.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest

from support import PASS_PATH, ROOT, hex_rgb, load, near, offline_fetch, pass_fetch, pixel, rgb_frame, take_spec

import frame
import receipt2spec

W, H = frame.WIDTH, frame.HEIGHT
TW, TH = frame.THUMB_WIDTH, frame.THUMB_HEIGHT


def spec() -> dict:
    return receipt2spec.spec_from_receipt(load(PASS_PATH), path=PASS_PATH, fetch=pass_fetch())


def any_near(data: bytes, width: int, box: tuple[int, int, int, int], color: str) -> bool:
    x0, y0, x1, y1 = box
    return any(near(pixel(data, width, x, y), color, 24) for y in range(y0, y1) for x in range(x0, x1))


class LawsAndProof(unittest.TestCase):
    def test_all_four_laws_hold_on_the_pass_receipt(self) -> None:
        laws = spec()["laws"]
        self.assertEqual([law["code"] for law in laws], ["L1", "L2", "L3", "L4"])
        self.assertEqual([law["on"] for law in laws], [True, True, True, True])

    def test_each_law_goes_dark_when_its_question_fails(self) -> None:
        receipt = load(PASS_PATH)
        cases = {
            "L1": lambda r: r["results"][0].update(status="FALSE"),
            "L2": lambda r: r["verdict"].update(failing=[{"source": "mandate", "rule": "allowedMarkets"}]),
            "L3": lambda r: r["verdict"].update(missingKinds=["liquidity"]),
            "L4": lambda r: r["intent"].update(notAfterBlock=r["verdict"]["checkedAtBlock"]),
        }
        for code, breaks in cases.items():
            with self.subTest(code=code):
                broken = json.loads(json.dumps(receipt))
                breaks(broken)
                lit = {law["code"]: law["on"] for law in receipt2spec.laws_from_receipt(broken)}
                self.assertFalse(lit[code])
                self.assertTrue(all(on for other, on in lit.items() if other != code))

    def test_proof_lines(self) -> None:
        self.assertEqual(
            spec()["proof"],
            ["rate: 9.5558 pct +/- 0.1", "liquidity: floor 1639330385558", "registry: 0x4eb44225...740240"],
        )

    def test_the_frame_mapping(self) -> None:
        s = spec()
        self.assertEqual(s["rail"], "// PROOF_OF_REASON")
        self.assertEqual(s["sys_id"], "por-monad-01")
        self.assertEqual(s["status"], "RECORDED")
        self.assertEqual(s["verdict"], "PASS")
        self.assertEqual(s["series"], ["PREMISE CHECK //", "MONAD 143 · BLOCK 107991649"])
        self.assertEqual(s["series_thumb"], "// PREMISE CHECK / MONAD 143 · BLOCK 107991649")
        self.assertEqual(s["run"], "> checked: block 107991649")
        self.assertEqual(
            s["title"],
            ["THE AGENT STATED ITS REASON.", "the chain said true. the gate moved the money."],
        )
        self.assertEqual(s["thumb"]["title"], "PROOF OF REASON")
        self.assertEqual(
            s["thumb"]["sub"],
            ["monad 143 · block 107991649", "the chain said true. the gate moved the money."],
        )
        self.assertEqual(
            s["identity"], ["proofofreason.com", "DJZS AI, LLC · issuer", "username.dj-z-s.eth"]
        )
        self.assertEqual(s["window"]["type"], "typed")

    def test_status_says_recorded_only_when_the_registry_took_it(self) -> None:
        self.assertEqual(spec()["status"], receipt2spec.STATUS_RECORDED)
        # The same check with the registry write failed: the verdict is signed, and RECORDED is the
        # one word that claims the chain has it, so it must go.
        unrecorded = load(PASS_PATH)
        unrecorded["registry"].pop("tx")
        unrecorded["registry"]["error"] = "nonce taken"
        url = unrecorded["provenance"]["url"]
        live = {key: value for key, value in unrecorded.items() if key != "provenance"}
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "pass.json")
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(unrecorded, handle)
            built = receipt2spec.spec_from_receipt(unrecorded, path=path, fetch=offline_fetch({url: live}))
        self.assertEqual(built["status"], receipt2spec.STATUS_SIGNED)
        self.assertEqual(built["proof"][2], "registry: nonce taken")

    def test_freshness_is_the_gates_own_window(self) -> None:
        gate = os.path.join(ROOT, "contracts", "src", "ReasonGate.sol")
        with open(gate, encoding="utf-8") as handle:
            source = handle.read()
        match = re.search(r"DEFAULT_MAX_AGE_BLOCKS\s*=\s*(\d+)", source)
        self.assertIsNotNone(match, "ReasonGate.sol no longer declares DEFAULT_MAX_AGE_BLOCKS")
        self.assertEqual(int(match.group(1)), receipt2spec.MAX_AGE_BLOCKS)

    def test_freshness_fails_on_state_read_outside_the_window(self) -> None:
        receipt = load(PASS_PATH)
        checked = int(receipt["verdict"]["checkedAtBlock"])

        def with_sample_block(block: int) -> bool:
            edited = json.loads(json.dumps(receipt))
            edited["observations"][0]["samples"][0]["block"] = str(block)
            return {law["code"]: law["on"] for law in receipt2spec.laws_from_receipt(edited)}["L4"]

        self.assertTrue(with_sample_block(checked - receipt2spec.MAX_AGE_BLOCKS))
        self.assertFalse(with_sample_block(checked - receipt2spec.MAX_AGE_BLOCKS - 1))
        self.assertFalse(with_sample_block(checked + 1))  # read after the check it is pinned to

    def test_proof_column_clears_the_verdict_block(self) -> None:
        # 335 px wide at 20 px, 30 px leading from y=569, and the verdict block starts at y=712:
        # five physical rows fit and a sixth does not. Claimed against observed for two claims plus
        # the registry tx needs six, which is why that comparison lives in the window, not here.
        rows = sum(len(frame.wrap(item, 335, 20)) for item in spec()["proof"])
        self.assertEqual(rows, 5)
        self.assertLessEqual(569 + (rows - 1) * 30 + 20, 712)
        self.assertGreater(569 + rows * 30 + 20, 712)

    def test_nothing_on_the_rail_collides(self) -> None:
        s = spec()
        status_start = (W - 153) - frame.text_width(f"STATUS: {s['status']}", 26)
        self.assertLess(37 + frame.text_width(s["rail"], 26), status_start)
        self.assertLess(37 + frame.text_width(f"SYS_ID: {s['sys_id']}", 22), status_start)
        for line in s["series"]:                      # series must clear the window border at x=467
            self.assertLess(36 + frame.text_width(line, 22), 467)
        self.assertLess(38 + frame.text_width(s["title"][0], 34), 1501)   # identity column at 1501
        self.assertLess(36 + frame.text_width(s["title"][1], 26), 1501)

    def test_nothing_on_the_thumbnail_overruns(self) -> None:
        s = spec()
        inner = TW - 35
        rail = f"{s['rail']} / SYS_ID: {s['sys_id']}"
        status_start = (TW - 54) - frame.text_width(f"STATUS: {s['status']}", 23)
        self.assertLess(56 + frame.text_width(rail, 23), status_start)
        self.assertLess(56 + frame.text_width(s["series_thumb"], 30), inner)
        self.assertLess(56 + frame.text_width(s["thumb"]["title"], 63), inner)
        for line in s["thumb"]["sub"]:
            self.assertLess(56 + frame.text_width(line, 28), inner)


class TakeWidths(unittest.TestCase):
    """The FAIL and WAIT takes of 29 Sep: their own words fit the frame and the thumbnail too."""

    def test_titles_and_subtitles_fit(self) -> None:
        inner = TW - 35
        for outcome in ("FAIL", "WAIT"):
            s = take_spec(outcome)
            title, subtitle = s["title"]
            with self.subTest(outcome=outcome):
                self.assertEqual(s["verdict"], outcome)
                self.assertLessEqual(len(title), 71)
                self.assertLessEqual(len(subtitle), 70)
                self.assertLess(38 + frame.text_width(title, 34), 1501)   # identity column at 1501
                self.assertLess(36 + frame.text_width(subtitle, 26), 1501)
                self.assertLess(56 + frame.text_width(s["series_thumb"], 30), inner)
                self.assertLess(56 + frame.text_width(s["thumb"]["title"], 63), inner)
                for line in s["thumb"]["sub"]:
                    self.assertLess(56 + frame.text_width(line, 28), inner)


class FrameIsProductBlind(unittest.TestCase):
    """frame.py renders the measured geometry and holds no product string of its own."""

    def test_the_renderer_names_no_product(self) -> None:
        with open(frame.__file__, encoding="utf-8") as handle:
            body = handle.read().split('"""', 2)[2]  # past the module docstring
        for token in ("DJZS_AUDIT", "djzs-mainnet", "PROOF_OF_REASON", "por-monad", "PROOF OF REASON"):
            with self.subTest(token=token):
                self.assertNotIn(token, body)

    def test_the_rail_is_whatever_the_spec_says(self) -> None:
        # Swap the rail and the drawn strings follow, which is what makes the geometry reusable.
        tmp = tempfile.mkdtemp(prefix="vid-rail-")
        try:
            draw = frame.Draw(tmpdir=tmp, regular=frame.find_font(False), bold=frame.find_font(True))
            edited = spec()
            edited["rail"], edited["sys_id"] = "// OTHER_RAIL", "other-01"
            frame.video_filters(edited, draw)
            drawn = set()
            for name in sorted(os.listdir(tmp)):
                with open(os.path.join(tmp, name), encoding="utf-8") as handle:
                    drawn.add(handle.read())
            self.assertIn("// OTHER_RAIL", drawn)
            self.assertIn("SYS_ID: other-01", drawn)
            self.assertNotIn("// PROOF_OF_REASON", drawn)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class RenderedShort(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.dir = tempfile.mkdtemp(prefix="vid-pass-")
        cls.spec = spec()
        cls.video = os.path.join(cls.dir, "pass.mp4")
        cls.thumb = os.path.join(cls.dir, "pass-thumb.png")
        frame.render_video(cls.spec, cls.video, fetch=pass_fetch())
        frame.render_thumb(cls.spec, cls.thumb, fetch=pass_fetch())
        # After the last typed line is revealed: the whole receipt reads out in the window.
        cls.last = rgb_frame(cls.video, W, H, at=cls.spec["window"]["dur"] - 1.0)
        cls.first = rgb_frame(cls.video, W, H, at=0.2)
        cls.thumb_rgb = rgb_frame(cls.thumb, TW, TH)

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.dir, ignore_errors=True)

    def test_encode(self) -> None:
        probe = subprocess.run(
            [frame.FFPROBE, "-v", "error", "-show_entries",
             "stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate:format=duration",
             "-of", "json", self.video],
            capture_output=True, text=True, check=True,
        )
        info = json.loads(probe.stdout)
        video = next(s for s in info["streams"] if s["codec_type"] == "video")
        audio = next(s for s in info["streams"] if s["codec_type"] == "audio")
        self.assertEqual((video["codec_name"], video["width"], video["height"], video["r_frame_rate"]),
                         ("h264", 1920, 1080, "25/1"))
        self.assertEqual((audio["codec_name"], audio["sample_rate"]), ("aac", "48000"))
        self.assertAlmostEqual(float(info["format"]["duration"]), self.spec["window"]["dur"], delta=0.1)

    def test_borders_and_window(self) -> None:
        f = self.last
        self.assertTrue(near(pixel(f, W, 960, 20), frame.OUTER))       # outer border, top edge
        self.assertTrue(near(pixel(f, W, 20, 540), frame.OUTER))       # outer border, left edge
        self.assertTrue(near(pixel(f, W, 960, 261), frame.PHOSPHOR))   # window border, top
        self.assertTrue(near(pixel(f, W, 467, 540), frame.PHOSPHOR))   # window border, left
        self.assertTrue(near(pixel(f, W, 1452, 540), frame.PHOSPHOR))  # window border, right
        self.assertTrue(near(pixel(f, W, 960, 817), frame.PHOSPHOR))   # window border, bottom
        self.assertTrue(near(pixel(f, W, 1200, 780), frame.BG, 6))     # inside the window, below the text

    def test_verdict_block(self) -> None:
        self.assertTrue(near(pixel(self.last, W, 1780, 770), frame.PHOSPHOR))
        self.assertTrue(near(pixel(self.last, W, 1502, 714), frame.PHOSPHOR))
        self.assertFalse(near(pixel(self.last, W, 1795, 744), frame.PHOSPHOR))  # right of the block

    def test_laws_render_lit(self) -> None:
        # Four laws over eight rows from y=518; lit is phosphor, dark would be #8A8A8A.
        # Green text picks up greyish fringes from 4:2:0 chroma, so dark is judged as neutral ink
        # (channels within 12 of each other, bright enough to be text), which lit text never is.
        box = (37, 518, 337, 518 + 8 * 28)
        self.assertTrue(any_near(self.last, W, box, frame.PHOSPHOR))
        neutral = [
            (x, y) for y in range(box[1], box[3]) for x in range(box[0], box[2])
            if max(pixel(self.last, W, x, y)) > 90
            and max(pixel(self.last, W, x, y)) - min(pixel(self.last, W, x, y)) < 12
        ]
        self.assertEqual(neutral, [])

    def test_typed_window_reveals_over_time(self) -> None:
        verdict_row = (469 + 40, 263 + 280, 469 + 300, 263 + 310)
        self.assertFalse(any_near(self.first, W, verdict_row, frame.PHOSPHOR))
        self.assertTrue(any_near(self.last, W, verdict_row, frame.PHOSPHOR))

    def test_thumbnail(self) -> None:
        t = self.thumb_rgb
        self.assertTrue(near(pixel(t, TW, 640, 23), frame.THUMB_OUTER))
        self.assertTrue(near(pixel(t, TW, 700, 620), frame.PHOSPHOR))   # verdict block
        self.assertTrue(near(pixel(t, TW, 60, 416), frame.PHOSPHOR))
        self.assertFalse(near(pixel(t, TW, 770, 520), frame.PHOSPHOR))  # right of the block
        self.assertTrue(any_near(t, TW, (801, 443, 990, 465), frame.PHOSPHOR))  # PROOF-OF-LOGIC:
        self.assertNotEqual(hex_rgb(frame.PHOSPHOR), pixel(t, TW, 1200, 200))


if __name__ == "__main__":
    unittest.main()
