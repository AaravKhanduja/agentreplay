import json
import re
import sys
import tempfile
import unittest
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import agentreplay as ar  # noqa: E402

import shutil  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"
NOW = datetime(2026, 10, 15, 12, 0, tzinfo=timezone.utc)


def totals(payload):
    rows = payload["sessions"]
    worked = sum(b - a for a, b in payload["intervals"])
    tools, mcp = {}, {}
    for r in rows:
        for name, n in r["tools"].items():
            tools[name] = tools.get(name, 0) + n
        for server, v in r["mcp"].items():
            mcp[server] = [x + y for x, y in zip(mcp.get(server, [0, 0, 0]), v)]
    return {
        "prompts": sum(n for _, _, n in payload["prompts"]),
        "tok": [sum(r["tok"][i] for r in rows) for i in range(4)],
        "lines": [sum(r["lines"][i] for r in rows) for i in range(2)],
        "worked_s": worked / 1000,
        "tools": tools,
        "mcp": mcp,
    }


class FixtureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.payload = ar.analyze(FIXTURES, timezone.utc, now=NOW)
        cls.t = totals(cls.payload)

    def test_sessions_from_both_sources(self):
        # History knows the old /tmp/old session whose transcript is gone;
        # only the transcripts know /tmp/notes.
        self.assertEqual(len(self.payload["allSessions"]), 4)
        self.assertEqual(sorted(self.payload["projects"]), ["blog", "notes", "old", "shop"])
        self.assertEqual(self.payload["firstDay"], "2026-06-01")
        self.assertEqual(len(self.payload["sessions"]), 3)

    def test_detail_starts_where_transcripts_are_complete(self):
        # The oldest surviving session's last activity is Oct 10, so the
        # notes session's Oct 1 exchange is not counted, its Oct 12 one is.
        self.assertEqual(self.payload["detailSince"], "2026-10-10")

    def test_tokens_dedupe_split_and_subagent_copies(self):
        # m1 split over two lines and m2 repeated in a subagent count once;
        # the <synthetic> record is not a model call; nm1 is before detailSince.
        self.assertEqual(self.t["tok"], [53, 153, 400, 39600])

    def test_prompts_from_history(self):
        # /clear and the exact repeat are dropped.
        self.assertEqual(self.t["prompts"], 6)

    def test_lines_written(self):
        # structuredPatch +2 -1, Write create +3, fallback +1 -2, harness file skipped.
        self.assertEqual(self.t["lines"], [6, 3])

    def test_tools_counted_once(self):
        self.assertEqual(self.t["tools"]["Edit"], 2)
        self.assertEqual(self.t["tools"]["Write"], 2)
        self.assertEqual(self.t["tools"]["Bash"], 2)
        self.assertEqual(self.t["tools"]["Grep"], 1)

    def test_mcp_declined_is_not_an_error(self):
        self.assertEqual(self.t["mcp"], {"github": [3, 1, 1]})

    def test_pr_needs_a_url(self):
        prs = self.payload["prs"]
        self.assertEqual(len(prs), 1)
        self.assertEqual(prs[0]["title"], "Add cart total")
        self.assertEqual(prs[0]["repo"], "acme/shop")
        self.assertEqual(prs[0]["number"], 42)

    def test_claude_working_time(self):
        # 14:00-14:15, 14:16-14:17 and 14:28-14:29 are Claude's. The gaps
        # ending in /clear and the meta line are you, the 11-minute gap is
        # idle, and blog's overlapping time is already covered. Plus notes'
        # two minutes on Oct 12.
        self.assertEqual(self.t["worked_s"], 1140)

    def test_bad_lines_counted(self):
        self.assertEqual(self.payload["meta"]["skippedLines"], 2)

    def test_streak_from_history(self):
        self.assertEqual(
            self.payload["streaks"]["all"],
            {"longest": {"start": "2026-06-01", "end": "2026-06-02", "days": 2}, "current": 0},
        )
        # The June streak is outside the last 30 days; Oct 10 is inside.
        self.assertEqual(self.payload["streaks"]["d30"]["longest"]["start"], "2026-10-10")
        self.assertEqual(self.payload["streaks"]["d7"]["longest"]["days"], 1)


