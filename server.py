#!/usr/bin/env python3
"""Thuishaven: een persoonlijke startpagina voor je eigen server.

Draait op alleen de Python-standaardbibliotheek (3.8+), dus er valt niets te
installeren. Alle gegevens staan in één JSON-bestand in de datamap.

    python3 server.py            # http://localhost:8080
    PORT=9000 python3 server.py  # andere poort
"""
import hashlib
import json
import mimetypes
import os
import re
import shutil
import socket
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
DATA = Path(os.environ.get("DASHBOARD_DATA", str(ROOT / "data"))).resolve()
VENDOR_DIR = DATA / "vendor"
ICON_DIR = DATA / "icons"
STATE_FILE = DATA / "state.json"
PVE_FILE = DATA / "proxmox.json"
PORT = int(os.environ.get("PORT", "8080"))
HOST = os.environ.get("HOST", "0.0.0.0")
USER_AGENT = "home-dashboard/1.0 (self-hosted start page)"
MAX_BODY = 2 * 1024 * 1024

# Bibliotheken, kaartdata en lettertypes worden één keer opgehaald en daarna
# vanaf de eigen server geserveerd. Alleen deze vaste lijst is toegestaan.
CDN = "https://cdn.jsdelivr.net/npm/"
VENDOR = {
    "d3.min.js": CDN + "d3@7.9.0/dist/d3.min.js",
    "topojson-client.min.js": CDN + "topojson-client@3.1.0/dist/topojson-client.min.js",
    "maplibre-gl.js": CDN + "maplibre-gl@5.20.0/dist/maplibre-gl.js",
    "maplibre-gl.css": CDN + "maplibre-gl@5.20.0/dist/maplibre-gl.css",
    "countries-110m.json": CDN + "world-atlas@2.0.2/countries-110m.json",
    "countries-50m.json": CDN + "world-atlas@2.0.2/countries-50m.json",
    "bricolage.woff2": CDN + "@fontsource-variable/bricolage-grotesque@5.2.5/files/bricolage-grotesque-latin-wght-normal.woff2",
    "instrument.woff2": CDN + "@fontsource-variable/instrument-sans@5.2.5/files/instrument-sans-latin-wght-normal.woff2",
}

DEFAULT_STATE = {
    "settings": {
        "name": "",
        "home": {"name": "Amsterdam", "country": "Nederland", "lat": 52.374, "lon": 4.89},
        "engine": "duckduckgo",
        "sky": "auto",
        "landscape": "meer",
        "feeds": [
            "https://feeds.nos.nl/nosnieuwsalgemeen",
            "https://tweakers.net/feeds/mixed.xml",
        ],
        "globe": {"rotate": True, "iss": True, "mode": "day", "labels": True},
    },
    "places": [],
    "links": [
        {"group": "Dagelijks", "items": [
            {"name": "Gmail", "url": "https://mail.google.com"},
            {"name": "Agenda", "url": "https://calendar.google.com"},
            {"name": "GitHub", "url": "https://github.com"},
            {"name": "YouTube", "url": "https://www.youtube.com"},
        ]},
        {"group": "Thuis", "items": [
            {"name": "Router", "url": "http://192.168.1.1", "check": True},
        ]},
        {"group": "Lezen", "items": [
            {"name": "Tweakers", "url": "https://tweakers.net"},
            {"name": "NOS", "url": "https://nos.nl"},
            {"name": "Reddit", "url": "https://www.reddit.com"},
        ]},
    ],
    "todos": [],
    "notes": "",
    "ride": {"from": None, "to": None, "normal": 0, "busy": 80},
}

_state_lock = threading.Lock()
_cache = {}
_cache_lock = threading.Lock()
_vendor_lock = threading.Lock()
_insecure = ssl.create_default_context()
_insecure.check_hostname = False
_insecure.verify_mode = ssl.CERT_NONE


# ---------------------------------------------------------------- opslag

def _deep_copy(value):
    return json.loads(json.dumps(value))


