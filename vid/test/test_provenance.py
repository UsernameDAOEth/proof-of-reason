"""The ruling: no synthetic receipts on screen.

A synthetic-*.json fixture, or a receipt without a live api.proofofreason.com url in its
provenance field, never becomes a spec, a short, a thumbnail or an episode segment.

    python3 -m unittest discover -s vid/test -t vid/test
"""

from __future__ import annotations

import copy
import json
import os
import shutil
import subprocess
import tempfile
import unittest

from support import FIXTURES, PASS_PATH, VID, load, offline_fetch, pass_fetch, published

import clipaudit
import episode
import frame
import provenance
import receipt2spec

PASS_URL = load(PASS_PATH)["provenance"]["url"]


class Workdir(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="vid-test-")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, name: str, document: dict) -> str:
        path = os.path.join(self.tmp, name)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(document, handle)
        return path


class SpecRefusal(Workdir):
    """receipt2spec.py, where a receipt becomes a spec."""

    def spec(self, path: str, fetch=None):
        return receipt2spec.spec_from_receipt(load(path), path=path, fetch=fetch or pass_fetch())

    def test_published_pass_receipt_builds(self) -> None:
        spec = self.spec(PASS_PATH)
        self.assertEqual(spec["trace"]["provenance"], PASS_URL)
        self.assertEqual(spec["trace"]["file"], "pass.json")

    def test_every_fixture_is_named_synthetic(self) -> None:
        names = sorted(os.listdir(FIXTURES))
        self.assertTrue(names)
        for name in names:
            self.assertTrue(name.startswith("synthetic-") and name.endswith(".json"), name)

    def test_synthetic_fixtures_are_refused(self) -> None:
        for name in sorted(os.listdir(FIXTURES)):
            with self.subTest(name=name), self.assertRaises(provenance.Refused) as caught:
                self.spec(os.path.join(FIXTURES, name))
            self.assertIn("synthetic fixture", caught.exception.reason)

    def test_synthetic_name_wins_over_a_valid_url(self) -> None:
        # synthetic-pass.json is the live receipt byte for byte, provenance included.
        path = os.path.join(FIXTURES, "synthetic-pass.json")
        self.assertEqual(load(path), load(PASS_PATH))
        with self.assertRaises(provenance.Refused):
            self.spec(path)

    def test_cli_refuses_with_nonzero_exit(self) -> None:
        out = os.path.join(self.tmp, "spec.json")
        with self.assertRaises(SystemExit) as caught:
            receipt2spec.main(["receipt", os.path.join(FIXTURES, "synthetic-fail.json"), out])
        self.assertNotEqual(caught.exception.code, 0)
        self.assertFalse(os.path.exists(out))

    def test_no_provenance_is_refused(self) -> None:
        receipt = load(PASS_PATH)
        receipt.pop("provenance")
        with self.assertRaises(provenance.Refused) as caught:
            self.spec(self.write("pass.json", receipt))
        self.assertIn("no receipt url", caught.exception.reason)

    def test_url_on_another_host_is_refused(self) -> None:
        receipt = load(PASS_PATH)
        receipt["provenance"]["url"] = PASS_URL.replace("api.proofofreason.com", "api.proofofreason.example")
        with self.assertRaises(provenance.Refused):
            self.spec(self.write("pass.json", receipt))

    def test_url_for_another_intent_is_refused(self) -> None:
        receipt = load(PASS_PATH)
        receipt["provenance"]["url"] = PASS_URL[:-4] + "0000"
        with self.assertRaises(provenance.Refused) as caught:
            self.spec(self.write("pass.json", receipt))
        self.assertIn("different intent", caught.exception.reason)

    def test_url_that_does_not_answer_is_refused(self) -> None:
        with self.assertRaises(provenance.Refused):
            self.spec(PASS_PATH, fetch=offline_fetch({}))

    def test_local_receipt_edited_after_publication_is_refused(self) -> None:
        receipt = load(PASS_PATH)
        receipt["verdict"]["outcome"] = "FAIL"
        with self.assertRaises(provenance.Refused) as caught:
            self.spec(self.write("pass.json", receipt))
        self.assertIn("different receipt", caught.exception.reason)


