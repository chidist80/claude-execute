// Strategy: Funding-rate Adaptive Mean Reversion
//
// Fixes the flaw in funding-mean-revert: a single fixed threshold (0.02%) is
// far too high for BTC (whose funding band is ~0.001%) and probably right for
// SOL only by accident. This variant computes a rolling z-score of funding
// over the trailing N entries and trades when the z-score crosses a fixed
// threshold (which IS comparable across symbols).

import { zScoreSeries } from "./_indicators.js";

const FAPI_BASE = process.env.BINANCE_FAPI_BASE_URL || "https://fapi.binance.com";

export const meta = {
  id: "funding-adaptive",
  name: "Funding-Rate Adaptive Mean Reversion",
  description:
    "Fade funding when its rolling z-score (over 90 prior 8h prints, ~30 days) breaches ±Z_THRESHOLD. Adapts to per-symbol funding noise floor.",
  auxData: ["fundingRate"],
};

const ZSCORE_WINDOW = 90; // ~30 days of 8h funding events
const Z_THRESHOLD = parseFloat(process.env.FUNDING_Z_THRESHOLD || "1.5");
const STOP_PCT = 0.5;

export async function loadAuxData({ symbol, startMs, endMs }) {
  // Pull a bit of history before startMs so the z-score has warmup.
  const warmupMs = ZSCORE_WINDOW * 8 * 60 * 60 * 1000 + 1;
  const out = [];
  let cursor = startMs - warmupMs;
  while (cursor < endMs) {
    const url = `${FAPI_BASE}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${cursor}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fundingRate HTTP ${res.status}`);
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const f of batch) out.push({ time: f.fundingTime, rate: parseFloat(f.fundingRate) });
    const lastTs = batch[batch.length - 1].fundingTime;
    if (lastTs <= cursor) break;
    cursor = lastTs + 1;
    await new Promise((r) => setTimeout(r, 60));
    if (out.length > 0 && out[out.length - 1].time >= endMs) break;
  }
  return { funding: out.filter((f) => f.time < endMs) };
}

export function runBacktest({ candles, aux, rules, fee }) {
  const stopPct = Math.max(rules.risk_limits?.stop_loss_pct ?? 0.3, STOP_PCT);
  const funding = aux.funding || [];
  if (funding.length === 0 || candles.length === 0) return [];

  const rates = funding.map((f) => f.rate);
  const z = zScoreSeries(rates, ZSCORE_WINDOW);

  const candleAt = (t) => {
    let lo = 0,
      hi = candles.length - 1,
      ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (candles[mid].time <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  };

  const trades = [];
  let pos = null;

  for (let fIdx = ZSCORE_WINDOW; fIdx < funding.length; fIdx++) {
    const f = funding[fIdx];
    const candleIdx = candleAt(f.time);
    if (candleIdx < 0) continue;
    if (z[fIdx] == null) continue;

    if (pos) {
      let exitInfo = null;
      for (let i = Math.max(pos.startCandle + 1, 0); i <= candleIdx; i++) {
        const c = candles[i];
        if (pos.side === "long" && c.low <= pos.stop) {
          exitInfo = { reason: "stop", price: pos.stop, candleIdx: i };
          break;
        }
        if (pos.side === "short" && c.high >= pos.stop) {
          exitInfo = { reason: "stop", price: pos.stop, candleIdx: i };
          break;
        }
      }
      if (!exitInfo) {
        exitInfo = {
          reason: "funding-tick",
          price: candles[candleIdx].close,
          candleIdx,
        };
      }
      trades.push(closeTrade(pos, exitInfo, candles, stopPct, fee));
      pos = null;
    }

    if (Math.abs(z[fIdx]) >= Z_THRESHOLD) {
      const side = z[fIdx] > 0 ? "short" : "long";
      const entry = candles[candleIdx].close;
      const stop =
        side === "long" ? entry * (1 - stopPct / 100) : entry * (1 + stopPct / 100);
      pos = { time: f.time, side, entry, stop, startCandle: candleIdx, fundingZ: z[fIdx] };
    }
  }

  return trades;
}

function closeTrade(pos, exit, candles, stopPct, fee) {
  const grossPctRaw =
    pos.side === "long"
      ? (exit.price - pos.entry) / pos.entry
      : (pos.entry - exit.price) / pos.entry;
  return {
    entryTime: new Date(pos.time).toISOString(),
    exitTime: new Date(candles[exit.candleIdx].time).toISOString(),
    side: pos.side,
    entry: pos.entry,
    exit: exit.price,
    stop: pos.stop,
    reason: exit.reason,
    grossPct: grossPctRaw * 100,
    netPct: (grossPctRaw - 2 * fee) * 100,
    rPnl: grossPctRaw / (stopPct / 100),
    fundingZ: pos.fundingZ,
  };
}
