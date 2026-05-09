// Strategy: Funding-rate mean reversion (Binance USD-M perps)
//
// Premise: when 8h funding rate prints unusually positive, longs are paying
// shorts — late-cycle long over-extension. Fade by going short. When funding
// prints unusually negative, fade by going long. Hold one funding period (8h),
// exit at the next funding tick. Use 1h klines for stop-loss granularity.
//
// Notes:
//   - Funding payment P&L (you collect funding on the side opposite the over-
//     extended crowd) is NOT modelled here — only price reversion is. This is
//     deliberately conservative; funding income would only improve results.
//   - Stop is wider than the scalper's (default 0.5% vs 0.3%) because the
//     intended holding period is 8h, not minutes.

import { rollingHigh, rollingLow } from "./_indicators.js";

const FAPI_BASE = process.env.BINANCE_FAPI_BASE_URL || "https://fapi.binance.com";

export const meta = {
  id: "funding-mean-revert",
  name: "Funding-Rate Mean Reversion",
  description:
    "Fade extreme funding-rate prints. Short when funding > +threshold (longs over-extended), long when funding < -threshold (shorts over-extended). Hold one funding period.",
  auxData: ["fundingRate"],
  preferredInterval: "1h",
};

// Threshold can be overridden via FUNDING_THRESHOLD env var to allow a sweep.
// 0.02% is empirically near the BTC/ETH 8h funding noise floor; 0.05% catches
// only severe over-extension (which is rare on majors).
const FUNDING_THRESHOLD = parseFloat(process.env.FUNDING_THRESHOLD || "0.0002");
const STOP_PCT = 0.5; // wider than scalper since hold is 8h
const FUNDING_PERIOD_MS = 8 * 60 * 60 * 1000;

export async function loadAuxData({ symbol, startMs, endMs }) {
  const out = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `${FAPI_BASE}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${cursor}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fundingRate HTTP ${res.status} on ${url}`);
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const f of batch) {
      out.push({
        time: f.fundingTime,
        rate: parseFloat(f.fundingRate),
      });
    }
    const lastTs = batch[batch.length - 1].fundingTime;
    if (lastTs <= cursor) break;
    cursor = lastTs + 1;
    await new Promise((r) => setTimeout(r, 60));
    if (out.length > 0 && out[out.length - 1].time >= endMs) break;
  }
  return { funding: out.filter((f) => f.time < endMs) };
}

export function runBacktest({ candles, aux, rules, fee }) {
  const stopPct = rules.risk_limits?.stop_loss_pct
    ? Math.max(rules.risk_limits.stop_loss_pct, STOP_PCT)
    : STOP_PCT;

  const funding = aux.funding || [];
  if (funding.length === 0 || candles.length === 0) return [];

  // Build a lookup: nearest candle index for each funding event
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
  let posEntryFundingIdx = -1;

  for (let fIdx = 0; fIdx < funding.length; fIdx++) {
    const f = funding[fIdx];
    const candleIdx = candleAt(f.time);
    if (candleIdx < 0) continue;

    // 1. Check exit on currently held position before considering new entry
    if (pos) {
      // Walk forward through candles between pos entry and this funding event,
      // checking stop loss intra-period
      let exitInfo = null;
      for (
        let i = Math.max(pos.startCandle + 1, 0);
        i <= candleIdx;
        i++
      ) {
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
        // No stop hit — exit at this funding tick's candle close
        exitInfo = {
          reason: "funding-tick",
          price: candles[candleIdx].close,
          candleIdx,
        };
      }
      trades.push(closeTrade(pos, exitInfo, candles, stopPct, fee));
      pos = null;
    }

    // 2. New entry?
    if (Math.abs(f.rate) >= FUNDING_THRESHOLD) {
      const side = f.rate > 0 ? "short" : "long";
      const entry = candles[candleIdx].close;
      const stop =
        side === "long" ? entry * (1 - stopPct / 100) : entry * (1 + stopPct / 100);
      pos = {
        time: f.time,
        side,
        entry,
        stop,
        startCandle: candleIdx,
        fundingRate: f.rate,
      };
      posEntryFundingIdx = fIdx;
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
    fundingRate: pos.fundingRate,
  };
}
