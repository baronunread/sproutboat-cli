#!/usr/bin/env python3
"""The summary must never publish incomplete or incorrect measurements."""
import json
import pathlib
import tempfile
import unittest

import report


def trial(name, repeat):
    workload = lambda kind: {"name": kind, "generatorDropped": 0, "correct": 10, "scheduled": 10,
                             "p95Ms": 2.5, "cpuUsec": 1000}
    return {"runtime": name, "repeat": repeat, "startupMs": 3.5,
            "correctness": [{"ok": True}], "idleMemory": {"PssKiB": 1024},
            "workloads": [workload("order"), workload("mixed")]}


class ReportGate(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source = pathlib.Path(self.temp.name) / "results.json"
        self.data = {"schema": 2, "dateUTC": "2026-09-30T00:00:00Z",
                     "protocol": {"repeats": 2, "offeredRate": 50},
                     "payload": {"cliTag": "v0.12.0", "cliCommit": "abc", "binaryBytes": 30},
                     "tools": {"node": {"executableBytes": 100}, "workerd": {"executableBytes": 200}},
                     "artifacts": {"nodeAppBytes": 10, "workerdBundleBytes": 20},
                     "runs": [trial(name, repeat) for repeat in range(2)
                              for name in ("node", "workerd", "sproutboat")]}

    def summarize(self):
        self.source.write_text(json.dumps(self.data))
        return report.summarize(self.source)

    def test_complete_run_has_attributed_metrics(self):
        summary = self.summarize()
        self.assertEqual(summary["rows"]["node"]["correctTraffic"], 40)
        self.assertEqual(summary["rows"]["workerd"]["runtimeExecutableBytes"], 200)
        self.assertIsNone(summary["rows"]["sproutboat"]["runtimeExecutableBytes"])

    def test_missing_repeat_is_rejected(self):
        self.data["runs"].pop()
        with self.assertRaisesRegex(ValueError, "Incomplete run"):
            self.summarize()

    def test_bad_response_is_rejected(self):
        self.data["runs"][0]["workloads"][0]["correct"] = 9
        with self.assertRaisesRegex(ValueError, "Load validation failed"):
            self.summarize()

    def test_dropped_arrival_is_rejected(self):
        self.data["runs"][0]["workloads"][0]["generatorDropped"] = 1
        with self.assertRaisesRegex(ValueError, "Load validation failed"):
            self.summarize()

    def test_failed_corpus_is_rejected(self):
        self.data["runs"][0]["correctness"][0]["ok"] = False
        with self.assertRaisesRegex(ValueError, "Correctness gate failed"):
            self.summarize()


if __name__ == "__main__":
    unittest.main()