def load_state():
    saved = {}
    if STATE_FILE.exists():
        try:
            saved = json.loads(STATE_FILE.read_text("utf-8"))
            if not isinstance(saved, dict):
                raise ValueError("state is geen object")
        except (OSError, ValueError) as exc:
            # Nooit stilletjes over een kapot bestand heen schrijven.
            backup = STATE_FILE.with_name("state.kapot-%d.json" % int(time.time()))
            try:
                STATE_FILE.replace(backup)
                print("state.json onleesbaar (%s); bewaard als %s" % (exc, backup.name), file=sys.stderr)
            except OSError:
                pass
            saved = {}
    state = _deep_copy(DEFAULT_STATE)
    for key, default in DEFAULT_STATE.items():
        if key not in saved or type(saved[key]) is not type(default):
            continue
        if key == "settings":
            for skey, sval in saved[key].items():
                if isinstance(sval, dict) and isinstance(state[key].get(skey), dict):
                    state[key][skey].update(sval)
                else:
                    state[key][skey] = sval
        else:
            state[key] = saved[key]
    return state


def write_state(state):
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1), "utf-8")
    os.replace(str(tmp), str(STATE_FILE))


# ------------------------------------------------------------ hulpfuncties

def cached(key, ttl, producer):
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and hit[0] > now:
            return hit[1]
    value = producer()
    with _cache_lock:
        _cache[key] = (now + ttl, value)
    return value


def is_web_url(url):
    try:
        parts = urllib.parse.urlparse(url)
    except ValueError:
        return False
    return parts.scheme in ("http", "https") and bool(parts.netloc)


def http_get(url, timeout=8, verify=True, limit=8 * 1024 * 1024, headers=None):
    if not is_web_url(url):
        raise ValueError("alleen http(s)-adressen zijn toegestaan")
    send = {"User-Agent": USER_AGENT, "Accept": "*/*"}
    send.update(headers or {})
    req = urllib.request.Request(url, headers=send)
    ctx = None if verify else _insecure
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as res:
        return res.read(limit)


# ----------------------------------------------------------------- nieuws

def _local(tag):
    return tag.rsplit("}", 1)[-1].lower() if isinstance(tag, str) else ""


def _parse_date(text):
    if not text:
        return None
    text = text.strip()
    try:
        return parsedate_to_datetime(text).timestamp()
    except (TypeError, ValueError, IndexError):
        pass
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except ValueError:
        return None


def parse_feed(raw, url):
    root = ET.fromstring(raw)
    source = urllib.parse.urlparse(url).netloc.replace("www.", "").replace("feeds.", "")
    for el in root.iter():
        if _local(el.tag) in ("channel", "feed"):
            for child in el:
                if _local(child.tag) == "title" and (child.text or "").strip():
                    source = child.text.strip()
                    break
            break
    items = []
    for el in root.iter():
        if _local(el.tag) not in ("item", "entry"):
            continue
        title, link, when = "", "", None
        for child in el:
            name = _local(child.tag)
            if name == "title":
                title = "".join(child.itertext()).strip()
            elif name == "link":
                href = child.get("href")
                if href:
                    if child.get("rel", "alternate") == "alternate" or not link:
                        link = href.strip()
                elif (child.text or "").strip():
                    link = child.text.strip()
            elif name in ("pubdate", "published", "updated", "date"):
                when = when or _parse_date(child.text)
        if title and is_web_url(link):
            items.append({"title": title[:300], "link": link, "source": source[:60], "time": when})
    return items[:30]


def news():
    feeds = [u for u in load_state()["settings"].get("feeds", []) if isinstance(u, str)][:8]

    def one(url):
        try:
            return {"url": url, "items": parse_feed(http_get(url, timeout=6), url)}
        except Exception as exc:  # een kapotte feed mag de rest niet blokkeren
            return {"url": url, "items": [], "error": str(exc)[:200]}

    def produce():
        if not feeds:
            return {"items": [], "errors": []}
        with ThreadPoolExecutor(max_workers=len(feeds)) as pool:
            results = list(pool.map(one, feeds))
        # Om en om per bron, zodat één drukke feed de lijst niet overneemt.
        per_feed = [sorted(r["items"], key=lambda i: i["time"] or 0, reverse=True)[:8] for r in results]
        merged = []
        for rank in range(8):
            for group in per_feed:
                if rank < len(group):
                    merged.append(group[rank])
        errors = [{"url": r["url"], "error": r["error"]} for r in results if r.get("error")]
        return {"items": merged[:24], "errors": errors}

    return cached("news:" + "|".join(feeds), 600, produce)


# ------------------------------------------------------------------ regen

