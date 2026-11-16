#!/usr/bin/env python3
"""Durable, one-site-at-a-time FMHY research queue for Watch Providers."""

import argparse
import fcntl
import hashlib
import html
import json
import os
import re
import tempfile
import urllib.parse
import urllib.request
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

SOURCE = "https://fmhy.net/video"
STATE = Path(os.environ.get("WATCH_BOTS_STATE", "/home/jack/watch-bots/state"))
QUEUE = STATE / "fmhy-queue.json"
INDEX = Path(__file__).with_name("provider-index.json")
SECTIONS = {"streaming-sites", "specialty-streaming", "live-tv-sports"}
SKIP_CATEGORIES = {"iptv-tools", "iptv-players"}
SKIP_LABELS = {"2", "3", "4", "5", "mirrors", "status", "guide", "invite", "discord", "api"}
SKIP_HOSTS = {"fmhy.net", "github.com", "discord.gg", "rentry.co", "tvchannellists.com"}
LEASE_HOURS = 4


def now():
    return datetime.now(timezone.utc)


def iso(value):
    return value.isoformat(timespec="seconds")


def clean_text(markup):
    return html.unescape(re.sub(r"<[^>]*>", "", markup)).replace("\u200b", "").strip()


def site_host(value):
    """Match a site by exact hostname, never by a loose brand substring."""
    parsed = urllib.parse.urlsplit(value if "://" in value else "https://" + value)
    return (parsed.hostname or "").lower().removeprefix("www.")


def integrated_providers():
    data = json.loads(INDEX.read_text())
    if data.get("version") != 1 or not isinstance(data.get("integrated"), list):
        raise ValueError("Invalid provider index")
    hosts = {}
    for provider in data["integrated"]:
        if not all(provider.get(key) for key in ("id", "name", "kind", "origins", "implementation")):
            raise ValueError("Provider index has an incomplete entry")
        for origin in provider["origins"]:
            host = site_host(origin)
            if not host:
                raise ValueError(f"Provider index has an invalid host: {origin}")
            # Related adapters can share an embed/API host. The queue only
            # needs to know that the host is already covered by *some* code.
            hosts.setdefault(host, provider)
    return data["integrated"], hosts


def index_entries(data):
    """Combine code-backed integrations with finished research attempts."""
    integrated, by_host = integrated_providers()
    rows = [{**provider, "status": "integrated"} for provider in integrated]
    for item in data["items"]:
        if item.get("status") not in {"verified", "unavailable", "blocked", "skipped"}:
            continue
        host = item.get("host") or site_host(item["url"])
        if host in by_host:
            continue
        rows.append({key: item[key] for key in ("id", "name", "url", "status", "finished_at", "note", "evidence", "integrator_task") if key in item})
    return rows


def sync_index(data):
    """Close pending queue sites whose exact origin is already in the app."""
    _, integrated_hosts = integrated_providers()
    count = 0
    for item in data["items"]:
        if item.get("status") != "pending":
            continue
        provider = integrated_hosts.get(item.get("host") or site_host(item["url"]))
        if not provider:
            continue
        item["status"] = "skipped"
        item["finished_at"] = iso(now())
        item["note"] = f"Already integrated as {provider['id']} ({', '.join(provider['implementation'])})"
        count += 1
    return count


def candidates_from_html(page):
    """Extract named streaming sites in page order; ignore mirror/status links."""
    headings = list(re.finditer(r'<h([23])\b[^>]*id="([^"]+)"[^>]*>.*?</h\1>', page, re.S | re.I))
    section = ""
    found = []
    seen = set()
    for index, heading in enumerate(headings):
        level, slug = heading.group(1), heading.group(2).lower()
        if level == "2":
            section = slug
            category = ""
        else:
            category = slug
        if level != "3" or section not in SECTIONS or category in SKIP_CATEGORIES:
            continue
        end = headings[index + 1].start() if index + 1 < len(headings) else len(page)
        block = page[heading.end():end]
        for item in re.finditer(r"<li\b[^>]*>(.*?)</li>", block, re.S | re.I):
            # The introductory links precede the site's feature list after " - ".
            intro = re.split(r"\s-\s", item.group(1), maxsplit=1)[0]
            for link in re.finditer(r'<a\b[^>]*href="([^"]+)"[^>]*>(.*?)</a>', intro, re.S | re.I):
                name = clean_text(link.group(2))
                raw = html.unescape(link.group(1)).strip()
                if not name or name.lower() in SKIP_LABELS or re.fullmatch(r"\d+", name):
                    continue
                parsed = urllib.parse.urlsplit(raw)
                host = (parsed.hostname or "").lower().removeprefix("www.")
                if parsed.scheme not in {"http", "https"} or not host or host in SKIP_HOSTS:
                    continue
                if host in seen:
                    continue
                seen.add(host)
                found.append({
                    "id": hashlib.sha256(host.encode()).hexdigest()[:12],
                    "name": name[:100], "url": urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path or "/", "", "")),
                    "host": host, "section": section, "category": category, "order": len(found),
                })
    return found


def fetch_candidates():
    request = urllib.request.Request(SOURCE, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=20) as response:
        page = response.read(2_000_000).decode("utf-8", "replace")
    items = candidates_from_html(page)
    if len(items) < 30:
        raise RuntimeError(f"FMHY extraction yielded only {len(items)} candidates")
    return items