class NoHistoryTest(unittest.TestCase):
    def test_falls_back_to_transcript_prompts(self):
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copytree(FIXTURES / "projects", Path(tmp) / "projects")
            payload = ar.analyze(Path(tmp), timezone.utc, now=NOW)
        # Tool results, the interrupt, /clear, meta caveats, task notifications,
        # the subagent's prompt and the copied record are not yours; notes'
        # Oct 1 prompt is before detailSince.
        self.assertEqual(totals(payload)["prompts"], 5)
        self.assertFalse(payload["meta"]["hasHistory"])
        self.assertEqual(len(payload["allSessions"]), 3)


class UnitTest(unittest.TestCase):
    def test_union_merges_overlaps(self):
        self.assertEqual(ar.union([(10, 20), (0, 12), (30, 40)]), [[0, 20], [30, 40]])

    def test_history_buckets_in_local_time(self):
        # 23:30 UTC on Jun 1 is Jun 2, 5am in Kolkata.
        from zoneinfo import ZoneInfo
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "history.jsonl"
            ts = int(datetime(2026, 6, 1, 23, 30, tzinfo=timezone.utc).timestamp() * 1000)
            path.write_text(json.dumps({"display": "hi", "timestamp": ts, "project": "/x", "sessionId": "s"}) + "\n")
            history = ar.read_history(path, ZoneInfo("Asia/Kolkata"), ar.Counter())
        self.assertEqual(dict(history["buckets"]), {("2026-06-02", 5): 1})

    def test_streaks(self):
        days = {date(2026, 10, d): 5 for d in (1, 2, 3, 5, 6, 14, 15)}
        s = ar.streaks(days, date(2026, 10, 15), date(2025, 10, 16))
        self.assertEqual(s["longest"], {"start": "2026-10-01", "end": "2026-10-03", "days": 3})
        self.assertEqual(s["current"], 2)

    def test_year_grid_starts_on_monday(self):
        grid = ar.year_grid({date(2026, 10, 15): 30}, date(2026, 10, 15), date(2025, 10, 16))
        self.assertEqual(date.fromisoformat(grid["start"]).weekday(), 0)
        self.assertEqual(grid["levels"][-1], 1)
        self.assertLessEqual(len(grid["levels"]), 53 * 7)

    def test_short_range_grid_marks_days_before_it(self):
        # Oct 15 2026 is a Thursday; a 7-day range starts Fri Oct 9, so the
        # grid starts Mon Oct 5 and its first four days are outside the range.
        grid = ar.year_grid({date(2026, 10, 9): 3, date(2026, 10, 6): 9}, date(2026, 10, 15), date(2026, 10, 9))
        self.assertEqual(grid["start"], "2026-10-05")
        self.assertEqual(grid["levels"][:5], [-1, -1, -1, -1, 1])

    def test_pr_title_forms(self):
        self.assertEqual(ar.pr_title('gh pr create --title "Fix \\"x\\"" --body y'), 'Fix "x"')
        self.assertEqual(ar.pr_title("gh pr create -t 'Short'"), "Short")
        self.assertIsNone(ar.pr_title("gh pr create --fill"))

    def test_empty_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            payload = ar.analyze(Path(tmp), timezone.utc, now=NOW)
        self.assertEqual(payload["sessions"], [])
        self.assertEqual(payload["streaks"]["all"], {"longest": None, "current": 0})


class RenderTest(unittest.TestCase):
    def test_script_injection_is_inert(self):
        payload = {"x": "</script><img src=x onerror=alert(1)> "}
        html = ar.render(payload, "page", template="<script>/*__DATA__*/null</script>")
        self.assertNotIn("</script><img", html)
        self.assertNotIn(" ", html)

    def test_output_has_no_network_references(self):
        payload = ar.analyze(FIXTURES, timezone.utc, now=NOW)
        payload["prs"] = []
        for mode in ("page", "card"):
            html = ar.render(payload, mode)
            urls = set(re.findall(r"https?://[^\s\"'`)]+", html))
            # The X share intent and the repo link open only when clicked.
            allowed = {u for u in urls if u.startswith(("https://x.com/intent/", "https://github.com/AaravKhanduja/agentreplay"))}
            self.assertEqual(urls - allowed, set(), mode)
            self.assertNotIn("<link", html)

    def test_data_round_trips(self):
        payload = ar.analyze(FIXTURES, timezone.utc, now=NOW)
        html = ar.render(payload, "card")
        raw = re.search(r'<script type="application/json" id="data">(.*?)</script>', html, re.S).group(1)
        self.assertEqual(json.loads(raw)["sessions"], payload["sessions"])


if __name__ == "__main__":
    unittest.main()
