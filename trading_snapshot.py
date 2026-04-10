#!/usr/bin/env python3
"""
Trading Comparison Snapshot — daily snapshot of MQT vs SMI paper trading
Runs once daily (via launchd), appends to snapshots file.
Both portfolios normalized to $1,000 starting value for fair comparison.
"""
import json, urllib.request, time
from datetime import datetime, timezone
from pathlib import Path

HOME           = Path.home()
MQT_STATE      = HOME / "openclaw/shared/mqt_paper_trading_state.json"
MQT_SIGNAL     = HOME / "openclaw/shared/mqt_latest_signal.json"
SMI_STATE      = HOME / "openclaw/shared/smi_paper_trading_state.json"
SNAPSHOTS_FILE = HOME / "openclaw/shared/trading_comparison_snapshots.json"

MQT_START_VALUE = 1000.0   # MQT started with $500 USDT + $500 in MQT → normalized to $1000
SMI_START_VALUE = 1000.0

YAHOO_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{}?interval=1d&range=1d"
HEADERS   = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}


def fetch_price(ticker):
    try:
        req = urllib.request.Request(YAHOO_URL.format(ticker), headers=HEADERS)
        with urllib.request.urlopen(req, timeout=10) as r:
            d = json.loads(r.read())
        return float(d["chart"]["result"][0]["meta"]["regularMarketPrice"])
    except Exception:
        return None


def load_json(path):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return {}


def get_mqt_value():
    """Return current MQT portfolio value, normalized to $1000 base."""
    state  = load_json(MQT_STATE)
    signal = load_json(MQT_SIGNAL)
    price  = signal.get("price", 0)
    usdt   = state.get("usdt_balance", 0)
    qty    = state.get("total_qty", 0)
    raw_value = usdt + qty * price

    # MQT started with $1000 total (500 USDT + 500 in MQT)
    # total_cost tracks how much was spent buying MQT
    total_cost = state.get("total_cost", 500)
    original_total = total_cost + state.get("usdt_balance", 500)  # approximate starting value
    # Normalize: what would $1000 be worth if we scaled proportionally?
    if original_total > 0:
        normalized = (raw_value / original_total) * MQT_START_VALUE
    else:
        normalized = raw_value
    return round(normalized, 2), round(raw_value, 2), price


def get_smi_value():
    """Return current SMI portfolio value with live stock prices."""
    state = load_json(SMI_STATE)
    balance = state.get("balance", 0)
    positions = state.get("positions", {})
    total = balance
    pos_detail = []
    for ticker, pos in positions.items():
        price = fetch_price(ticker)
        time.sleep(0.3)
        if price is None:
            price = pos.get("entry_price", 0)
        val = pos.get("shares", 0) * price
        gain_pct = ((price - pos["entry_price"]) / pos["entry_price"] * 100) if pos.get("entry_price") else 0
        total += val
        pos_detail.append({"ticker": ticker, "price": price, "value": round(val, 2), "gain_pct": round(gain_pct, 2)})
    return round(total, 2), pos_detail


def run():
    now = datetime.now(timezone.utc)
    today = now.strftime("%Y-%m-%d")
    print(f"[Trading Snapshot] {today}")

    # Load existing snapshots
    try:
        snapshots = json.loads(SNAPSHOTS_FILE.read_text())
    except Exception:
        snapshots = []

    # Skip if already snapshotted today
    if snapshots and snapshots[-1].get("date") == today:
        print(f"  Already snapshotted today ({today}), skipping.")
        return

    # Get values
    mqt_norm, mqt_raw, mqt_price = get_mqt_value()
    smi_total, smi_positions      = get_smi_value()

    mqt_pnl_pct = round(((mqt_norm - MQT_START_VALUE) / MQT_START_VALUE) * 100, 2)
    smi_pnl_pct = round(((smi_total - SMI_START_VALUE) / SMI_START_VALUE) * 100, 2)

    # Day numbers
    smi_state   = load_json(SMI_STATE)
    smi_start   = smi_state.get("start_date", now.isoformat())
    smi_start_dt = datetime.fromisoformat(smi_start)
    smi_day     = max(0, (now - smi_start_dt).days)

    # MQT day
    mqt_state    = load_json(MQT_STATE)
    mqt_created  = mqt_state.get("created", now.isoformat())
    mqt_start_dt = datetime.fromisoformat(mqt_created)
    mqt_day      = max(0, (now - mqt_start_dt).days)

    snapshot = {
        "date":          today,
        "timestamp":     now.isoformat(),
        "mqt": {
            "value":     mqt_norm,
            "raw_value": mqt_raw,
            "price":     mqt_price,
            "pnl_pct":   mqt_pnl_pct,
            "day":       mqt_day,
        },
        "smi": {
            "value":     smi_total,
            "pnl_pct":   smi_pnl_pct,
            "day":       smi_day,
            "positions": smi_positions,
        },
        "leader": "MQT" if mqt_pnl_pct > smi_pnl_pct else ("SMI" if smi_pnl_pct > mqt_pnl_pct else "TIE"),
    }
    snapshots.append(snapshot)
    SNAPSHOTS_FILE.write_text(json.dumps(snapshots, indent=2))

    print(f"  MQT Day {mqt_day}: ${mqt_norm:.2f} ({mqt_pnl_pct:+.2f}%) | price ${mqt_price:.4f}")
    print(f"  SMI Day {smi_day}: ${smi_total:.2f} ({smi_pnl_pct:+.2f}%) | {len(smi_positions)} positions")
    print(f"  Leader: {snapshot['leader']}")
    for p in smi_positions:
        print(f"    {p['ticker']}: ${p['price']:.2f} | {p['gain_pct']:+.2f}%")


if __name__ == "__main__":
    run()
