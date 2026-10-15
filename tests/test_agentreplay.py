import json
import re
import sys
import tempfile
import unittest
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import agentreplay as ar  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "projects"
NOW = datetime(2026, 10, 15, 12, 0, tzinfo=timezone.utc)


def totals(payload):
    rows = payload["sessions"]
    agent = sum(b - a for a, b, k in payload["intervals"] if k == 1)
    you = sum(b - a for a, b, k in payload["intervals"] if k == 0)
    tools, mcp = {}, {}
    for r in rows:
        for name, n in r["tools"].items():
            tools[name] = tools.get(name, 0) + n
        for server, v in r["mcp"].items():
            mcp[server] = [x + y for x, y in zip(mcp.get(server, [0, 0, 0]), v)]
    return {
        "prompts": sum(r["prompts"] for r in rows),
        "tok": [sum(r["tok"][i] for r in rows) for i in range(4)],
        "lines": [sum(r["lines"][i] for r in rows) for i in range(2)],
        "agent_s": agent / 1000,
        "you_s": you / 1000,
        "tools": tools,
        "mcp": mcp,
    }


class FixtureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.payload = ar.analyze(FIXTURES, timezone.utc, now=NOW)
        cls.t = totals(cls.payload)

    def test_sessions_and_projects(self):
        self.assertEqual(len(self.payload["sessions"]), 2)
        self.assertEqual(sorted(r["project"] for r in self.payload["sessions"]), ["blog", "shop"])

    def test_tokens_dedupe_split_and_subagent_copies(self):
        # m1 split over two lines and m2 repeated in a subagent count once;
        # the <synthetic> record is not a model call.
        self.assertEqual(self.t["tok"], [52, 152, 400, 39600])

    def test_human_prompts(self):
        # Tool results, the interrupt, /clear, meta caveats, task notifications,
        # the subagent's prompt and the copied record are not yours.
        self.assertEqual(self.t["prompts"], 4)

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

    def test_agent_and_you_time(self):
        # 14:00-14:15 and 14:16-14:17 and 14:28-14:29 are Claude's; the
        # 11-minute gap is idle; blog's overlapping time is already covered.
        self.assertEqual(self.t["agent_s"], 1020)
        self.assertEqual(self.t["you_s"], 60)

    def test_bad_lines_counted(self):
        self.assertEqual(self.payload["meta"]["skippedLines"], 2)

    def test_streak(self):
        self.assertEqual(
            self.payload["streak"],
            {"longest": {"start": "2026-10-10", "end": "2026-10-10", "days": 1}, "current": 0},
        )


class UnitTest(unittest.TestCase):
    def test_split_time_agent_wins_overlap(self):
        out = ar.split_time([(10, 20)], [(0, 30)])
        self.assertEqual(out, [(0, 10, "you"), (10, 20, "agent"), (20, 30, "you")])

    def test_minutes_split_at_local_midnight(self):
        start = datetime(2026, 3, 1, 23, 50, tzinfo=timezone.utc).timestamp() * 1000
        days = ar.active_minutes_by_day([(start, start + 20 * 60000, "agent")], timezone.utc)
        self.assertEqual(days, {date(2026, 3, 1): 10, date(2026, 3, 2): 10})

    def test_streaks(self):
        days = {date(2026, 10, d): 5 for d in (1, 2, 3, 5, 6, 14, 15)}
        s = ar.streaks(days, date(2026, 10, 15))
        self.assertEqual(s["longest"], {"start": "2026-10-01", "end": "2026-10-03", "days": 3})
        self.assertEqual(s["current"], 2)

    def test_year_grid_starts_on_monday(self):
        grid = ar.year_grid({date(2026, 10, 15): 30}, date(2026, 10, 15))
        self.assertEqual(date.fromisoformat(grid["start"]).weekday(), 0)
        self.assertEqual(grid["levels"][-1], 1)
        self.assertLessEqual(len(grid["levels"]), 53 * 7)

    def test_pr_title_forms(self):
        self.assertEqual(ar.pr_title('gh pr create --title "Fix \\"x\\"" --body y'), 'Fix "x"')
        self.assertEqual(ar.pr_title("gh pr create -t 'Short'"), "Short")
        self.assertIsNone(ar.pr_title("gh pr create --fill"))

    def test_empty_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            payload = ar.analyze(Path(tmp) / "projects", timezone.utc, now=NOW)
        self.assertEqual(payload["sessions"], [])
        self.assertEqual(payload["streak"], {"longest": None, "current": 0})


if __name__ == "__main__":
    unittest.main()
