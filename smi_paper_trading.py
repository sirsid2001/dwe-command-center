#!/usr/bin/env python3
"""
SMI Paper Trading — Smart Money Intel stock paper trader
Strategy: follow insider/congressional buy signals from the DWE Intel board
  - BUY: ticker in top_signals with score >= 10, allocate $333 (max 3 positions)
  - SELL: ticker appears in top_sells, OR price drops 8% from entry, OR +20% gain
  - Check prices every 4h via Yahoo Finance (no API key needed)
  - $1,000 starting balance, 30-day experiment
"""
import json, urllib.request, time, os, sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from math import log

HOME          = Path.home()
SIGNALS_FILE  = HOME / "openclaw/shared/intel/latest_signals.json"
STATE_FILE    = HOME / "openclaw/shared/smi_paper_trading_state.json"
LOG_FILE      = HOME / "openclaw/shared/smi_trade_log.json"
MC_DIR        = Path("/Users/elf-6/mission-control-server")

START_BALANCE     = 1000.0
MAX_POSITIONS     = 3
POSITION_SIZE     = START_BALANCE / MAX_POSITIONS   # ~$333
BUY_SCORE_MIN     = 10.0   # minimum signal score to enter
STOP_LOSS_PCT     = -8.0   # exit if -8% from entry
TAKE_PROFIT_PCT   = 20.0   # exit if +20%
SELL_SIGNAL_EXIT  = True   # exit if ticker shows up in top_sells

YAHOO_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{}?interval=1d&range=1d"
HEADERS   = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}


def fetch_price(ticker):
    """Fetch current price from Yahoo Finance."""
    try:
        req = urllib.request.Request(YAHOO_URL.format(ticker), headers=HEADERS)
        with urllib.request.urlopen(req, timeout=10) as r:
            d = json.loads(r.read())
        meta = d["chart"]["result"][0]["meta"]
        return float(meta["regularMarketPrice"])
    except Exception as e:
        print(f"  [WARN] price fetch failed for {ticker}: {e}")
        return None


def load_state():
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return {
            "balance": START_BALANCE,
            "positions": {},      # ticker → {shares, entry_price, entry_date, cost_basis}
            "total_trades": 0,
            "total_pnl": 0.0,
            "trade_count_buys": 0,
            "trade_count_sells": 0,
            "start_date": datetime.now(timezone.utc).isoformat(),
            "end_date": (datetime.now(timezone.utc) + timedelta(days=30)).isoformat(),
            "peak_value": START_BALANCE,
        }


def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2))


def load_log():
    try:
        return json.loads(LOG_FILE.read_text())
    except Exception:
        return []


def save_log(trades):
    LOG_FILE.write_text(json.dumps(trades, indent=2))


def load_signals():
    try:
        return json.loads(SIGNALS_FILE.read_text())
    except Exception:
        print("[ERROR] Could not load signals file")
        return None


def portfolio_value(state, prices):
    total = state["balance"]
    for ticker, pos in state["positions"].items():
        price = prices.get(ticker, pos["entry_price"])
        total += pos["shares"] * price
    return round(total, 2)