def _rain_point(point):
    """Buienradar: regen per vijf minuten voor de komende twee uur, als [["HH:MM", mm per uur], ...]."""
    def produce():
        raw = http_get("https://gpsgadget.buienradar.nl/data/raintext?lat=%s&lon=%s" % point, timeout=6)
        rows = []
        for line in raw.decode("ascii", "replace").splitlines():
            value, _, when = line.strip().partition("|")
            if value.isdigit() and len(when) == 5:
                level = int(value)
                rows.append([when, round(10 ** ((level - 109) / 32.0), 2) if level > 0 else 0])
        return rows

    try:
        return cached("rain:%s,%s" % point, 240, produce)
    except Exception:
        return []


def rain_along(text):
    points = []
    for part in text.split(";")[:45]:
        lat, _, lon = part.partition(",")
        lat, lon = float(lat), float(lon)
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise ValueError("buiten bereik")
        points.append(("%.2f" % lat, "%.2f" % lon))
    if not points:
        return []
    with ThreadPoolExecutor(max_workers=8) as pool:
        return list(pool.map(_rain_point, points))


# --------------------------------------------------------------- proxmox

# De API-tokens staan in een eigen bestand en gaan nooit naar de browser of in een backup.
_pve_lock = threading.Lock()


def load_proxmox():
    try:
        data = json.loads(PVE_FILE.read_text("utf-8"))
        return [x for x in data if isinstance(x, dict)] if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def proxmox_public():
    return [{"id": x.get("id", ""), "name": x.get("name", ""), "url": x.get("url", ""),
             "tokenId": x.get("tokenId", ""), "hasSecret": bool(x.get("secret"))} for x in load_proxmox()]


def save_proxmox(items):
    """Slaat de lijst op. Een leeg geheim betekent: het bestaande geheim behouden."""
    with _pve_lock:
        old = {x.get("id"): x for x in load_proxmox()}
        clean = []
        for item in items[:12]:
            if not isinstance(item, dict):
                continue
            url = str(item.get("url", "")).strip().rstrip("/")
            if not is_web_url(url):
                continue
            ident = str(item.get("id", ""))[:40] or hashlib.sha1(url.encode("utf-8")).hexdigest()[:12]
            secret = str(item.get("secret", "")).strip() or old.get(ident, {}).get("secret", "")
            clean.append({"id": ident, "name": str(item.get("name", "")).strip()[:60], "url": url,
                          "tokenId": str(item.get("tokenId", "")).strip()[:120], "secret": secret[:200]})
        DATA.mkdir(parents=True, exist_ok=True)
        tmp = PVE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(clean, indent=1), "utf-8")
        try:
            os.chmod(str(tmp), 0o600)
        except OSError:
            pass
        os.replace(str(tmp), str(PVE_FILE))
    with _cache_lock:
        _cache.pop("proxmox", None)


def _proxmox_one(server):
    result = {"id": server.get("id"), "name": server.get("name") or server.get("url"), "nodes": [], "error": ""}
    if not server.get("tokenId") or not server.get("secret"):
        result["error"] = "Nog geen API-token ingevuld."
        return result
    auth = {"Authorization": "PVEAPIToken=%s=%s" % (server["tokenId"], server["secret"])}
    try:
        raw = http_get(server["url"] + "/api2/json/cluster/resources", timeout=6, verify=False, headers=auth)
        rows = json.loads(raw.decode("utf-8")).get("data") or []
    except urllib.error.HTTPError as exc:
        result["error"] = ("Proxmox weigert het token. Klopt het token-ID en het geheim, en heeft het de rol PVEAuditor?"
                           if exc.code in (401, 403) else "Proxmox gaf foutcode %d." % exc.code)
        return result
    except Exception:
        result["error"] = "Niet bereikbaar. Klopt het adres (meestal https://ip-adres:8006)?"
        return result
    nodes = {}
    for row in rows:
        if row.get("type") == "node":
            nodes[row.get("node")] = {
                "node": row.get("node"), "online": row.get("status") == "online",
                "cpu": row.get("cpu"), "cores": row.get("maxcpu"),
                "mem": row.get("mem"), "maxmem": row.get("maxmem"),
                "disk": row.get("disk"), "maxdisk": row.get("maxdisk"),
                "uptime": row.get("uptime"), "vm": [0, 0], "lxc": [0, 0], "guests": [],
            }
    for row in rows:
        kind = {"qemu": "vm", "lxc": "lxc"}.get(row.get("type"))
        node = nodes.get(row.get("node"))
        if not kind or not node or row.get("template"):
            continue
        running = row.get("status") == "running"
        node[kind][1] += 1
        node[kind][0] += 1 if running else 0
        node["guests"].append({
            "name": str(row.get("name") or row.get("vmid")), "kind": kind, "running": running,
            "cpu": row.get("cpu") if running else None,
            "mem": row.get("mem") if running else None, "maxmem": row.get("maxmem"),
        })
    for node in nodes.values():
        node["guests"].sort(key=lambda g: (not g["running"], g["name"].lower()))
        node["guests"] = node["guests"][:40]
    result["nodes"] = sorted(nodes.values(), key=lambda n: str(n["node"]))
    if not result["nodes"]:
        result["error"] = "Het token mag niets zien. Geef het de rol PVEAuditor op pad /."
    return result


