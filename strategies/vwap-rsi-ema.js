// Strategy: VWAP + RSI(3) + EMA(8) Scalping (the upstream baseline)
//
// Entry:
//   Long  : price > VWAP, price > EMA(8), RSI(3) < 30, |price-vwap|/vwap < 1.5%
//   Short : price < VWAP, price < EMA(8), RSI(3) > 70, |price-vwap|/vwap < 1.5%
// Exit:
//   - Hard stop (rules.risk_limits.stop_loss_pct, default 0.3%)
//   - RSI(3) cross-back through 50
//   - VWAP touch
//   - EMA(8) cross

import { emaSeries, rsiSeries, vwapSeries } from "./_indicators.js";

export const meta = {
  id: "vwap-rsi-ema",
  name: "VWAP + RSI(3) + EMA(8) Scalping",
  description:
    "Three-indicator counter-trend scalper. Bias filter (price vs VWAP+EMA), entry on RSI(3) snap-back. Designed for 1m-5m but routinely run on 4h via cron.",
  auxData: [],
};

export async function loadAuxData() {
  return {};
}

export function runBacktest({ candles, rules, fee }) {
  const closes = candles.map((c) => c.close);
  const ema8 = emaSeries(closes, 8);
  const rsi3 = rsiSeries(closes, 3);
  const vwap = vwapSeries(candles);
  const stopPct = rules.risk_limits?.stop_loss_pct ?? 0.3;

  const trades = [];
  let pos = null;

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    if (pos) {
      const exit = checkExit(pos, c, ema8[i], vwap[i], rsi3[i], rsi3[i - 1], candles[i - 1].close);
      if (exit) {
        trades.push(closeTrade(pos, c.time, exit, stopPct, fee));
        pos = null;
      }
    }
    if (!pos) {
      const e = checkEntry(c.close, ema8[i], vwap[i], rsi3[i]);
      if (e.bias) {
        const stop =
          e.bias === "long"
            ? c.close * (1 - stopPct / 100)
            : c.close * (1 + stopPct / 100);
        pos = { time: c.time, side: e.bias, entry: c.close, stop };
      }
    }
  }
  return trades;
}

function checkEntry(price, ema8, vwap, rsi3) {
  if (ema8 == null || vwap == null || rsi3 == null) return { bias: null };
  const dist = (Math.abs(price - vwap) / vwap) * 100;
  if (dist >= 1.5) return { bias: null };
  if (price > vwap && price > ema8 && rsi3 < 30) return { bias: "long" };
  if (price < vwap && price < ema8 && rsi3 > 70) return { bias: "short" };
  return { bias: null };
}

function checkExit(pos, c, ema8, vwap, rsi3, prevRsi3, prevClose) {
  if (rsi3 == null || vwap == null || ema8 == null) return null;
  if (pos.side === "long" && c.low <= pos.stop) return { reason: "stop", price: pos.stop };
  if (pos.side === "short" && c.high >= pos.stop) return { reason: "stop", price: pos.stop };

  if (pos.side === "long" && prevRsi3 != null && prevRsi3 < 50 && rsi3 >= 50)
    return { reason: "rsi-cross", price: c.close };
  if (pos.side === "short" && prevRsi3 != null && prevRsi3 > 50 && rsi3 <= 50)
    return { reason: "rsi-cross", price: c.close };

  if (pos.side === "long" && prevClose != null && prevClose > vwap && c.close <= vwap)
    return { reason: "vwap-touch", price: c.close };
  if (pos.side === "short" && prevClose != null && prevClose < vwap && c.close >= vwap)
    return { reason: "vwap-touch", price: c.close };

  if (pos.side === "long" && prevClose != null && prevClose > ema8 && c.close <= ema8)
    return { reason: "ema-cross", price: c.close };
  if (pos.side === "short" && prevClose != null && prevClose < ema8 && c.close >= ema8)
    return { reason: "ema-cross", price: c.close };

  return null;
}

function closeTrade(pos, exitTime, exit, stopPct, fee) {
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
    rPnl: grossPctRaw / (stopPct / 100),
  };
}
