#!/usr/bin/env python3
"""Capture the real site and the real dashboard for README/site screenshots.

The dashboard capture seeds a temporary CCW_HOME with sample sessions and
transcripts, starts the actual dashboard server against it, and screenshots the
real UI. Nothing in the user's state directory is touched.

Requires Playwright for Python:
    pip install playwright && python -m playwright install chromium
"""

from __future__ import annotations

import argparse
import json
import os
import random
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "site" / "static" / "screenshots"
OG_SOURCE = ROOT / "site" / "og.html"
OG_OUT = ROOT / "site" / "static" / "og.png"
MIN = 60_000
NOW = time.time() * 1000


def iso(ms: float) -> str:
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def usage_line(session_id, t, read, write, model, cwd, key):
    return json.dumps({
        "type": "assistant",
        "isSidechain": False,
        "sessionId": session_id,
        "timestamp": iso(t),
        "cwd": cwd,
        "message": {
            "id": key,
            "model": model,
            "usage": {
                "input_tokens": 3,
                "cache_read_input_tokens": read,
                "cache_creation_input_tokens": write,
                "cache_creation": {"ephemeral_1h_input_tokens": write, "ephemeral_5m_input_tokens": 0},
            },
        },
    }) + "\n"


SESSIONS = [
    {
        "id": "264db9fa-8b1c-4e0a-9e2f-1f0c2a7c51d1",
        "surface": "cli", "cwd": "D:/work/atlas", "slug": "atlas",
        "model": "claude-opus-5", "ctx": 245_300, "ctx_write": 5_000,
        "last_request_min": 18, "last_human_min": 25, "work": True,
        "interval_min": 50, "pings": 3,
    },
    {
        "id": "a3398cd8-20f3-4e16-a5df-89d31b5f6c2a",
        "surface": "desktop", "cwd": "D:/work/api", "slug": "api",
        "model": "claude-opus-5", "ctx": 466_900, "ctx_write": 6_900,
        "last_request_min": 5, "last_human_min": 41, "work": True,
        "interval_min": 30, "pings": 6,
    },
    {
        "id": "f81c02ae-5c2d-4a83-bbf5-0d4e28c91a77",
        "surface": "cli", "cwd": "D:/work/notes", "slug": "notes",
        "model": "claude-sonnet-5", "ctx": 88_400, "ctx_write": 2_400,
        "last_request_min": 3, "last_human_min": 3, "work": False,
        "interval_min": 50, "pings": 0,
    },
    {
        "id": "7b2e44d0-9f1a-4c6e-8d02-6a1e35b7c4f9",
        "surface": "ide", "cwd": "D:/work/site", "slug": "site",
        "model": "claude-opus-5", "ctx": 312_700, "ctx_write": 4_100,
        "last_request_min": 11, "last_human_min": 11, "work": True,
        "interval_min": 50, "pings": 1,
    },
]


def seed_transcript(session, projects_dir: Path, seed: int) -> Path:
    """Seven days of plausible requests, with cold rebuilds after long pauses."""
    rnd = random.Random(seed)
    out_dir = projects_dir / session["slug"]
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{session['id']}.jsonl"
    lines = []
    base = session["ctx"]
    counter = 0
    start = NOW - 6.5 * 24 * 60 * MIN
    t = start
    while t < NOW - session["last_request_min"] * MIN - 5 * MIN:
        # A working block: a handful of cheap cache reads.
        for _ in range(rnd.randint(4, 9)):
            if t >= NOW - session["last_request_min"] * MIN - 2 * MIN:
                break
            counter += 1
            lines.append(usage_line(session["id"], t, base + rnd.randint(-4000, 4000), rnd.randint(250, 900),
                                    session["model"], session["cwd"], f"{session['id']}-{counter}"))
            t += rnd.randint(2, 7) * MIN
        # A pause long enough to expire the 1-hour cache: come back with a rewrite.
        gap = rnd.choice([75, 90, 110, 135, 160])
        t += gap * MIN
        if t >= NOW - session["last_request_min"] * MIN - 2 * MIN:
            break
        counter += 1
        lines.append(usage_line(session["id"], t, 0, base + rnd.randint(-3000, 3000),
                                session["model"], session["cwd"], f"{session['id']}-{counter}"))
        t += rnd.randint(2, 5) * MIN

    # Final request: the current cached context shown by the dashboard.
    counter += 1
    t = NOW - session["last_request_min"] * MIN
    lines.append(usage_line(session["id"], t, session["ctx"], session["ctx_write"],
                            session["model"], session["cwd"], f"{session['id']}-{counter}"))
    path.write_text("".join(lines), encoding="utf-8")
    return path