def proxmox_stats():
    servers = load_proxmox()

    def produce():
        if not servers:
            return []
        with ThreadPoolExecutor(max_workers=len(servers)) as pool:
            return list(pool.map(_proxmox_one, servers))

    return cached("proxmox", 8, produce)


# ---------------------------------------------------------------- iconen

def image_type(body):
    head = body[:16]
    if head.startswith(b"\x89PNG"):
        return "image/png"
    if head.startswith(b"\x00\x00\x01\x00"):
        return "image/x-icon"
    if head.startswith(b"\xff\xd8"):
        return "image/jpeg"
    if head.startswith(b"GIF8"):
        return "image/gif"
    if head.startswith(b"RIFF") and body[8:12] == b"WEBP":
        return "image/webp"
    if b"<svg" in body[:2000].lower():
        return "image/svg+xml"
    return None


_LINK_TAG = re.compile(rb"<link\b[^>]*>", re.I)
_ATTR = re.compile(rb"""([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')""")


def _find_icon_url(origin):
    """Zoekt in de startpagina naar het mooiste icoon; valt terug op /favicon.ico."""
    best, best_score = origin + "/favicon.ico", 0
    try:
        html = http_get(origin + "/", timeout=4, verify=False, limit=300000)
    except Exception:
        return best
    for tag in _LINK_TAG.findall(html):
        attrs = {m.group(1).lower(): (m.group(2) or m.group(3) or b"") for m in _ATTR.finditer(tag)}
        rel, href = attrs.get(b"rel", b"").lower(), attrs.get(b"href", b"")
        if b"icon" not in rel or not href or href.startswith(b"data:"):
            continue
        score = 3 if b"apple-touch-icon" in rel else 2 if b".svg" in href.lower() else 1
        if score > best_score:
            try:
                candidate = urllib.parse.urljoin(origin + "/", href.decode("utf-8", "replace").strip())
            except ValueError:
                continue
            if is_web_url(candidate):
                best, best_score = candidate, score
    return best


def site_icon(url):
    """Geeft (bytes, type) van het icoon van een site, of (b"", None). Wordt op schijf onthouden."""
    parts = urllib.parse.urlparse(url)
    origin = "%s://%s" % (parts.scheme, parts.netloc)
    target = ICON_DIR / hashlib.sha1(origin.encode("utf-8")).hexdigest()[:24]
    if target.is_file():
        body = target.read_bytes()
        if body or time.time() - target.stat().st_mtime < 86400:  # "geen icoon" een dag onthouden
            return body, image_type(body)
    body = b""
    for candidate in (_find_icon_url(origin), origin + "/favicon.ico"):
        try:
            found = http_get(candidate, timeout=4, verify=False, limit=600000)
        except Exception:
            continue
        if image_type(found):
            body = found
            break
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    target.write_bytes(body)
    return body, image_type(body)


def linked_urls(only_checked=False):
    urls = []
    for group in load_state()["links"]:
        for item in group.get("items", []) if isinstance(group, dict) else []:
            if isinstance(item, dict) and is_web_url(item.get("url", "")) and (item.get("check") or not only_checked):
                urls.append(item["url"])
    return urls


# ---------------------------------------------------------- statuscontrole

