// Strategy: Time-Series Momentum (TSMOM)
//
// Moskowitz/Ooi/Pedersen 2012, adapted to crypto. At each daily close:
//   - Compute LOOKBACK-day return.
//   - If > +ENTRY_THRESHOLD: target long.
//   - If < -ENTRY_THRESHOLD: target short.
//   - Otherwise: flat.
// Exit when the momentum sign flips (or threshold-band exits position).
// Optional: vol-target via realised-vol scaling (left out of MVP — uniform sizing).
//
// Why this can work where scalpers don't: TSMOM rides multi-week trends with one
// trade per regime. Fee drag scales with trade frequency, not with edge size.

import { returnSeries, atrSeries } from "./_indicators.js";

export const meta = {
  id: "tsmom",
  name: "Time-Series Momentum (28-day, daily)",
  description:
    "Hold long if 28-day return > +0.5%, hold short if < -0.5%, flat otherwise. Trend-follower. Designed for daily candles.",
  auxData: [],
};

// Standard TSMOM parameters from the literature: 60-day (or 1-12mo) lookback.
// 0.5% threshold whipsaws on dailies; 2% requires a real trend before flipping.
// Both are env-overridable for parameter sweeps.
const LOOKBACK = parseInt(process.env.TSMOM_LOOKBACK || "60", 10);
const ENTRY_THRESHOLD = parseFloat(process.env.TSMOM_THRESHOLD || "0.02");
const ATR_STOP_MULTIPLE = 4;
const ATR_PERIOD = 14;

export async function loadAuxData() {
  return {};
}

export function runBacktest({ candles, rules, fee }) {
  const closes = candles.map((c) => c.close);
  const ret = returnSeries(closes, LOOKBACK);
  const atr = atrSeries(candles, ATR_PERIOD);
  const stopPctRules = rules.risk_limits?.stop_loss_pct ?? 0.3;

  const trades = [];
  let pos = null;

  for (let i = LOOKBACK + ATR_PERIOD; i < candles.length; i++) {
    const c = candles[i];
    const r = ret[i];
    const a = atr[i];
    if (r == null || a == null) continue;

    const targetSide =
      r > ENTRY_THRESHOLD ? "long" : r < -ENTRY_THRESHOLD ? "short" : "flat";

    if (pos) {
      // Stop-out (intra-candle)
      if (pos.side === "long" && c.low <= pos.stop) {
        trades.push(closeTrade(pos, c.time, { reason: "atr-stop", price: pos.stop }, stopPctRules, fee));
        pos = null;
      } else if (pos.side === "short" && c.high >= pos.stop) {
        trades.push(closeTrade(pos, c.time, { reason: "atr-stop", price: pos.stop }, stopPctRules, fee));
        pos = null;
      } else if (
        // Signal flip
        (pos.side === "long" && targetSide !== "long") ||
        (pos.side === "short" && targetSide !== "short")
      ) {
        trades.push(closeTrade(pos, c.time, { reason: "signal-flip", price: c.close }, stopPctRules, fee));
        pos = null;
      } else {
        // Trail the ATR stop
        if (pos.side === "long") {
          const newStop = c.close - ATR_STOP_MULTIPLE * a;
          if (newStop > pos.stop) pos.stop = newStop;
        } else {
          const newStop = c.close + ATR_STOP_MULTIPLE * a;
          if (newStop < pos.stop) pos.stop = newStop;
        }
      }
    }

    if (!pos && targetSide !== "flat") {
      const stop =
        targetSide === "long"
          ? c.close - ATR_STOP_MULTIPLE * a
          : c.close + ATR_STOP_MULTIPLE * a;
      pos = { time: c.time, side: targetSide, entry: c.close, stop };
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
