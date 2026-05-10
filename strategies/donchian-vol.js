// Strategy: Donchian Breakout with ATR Vol Filter
//
// Classical Turtle-style breakout (long on N-bar high break, short on N-bar low),
// gated by an ATR vol filter that suppresses entries during dead-quiet markets
// (no follow-through) and during blow-off vol spikes (mean-reversion takes over).
// Trailing stop = opposite N-bar extreme.

import { rollingHigh, rollingLow, atrSeries } from "./_indicators.js";

export const meta = {
  id: "donchian-vol",
  name: "Donchian Breakout (vol-filtered)",
  description:
    "Long on close > 20-bar high (or short < 20-bar low), only when 14-bar ATR is in middle 50% of trailing 80-bar ATR distribution. Trailing stop on opposite 10-bar extreme.",
  auxData: [],
};

const ENTRY_WINDOW = 20;
const EXIT_WINDOW = 10;
const ATR_PERIOD = 14;
const ATR_DIST_WINDOW = 80;

export async function loadAuxData() {
  return {};
}

export function runBacktest({ candles, rules, fee }) {
  const stopPct = rules.risk_limits?.stop_loss_pct ?? 0.3;
  const high20 = rollingHigh(candles, ENTRY_WINDOW);
  const low20 = rollingLow(candles, ENTRY_WINDOW);
  const high10 = rollingHigh(candles, EXIT_WINDOW);
  const low10 = rollingLow(candles, EXIT_WINDOW);
  const atr = atrSeries(candles, ATR_PERIOD);

  // Compute middle-50% band of trailing ATR distribution at each i.
  const atrLowerBand = new Array(candles.length).fill(null);
  const atrUpperBand = new Array(candles.length).fill(null);
  for (let i = ATR_DIST_WINDOW; i < candles.length; i++) {
    const slice = atr.slice(i - ATR_DIST_WINDOW + 1, i + 1).filter((x) => x != null);
    if (slice.length < 10) continue;
    const sorted = slice.slice().sort((a, b) => a - b);
    atrLowerBand[i] = sorted[Math.floor(sorted.length * 0.25)];
    atrUpperBand[i] = sorted[Math.floor(sorted.length * 0.75)];
  }

  const trades = [];
  let pos = null;

  for (let i = ATR_DIST_WINDOW; i < candles.length; i++) {
    const c = candles[i];
    const a = atr[i];
    const lo = atrLowerBand[i];
    const hi = atrUpperBand[i];
    const prev = candles[i - 1];

    if (pos) {
      // Trailing exit on opposite N-bar extreme
      if (pos.side === "long" && c.low <= low10[i - 1]) {
        trades.push(closeTrade(pos, c.time, { reason: "trail-exit", price: low10[i - 1] }, stopPct, fee));
        pos = null;
      } else if (pos.side === "short" && c.high >= high10[i - 1]) {
        trades.push(closeTrade(pos, c.time, { reason: "trail-exit", price: high10[i - 1] }, stopPct, fee));
        pos = null;
      } else if (pos.side === "long" && c.low <= pos.stop) {
        trades.push(closeTrade(pos, c.time, { reason: "hard-stop", price: pos.stop }, stopPct, fee));
        pos = null;
      } else if (pos.side === "short" && c.high >= pos.stop) {
        trades.push(closeTrade(pos, c.time, { reason: "hard-stop", price: pos.stop }, stopPct, fee));
        pos = null;
      }
    }

    if (!pos && a != null && lo != null && hi != null) {
      // Vol filter: only enter when ATR is within middle 50% of recent distribution.
      const inBand = a >= lo && a <= hi;
      if (!inBand) continue;
      // Breakout entries — close (which has just printed) crosses prior high/low
      if (prev.close <= high20[i - 1] && c.close > high20[i - 1]) {
        const stop = c.close - 2.5 * a;
        pos = { time: c.time, side: "long", entry: c.close, stop, startIdx: i };
      } else if (prev.close >= low20[i - 1] && c.close < low20[i - 1]) {
        const stop = c.close + 2.5 * a;
        pos = { time: c.time, side: "short", entry: c.close, stop, startIdx: i };
      }
    }
  }
  return trades;
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