def check_url(url):
    started = time.monotonic()
    code = None
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=4, context=_insecure) as res:
            code = res.status
        up = True
    except urllib.error.HTTPError as exc:
        code = exc.code
        up = exc.code < 500  # 401/403 betekent: de dienst leeft, je bent alleen niet ingelogd
    except Exception:
        up = False
    return {"up": up, "code": code, "ms": int((time.monotonic() - started) * 1000)}


def link_status():
    urls = sorted(set(linked_urls(only_checked=True)))[:40]

    def produce():
        if not urls:
            return {}
        with ThreadPoolExecutor(max_workers=min(10, len(urls))) as pool:
            return dict(zip(urls, pool.map(check_url, urls)))

    return cached("status:" + "|".join(urls), 20, produce)


# ------------------------------------------------------------ serverstatus

_cpu_prev = None


def _read_cpu():
    with open("/proc/stat") as fh:
        parts = [int(x) for x in fh.readline().split()[1:]]
    idle = parts[3] + (parts[4] if len(parts) > 4 else 0)
    return sum(parts), idle


def system_stats():
    global _cpu_prev
    stats = {"hostname": socket.gethostname(), "cpu": None, "mem": None, "disk": None,
             "load": None, "uptime": None, "temp": None, "cores": os.cpu_count()}
    try:
        usage = shutil.disk_usage(str(ROOT))
        stats["disk"] = {"used": usage.used, "total": usage.total}
    except OSError:
        pass
    if not sys.platform.startswith("linux"):
        return stats
    try:
        now = _read_cpu()
        prev = _cpu_prev
        if prev is None:
            time.sleep(0.25)
            prev, now = now, _read_cpu()
        _cpu_prev = now
        total, idle = now[0] - prev[0], now[1] - prev[1]
        if total > 0:
            stats["cpu"] = round(100 * (1 - idle / total), 1)
    except (OSError, ValueError, IndexError):
        pass
    try:
        info = {}
        with open("/proc/meminfo") as fh:
            for line in fh:
                key, _, rest = line.partition(":")
                info[key] = int(rest.split()[0]) * 1024
        stats["mem"] = {"used": info["MemTotal"] - info["MemAvailable"], "total": info["MemTotal"]}
    except (OSError, ValueError, KeyError, IndexError):
        pass
    try:
        stats["load"] = [round(x, 2) for x in os.getloadavg()]
    except OSError:
        pass
    try:
        with open("/proc/uptime") as fh:
            stats["uptime"] = int(float(fh.read().split()[0]))
    except (OSError, ValueError, IndexError):
        pass
    temps = []
    for zone in Path("/sys/class/thermal").glob("thermal_zone*/temp"):
        try:
            value = int(zone.read_text().strip()) / 1000
            if 0 < value < 150:
                temps.append(value)
        except (OSError, ValueError):
            pass
    if temps:
        stats["temp"] = round(max(temps), 1)
    return stats


# ------------------------------------------------------------- webserver

