#!/usr/bin/env python3
"""AgentReplay: an overview of how you work with Claude Code, from ~/.claude.

Reads the session JSONL files Claude Code writes under ~/.claude/projects and
writes two self-contained HTML files: an overview page and a 1200x675 share
card. Standard library only. Nothing leaves the machine.

    python3 agentreplay.py [--handle @you] [--out-dir .] [--no-open]
"""

import argparse
import base64
import bisect
import json
import os
import re
import sys
import webbrowser
from collections import Counter, defaultdict
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
TEMPLATE = HERE / "template.html"
FONTS = [
    ("IBM Plex Mono", "400", "IBMPlexMono-400.woff2"),
    ("IBM Plex Mono", "500", "IBMPlexMono-500.woff2"),
    ("IBM Plex Sans", "400 600", "IBMPlexSans-var.woff2"),
]
DEMO_DIR = HERE / "tests" / "fixtures"

# A gap between two records longer than this is idle time, not work.
IDLE_GAP_MS = 10 * 60 * 1000
# Ranges the page can switch between, in days. None is all time.
RANGES = {"all": None, "d90": 90, "d30": 30, "d7": 7}
GRID_DAYS = 365

DECLINED_RE = re.compile(
    r"user doesn't want to proceed|tool use was rejected|user rejected"
    r"|operation was aborted by the user",
    re.I,
)
HARNESS_RE = re.compile(r"(^|/)\.claude(/|$)")
PR_CMD_RE = re.compile(r"\bgh\s+pr\s+create\b")
PR_TITLE_RE = re.compile(r"""(?:--title|-t)(?:\s+|=)(?:"((?:[^"\\]|\\.)*)"|'([^']*)')""")
PR_URL_RE = re.compile(r"https://github\.com/([\w.-]+)/([\w.-]+)/pull/(\d+)")
EDIT_TOOLS = {"Edit", "Write", "MultiEdit"}


# ---------------------------------------------------------------- reading


def parse_ts(value):
    """ISO 8601 string to epoch milliseconds, or None."""
    if not isinstance(value, str):
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def read_jsonl(path, stats):
    """Yield parsed records. Bad or truncated lines are counted, never fatal."""
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except ValueError:
                    stats["skippedLines"] += 1
                    continue
                if isinstance(record, dict):
                    yield record
                else:
                    stats["skippedLines"] += 1
    except OSError:
        stats["unreadableFiles"] += 1


def file_birth(path):
    try:
        st = path.stat()
    except OSError:
        return 0
    return getattr(st, "st_birthtime", st.st_mtime)


def discover(projects_dir):
    """Map session id -> list of files: the session file plus its subagents.

    Layout: projects/<encoded-cwd>/<session>.jsonl and
    projects/<encoded-cwd>/<session>/subagents/*.jsonl.
    """
    sessions = defaultdict(list)
    if not projects_dir.is_dir():
        return sessions
    for project in sorted(projects_dir.iterdir()):
        if not project.is_dir():
            continue
        for f in sorted(project.glob("*.jsonl")):
            sessions[(project.name, f.stem)].append(f)
        for f in sorted(project.glob("*/subagents/*.jsonl")):
            sessions[(project.name, f.parent.parent.name)].append(f)
    return sessions


# ---------------------------------------------------------------- records


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict):
                if isinstance(block.get("text"), str):
                    parts.append(block["text"])
                elif "content" in block:
                    parts.append(text_of(block["content"]))
        return "\n".join(parts)
    return ""


def tool_results(record):
    content = (record.get("message") or {}).get("content")
    if not isinstance(content, list):
        return []
    return [b for b in content if isinstance(b, dict) and b.get("type") == "tool_result"]


def is_machine_message(record):
    """A user-typed record Claude Code wrote itself, e.g. a background-task
    notification. Newer versions say so in `origin.kind`."""
    origin = record.get("origin")
    if isinstance(origin, dict) and origin.get("kind") not in (None, "human"):
        return True
    text = text_of((record.get("message") or {}).get("content")).lstrip()
    return text.startswith(("<task-notification", "[Request interrupted"))