def seed_demo_home(home: Path, projects_dir: Path) -> None:
    sessions_dir = home / "sessions"
    sessions_dir.mkdir(parents=True, exist_ok=True)
    config = {
        "schema": 2,
        "global": {"minContextTokens": 20000},
        "surfaces": {"desktop": {"intervalMinutes": 30}},
        "projects": {},
        "enabled": False,
        "fallbackCron": False,
        "_note": "Demo state for screenshots.",
    }
    (home / "config.json").write_text(json.dumps(config, indent=2), encoding="utf-8")

    events = []
    for i, session in enumerate(SESSIONS):
        transcript = seed_transcript(session, projects_dir, seed=40 + i)
        last_request = NOW - session["last_request_min"] * MIN
        last_human = NOW - session["last_human_min"] * MIN
        session_doc = {
            "schema": 2,
            "sessionId": session["id"],
            "surface": session["surface"],
            "entrypoint": "claude-desktop-3p" if session["surface"] == "desktop" else ("vscode" if session["surface"] == "ide" else "cli"),
            "cwd": session["cwd"],
            "transcriptPath": str(transcript),
            "claudePid": os.getpid(),
            "startedAt": NOW - 4 * 3600 * 1000,
            "lastHumanAt": last_human,
            "lastPromptAt": last_request,
            "lastPromptKind": "human",
            "lastStopAt": last_request,
            "lastWorkStopAt": last_human,
            "background": {
                "at": last_request,
                "tasks": ([{"id": f"bg-{i}", "type": "subagent", "status": "running", "description": "background research"}] if session["work"] else []),
                "crons": [],
            },
            "overrides": {},
            "enabled": False,
        }
        (sessions_dir / f"{session['id']}.json").write_text(json.dumps(session_doc, indent=2), encoding="utf-8")
        ping_times = [NOW - (30 + 50 * n) * MIN for n in range(session["pings"])]
        state = {
            "pingTimes": ping_times,
            "pingsTotal": session["pings"],
            "lastPing": ({"at": ping_times[-1], "result": "hit", "read": session["ctx"], "write": 400} if ping_times else None),
            "consecutiveMisses": 0,
            "suspended": None,
            "waker": ({"gen": f"{os.getpid()}.{int(NOW)}", "pid": os.getpid(), "startedAt": last_request,
                       "heartbeatAt": NOW, "status": "sleeping", "lastStatus": "warming",
                       "nextPingAt": last_request + session["interval_min"] * MIN, "exitReason": None}
                      if session["work"] else None),
        }
        (sessions_dir / f"{session['id']}.state.json").write_text(json.dumps(state, indent=2), encoding="utf-8")

        for n, pt in enumerate(ping_times):
            events.append({"t": pt, "type": "ping", "engine": "rewake", "sessionId": session["id"],
                           "surface": session["surface"], "ttl": "1h", "intervalMinutes": session["interval_min"],
                           "estCostUsd": round(session["ctx"] / 1e6 * 5 * 0.1, 4)})
            events.append({"t": pt + 20_000, "type": "ping_result", "sessionId": session["id"],
                           "surface": session["surface"], "result": "hit", "read": session["ctx"], "write": 400})

    events.sort(key=lambda e: e["t"])
    (home / "events.jsonl").write_text("".join(json.dumps(e) + "\n" for e in events), encoding="utf-8")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_http(url: str, timeout: float = 25.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as res:
                if res.status == 200:
                    return
        except Exception:
            time.sleep(0.2)
    raise RuntimeError(f"server did not answer: {url}")


def shoot_dashboard(out: Path) -> None:
    tmp = Path(tempfile.mkdtemp(prefix="ccw-shot-"))
    home = tmp / "home"
    projects = tmp / "projects"
    claude = tmp / "claude"
    for p in (home, projects, claude):
        p.mkdir(parents=True, exist_ok=True)
    seed_demo_home(home, projects)
    port = free_port()
    env = {**os.environ, "CCW_HOME": str(home), "CCW_PROJECTS_DIR": str(projects),
           "CCW_PORT": str(port), "CLAUDE_CONFIG_DIR": str(claude)}
    server = subprocess.Popen([os.environ.get("CCW_NODE", "node"), str(ROOT / "dashboard" / "server.mjs")],
                              cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_http(f"http://127.0.0.1:{port}/api/health")
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page(viewport={"width": 1440, "height": 1750}, device_scale_factor=1)
            page.goto(f"http://127.0.0.1:{port}/", wait_until="networkidle")
            page.wait_for_timeout(1800)
            page.screenshot(path=str(out / "dashboard.png"))
            browser.close()
        print("captured dashboard.png")
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()


def shoot_og() -> None:
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1200, "height": 630}, device_scale_factor=1)
        page.goto(OG_SOURCE.as_uri())
        page.wait_for_timeout(700)
        page.screenshot(path=str(OG_OUT), clip={"x": 0, "y": 0, "width": 1200, "height": 630})
        browser.close()
    print("captured og.png")


def build_site() -> None:
    subprocess.run([sys.executable, str(ROOT / "scripts" / "build_site.py")], cwd=ROOT, check=True)


def static_server() -> tuple[subprocess.Popen, str]:
    port = free_port()
    proc = subprocess.Popen([sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"],
                            cwd=ROOT / "docs", stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://127.0.0.1:{port}"
    wait_http(base + "/")
    return proc, base


def shoot_site(out: Path) -> None:
    proc, base = static_server()
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page(viewport={"width": 1440, "height": 1000}, device_scale_factor=1)
            for name, path in [("home", "/"), ("reference", "/reference/")]:
                page.goto(base + path, wait_until="networkidle")
                page.wait_for_timeout(450)
                page.screenshot(path=str(out / f"{name}.png"))
                print(f"captured {name}.png")
            mobile = browser.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2)
            mobile.goto(base + "/", wait_until="networkidle")
            mobile.wait_for_timeout(450)
            mobile.screenshot(path=str(out / "mobile-home.png"))
            print("captured mobile-home.png")
            browser.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-dashboard", action="store_true", help="keep the existing dashboard.png")
    parser.add_argument("--skip-site", action="store_true", help="only refresh og.png and dashboard.png")
    args = parser.parse_args()
    SHOTS.mkdir(parents=True, exist_ok=True)
    if not args.skip_dashboard:
        shoot_dashboard(SHOTS)
    shoot_og()
    build_site()
    if not args.skip_site:
        shoot_site(SHOTS)
        build_site()
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