def run():
    print(f"[SMI Paper Trading] {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    state   = load_state()
    trades  = load_log()
    signals = load_signals()
    if not signals:
        return

    # Check if 30-day experiment is over
    end_date = datetime.fromisoformat(state.get("end_date", "2099-01-01"))
    if datetime.now(timezone.utc) > end_date:
        print("[SMI] 30-day experiment complete. No new trades.")
        return

    buy_signals  = signals.get("top_signals", [])
    sell_signals = signals.get("top_sells", [])
    sell_tickers = {s["ticker"] for s in sell_signals if s.get("ticker")}

    # Fetch current prices for all held positions + candidate buys
    held_tickers     = list(state["positions"].keys())
    buy_candidates   = [s for s in buy_signals if s.get("ticker") and s["score"] >= BUY_SCORE_MIN]
    candidate_tickers = list({s["ticker"] for s in buy_candidates if s["ticker"]})
    all_tickers      = list(set(held_tickers + candidate_tickers))

    prices = {}
    for t in all_tickers:
        p = fetch_price(t)
        if p:
            prices[t] = p
            print(f"  {t}: ${p:.2f}")
        time.sleep(0.3)

    now_iso = datetime.now(timezone.utc).isoformat()

    # ── SELL CHECK ───────────────────────────────────────────────────
    for ticker in list(state["positions"].keys()):
        pos   = state["positions"][ticker]
        price = prices.get(ticker)
        if not price:
            continue

        entry  = pos["entry_price"]
        shares = pos["shares"]
        gain_pct = ((price - entry) / entry) * 100

        reason = None
        if gain_pct <= STOP_LOSS_PCT:
            reason = f"stop_loss ({gain_pct:.1f}%)"
        elif gain_pct >= TAKE_PROFIT_PCT:
            reason = f"take_profit ({gain_pct:.1f}%)"
        elif SELL_SIGNAL_EXIT and ticker in sell_tickers:
            reason = f"sell_signal (insider exit detected)"

        if reason:
            proceeds = shares * price
            pnl      = proceeds - pos["cost_basis"]
            state["balance"] += proceeds
            state["total_pnl"]         = round(state["total_pnl"] + pnl, 4)
            state["total_trades"]      += 1
            state["trade_count_sells"] += 1
            del state["positions"][ticker]
            trade = {
                "type": "SELL", "ticker": ticker,
                "shares": shares, "price": price,
                "proceeds": round(proceeds, 2), "pnl": round(pnl, 2),
                "gain_pct": round(gain_pct, 2), "reason": reason,
                "timestamp": now_iso
            }
            trades.append(trade)
            print(f"  SELL {ticker}: {shares:.4f} shares @ ${price:.2f} | PnL ${pnl:+.2f} | {reason}")

    # ── BUY CHECK ────────────────────────────────────────────────────
    open_positions = len(state["positions"])
    for sig in buy_candidates:
        ticker = sig["ticker"]
        if not ticker or ticker in state["positions"]:
            continue  # already holding
        if open_positions >= MAX_POSITIONS:
            break
        price = prices.get(ticker)
        if not price:
            continue
        if state["balance"] < POSITION_SIZE * 0.9:
            print(f"  [SKIP] Insufficient balance (${state['balance']:.2f}) for {ticker}")
            continue

        # Don't buy if ticker is also in sell signals
        if ticker in sell_tickers:
            print(f"  [SKIP] {ticker} in sell signals — skipping")
            continue

        alloc  = min(POSITION_SIZE, state["balance"])
        shares = alloc / price
        state["balance"]           -= alloc
        state["total_trades"]      += 1
        state["trade_count_buys"]  += 1
        open_positions             += 1
        state["positions"][ticker] = {
            "shares":       round(shares, 6),
            "entry_price":  price,
            "entry_date":   now_iso,
            "cost_basis":   round(alloc, 2),
            "signal_score": sig["score"],
            "signal_source": sig["source"],
        }
        trade = {
            "type": "BUY", "ticker": ticker,
            "shares": round(shares, 6), "price": price,
            "cost": round(alloc, 2), "signal_score": sig["score"],
            "signal_source": sig["source"],
            "timestamp": now_iso
        }
        trades.append(trade)
        print(f"  BUY  {ticker}: {shares:.4f} shares @ ${price:.2f} | ${alloc:.2f} | score {sig['score']:.2f}")

    # ── UPDATE PEAK ──────────────────────────────────────────────────
    total_val = portfolio_value(state, prices)
    if total_val > state.get("peak_value", START_BALANCE):
        state["peak_value"] = total_val

    state["last_run"]       = now_iso
    state["portfolio_value"] = total_val

    save_state(state)
    save_log(trades)

    # Summary
    pnl_pct = ((total_val - START_BALANCE) / START_BALANCE) * 100
    days_left = max(0, (end_date - datetime.now(timezone.utc)).days)
    print(f"\n  Portfolio: ${total_val:.2f} | PnL: {pnl_pct:+.1f}% | Positions: {len(state['positions'])} | Trades: {state['total_trades']} | Days left: {days_left}")
    for t, p in state["positions"].items():
        price = prices.get(t, p["entry_price"])
        g = ((price - p["entry_price"]) / p["entry_price"]) * 100
        print(f"    {t}: {p['shares']:.4f} shares @ ${p['entry_price']:.2f} | now ${price:.2f} | {g:+.1f}%")


if __name__ == "__main__":
    run()