def is_human_prompt(record):
    """A prompt you typed: not a tool result, not injected, not a subagent."""
    if record.get("type") != "user" or record.get("isMeta") or record.get("isSidechain"):
        return False
    if record.get("isCompactSummary") or tool_results(record) or is_machine_message(record):
        return False
    text = text_of((record.get("message") or {}).get("content")).lstrip()
    if not text:
        return False
    return not text.startswith(("<command-name>", "<command-message>", "<local-command"))


def gap_kind(record):
    """Who a gap ending in this record belongs to: 'agent', 'you', or None."""
    kind = record.get("type")
    if kind == "assistant":
        return "agent"
    if kind != "user":
        return None
    if record.get("isSidechain") or tool_results(record) or is_machine_message(record):
        return "agent"
    return "you"


def count_lines(text):
    if not isinstance(text, str) or not text:
        return 0
    return text.count("\n") + (0 if text.endswith("\n") else 1)


def edit_lines(tool_input, result):
    """(+, -) lines for one successful Edit/Write/MultiEdit."""
    if isinstance(result, dict):
        patch = result.get("structuredPatch")
        if isinstance(patch, list) and patch:
            added = removed = 0
            for hunk in patch:
                for line in (hunk or {}).get("lines") or []:
                    if isinstance(line, str) and line.startswith("+"):
                        added += 1
                    elif isinstance(line, str) and line.startswith("-"):
                        removed += 1
            return added, removed
        if result.get("type") == "create":
            return count_lines(result.get("content")), 0
    tool_input = tool_input or {}
    if "content" in tool_input:
        return count_lines(tool_input.get("content")), 0
    edits = tool_input.get("edits") or [tool_input]
    added = sum(count_lines(e.get("new_string")) for e in edits if isinstance(e, dict))
    removed = sum(count_lines(e.get("old_string")) for e in edits if isinstance(e, dict))
    return added, removed


def pr_title(command):
    match = PR_TITLE_RE.search(command)
    if not match:
        return None
    title = match.group(1) if match.group(1) is not None else match.group(2)
    return title.replace('\\"', '"').strip() or None


def mcp_server(name):
    parts = name.split("__")
    if len(parts) < 3:
        return None
    server = parts[1]
    if server.startswith("claude_ai_"):
        server = server[len("claude_ai_"):]
    return server.replace("_", " ")


# ---------------------------------------------------------------- analysis


def new_session(key):
    return {
        "key": key,
        "records": [],
        "first": None,
        "cwds": Counter(),
    }


def load_sessions(projects_dir, stats):
    sessions = []
    for key, files in discover(projects_dir).items():
        session = new_session(key)
        for f in files:
            stats["files"] += 1
            for record in read_jsonl(f, stats):
                ts = parse_ts(record.get("timestamp"))
                if ts is None:
                    continue
                record["_ts"] = ts
                session["records"].append(record)
                if isinstance(record.get("cwd"), str):
                    session["cwds"][record["cwd"]] += 1
        if not session["records"]:
            continue
        session["records"].sort(key=lambda r: r["_ts"])
        session["first"] = session["records"][0]["_ts"]
        session["born"] = file_birth(files[0])
        sessions.append(session)
    # A resume or fork copies earlier records, timestamps and all, into a new
    # file. The session whose file was created first owns those records.
    sessions.sort(key=lambda s: (s["first"], s["born"]))
    return sessions


