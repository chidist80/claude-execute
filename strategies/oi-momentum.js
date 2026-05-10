// Strategy: Open Interest + Price Momentum
//
// Premise: a price move with rising OI is "real" (new money entering), a
// price move with falling OI is a squeeze/exit. Long when both price AND
// open interest are above their 20-bar SMA. Mirror for shorts. Captures
// crowd-positioning information not visible in price alone.
//
// Data: /futures/data/openInterestHist (30-day max range per request, paginated)

import { smaSeries, atrSeries } from "./_indicators.js";

const FAPI_BASE = process.env.BINANCE_FAPI_BASE_URL || "https://fapi.binance.com";

export const meta = {
  id: "oi-momentum",
  name: "Open Interest Momentum",
  description:
    "Long when both price > SMA(20) AND open interest > SMA(20). Mirror for shorts. ATR-based stop. NOTE: /futures/data/openInterestHist is hard-capped at 30 days of history, so this strategy cannot be backtested on >1 month. Run with --months 1 for recency check; it remains usable for live trading where rolling 30-day data is always available.",
  auxData: ["openInterestHist"],
};

const SMA_PERIOD = 20;
const ATR_PERIOD = 14;
const ATR_STOP_MULTIPLE = 2.5;
const TIMEOUT_BARS = 48;

export async function loadAuxData({ symbol, startMs, endMs }) {
  // openInterestHist returns 500 hourly entries per request (~21 days).
  // Paginate by advancing cursor to last_timestamp + 1h. The endpoint also
  // caps lookback at 30 days from now() — older data is unavailable, so
  // requested ranges beyond that horizon will simply return shorter history.
  const HOUR = 60 * 60 * 1000;
  const out = [];
  let cursor = startMs;
  let safety = 0;
  while (cursor < endMs && safety < 200) {
    safety++;
    const url = `${FAPI_BASE}/futures/data/openInterestHist?symbol=${symbol}&period=1h&limit=500&startTime=${cursor}&endTime=${endMs}`;
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 404 || res.status === 400) return { oi: [] };
      throw new Error(`openInterestHist HTTP ${res.status}`);
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const e of batch) {
      out.push({
        time: e.timestamp,
        oi: parseFloat(e.sumOpenInterest),
        oiUSD: parseFloat(e.sumOpenInterestValue),
      });
    }
    const lastTs = batch[batch.length - 1].timestamp;
    if (lastTs <= cursor) break;
    cursor = lastTs + HOUR;
    await new Promise((r) => setTimeout(r, 60));
  }
  // Sort + dedupe (rare overlaps)
  out.sort((a, b) => a.time - b.time);
  const dedup = [];
  for (const e of out) {
    if (dedup.length === 0 || dedup[dedup.length - 1].time !== e.time) dedup.push(e);
  }
  return { oi: dedup.filter((e) => e.time >= startMs && e.time < endMs) };
}

export function runBacktest({ candles, aux, rules, fee }) {
  const stopPctRules = rules.risk_limits?.stop_loss_pct ?? 0.3;
  const oi = aux.oi || [];
  if (oi.length === 0) return [];

  // Build per-candle OI value by aligning hourly OI samples to candle starts.
  // Both sources are 1h-cadence so we can do nearest-prior lookup.
  const oiMap = new Map(oi.map((e) => [e.time, e.oi]));
  const oiTimes = oi.map((e) => e.time);
  const lookupOi = (t) => {
    let lo = 0,
      hi = oiTimes.length - 1,
      ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (oiTimes[mid] <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans >= 0 ? oi[ans].oi : null;
  };

  const oiPerCandle = candles.map((c) => lookupOi(c.time));
  // Forward-fill nulls. Find first non-null and back-fill to start.
  let firstIdx = oiPerCandle.findIndex((v) => v != null);
  if (firstIdx < 0) return []; // no OI data overlaps any candle
  for (let i = 0; i < firstIdx; i++) oiPerCandle[i] = oiPerCandle[firstIdx];
  for (let i = 1; i < oiPerCandle.length; i++) {
    if (oiPerCandle[i] == null) oiPerCandle[i] = oiPerCandle[i - 1];
  }

  const closes = candles.map((c) => c.close);
  const priceSma = smaSeries(closes, SMA_PERIOD);
  const oiSma = smaSeries(oiPerCandle, SMA_PERIOD);
  const atr = atrSeries(candles, ATR_PERIOD);

  const trades = [];
  let pos = null;

  for (let i = SMA_PERIOD; i < candles.length; i++) {
    const c = candles[i];
    const ps = priceSma[i];
    const os = oiSma[i];
    const a = atr[i];
    if (ps == null || os == null || a == null) continue;

    if (pos) {
      // Stop-out
      if (pos.side === "long" && c.low <= pos.stop) {
        trades.push(closeTrade(pos, c.time, { reason: "stop", price: pos.stop }, stopPctRules, fee));
        pos = null;
      } else if (pos.side === "short" && c.high >= pos.stop) {
        trades.push(closeTrade(pos, c.time, { reason: "stop", price: pos.stop }, stopPctRules, fee));
        pos = null;
      } else if (
        // Signal flip: bias gone
        (pos.side === "long" && (c.close < ps || oiPerCandle[i] < os)) ||
        (pos.side === "short" && (c.close > ps || oiPerCandle[i] > os))
      ) {
        trades.push(closeTrade(pos, c.time, { reason: "bias-flip", price: c.close }, stopPctRules, fee));
        pos = null;
      } else if (i - pos.startIdx >= TIMEOUT_BARS) {
        trades.push(closeTrade(pos, c.time, { reason: "timeout", price: c.close }, stopPctRules, fee));
        pos = null;
      } else {
        // trail
        if (pos.side === "long") {
          const newStop = c.close - ATR_STOP_MULTIPLE * a;
          if (newStop > pos.stop) pos.stop = newStop;
        } else {
          const newStop = c.close + ATR_STOP_MULTIPLE * a;
          if (newStop < pos.stop) pos.stop = newStop;
        }
      }
    }

    if (!pos) {
      const longBias = c.close > ps && oiPerCandle[i] > os;
      const shortBias = c.close < ps && oiPerCandle[i] < os;
      if (longBias) {
        const stop = c.close - ATR_STOP_MULTIPLE * a;
        pos = { time: c.time, side: "long", entry: c.close, stop, startIdx: i };
      } else if (shortBias) {
        const stop = c.close + ATR_STOP_MULTIPLE * a;
        pos = { time: c.time, side: "short", entry: c.close, stop, startIdx: i };
      }
    }
  }
  return trades;
}

function closeTrade(pos, exitTime, exit, stopPctRules, fee) {
  const grossPctRaw =
    pos.side === "long"
      ? (exit.price - pos.entry) / pos.entry
      : (pos.entry - exit.price) / pos.entry;
  return {
    entryTime: new Date(pos.time).toISOString(),
    exitTime: new Date(exitTime).toISOString(),
    side: pos.side,
    entry: pos.entry,
    exit: exit.price,
    stop: pos.stop,
    reason: exit.reason,
    grossPct: grossPctRaw * 100,
    netPct: (grossPctRaw - 2 * fee) * 100,
    rPnl: grossPctRaw / (stopPctRules / 100),
  };
}