class RenderRefusal(Workdir):
    """frame.py and clipaudit.py, where a spec becomes a short or a thumbnail."""

    def setUp(self) -> None:
        super().setUp()
        self.good = receipt2spec.spec_from_receipt(load(PASS_PATH), path=PASS_PATH, fetch=pass_fetch())

    def assert_refused_both(self, spec: dict, fetch=None) -> None:
        fetch = fetch or pass_fetch()
        video = os.path.join(self.tmp, "short.mp4")
        thumb = os.path.join(self.tmp, "thumb.png")
        with self.assertRaises(provenance.Refused):
            frame.render_video(spec, video, 1.0, fetch=fetch)
        with self.assertRaises(provenance.Refused):
            frame.render_thumb(spec, thumb, fetch=fetch)
        self.assertFalse(os.path.exists(video))
        self.assertFalse(os.path.exists(thumb))

    def test_spec_traced_to_a_synthetic_file_is_refused(self) -> None:
        spec = copy.deepcopy(self.good)
        spec["trace"]["file"] = "synthetic-pass.json"
        self.assert_refused_both(spec)

    def test_spec_without_trace_is_refused(self) -> None:
        spec = copy.deepcopy(self.good)
        spec.pop("trace")
        self.assert_refused_both(spec)

    def test_spec_without_provenance_url_is_refused(self) -> None:
        spec = copy.deepcopy(self.good)
        spec["trace"]["provenance"] = None
        self.assert_refused_both(spec)

    def test_spec_whose_url_went_dead_is_refused(self) -> None:
        self.assert_refused_both(copy.deepcopy(self.good), fetch=offline_fetch({}))

    def test_spec_claiming_another_verdict_than_the_live_one_is_refused(self) -> None:
        spec = copy.deepcopy(self.good)
        spec["trace"]["outcome"] = "FAIL"
        self.assert_refused_both(spec)

    def test_clipaudit_refuses_a_synthetic_spec_file(self) -> None:
        path = self.write("synthetic-spec-pass.json", self.good)
        out = os.path.join(self.tmp, "short.mp4")
        for extra in ([], ["--thumb"]):
            with self.subTest(extra=extra), self.assertRaises(provenance.Refused):
                clipaudit.main([path, out, *extra])
        self.assertFalse(os.path.exists(out))

    def test_published_spec_renders_a_thumbnail(self) -> None:
        thumb = os.path.join(self.tmp, "thumb.png")
        frame.render_thumb(self.good, thumb, fetch=pass_fetch())
        self.assertTrue(os.path.getsize(thumb) > 0)