def analyze(projects_dir, tz, now=None):
    stats = Counter()
    sessions = load_sessions(projects_dir, stats)
    now = now or datetime.now(tz)
    today = now.astimezone(tz).date()

    seen_records = set()
    seen_messages = set()
    seen_tools = set()
    calls = {}  # tool_use id -> (name, input, row)
    agent_spans, you_spans = [], []
    rows, prs = [], []

    for session in sessions:
        row = {
            "start": session["first"],
            "project": project_name(session),
            "prompts": 0,
            "tok": [0, 0, 0, 0],  # input, output, cache write, cache read
            "models": {},
            "lines": [0, 0],
            "tools": Counter(),
            "mcp": {},
            "heat": Counter(),
        }
        timeline = []
        for record in session["records"]:
            uid = record.get("uuid")
            if uid:
                if uid in seen_records:
                    continue
                seen_records.add(uid)
            timeline.append(record)
            if record.get("type") == "assistant":
                read_assistant(record, row, seen_messages, seen_tools, calls)
            elif record.get("type") == "user":
                read_user(record, row, calls, prs, tz)
        if not timeline:
            continue

        last = None
        for record in timeline:
            kind = gap_kind(record)
            if kind is None:
                continue
            ts = record["_ts"]
            if last is not None and 0 < ts - last <= IDLE_GAP_MS:
                (agent_spans if kind == "agent" else you_spans).append((last, ts))
            last = ts

        row["tools"] = dict(row["tools"])
        row["heat"] = [[wd, h, n] for (wd, h), n in sorted(row["heat"].items())]
        rows.append(row)

    intervals = split_time(agent_spans, you_spans)
    days = active_minutes_by_day(intervals, tz)
    names = disambiguate([r["project"] for r in rows])
    for r, name in zip(rows, names):
        r["project"] = name[0]
        r["path"] = name[1]

    prs.sort(key=lambda p: p["ts"], reverse=True)
    origin = int(datetime.combine(today, time(), tz).timestamp() * 1000)
    grid = year_grid(days, today)
    return {
        "meta": {
            "today": today.isoformat(),
            "tz": str(tz),
            "generatedAt": now.isoformat(timespec="seconds"),
            "source": str(projects_dir),
            "files": stats["files"],
            "skippedLines": stats["skippedLines"],
            "idleGapMinutes": IDLE_GAP_MS // 60000,
        },
        "cutoffs": {
            k: (None if n is None else origin - (n - 1) * 86400000)
            for k, n in RANGES.items()
        },
        "grid": grid,
        "streak": streaks(days, today),
        "sessions": [strip_row(r) for r in rows],
        # [start ms, end ms, 1 = Claude's time / 0 = yours], disjoint and sorted.
        "intervals": [[a, b, 1 if k == "agent" else 0] for a, b, k in intervals],
        "prs": prs,
    }


def read_assistant(record, row, seen_messages, seen_tools, calls):
    message = record.get("message") or {}
    model = message.get("model")
    mid = message.get("id")
    if mid and mid not in seen_messages and model and model != "<synthetic>":
        seen_messages.add(mid)
        usage = message.get("usage") or {}
        tok = [
            int(usage.get("input_tokens") or 0),
            int(usage.get("output_tokens") or 0),
            int(usage.get("cache_creation_input_tokens") or 0),
            int(usage.get("cache_read_input_tokens") or 0),
        ]
        for i, n in enumerate(tok):
            row["tok"][i] += n
        entry = row["models"].setdefault(model, [0, 0])
        entry[0] += sum(tok)
        entry[1] += 1
    content = message.get("content")
    if not isinstance(content, list):
        return
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "tool_use":
            continue
        bid, name = block.get("id"), block.get("name")
        if not isinstance(name, str) or (bid and bid in seen_tools):
            continue
        if bid:
            seen_tools.add(bid)
            calls[bid] = (name, block.get("input") or {}, row)
        row["tools"][name] += 1
        server = mcp_server(name) if name.startswith("mcp__") else None
        if server:
            row["mcp"].setdefault(server, [0, 0, 0])[0] += 1


def read_user(record, row, calls, prs, tz):
    if is_human_prompt(record):
        row["prompts"] += 1
        local = datetime.fromtimestamp(record["_ts"] / 1000, tz)
        row["heat"][(local.weekday(), local.hour)] += 1
        return
    for block in tool_results(record):
        call = calls.pop(block.get("tool_use_id"), None)
        if call is None:
            continue
        name, tool_input, owner = call
        text = text_of(block.get("content"))
        declined = bool(DECLINED_RE.search(text))
        failed = bool(block.get("is_error")) and not declined
        if name.startswith("mcp__"):
            entry = owner["mcp"].get(mcp_server(name) or "")
            if entry is not None:
                entry[1] += 1 if failed else 0
                entry[2] += 1 if declined else 0
        if name in EDIT_TOOLS and not block.get("is_error"):
            path = tool_input.get("file_path") or ""
            if not HARNESS_RE.search(path):
                added, removed = edit_lines(tool_input, record.get("toolUseResult"))
                owner["lines"][0] += added
                owner["lines"][1] += removed
        if name == "Bash" and PR_CMD_RE.search(str(tool_input.get("command", ""))):
            result = record.get("toolUseResult")
            stdout = result.get("stdout", "") if isinstance(result, dict) else ""
            match = PR_URL_RE.search(f"{stdout}\n{text}")
            if match and not block.get("is_error"):
                owner_, repo, number = match.groups()
                local = datetime.fromtimestamp(record["_ts"] / 1000, tz)
                prs.append({
                    "ts": record["_ts"],
                    "date": local.date().isoformat(),
                    "title": pr_title(tool_input["command"]) or f"Pull request #{number}",
                    "repo": f"{owner_}/{repo}",
                    "number": int(number),
                    "url": match.group(0),
                })