@contextmanager
def locked_queue():
    STATE.mkdir(parents=True, exist_ok=True)
    lock_path = STATE / "fmhy-queue.lock"
    with lock_path.open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        data = json.loads(QUEUE.read_text()) if QUEUE.exists() else {"source": SOURCE, "fetched_at": None, "items": []}
        yield data


def save(data):
    fd, temp_path = tempfile.mkstemp(prefix=".fmhy-queue-", dir=STATE)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(data, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
        os.replace(temp_path, QUEUE)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)


def refresh(data):
    current = {item["id"]: item for item in data["items"]}
    fresh = fetch_candidates()
    present = set()
    for row in fresh:
        present.add(row["id"])
        old = current.get(row["id"], {})
        old.update(row)
        old.setdefault("status", "pending")
        old.setdefault("attempts", 0)
        old["listed"] = True
        current[row["id"]] = old
    for key, row in current.items():
        if key not in present:
            row["listed"] = False
    data["items"] = sorted(current.values(), key=lambda row: (not row.get("listed", False), row.get("order", 999999)))
    data["fetched_at"] = iso(now())
    save(data)
    return len(fresh)


def claim(data):
    fetched = datetime.fromisoformat(data["fetched_at"]) if data.get("fetched_at") else None
    if not fetched or now() - fetched > timedelta(hours=24):
        try:
            refresh(data)
        except Exception:
            if not data["items"]:
                raise
    changed = False
    for item in data["items"]:
        if item.get("status") == "claimed":
            until = datetime.fromisoformat(item["lease_until"])
            if now() >= until:
                if item.get("attempts", 0) >= 3:
                    item["status"] = "blocked"
                    item["finished_at"] = iso(now())
                    item["note"] = "Research lease expired three times"
                    item.pop("lease_until", None)
                    changed = True
                else:
                    item["status"] = "pending"
                    changed = True
    changed = bool(sync_index(data)) or changed
    active = next((item for item in data["items"] if item.get("status") == "claimed"), None)
    if active:
        if changed:
            save(data)
        return {**{key: active[key] for key in ("id", "name", "url", "section", "category", "attempts", "lease_until")},
                "resumed": True}
    for item in data["items"]:
        if item.get("listed", True) and item.get("status") == "pending":
            item["status"] = "claimed"
            item["attempts"] = item.get("attempts", 0) + 1
            item["lease_until"] = iso(now() + timedelta(hours=LEASE_HOURS))
            save(data)
            return {key: item[key] for key in ("id", "name", "url", "section", "category", "attempts", "lease_until")}
    if changed:
        save(data)
    return None


def finish(candidate_id, status, note="", evidence="", task_id=""):
    if status not in {"verified", "unavailable", "blocked", "skipped"}:
        raise ValueError("Unsupported status")
    if status == "verified" and (not evidence or not task_id):
        raise ValueError("Verified items require an evidence path and integrator task ID")
    with locked_queue() as data:
        item = next((row for row in data["items"] if row["id"] == candidate_id), None)
        if not item:
            raise ValueError("Unknown candidate ID")
        item["status"] = status
        item["finished_at"] = iso(now())
        item["note"] = re.sub(r"https?://\S+", "[URL]", note)[:300]
        item.pop("lease_until", None)
        if evidence:
            item["evidence"] = str(Path(evidence).resolve())
        if task_id:
            item["integrator_task"] = task_id
        save(data)


def main():
    parser = argparse.ArgumentParser()
    command = parser.add_subparsers(dest="command", required=True)
    for name in ("refresh", "claim", "status", "index", "sync-index"):
        command.add_parser(name)
    lookup = command.add_parser("lookup")
    lookup.add_argument("site", help="Site URL or hostname")
    done = command.add_parser("finish")
    done.add_argument("id")
    done.add_argument("status", choices=("unavailable", "blocked", "skipped"))
    done.add_argument("--note", default="")
    args = parser.parse_args()
    if args.command == "finish":
        finish(args.id, args.status, args.note)
        print(json.dumps({"id": args.id, "status": args.status}))
        return
    with locked_queue() as data:
        if args.command == "refresh":
            print(json.dumps({"count": refresh(data), "source": SOURCE}))
        elif args.command == "claim":
            print(json.dumps({"candidate": claim(data)}))
        elif args.command == "index":
            print(json.dumps({"providers": index_entries(data)}, ensure_ascii=False, indent=2))
        elif args.command == "lookup":
            host = site_host(args.site)
            matches = [row for row in index_entries(data) if host in {site_host(origin) for origin in row.get("origins", [row.get("url", "")])}]
            print(json.dumps({"host": host, "matches": matches}, ensure_ascii=False, indent=2))
        elif args.command == "sync-index":
            skipped = sync_index(data)
            if skipped:
                save(data)
            print(json.dumps({"skipped": skipped, "total": len(data["items"])}))
        else:
            counts = {}
            for item in data["items"]:
                counts[item["status"]] = counts.get(item["status"], 0) + 1
            print(json.dumps({"source": SOURCE, "fetched_at": data.get("fetched_at"), "counts": counts, "total": len(data["items"])}))


if __name__ == "__main__":
    main()
