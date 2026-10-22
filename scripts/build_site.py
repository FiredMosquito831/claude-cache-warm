#!/usr/bin/env python3
"""Build the Cache Warm static site into docs/.

Data is derived from the repository, not typed twice:
  * version + engine range      -> package.json
  * defaults, scoped keys,      -> scripts/lib.mjs (imported with Node)
    intervals, status lines
  * option titles/descriptions  -> .claude-plugin/plugin.json
  * status names                -> parsed from computeStatus() in lib.mjs

Output is deterministic: no timestamps, no build ids, no ordering that depends
on the filesystem. `--check` builds into a temporary directory and compares it
byte-for-byte with docs/, which is what CI runs.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape
from markupsafe import Markup

ROOT = Path(__file__).resolve().parent.parent
SITE_DIR = ROOT / "site"
DOCS_DIR = ROOT / "docs"

# The one canonical origin. CNAME, sitemap, robots, canonical tags and JSON-LD
# all derive from this constant.
SITE_URL = "https://cachewarm.danubelabs.net"
SITE_HOST = urllib.parse.urlsplit(SITE_URL).netloc
REPO_URL = "https://github.com/FiredMosquito831/claude-cache-warm"

PAGES = {
    "home": {
        "out": "index.html",
        "template": "index.html",
        "title": "Cache Warm — keep Claude Code's prompt cache warm",
        "description": "Keep-alive pings for idle Claude Code sessions. Scoped settings, a status line segment, a local dashboard and a self-checking waker. Node 18+, zero runtime dependencies.",
        "keywords": "Claude Code plugin, prompt cache, cache warm, keep-alive, prompt caching, Claude Code cost, cache TTL, status line, ccw",
        "canonical": SITE_URL + "/",
        "og_type": "website",
    },
    "reference": {
        "out": "reference/index.html",
        "template": "reference.html",
        "title": "Configuration reference — Cache Warm",
        "description": "Every Cache Warm setting, default, validation rule and scope: warmWhen, intervalMinutes, maxIdleMinutes, minContextTokens, dashboardPort, statusline and statuslineSegments.",
        "keywords": "Cache Warm configuration, warmWhen, intervalMinutes, maxIdleMinutes, minContextTokens, statuslineSegments, ccw reference, Claude Code plugin settings",
        "canonical": SITE_URL + "/reference/",
        "og_type": "article",
    },
    "dashboard": {
        "out": "dashboard/index.html",
        "template": "dashboard.html",
        "title": "Dashboard, status line and tray — Cache Warm",
        "description": "The local Cache Warm dashboard: live sessions, per-scope settings, cache analytics from local transcripts. Plus the automatic status line segment and the optional tray app.",
        "keywords": "Cache Warm dashboard, Claude Code cache analytics, status line, tray app, Tauri, prompt cache monitor",
        "canonical": SITE_URL + "/dashboard/",
        "og_type": "article",
    },
    "faq": {
        "out": "faq/index.html",
        "template": "faq.html",
        "title": "FAQ — Cache Warm",
        "description": "Does Cache Warm invalidate the prompt cache? What does a ping cost? Why is my session not pinging? Straight answers about safety, cost, subscriptions and troubleshooting.",
        "keywords": "Cache Warm FAQ, prompt cache safety, cache keep-alive cost, Claude Code prompt cache, cache miss, asyncRewake",
        "canonical": SITE_URL + "/faq/",
        "og_type": "article",
    },
    "security": {
        "out": "security/index.html",
        "template": "security.html",
        "title": "Security and architecture — Cache Warm",
        "description": "How Cache Warm touches your machine: five hook events, a local state directory, read-only transcript access, a loopback-only dashboard, no telemetry and no runtime dependencies.",
        "keywords": "Cache Warm security, Claude Code plugin security, local dashboard, loopback, MIT, prompt cache privacy",
        "canonical": SITE_URL + "/security/",
        "og_type": "article",
    },
    "notfound": {
        "out": "404.html",
        "template": "404.html",
        "title": "Page not found — Cache Warm",
        "description": "This page went cold. Return to the Cache Warm overview, reference, dashboard guide, FAQ or security notes.",
        "keywords": "Cache Warm, 404",
        "canonical": SITE_URL + "/404.html",
        "robots": "noindex,nofollow",
        "og_type": "website",
    },
}

SITEMAP_PAGES = ["home", "reference", "dashboard", "faq", "security"]

SEGMENT_DESCRIPTIONS = {
    "model": "Model name, with the effort level when Claude Code reports it.",
    "folder": "Project folder, plus the subfolder you are in when it differs.",
    "branch": "Current git branch, read from .git without spawning a process.",
    "pr": "Open pull request number and review state.",
    "warm": "Warming state, next-ping countdown and pending background jobs.",
    "context": "Tokens currently in the context window.",
    "cache": "Tokens the last request read from the cache, and the percentage.",
    "fill": "Context-window usage as an amount and a percentage.",
    "limits": "5-hour and 7-day subscription usage, when available.",
    "cost": "List-price cost estimate. Opt-in: misleading on a subscription.",
}

STATUS_DESCRIPTIONS = {
    "warming": "Eligible and waiting; nextPingAt is set and the waker will exit 2 when it is due.",
    "busy": "A turn is in progress, so the conversation is refreshing its own cache. Nothing fires mid-turn.",
    "off": "Warming is switched off at some scope that applies to this session.",
    "no-work": "The default background-work policy is on and nothing is pending in the background.",
    "small-context": "The context is below minContextTokens; rebuilding it is cheap.",
    "idle-cap": "Nobody has been active for longer than maxIdleMinutes, and no background work is running.",
    "ping-cap": "The session already used its pings for this idle stretch (ceil(idle cap / interval) + 1, hard cap 24).",
    "suspended": "The last two verifiable pings missed the cache. Warming resumes when someone is active again.",
    "expired": "The cache TTL already elapsed. A ping now would be the expensive rewrite, so none is sent.",
    "ended": "The session ended or its process is gone.",
}
STATUS_ORDER = ["warming", "busy", "no-work", "off", "small-context", "idle-cap", "ping-cap", "suspended", "expired", "ended"]

COMMANDS = [
    {"slash": "/cache-warm:on [scope]", "shell": "ccw on [scope]", "description": "Switch warming on."},
    {"slash": "/cache-warm:off [scope]", "shell": "ccw off [scope]", "description": "Switch warming off."},
    {"slash": "/cache-warm:status", "shell": "ccw status [--all] [--json]", "description": "Sessions, what each waits on, next-ping countdown, per-ping and cold-return estimates."},
    {"slash": "/cache-warm:config …", "shell": "ccw config [scope]", "description": "Effective settings and the scope each value comes from."},
    {"slash": "/cache-warm:dashboard", "shell": "ccw dashboard [--no-open]", "description": "Start the loopback dashboard and open it."},
    {"slash": "/cache-warm:statusline", "shell": "ccw statusline install | auto | off", "description": "Install, configure or restore the status line segment."},
    {"slash": "/cache-warm:test", "shell": "ccw test", "description": "Self-test this session: one verified ping a minute after the turn, settings restored."},
    {"slash": "", "shell": "ccw when <background-work|always> [scope]", "description": "Choose the warming policy."},
    {"slash": "", "shell": "ccw interval <minutes|auto> [scope]", "description": "Set the ping interval; auto follows the session's cache TTL."},
    {"slash": "", "shell": "ccw set <key> <value> [scope]", "description": "Set any scoped key; global-only keys always write to global."},
    {"slash": "", "shell": "ccw unset <key> [scope]", "description": "Drop one key at that scope so it inherits again."},
    {"slash": "", "shell": "ccw reset [scope]", "description": "Drop every setting at one scope."},
    {"slash": "", "shell": "ccw scopes", "description": "List every scope that currently holds settings."},
    {"slash": "", "shell": "ccw doctor", "description": "Health checks, including verified pings per surface."},
    {"slash": "", "shell": "ccw events [n]", "description": "The most recent entries from the local event log."},
]

PLUGIN_OPTION_KEYS = {
    "enabled": "enabled",
    "warm_when": "warmWhen",
    "interval_minutes": "intervalMinutes",
    "max_idle_minutes": "maxIdleMinutes",
    "min_context_tokens": "minContextTokens",
    "desktop_mode": "desktopMode",
    "dashboard_port": "dashboardPort",
    "statusline": "statusline",
    "statusline_segments": "statuslineSegments",
}

RULES = {
    "enabled": "boolean (the CLI also accepts <code>true</code> / <code>false</code>)",
    "warmWhen": "<code>background-work</code> or <code>always</code>",
    "intervalMinutes": "<code>auto</code>, or an integer from 1 to 59",
    "maxIdleMinutes": "number ≥ 0; <code>0</code> = never stop",
    "minContextTokens": "number ≥ 0",
    "dashboardPort": "integer from 1024 to 65535",
    "statusline": "<code>auto</code>, <code>wrap-only</code> or <code>off</code>",
    "statuslineSegments": "comma-separated parts, each one of the available segments",
    "desktopMode": "<code>same-as-cli</code>, <code>off</code>, <code>background-work</code> or <code>always</code>",
}

SET_WITH = {
    "enabled": "ccw on / ccw off",
    "warmWhen": "ccw when background-work",
    "intervalMinutes": "ccw interval 30",
    "maxIdleMinutes": "ccw set maxIdleMinutes 180",
    "minContextTokens": "ccw set minContextTokens 20000",
    "dashboardPort": "ccw set dashboardPort 4777",
    "statusline": "ccw statusline auto",
    "statuslineSegments": "ccw set statuslineSegments model,folder,warm",
    "desktopMode": "plugin tab → configure",
}


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def run_node_constants() -> dict:
    """Import the real core module so defaults cannot drift from this site."""
    script = (
        "import * as lib from " + json.dumps((ROOT / "scripts" / "lib.mjs").as_uri()) + ";\n"
        "const cost = lib.estimateCosts('claude-opus-5', 800000, '1h');\n"
        "console.log(JSON.stringify({\n"
        "  version: lib.VERSION, defaults: lib.DEFAULTS, scoped: lib.SCOPED_KEYS,\n"
        "  globalOnly: lib.GLOBAL_ONLY_KEYS, segments: lib.STATUS_SEGMENTS,\n"
        "  defaultSegments: lib.DEFAULT_STATUS_SEGMENTS, auto: lib.AUTO_INTERVAL,\n"
        "  ttl: lib.TTL_MINUTES, cost,\n"
        "}));"
    )
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if proc.returncode != 0:
        raise SystemExit(f"Could not read constants from scripts/lib.mjs via node:\n{proc.stderr}")
    return json.loads(proc.stdout.strip().splitlines()[-1])


def parse_source_facts() -> dict:
    src = (ROOT / "scripts" / "lib.mjs").read_text(encoding="utf-8")

    def number(pattern: str, label: str) -> int:
        m = re.search(pattern, src)
        if not m:
            raise SystemExit(f"Could not find {label} in scripts/lib.mjs")
        return int(m.group(1))

    max_pings = number(r"const MAX_PINGS_PER_IDLE\s*=\s*(\d+);", "MAX_PINGS_PER_IDLE")
    misses = number(r"export const MISSES_BEFORE_SUSPEND\s*=\s*(\d+);", "MISSES_BEFORE_SUSPEND")
    trust = number(r"export const WORK_TRUST_MS\s*=\s*(\d+)\s*\*\s*3600_000", "WORK_TRUST_MS")

    body_start = src.find("export function computeStatus(")
    body_end = src.find("export const FINAL_STATUSES", body_start)
    if body_start < 0 or body_end < 0:
        raise SystemExit("Could not locate computeStatus() in scripts/lib.mjs")
    found = []
    for name in re.findall(r"status = '([a-z-]+)'", src[body_start:body_end]):
        if name not in found:
            found.append(name)
    missing = sorted(set(STATUS_DESCRIPTIONS) - set(found))
    extra = sorted(set(found) - set(STATUS_DESCRIPTIONS))
    if missing or extra:
        raise SystemExit(f"Status drift: missing descriptions {missing}, undescribed states {extra}")
    statuses = [{"key": key, "description": STATUS_DESCRIPTIONS[key]} for key in STATUS_ORDER]
    return {"max_pings": max_pings, "misses": misses, "trust_hours": trust, "statuses": statuses}


def default_display(key: str, value, auto: dict) -> str:
    if key == "statuslineSegments":
        return ", ".join(value)
    if key == "intervalMinutes":
        return f"auto — {auto['1h']} min on a 1h cache, {auto['5m']} min on a 5m cache"
    if key == "maxIdleMinutes":
        return f"{value} min (0 = never)"
    if key == "minContextTokens":
        return f"{value:,}"
    if key == "enabled":
        return "On" if value else "Off"
    return str(value)


def build_options(plugin: dict, constants: dict) -> tuple[list[dict], list[dict]]:
    user_config = plugin.get("userConfig", {})
    by_key = {PLUGIN_OPTION_KEYS[k]: v for k, v in user_config.items() if k in PLUGIN_OPTION_KEYS}
    defaults = constants["defaults"]
    scoped = constants["scoped"]
    global_only = constants["globalOnly"]
    order = ["enabled", "warmWhen", "intervalMinutes", "maxIdleMinutes", "minContextTokens", "dashboardPort", "statusline", "statuslineSegments"]

    options = []
    for key in order:
        cfg = by_key.get(key)
        if not cfg:
            raise SystemExit(f"plugin.json has no userConfig entry for {key}")
        value = defaults[key]
        options.append({
            "key": key,
            "title": cfg.get("title", key),
            "description": cfg.get("description", ""),
            "default_display": default_display(key, value, constants["auto"]),
            "default_raw": value,
            "global_only": key in global_only,
            "scoped": key in scoped,
            "rules": Markup(RULES[key]),
            "set_with": SET_WITH[key],
            "plugin_only": False,
        })

    dm = by_key.get("desktopMode")
    if not dm:
        raise SystemExit("plugin.json has no desktop_mode entry")
    options.append({
        "key": "desktopMode",
        "title": dm.get("title", "Desktop app sessions"),
        "description": dm.get("description", ""),
        "default_display": dm.get("default", "same-as-cli"),
        "default_raw": dm.get("default", "same-as-cli"),
        "global_only": False,
        "scoped": False,
        "rules": Markup(RULES["desktopMode"]),
        "set_with": SET_WITH["desktopMode"],
        "plugin_only": True,
    })
    core = [o for o in options if o["key"] in scoped]
    return options, core


def icon(name: str) -> Markup:
    paths = {
        "layers": '<path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 16 9 5 9-5"/>',
        "line": '<path d="M3 17h4l3-9 4 13 3-7h4"/>',
        "check": '<path d="M20 6 9 17l-5-5"/>',
        "chart": '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
        "tray": '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
        "shield": '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/>',
    }
    body = paths.get(name, paths["check"])
    return Markup(
        f'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" '
        f'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{body}</svg>'
    )


def site_data() -> dict:
    package = read_json(ROOT / "package.json")
    plugin = read_json(ROOT / ".claude-plugin" / "plugin.json")
    constants = run_node_constants()
    facts = parse_source_facts()

    if package["version"] != constants["version"] or plugin["version"] != constants["version"]:
        raise SystemExit(
            "Version mismatch: package.json, plugin.json and scripts/lib.mjs must agree "
            f"({package['version']}, {plugin['version']}, {constants['version']})"
        )

    options, core = build_options(plugin, constants)
    segments = [
        {
            "key": key,
            "description": SEGMENT_DESCRIPTIONS.get(key, "—"),
        }
        for key in constants["segments"]
    ]
    engines = package.get("engines", {}).get("node", ">=18")
    node_range = engines.replace(">=", "").replace(" ", "")

    return {
        "version": constants["version"],
        "defaults": constants["defaults"],
        "auto_interval": constants["auto"],
        "ttl_minutes": constants["ttl"],
        "scoped_keys": constants["scoped"],
        "global_keys": constants["globalOnly"],
        "segments": segments,
        "statuses": facts["statuses"],
        "max_pings_per_idle": facts["max_pings"],
        "misses_before_suspend": facts["misses"],
        "work_trust_hours": facts["trust_hours"],
        "options": options,
        "settings_options": [o for o in options if not o["plugin_only"]],
        "core_options": core,
        "commands": COMMANDS,
        "cost_example": {
            "ping": f"{constants['cost']['pingUsd']:.2f}",
            "rebuild": f"{constants['cost']['rebuildUsd']:.2f}",
            "break_even": constants["cost"]["breakEvenPings"],
        },
        "node_range": node_range,
        "site_host": SITE_HOST,
        "repo_url": REPO_URL,
    }


def jsonld(meta: dict, data: dict) -> str:
    payload = {
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        "name": "Cache Warm",
        "alternateName": "claude-cache-warm",
        "applicationCategory": "DeveloperApplication",
        "applicationSubCategory": "Claude Code plugin",
        "operatingSystem": "Windows, macOS, Linux",
        "softwareVersion": data["version"],
        "softwareRequirements": f"Node.js {data['node_range']}+ and a Claude Code version that supports asyncRewake hooks",
        "description": PAGES["home"]["description"],
        "url": SITE_URL + "/",
        "codeRepository": REPO_URL,
        "downloadUrl": REPO_URL,
        "license": "https://opensource.org/licenses/MIT",
        "isAccessibleForFree": True,
        "author": {
            "@type": "Person",
            "name": "FiredMosquito831",
            "url": "https://github.com/FiredMosquito831",
        },
        "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"},
        "keywords": PAGES["home"]["keywords"],
        "featureList": [
            "Keep-alive pings for idle Claude Code sessions",
            "Session, project, surface and global scopes",
            "Status line segment that wraps an existing line",
            "Local dashboard with transcript analytics",
            "Verified pings with automatic suspension after misses",
        ],
    }
    return json.dumps(payload, indent=2, ensure_ascii=False)


def render_all(data: dict) -> dict[str, bytes]:
    env = Environment(
        loader=FileSystemLoader(SITE_DIR / "templates"),
        autoescape=select_autoescape(["html", "xml"]),
        trim_blocks=True,
        lstrip_blocks=True,
    )
    env.globals["icon"] = icon
    outputs: dict[str, bytes] = {}

    for page, meta in PAGES.items():
        template = env.get_template(meta["template"])
        html = template.render(
            **data,
            page=page,
            meta={
                "title": meta["title"],
                "description": meta["description"],
                "keywords": meta["keywords"],
                "robots": meta.get("robots", "index,follow"),
            },
            canonical=meta["canonical"],
            jsonld=jsonld(meta, data),
            site_url=SITE_URL,
        )
        outputs[meta["out"]] = html.encode("utf-8")

    urls = [SITE_URL + "/" + ("" if p == "home" else p + "/") for p in SITEMAP_PAGES]
    sitemap = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "".join(
            "  <url>\n"
            f"    <loc>{url}</loc>\n"
            "    <changefreq>monthly</changefreq>\n"
            f"    <priority>{'1.0' if i == 0 else '0.8'}</priority>\n"
            "  </url>\n"
            for i, url in enumerate(urls)
        )
        + "</urlset>\n"
    )
    outputs["sitemap.xml"] = sitemap.encode("utf-8")
    outputs["robots.txt"] = (
        "User-agent: *\n"
        "Allow: /\n"
        f"Sitemap: {SITE_URL}/sitemap.xml\n"
    ).encode("utf-8")
    outputs["CNAME"] = (SITE_HOST + "\n").encode("utf-8")
    outputs[".nojekyll"] = b""

    static = SITE_DIR / "static"
    for src in sorted(static.rglob("*")):
        if src.is_dir():
            continue
        rel = src.relative_to(static).as_posix()
        if rel == "og.png":
            outputs["og.png"] = src.read_bytes()
        else:
            outputs[f"assets/{rel}"] = src.read_bytes()

    if "og.png" not in outputs:
        raise SystemExit("Missing site/static/og.png (run scripts/capture_site.py first)")
    return outputs


def write_outputs(outputs: dict[str, bytes], target: Path, clean: bool) -> None:
    if clean:
        for rel in ["assets", "reference", "dashboard", "faq", "security"]:
            shutil.rmtree(target / rel, ignore_errors=True)
        for rel in ["index.html", "404.html", "sitemap.xml", "robots.txt", "CNAME", ".nojekyll", "og.png"]:
            (target / rel).unlink(missing_ok=True)
    for rel, content in outputs.items():
        dest = target / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(content)


def compare(outputs: dict[str, bytes], target: Path) -> list[str]:
    problems: list[str] = []
    for rel, content in sorted(outputs.items()):
        dest = target / rel
        if not dest.exists():
            problems.append(f"missing: {rel}")
        elif dest.read_bytes() != content:
            problems.append(f"differs: {rel}")
    generated_dirs = ["assets", "reference", "dashboard", "faq", "security"]
    for directory in generated_dirs:
        root = target / directory
        if not root.exists():
            continue
        for path in sorted(root.rglob("*")):
            if path.is_file():
                rel = path.relative_to(target).as_posix()
                if rel not in outputs:
                    problems.append(f"stale: {rel}")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the Cache Warm site into docs/.")
    parser.add_argument("--check", action="store_true", help="verify docs/ is byte-identical to a fresh build")
    parser.add_argument("--out", type=Path, default=DOCS_DIR, help="output directory (default: docs/)")
    args = parser.parse_args()

    data = site_data()
    outputs = render_all(data)

    if args.check:
        problems = compare(outputs, DOCS_DIR)
        if problems:
            print("Site output is stale. Run: python scripts/build_site.py", file=sys.stderr)
            for problem in problems:
                print(f"  {problem}", file=sys.stderr)
            return 1
        print(f"site is up to date ({len(outputs)} files, v{data['version']})")
        return 0

    write_outputs(outputs, args.out, clean=True)
    print(f"built {len(outputs)} files into {args.out.relative_to(ROOT).as_posix() if args.out.is_absolute() and args.out.is_relative_to(ROOT) else args.out} (v{data['version']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