def project_name(session):
    if not session["cwds"]:
        return session["key"][0], session["key"][0]
    cwd = session["cwds"].most_common(1)[0][0].rstrip("/")
    return os.path.basename(cwd) or cwd, cwd


def disambiguate(names):
    """Same basename, different paths: prefix the parent directory."""
    paths_by_base = defaultdict(set)
    for base, path in names:
        paths_by_base[base].add(path)
    out = []
    for base, path in names:
        if len(paths_by_base[base]) > 1:
            parent = os.path.basename(os.path.dirname(path))
            out.append((f"{parent}/{base}" if parent else base, path))
        else:
            out.append((base, path))
    return out


def strip_row(row):
    return {
        "start": row["start"],
        "project": row["project"],
        "prompts": row["prompts"],
        "tok": row["tok"],
        "models": row["models"],
        "lines": row["lines"],
        "tools": row["tools"],
        "mcp": row["mcp"],
        "heat": row["heat"],
    }


# ---------------------------------------------------------------- time


def union(spans):
    merged = []
    for a, b in sorted(spans):
        if merged and a <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return merged


def split_time(agent_spans, you_spans):
    """Disjoint (start, end, kind) intervals. Claude's time wins an overlap,
    so Claude's hours plus yours always equal active hours."""
    agent = union(agent_spans)
    starts = [a for a, _ in agent]
    out = [(a, b, "agent") for a, b in agent]
    for a, b in union(you_spans):
        i = max(bisect.bisect_right(starts, a) - 1, 0)
        cursor = a
        while i < len(agent) and agent[i][0] < b:
            s, e = agent[i]
            if e > cursor:
                if s > cursor:
                    out.append((cursor, s, "you"))
                cursor = max(cursor, e)
            i += 1
        if cursor < b:
            out.append((cursor, b, "you"))
    out.sort()
    return out


def active_minutes_by_day(intervals, tz):
    """Local date -> active minutes, splitting intervals at local midnight."""
    days = defaultdict(float)
    for a, b, _ in intervals:
        start = datetime.fromtimestamp(a / 1000, tz)
        end = datetime.fromtimestamp(b / 1000, tz)
        while start.date() < end.date():
            midnight = datetime.combine(start.date() + timedelta(days=1), time(), tz)
            days[start.date()] += (midnight - start).total_seconds() / 60
            start = midnight
        days[start.date()] += (end - start).total_seconds() / 60
    return dict(days)


def year_grid(days, today):
    """53 weeks x 7 days ending today, Monday first, with quantile levels 0-5."""
    first = today - timedelta(days=GRID_DAYS - 1)
    start = first - timedelta(days=first.weekday())
    count = (today - start).days + 1
    values = [days.get(start + timedelta(days=i), 0) for i in range(count)]
    active = sorted(v for v in values if v > 0)
    cuts = [active[int(q * (len(active) - 1))] for q in (0.2, 0.4, 0.6, 0.8)] if active else []
    levels = [0 if v <= 0 else 1 + sum(v > c for c in cuts) for v in values]
    return {
        "start": start.isoformat(),
        "levels": levels,
        "minutes": [round(v) for v in values],
    }