TYPES = {
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8", ".json": "application/json",
    ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "Thuishaven/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if args and str(args[1] if len(args) > 1 else "").startswith(("4", "5")):
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    # -- antwoorden
    def send_bytes(self, body, ctype, status=200, cache="no-cache", extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        if status >= 400:
            # De aanvraag is mogelijk niet helemaal gelezen; verbinding niet hergebruiken.
            self.close_connection = True
            self.send_header("Connection", "close")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, value, status=200, extra=None):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_bytes(body, "application/json; charset=utf-8", status, "no-store", extra)

    def fail(self, status, message):
        self.send_json({"error": message}, status)

    # -- routes
    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(url.path)
        query = urllib.parse.parse_qs(url.query)
        try:
            if path == "/api/state":
                extra = None
                if "download" in query:
                    name = "thuishaven-%s.json" % time.strftime("%Y-%m-%d")
                    extra = {"Content-Disposition": 'attachment; filename="%s"' % name}
                with _state_lock:
                    state = load_state()
                return self.send_json(state, extra=extra)
            if path == "/api/system":
                return self.send_json(system_stats())
            if path == "/api/status":
                return self.send_json(link_status())
            if path == "/api/icon":
                target = query.get("u", [""])[0]
                # Alleen voor je eigen snelkoppelingen, zodat dit geen open doorgeefluik wordt.
                if target not in linked_urls():
                    return self.fail(404, "onbekende koppeling")
                body, ctype = site_icon(target)
                if not body:
                    # Leeg antwoord: de pagina toont dan zelf een letter als icoon.
                    return self.send_bytes(b"", "text/plain", 204, cache="public, max-age=3600")
                return self.send_bytes(body, ctype, cache="public, max-age=604800", extra={
                    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox"})
            if path == "/api/news":
                return self.send_json(news())
            if path == "/api/rain":
                try:
                    return self.send_json(rain_along(query.get("pts", [""])[0]))
                except ValueError:
                    return self.fail(400, "ongeldige punten")
            if path == "/api/proxmox":
                return self.send_json(proxmox_public())
            if path == "/api/proxmox/stats":
                return self.send_json(proxmox_stats())
            if path.startswith("/api/"):
                return self.fail(404, "onbekend")
            if path.startswith("/vendor/"):
                return self.serve_vendor(path[len("/vendor/"):])
            return self.serve_static(path)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            sys.stderr.write("fout bij %s: %r\n" % (self.path, exc))
            try:
                self.fail(500, "interne fout")
            except OSError:
                pass

    do_HEAD = do_GET

    def do_PUT(self):
        path = urllib.parse.urlparse(self.path).path
        # JSON verplicht: zo kan een willekeurige website niet stiekem naar het dashboard schrijven.
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            return self.fail(415, "Content-Type moet application/json zijn")
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self.fail(400, "ongeldige lengte")
        if length <= 0 or length > MAX_BODY:
            return self.fail(413, "te groot of leeg")
        try:
            value = json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError:
            return self.fail(400, "ongeldige JSON")
        if path == "/api/proxmox":
            if not isinstance(value, list):
                return self.fail(400, "verwacht een lijst")
            try:
                save_proxmox(value)
            except OSError as exc:
                sys.stderr.write("opslaan mislukt: %r\n" % exc)
                return self.fail(500, "opslaan mislukt")
            return self.send_json(proxmox_public())
        try:
            with _state_lock:
                state = load_state()
                if path == "/api/state":
                    if not isinstance(value, dict):
                        return self.fail(400, "verwacht een object")
                    for key, default in DEFAULT_STATE.items():
                        if key in value and type(value[key]) is type(default):
                            state[key] = value[key]
                elif path.startswith("/api/state/"):
                    key = path[len("/api/state/"):]
                    if key not in DEFAULT_STATE:
                        return self.fail(404, "onbekende sleutel")
                    if type(value) is not type(DEFAULT_STATE[key]):
                        return self.fail(400, "verkeerd type")
                    state[key] = value
                else:
                    return self.fail(404, "onbekend")
                write_state(state)
            self.send_json({"ok": True})
        except OSError as exc:
            sys.stderr.write("opslaan mislukt: %r\n" % exc)
            self.fail(500, "opslaan mislukt")

    def serve_static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        target = (PUBLIC / path.lstrip("/")).resolve()
        if PUBLIC not in target.parents or not target.is_file():
            return self.fail(404, "niet gevonden")
        ctype = TYPES.get(target.suffix.lower()) or mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.send_bytes(target.read_bytes(), ctype)

    def serve_vendor(self, name):
        if name not in VENDOR:
            return self.fail(404, "niet gevonden")
        target = VENDOR_DIR / name
        if not target.is_file():
            with _vendor_lock:
                if not target.is_file():
                    try:
                        body = http_get(VENDOR[name], timeout=20)
                    except Exception as exc:
                        sys.stderr.write("ophalen van %s mislukt: %r\n" % (name, exc))
                        return self.fail(502, "kon %s niet ophalen; heeft de server internet?" % name)
                    VENDOR_DIR.mkdir(parents=True, exist_ok=True)
                    tmp = target.with_suffix(target.suffix + ".tmp")
                    tmp.write_bytes(body)
                    os.replace(str(tmp), str(target))
        ctype = TYPES.get(target.suffix.lower(), "application/octet-stream")
        self.send_bytes(target.read_bytes(), ctype, cache="public, max-age=2592000")


def main():
    DATA.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    print("Thuishaven draait op http://%s:%d  (gegevens in %s)" % (
        "localhost" if HOST in ("0.0.0.0", "") else HOST, PORT, DATA), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
