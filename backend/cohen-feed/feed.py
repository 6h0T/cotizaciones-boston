"""
feed.py — Puente de market data Cohen (Primary/XOMS) → cotizaciones-boston.

SOLO LECTURA: este proceso jamás envía órdenes. Se suscribe por WebSocket al
libro de CEDEARs (plazos CI y 24hs, patas ARS + D + C) y expone snapshots HTTP
con el MISMO formato CedearRow que devuelve /api/iol/cedears, para que el
frontend lo consuma sin cambios de modelo:

    GET http://127.0.0.1:8125/cedears?plazo=t0   → libro CI      (CedearRow[])
    GET http://127.0.0.1:8125/cedears?plazo=t1   → libro 24hs    (CedearRow[])
    GET http://127.0.0.1:8125/health             → estado de la conexión

Uso:
    python feed.py               # conecta a Cohen con credenciales de .env
    python feed.py --simulate    # sin credenciales: libros falsos para probar
                                 # el contrato HTTP y la integración frontend

Credenciales en .env (ver .env.example). Son las de MATRIZ (no Cohen Connect)
y requieren que Cohen habilite el acceso API en la cuenta. Para activar el
feed en la app: localStorage.setItem('cohenFeedUrl', 'http://127.0.0.1:8125')
y recargar; localStorage.removeItem('cohenFeedUrl') vuelve a IOL.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
CEDEARS_META_TS = HERE.parent.parent / "src" / "app" / "cedears-meta.ts"

DEFAULT_API_URL = "https://api.cohen.xoms.com.ar/"
DEFAULT_WS_URL = "wss://api.cohen.xoms.com.ar/"
DEFAULT_PORT = 8125

# Plazo Primary → plazo de la app (mismo contrato que /api/iol/cedears).
PLAZOS = {"CI": "t0", "24hs": "t1"}
SUBSCRIPTION_CHUNK = 250  # tickers por mensaje de suscripción

# Si no se puede leer cedears-meta.ts se usa este subset líquido.
FALLBACK_BASES = [
    "AAPL", "AMD", "AMZN", "BABA", "BRKB", "GGAL", "GOLD", "KO", "MELI",
    "META", "MSFT", "NVDA", "PBR", "SPY", "TSLA", "VIST", "XOM", "YPFD",
]


def load_env(path: Path) -> dict[str, str]:
    """Parser mínimo de .env (KEY=VALUE, # comentarios). Sin dependencias."""
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip().strip("'\"")
    return env


def load_bases() -> list[str]:
    """Tickers base desde cedears-meta.ts (única fuente de verdad del universo)."""
    try:
        text = CEDEARS_META_TS.read_text(encoding="utf-8")
        bases = re.findall(r"^\s{2}([A-Z][A-Z0-9]*):\s*\{", text, re.MULTILINE)
        if bases:
            return sorted(set(bases))
    except OSError:
        pass
    print(f"[feed] aviso: no pude leer {CEDEARS_META_TS}, uso subset líquido")
    return FALLBACK_BASES


def build_tickers(bases: list[str]) -> list[str]:
    """Ticker Primary por pata (ARS, D=MEP, C=CCL) y plazo (CI, 24hs)."""
    tickers = []
    for base in bases:
        for leg in (base, base + "D", base + "C"):
            for plazo in PLAZOS:
                tickers.append(f"MERV - XMEV - {leg} - {plazo}")
    return tickers


# ── Estado compartido ────────────────────────────────────────────────────────

class Books:
    """Snapshots por plazo, protegidos por lock (escribe el WS, lee el HTTP)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._rows: dict[str, dict[str, dict]] = {"t0": {}, "t1": {}}
        self.messages = 0
        self.last_message_ts: float | None = None
        self.connected = False
        self.mode = "live"

    def update(self, plazo: str, symbol: str, row: dict) -> None:
        with self._lock:
            self._rows[plazo][symbol] = row
            self.messages += 1
            self.last_message_ts = time.time()

    def snapshot(self, plazo: str) -> list[dict]:
        with self._lock:
            return list(self._rows.get(plazo, {}).values())

    def health(self) -> dict:
        with self._lock:
            return {
                "mode": self.mode,
                "connected": self.connected,
                "messages": self.messages,
                "lastMessageAgoSec": (
                    round(time.time() - self.last_message_ts, 1)
                    if self.last_message_ts else None
                ),
                "symbols": {p: len(rows) for p, rows in self._rows.items()},
            }


BOOKS = Books()


# ── Mapeo Primary → CedearRow ────────────────────────────────────────────────

def _price(entry) -> float:
    """Extrae price de las formas que devuelve Primary: dict, lista o número."""
    if entry is None:
        return 0.0
    if isinstance(entry, list):
        return _price(entry[0]) if entry else 0.0
    if isinstance(entry, dict):
        return float(entry.get("price") or 0.0)
    if isinstance(entry, (int, float)):
        return float(entry)
    return 0.0


def _size(entry) -> float:
    if isinstance(entry, list):
        return _size(entry[0]) if entry else 0.0
    if isinstance(entry, dict):
        return float(entry.get("size") or 0.0)
    return 0.0


def md_to_row(symbol: str, md: dict) -> dict:
    """Convierte un mensaje Md de Primary al CedearRow que espera la app."""
    last = _price(md.get("LA"))
    close = _price(md.get("CL"))
    pct = ((last / close) - 1.0) * 100.0 if last > 0 and close > 0 else 0.0
    return {
        "symbol": symbol,
        "q_bid": _size(md.get("BI")),
        "px_bid": _price(md.get("BI")),
        "px_ask": _price(md.get("OF")),
        "q_ask": _size(md.get("OF")),
        "v": float(md.get("EV") or 0.0),      # volumen efectivo
        "q_op": float(md.get("TC") or 0.0),   # cantidad de operaciones
        "c": last,
        "pct_change": pct,
    }


TICKER_RE = re.compile(r"^MERV - XMEV - (?P<leg>[A-Z0-9]+) - (?P<plazo>CI|24hs)$")


def on_market_data(message: dict) -> None:
    ticker = (message.get("instrumentId") or {}).get("symbol", "")
    m = TICKER_RE.match(ticker)
    if not m:
        return
    plazo = PLAZOS[m.group("plazo")]
    BOOKS.update(plazo, m.group("leg"), md_to_row(m.group("leg"), message.get("marketData") or {}))


# ── Conexión pyRofex (solo market data; nunca se importan funciones de órdenes)

def start_live(env: dict[str, str]) -> None:
    import pyRofex
    from pyRofex.components.enums import Environment, MarketDataEntry

    user = env.get("COHEN_USER", "")
    password = env.get("COHEN_PASSWORD", "")
    if not user or not password:
        sys.exit("[feed] faltan COHEN_USER / COHEN_PASSWORD en .env")

    api_url = env.get("COHEN_API_URL", DEFAULT_API_URL)
    ws_url = env.get("COHEN_WS_URL", DEFAULT_WS_URL)
    pyRofex._set_environment_parameter("url", api_url, Environment.LIVE)
    pyRofex._set_environment_parameter("ws", ws_url, Environment.LIVE)

    try:
        # account: sólo requerido por la firma; no se rutean órdenes jamás.
        pyRofex.initialize(
            user=user,
            password=password,
            account=env.get("COHEN_ACCOUNT", "N/A"),
            environment=Environment.LIVE,
        )
    except Exception as exc:  # ApiException con mensaje claro de Primary
        sys.exit(
            f"[feed] autenticación rechazada por {api_url}: {exc}\n"
            "  → verificá que sean las credenciales de MATRIZ (no Cohen Connect)\n"
            "  → y que Cohen haya habilitado el acceso API en la cuenta"
        )

    tickers = build_tickers(load_bases())
    entries = [
        MarketDataEntry.BIDS, MarketDataEntry.OFFERS, MarketDataEntry.LAST,
        MarketDataEntry.CLOSING_PRICE, MarketDataEntry.TRADE_EFFECTIVE_VOLUME,
        MarketDataEntry.TRADE_COUNT,
    ]

    def on_error(message):
        print(f"[feed] ws error: {message}")

    def on_exception(exc):
        print(f"[feed] ws excepción: {exc}")
        BOOKS.connected = False

    def connect() -> None:
        pyRofex.init_websocket_connection(
            market_data_handler=on_market_data,
            error_handler=on_error,
            exception_handler=on_exception,
        )
        for i in range(0, len(tickers), SUBSCRIPTION_CHUNK):
            pyRofex.market_data_subscription(
                tickers=tickers[i : i + SUBSCRIPTION_CHUNK], entries=entries, depth=1
            )
        BOOKS.connected = True
        print(f"[feed] conectado a {ws_url} — {len(tickers)} instrumentos suscriptos")

    connect()

    # Watchdog: si se cae el WS o deja de llegar data en horario, reconecta.
    def watchdog() -> None:
        backoff = 5
        while True:
            time.sleep(5)
            if BOOKS.connected:
                backoff = 5
                continue
            print(f"[feed] reconectando en {backoff}s…")
            time.sleep(backoff)
            try:
                try:
                    pyRofex.close_websocket_connection()
                except Exception:
                    pass
                connect()
            except Exception as exc:
                print(f"[feed] reconexión falló: {exc}")
                backoff = min(backoff * 2, 120)

    threading.Thread(target=watchdog, daemon=True, name="watchdog").start()


# ── Modo simulación (sin credenciales) ───────────────────────────────────────

SIM_BASES = {"AAPL": 24000, "GGAL": 8300, "NVDA": 41000, "SPY": 52000, "TSLA": 21000}
SIM_FX = 1480.0  # ARS/USD de referencia para las patas D/C


def start_simulate() -> None:
    BOOKS.mode = "simulate"
    BOOKS.connected = True

    def tick() -> None:
        while True:
            for base, px in SIM_BASES.items():
                for plazo in ("t0", "t1"):
                    drift = 1 + (0.003 if plazo == "t0" else 0.0)
                    for leg, ars in ((base, True), (base + "D", False), (base + "C", False)):
                        mid = px * drift if ars else px * drift / SIM_FX * (1 + random.uniform(-0.002, 0.002))
                        spread = mid * random.uniform(0.001, 0.004)
                        bid, ask = mid - spread / 2, mid + spread / 2
                        BOOKS.update(plazo, leg, {
                            "symbol": leg,
                            "q_bid": float(random.randint(50, 5000)),
                            "px_bid": round(bid, 2),
                            "px_ask": round(ask, 2),
                            "q_ask": float(random.randint(50, 5000)),
                            "v": round(mid * random.randint(1000, 9000), 2),
                            "q_op": float(random.randint(10, 400)),
                            "c": round(mid, 2),
                            "pct_change": round(random.uniform(-2, 2), 2),
                        })
            time.sleep(1)

    threading.Thread(target=tick, daemon=True, name="simulator").start()
    print("[feed] modo SIMULACIÓN — libros falsos, sólo para probar la integración")


# ── Servidor HTTP ────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def _send_json(self, payload, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 (nombre requerido por BaseHTTPRequestHandler)
        url = urlparse(self.path)
        if url.path == "/cedears":
            plazo = (parse_qs(url.query).get("plazo") or ["t1"])[0]
            if plazo not in ("t0", "t1"):
                self._send_json({"error": "plazo debe ser t0 o t1"}, 400)
                return
            self._send_json(BOOKS.snapshot(plazo))
        elif url.path == "/health":
            self._send_json(BOOKS.health())
        else:
            self._send_json({"error": "not found"}, 404)

    def log_message(self, *args) -> None:  # silenciar access log
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--simulate", action="store_true", help="libros falsos, sin credenciales")
    parser.add_argument("--port", type=int, default=None)
    args = parser.parse_args()

    env = load_env(HERE / ".env")
    port = args.port or int(env.get("PORT", DEFAULT_PORT))

    if args.simulate:
        start_simulate()
    else:
        start_live(env)

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"[feed] sirviendo en http://127.0.0.1:{port}  (/cedears?plazo=t0|t1, /health)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[feed] fin")


if __name__ == "__main__":
    main()