def streaks(days, today):
    """Longest run of active days in the last 12 months, and the current run."""
    first = today - timedelta(days=GRID_DAYS - 1)
    active = sorted(d for d, m in days.items() if m > 0 and first <= d <= today)
    best, run_start, prev = None, None, None
    for d in active:
        if prev is None or (d - prev).days != 1:
            run_start = d
        length = (d - run_start).days + 1
        if best is None or length > best[2]:
            best = (run_start, d, length)
        prev = d
    current = 0
    if active and (today - active[-1]).days <= 1:
        d = active[-1]
        while d in days and days[d] > 0:
            current += 1
            d -= timedelta(days=1)
    longest = None
    if best:
        longest = {"start": best[0].isoformat(), "end": best[1].isoformat(), "days": best[2]}
    return {"longest": longest, "current": current}


# ---------------------------------------------------------------- output


def font_faces():
    css = []
    for family, weight, filename in FONTS:
        path = HERE / "fonts" / filename
        if not path.is_file():
            continue
        data = base64.b64encode(path.read_bytes()).decode("ascii")
        css.append(
            f"@font-face{{font-family:'{family}';font-style:normal;font-weight:{weight};"
            f"font-display:block;src:url(data:font/woff2;base64,{data}) format('woff2')}}"
        )
    return "\n".join(css)


def safe_json(payload):
    text = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    return text.replace("</", "<\\/").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def render(payload, mode, template=None):
    template = template if template is not None else TEMPLATE.read_text(encoding="utf-8")
    page = dict(payload, mode=mode)
    return (
        template.replace("/*__FONTS__*/", font_faces())
        .replace("/*__DATA__*/null", safe_json(page))
    )


def resolve_tz(name):
    if not name:
        return datetime.now().astimezone().tzinfo
    try:
        from zoneinfo import ZoneInfo
    except ImportError:  # Python < 3.9
        sys.exit("--tz needs Python 3.9 or newer")
    try:
        return ZoneInfo(name)
    except Exception:
        sys.exit(f"Unknown time zone: {name}")


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="agentreplay",
        description="An overview of how you work with Claude Code, from ~/.claude.",
    )
    parser.add_argument("--handle", help="your @handle, shown on the share card")
    parser.add_argument(
        "--claude-dir",
        default=os.environ.get("CLAUDE_CONFIG_DIR") or str(Path.home() / ".claude"),
        help="Claude Code config directory (default: $CLAUDE_CONFIG_DIR or ~/.claude)",
    )
    parser.add_argument("--out-dir", default=".", help="where to write the two HTML files")
    parser.add_argument("--tz", help="IANA time zone for days and hours (default: local)")
    parser.add_argument("--no-open", action="store_true", help="don't open the page")
    parser.add_argument("--json", action="store_true", help="print the stats as JSON and exit")
    parser.add_argument("--demo", action="store_true", help="use the bundled sample sessions")
    args = parser.parse_args(argv)

    tz = resolve_tz(args.tz)
    claude_dir = DEMO_DIR if args.demo else Path(args.claude_dir).expanduser()
    payload = analyze(claude_dir / "projects", tz)
    handle = (args.handle or "").strip()
    if handle and not handle.startswith("@"):
        handle = "@" + handle
    payload["meta"]["handle"] = handle

    if args.json:
        print(json.dumps(payload, indent=2))
        return 0

    if not TEMPLATE.is_file():
        sys.exit(f"template.html not found next to {Path(__file__).name}")
    out_dir = Path(args.out_dir).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    template = TEMPLATE.read_text(encoding="utf-8")
    page = out_dir / "agentreplay.html"
    card = out_dir / "agentreplay-card.html"
    page.write_text(render(payload, "page", template), encoding="utf-8")
    card.write_text(render(payload, "card", template), encoding="utf-8")

    n = len(payload["sessions"])
    if n == 0:
        print(f"No Claude Code sessions found under {claude_dir / 'projects'}.")
    else:
        print(f"Read {n} sessions from {claude_dir / 'projects'}.")
    if payload["meta"]["skippedLines"]:
        print(f"Skipped {payload['meta']['skippedLines']} unreadable lines.")
    print(f"Wrote {page}\nWrote {card}")
    if not args.no_open:
        webbrowser.open(page.resolve().as_uri())
    return 0


if __name__ == "__main__":
    sys.exit(main())
