#!/usr/bin/env python3
"""Offline checks for FMHY parsing and stalled research progression."""

import tempfile
import unittest
import json
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

import fmhy_queue as queue
import handoff
import integration_inbox


class QueueTests(unittest.TestCase):
    def test_integrated_sites_are_indexed_and_skipped_before_claim(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            provider_index = root / "provider-index.json"
            provider_index.write_text(json.dumps({"version": 1, "integrated": [
                {"id": "existing", "name": "Existing", "kind": "vod",
                 "origins": ["https://site.example"], "implementation": ["api/providers.mjs"]},
            ]}))
            data = {"fetched_at": queue.iso(queue.now()), "items": [
                {"id": "existing-site", "name": "Existing", "url": "https://www.site.example/", "host": "site.example",
                 "section": "streaming-sites", "category": "stream-aggregators", "attempts": 0, "status": "pending"},
                {"id": "next", "name": "Next", "url": "https://next.example/", "host": "next.example",
                 "section": "streaming-sites", "category": "stream-aggregators", "attempts": 0, "status": "pending"},
            ]}
            with patch.object(queue, "INDEX", provider_index), patch.object(queue, "STATE", root), \
                 patch.object(queue, "QUEUE", root / "queue.json"):
                self.assertEqual(queue.claim(data)["id"], "next")
                self.assertEqual(data["items"][0]["status"], "skipped")
                self.assertEqual([row["id"] for row in queue.index_entries(data)], ["existing"])
                self.assertEqual(json.loads(queue.QUEUE.read_text())["items"][0]["status"], "skipped")

    def test_stream_sites_without_mirrors_or_tools(self):
        page = '''
<h2 id="streaming-sites">Streaming Sites</h2>
<h3 id="stream-aggregators">Stream Aggregators</h3>
<ul><li><strong><a href="https://alpha.example/">Alpha</a></strong>,
<a href="https://mirror.example/">2</a> or <a href="https://beta.example/">Beta</a>
 - 1080p / <a href="https://status.example/">Status</a></li></ul>
<h2 id="live-tv-sports">Live TV</h2>
<h3 id="iptv-tools">IPTV Tools</h3><ul><li><a href="https://tool.example/">Tool</a></li></ul>
<h3 id="live-sports">Live Sports</h3><ul><li><a href="https://game.example/">Game</a> - Sports</li></ul>
<h2 id="download-sites">Downloads</h2><h3 id="downloads">Downloads</h3>
<ul><li><a href="https://download.example/">Download</a></li></ul>
'''
        found = queue.candidates_from_html(page)
        self.assertEqual([item["name"] for item in found], ["Alpha", "Beta", "Game"])

    def test_expired_claim_eventually_moves_to_next_site(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(queue, "STATE", Path(temp)), patch.object(queue, "QUEUE", Path(temp) / "queue.json"):
                data = {"fetched_at": queue.iso(queue.now()), "items": [
                    {"id": "first", "name": "First", "url": "https://first.example", "section": "streaming-sites",
                     "category": "stream-aggregators", "attempts": 2, "status": "claimed",
                     "lease_until": queue.iso(queue.now() - timedelta(hours=1))},
                    {"id": "next", "name": "Next", "url": "https://next.example", "section": "streaming-sites",
                     "category": "stream-aggregators", "attempts": 0, "status": "pending"},
                ]}
                self.assertEqual(queue.claim(data)["id"], "first")
                data["items"][0]["lease_until"] = queue.iso(queue.now() - timedelta(hours=1))
                self.assertEqual(queue.claim(data)["id"], "next")
                self.assertEqual(data["items"][0]["status"], "blocked")

    def test_active_claim_resumes_before_claiming_next_site(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(queue, "STATE", Path(temp)), patch.object(queue, "QUEUE", Path(temp) / "queue.json"):
                data = {"fetched_at": queue.iso(queue.now()), "items": [
                    {"id": "first", "name": "First", "url": "https://first.example", "section": "streaming-sites",
                     "category": "stream-aggregators", "attempts": 1, "status": "claimed",
                     "lease_until": queue.iso(queue.now() + timedelta(hours=1))},
                    {"id": "next", "name": "Next", "url": "https://next.example", "section": "streaming-sites",
                     "category": "stream-aggregators", "attempts": 0, "status": "pending"},
                ]}
                result = queue.claim(data)
                self.assertEqual(result["id"], "first")
                self.assertTrue(result["resumed"])
                self.assertEqual(data["items"][1]["status"], "pending")

    def test_handoff_rejects_player_page_and_sends_verified_media(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state = root / "state"
            artifacts = root / "artifacts"
            item_dir = artifacts / "sample"
            item_dir.mkdir(parents=True)
            state.mkdir()
            api_file = item_dir / "api.mjs"
            api_file.write_text("export const source = 'sample';\n")
            probe_file = item_dir / "probe.json"
            evidence_file = item_dir / "evidence.json"
            evidence = {
                "candidate_id": "sample", "provider_name": "Sample", "site_url": "https://sample.example/",
                "kind": "vod", "catalog": "GET /search", "resolver": "GET /resolve",
                "sample": "Exact movie 123", "verification": {
                    "verdict": "raw_verified", "media_kind": "mpeg-ts", "checked_at": queue.iso(queue.now()),
                },
                "api_file": str(api_file), "probe_file": str(probe_file),
            }
            evidence_file.write_text(json.dumps(evidence))
            queue_data = {"fetched_at": queue.iso(queue.now()), "items": [
                {"id": "sample", "url": "https://sample.example/", "status": "claimed", "attempts": 1},
            ]}
            with patch.object(queue, "STATE", state), patch.object(queue, "QUEUE", state / "fmhy-queue.json"), \
                 patch.object(handoff, "ARTIFACTS", artifacts):
                queue.save(queue_data)
                probe_file.write_text(json.dumps({"verdict": "player_only", "segmentKind": "mpeg-ts"}))
                with self.assertRaises(ValueError), patch.object(handoff.subprocess, "run") as run:
                    handoff.send(evidence_file)
                run.assert_not_called()

                probe_file.write_text(json.dumps({"verdict": "raw_verified", "segmentKind": "mpeg-ts"}))
                class Result:
                    stdout = '{"id":"t123"}'
                with patch.object(handoff.subprocess, "run", return_value=Result()) as run:
                    output = handoff.send(evidence_file)
                self.assertEqual(output["task_id"], "t123")
                self.assertIn("--assignee", run.call_args.args[0])
                self.assertIn("--initial-status", run.call_args.args[0])
                self.assertEqual(json.loads(queue.QUEUE.read_text())["items"][0]["status"], "verified")

    def test_integrator_inbox_delivers_once_without_dispatching_running_worker(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            cards = [
                {"id": "t_11111111", "status": "running", "assignee": "watch-integrator",
                 "created_by": "watch-providers", "body": handoff.BOT_CHAT_MARKER},
                {"id": "t_22222222", "status": "blocked", "assignee": "watch-integrator",
                 "created_by": "watch-providers", "body": handoff.BOT_CHAT_MARKER},
            ]
            class Result:
                stdout = json.dumps(cards)
            with patch.object(integration_inbox, "STATE", root), \
                 patch.object(integration_inbox, "SENT", root / "sent.json"), \
                 patch.object(integration_inbox.subprocess, "run", return_value=Result()):
                message = integration_inbox.deliver_next()
                self.assertIn("t_22222222", message)
                self.assertNotIn("t_11111111", message)
                self.assertEqual(integration_inbox.deliver_next(), "")


if __name__ == "__main__":
    unittest.main()
