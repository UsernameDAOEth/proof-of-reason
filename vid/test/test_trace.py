"""Nothing on the frame is typed by hand.

Two sources, and every slot belongs to exactly one of them. A receipt fills the slots that carry
numbers: every number in them appears in the published receipt. numbers.json fills the slots no
receipt can carry, the frame identity and the two title lines: every one of those appears in
numbers.json verbatim. A frame with no receipt behind it (open, numbers, end) is numbers.json
throughout.

    python3 -m unittest discover -s vid/test -t vid/test
"""

from __future__ import annotations

import json
import os
import re
import unittest

from support import PASS_PATH, VID, load, pass_fetch, published, take_published, take_spec

import receipt2spec

NUMBERS_PATH = os.path.join(VID, "numbers.json")


def receipt_slots(spec: dict) -> list[str]:
    """The slots a receipt fills. STATUS is receipt driven too, and test_pass.py maps it."""
    strings = [
        *spec["series"],
        spec["series_thumb"],
        *spec["proof"],
        spec["verdict"],
        spec["run"],
        spec["thumb"]["sub"][0],
    ]
    strings += [law["name"] for law in spec["laws"]]
    strings += [line["text"] for line in spec["window"].get("lines", [])]
    return [s for s in strings if s]


def operator_slots(spec: dict) -> list[str]:
    """The slots no receipt carries: who publishes, and this verdict's own two title lines."""
    strings = [
        spec["rail"],
        spec["sys_id"],
        *spec["title"],
        spec["thumb"]["title"],
        spec["thumb"]["sub"][1],
        *spec["identity"],
        spec["domain"],
        spec["ens"],
    ]
    return [s for s in strings if s]


def every_slot(spec: dict) -> list[str]:
    return [spec["status"], *receipt_slots(spec), *operator_slots(spec)]


class ReceiptTrace(unittest.TestCase):
    def setUp(self) -> None:
        self.spec = receipt2spec.spec_from_receipt(load(PASS_PATH), path=PASS_PATH, fetch=pass_fetch())

    def test_every_number_on_the_pass_frame_is_in_the_receipt(self) -> None:
        receipt_text = json.dumps(published())
        for text in receipt_slots(self.spec):
            for number in re.findall(r"0x[0-9a-fA-F]+|\d+(?:\.\d+)?", text):
                with self.subTest(text=text, number=number):
                    self.assertIn(number, receipt_text)

    def test_every_operator_string_on_the_pass_frame_is_in_numbers_json(self) -> None:
        with open(NUMBERS_PATH, encoding="utf-8") as handle:
            raw = handle.read()
        for text in operator_slots(self.spec):
            with self.subTest(text=text):
                self.assertIn(json.dumps(text, ensure_ascii=False), raw)

    def test_the_two_sources_do_not_overlap(self) -> None:
        # A slot belongs to one source. If a slot moved, one of the two tests above would stop
        # covering it, so the split itself is checked.
        self.assertEqual(set(receipt_slots(self.spec)) & set(operator_slots(self.spec)), set())
        self.assertEqual(
            len(every_slot(self.spec)),
            1 + len(receipt_slots(self.spec)) + len(operator_slots(self.spec)),
        )


class TakeTrace(unittest.TestCase):
    """The FAIL and WAIT takes of 29 Sep hold the same line as the PASS frame."""

    def test_every_number_on_a_take_frame_is_in_its_receipt(self) -> None:
        for outcome in ("FAIL", "WAIT"):
            spec = take_spec(outcome)
            receipt_text = json.dumps(take_published(outcome))
            for text in receipt_slots(spec):
                for number in re.findall(r"0x[0-9a-fA-F]+|\d+(?:\.\d+)?", text):
                    with self.subTest(outcome=outcome, text=text, number=number):
                        self.assertIn(number, receipt_text)

    def test_every_operator_string_on_a_take_frame_is_in_numbers_json(self) -> None:
        with open(NUMBERS_PATH, encoding="utf-8") as handle:
            raw = handle.read()
        for outcome in ("FAIL", "WAIT"):
            spec = take_spec(outcome)
            self.assertEqual(spec["verdict"], outcome)
            for text in operator_slots(spec):
                with self.subTest(outcome=outcome, text=text):
                    self.assertIn(json.dumps(text, ensure_ascii=False), raw)

    def test_the_two_sources_do_not_overlap_on_a_take_frame(self) -> None:
        for outcome in ("FAIL", "WAIT"):
            spec = take_spec(outcome)
            with self.subTest(outcome=outcome):
                self.assertEqual(set(receipt_slots(spec)) & set(operator_slots(spec)), set())


class NumbersTrace(unittest.TestCase):
    def test_every_string_on_a_numbers_frame_is_in_numbers_json(self) -> None:
        with open(NUMBERS_PATH, encoding="utf-8") as handle:
            raw = handle.read()
        numbers = json.loads(raw)
        for kind in ("open", "numbers", "end"):
            spec = receipt2spec.spec_from_numbers(numbers, kind)
            for text in every_slot(spec):
                if text in receipt2spec.LAW_NAMES.values():
                    continue
                with self.subTest(kind=kind, text=text):
                    self.assertIn(json.dumps(text, ensure_ascii=False), raw)


if __name__ == "__main__":
    unittest.main()