class EpisodeRefusal(Workdir):
    """episode.py, where segments become an episode. Each segment is checked from its own tags."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.dir = tempfile.mkdtemp(prefix="vid-episode-")
        good = receipt2spec.spec_from_receipt(load(PASS_PATH), path=PASS_PATH, fetch=pass_fetch())
        numbers = receipt2spec.spec_from_numbers(load(os.path.join(VID, "numbers.json")), "open")
        cls.receipt_segment = os.path.join(cls.dir, "pass.mp4")
        cls.numbers_segment = os.path.join(cls.dir, "open.mp4")
        frame.render_video(good, cls.receipt_segment, 1.0, fetch=pass_fetch())
        frame.render_video(numbers, cls.numbers_segment, 1.0, fetch=pass_fetch())
        # The same receipt segment with its container tags stripped: nothing says where it came from.
        cls.bare_segment = os.path.join(cls.dir, "stripped.mp4")
        subprocess.run(
            [frame.FFMPEG, "-v", "error", "-y", "-i", cls.receipt_segment, "-map_metadata", "-1", "-c", "copy", cls.bare_segment],
            check=True,
        )

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.dir, ignore_errors=True)

    def test_segments_carry_their_trace(self) -> None:
        trace = episode.segment_trace(self.receipt_segment)
        self.assertEqual(trace["provenance"], PASS_URL)
        self.assertEqual(episode.segment_trace(self.numbers_segment)["source"], "numbers")

    def test_live_receipt_segment_with_numbers_segment_is_accepted(self) -> None:
        episode.require_segments([self.numbers_segment, self.receipt_segment], fetch=pass_fetch())

    def test_synthetic_segment_name_is_refused(self) -> None:
        synthetic = os.path.join(self.tmp, "synthetic-pass.mp4")
        shutil.copy(self.receipt_segment, synthetic)
        with self.assertRaises(provenance.Refused):
            episode.require_segments([self.receipt_segment, synthetic], fetch=pass_fetch())

    def test_segment_without_trace_is_refused(self) -> None:
        with self.assertRaises(provenance.Refused) as caught:
            episode.require_segments([self.receipt_segment, self.bare_segment], fetch=pass_fetch())
        self.assertIn("stripped.mp4", caught.exception.reason)

    def test_episode_with_no_live_receipt_is_refused(self) -> None:
        with self.assertRaises(provenance.Refused) as caught:
            episode.require_segments([self.numbers_segment], fetch=pass_fetch())
        self.assertIn("no segment carries", caught.exception.reason)

    def test_receipt_segment_whose_url_went_dead_is_refused(self) -> None:
        with self.assertRaises(provenance.Refused):
            episode.require_segments([self.receipt_segment], fetch=offline_fetch({}))

    def test_a_still_from_a_traced_short_is_extracted(self) -> None:
        png = os.path.join(self.tmp, "pass-frame.png")
        frame.extract_frame(self.receipt_segment, png, 0.5, fetch=pass_fetch())
        self.assertGreater(os.path.getsize(png), 0)

    def test_a_still_from_a_short_with_no_trace_is_refused(self) -> None:
        # A PNG pulled out of a short is a rendered output too, so it answers to the same rule.
        png = os.path.join(self.tmp, "stripped-frame.png")
        with self.assertRaises(provenance.Refused):
            frame.extract_frame(self.bare_segment, png, 0.5, fetch=pass_fetch())
        self.assertFalse(os.path.exists(png))

    def test_a_still_from_a_short_whose_url_went_dead_is_refused(self) -> None:
        png = os.path.join(self.tmp, "dead-frame.png")
        with self.assertRaises(provenance.Refused):
            frame.extract_frame(self.receipt_segment, png, 0.5, fetch=offline_fetch({}))
        self.assertFalse(os.path.exists(png))

    def test_cli_refuses_before_writing(self) -> None:
        out = os.path.join(self.tmp, "episode.mp4")
        synthetic = os.path.join(self.tmp, "synthetic-pass.mp4")
        shutil.copy(self.receipt_segment, synthetic)
        with self.assertRaises(provenance.Refused):
            episode.main([out, self.numbers_segment, synthetic])
        self.assertFalse(os.path.exists(out))


class VerdictEntries(unittest.TestCase):
    """PASS, FAIL and WAIT each have a published receipt and their own words in numbers.json.

    Each verdict's title and subtitle are its own. They are written when its receipt is published,
    and a verdict with no words there is refused rather than borrowing another verdict's.
    """

    def setUp(self) -> None:
        self.numbers = load(os.path.join(VID, "numbers.json"))

    def test_every_rendered_entry_is_a_file_with_that_url(self) -> None:
        receipts = self.numbers["receipts"]
        self.assertEqual(receipts["pass"]["url"], PASS_URL)
        for key in ("pass", "fail", "wait"):
            with self.subTest(key=key):
                entry = receipts[key]
                self.assertEqual(entry["state"], "rendered")
                self.assertEqual(load(os.path.join(VID, entry["file"]))["provenance"]["url"], entry["url"])

    def test_each_verdict_has_its_own_wording(self) -> None:
        self.assertEqual(
            receipt2spec.wording(self.numbers, "PASS"),
            ("THE AGENT STATED ITS REASON.", "the chain said true. the gate moved the money."),
        )
        self.assertEqual(
            receipt2spec.wording(self.numbers, "FAIL"),
            ("THE AGENT STATED A FALSE REASON.", "the chain said false. the gate refused it. nothing was sent."),
        )
        self.assertEqual(
            receipt2spec.wording(self.numbers, "WAIT"),
            ("THE AGENT LEFT OUT A REQUIRED FACT.", "the gate let it through once its owner signed off."),
        )

    def test_a_receipt_whose_verdict_has_no_wording_builds_nothing(self) -> None:
        # The published PASS receipt, with its wording taken back out of numbers.json: a live
        # receipt is not enough on its own, the words have to have been written.
        numbers = copy.deepcopy(self.numbers)
        numbers["receipts"]["pass"].pop("title")
        with self.assertRaises(provenance.Refused) as caught:
            receipt2spec.spec_from_receipt(
                load(PASS_PATH), path=PASS_PATH, fetch=pass_fetch(), numbers=numbers
            )
        self.assertIn("no title and subtitle", caught.exception.reason)


class LiveReceipt(unittest.TestCase):
    """The one test that goes to the network: the PASS receipt is live right now."""

    def test_pass_receipt_is_live(self) -> None:
        try:
            url = provenance.require_live_receipt(PASS_PATH, load(PASS_PATH))
        except provenance.Refused as refused:
            if "did not answer" in refused.reason and os.environ.get("VID_OFFLINE"):
                self.skipTest(refused.reason)
            raise
        self.assertEqual(url, PASS_URL)
        self.assertEqual(provenance.fetch_live(url), published())


if __name__ == "__main__":
    unittest.main()
