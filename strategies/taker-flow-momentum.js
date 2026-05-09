// Strategy: Taker-Flow Momentum
//
// Substitutes for the project plan's "order-book imbalance momentum" strategy,
// which the plan attributes to /fapi/v1/depth — but Binance only exposes the
// CURRENT order book, not history. Klines, however, include the per-candle
// taker-buy volume, which captures the same intent (aggressive flow imbalance)
// and is fully backtestable from free public data.
//
// Premise: when aggressive buyers dominate over an N-bar window AND price is
// above the medium-term SMA, ride momentum long. Mirror for shorts. This is a
// trend-following counterweight to the two mean-reversion strategies.
//
// Signal: smoothed taker_buy_ratio over WINDOW bars
//   - > 0.55 + price > SMA(SMA_PERIOD): long
//   - < 0.45 + price < SMA(SMA_PERIOD): short
// Exit: smoothed ratio crosses back through 0.50, OR stop, OR N-bar timeout

import { smaSeries } from "./_indicators.js";

export const meta = {
  id: "taker-flow-momentum",
  name: "Taker-Flow Momentum",
  description:
    "Trend-following on aggressive flow imbalance. Long when smoothed taker-buy ratio > 0.55 and price > SMA(20). Mirror for shorts. Substitutes the orderbook-imbalance strategy with a backtestable proxy.",
  auxData: [],
};

const WINDOW = 6; // bars to smooth taker-buy ratio
const SMA_PERIOD = 20;
const LONG_THRESHOLD = 0.55;
const SHORT_THRESHOLD = 0.45;
const NEUTRAL_BAND = 0.5;
const TIMEOUT_BARS = 24;
const STOP_PCT = 0.5;

export async function loadAuxData() {
  return {};
}

export function runBacktest({ candles, rules, fee }) {
  const closes = candles.map((c) => c.close);
  const sma = smaSeries(closes, SMA_PERIOD);

  // Smoothed taker-buy ratio over WINDOW
  const ratio = new Array(candles.length).fill(null);
  for (let i = WINDOW - 1; i < candles.length; i++) {
    let takerBuy = 0,
      total = 0;
    for (let j = i - WINDOW + 1; j <= i; j++) {
      takerBuy += candles[j].takerBuyBase ?? 0;
      total += candles[j].volume;
    }
    ratio[i] = total > 0 ? takerBuy / total : null;
  }

  const stopPct = Math.max(rules.risk_limits?.stop_loss_pct ?? 0.3, STOP_PCT);

  const trades = [];
  let pos = null;

  for (let i = SMA_PERIOD; i < candles.length; i++) {
    const c = candles[i];
    if (pos) {
      // Stop check
      if (pos.side === "long" && c.low <= pos.stop) {
        trades.push(closeTrade(pos, c.time, { reason: "stop", price: pos.stop }, stopPct, fee));
        pos = null;
        continue;
      }
      if (pos.side === "short" && c.high >= pos.stop) {
        trades.push(closeTrade(pos, c.time, { reason: "stop", price: pos.stop }, stopPct, fee));
        pos = null;
        continue;
      }
      // Ratio crosses back through neutral
      if (
        ratio[i] != null &&
        ((pos.side === "long" && ratio[i] < NEUTRAL_BAND) ||
          (pos.side === "short" && ratio[i] > NEUTRAL_BAND))
      ) {
        trades.push(closeTrade(pos, c.time, { reason: "ratio-cross", price: c.close }, stopPct, fee));
        pos = null;
        continue;
      }
      // Timeout
      if (i - pos.startIdx >= TIMEOUT_BARS) {
        trades.push(closeTrade(pos, c.time, { reason: "timeout", price: c.close }, stopPct, fee));
        pos = null;
      }
    }

    if (!pos && ratio[i] != null && sma[i] != null) {
      let side = null;
      if (ratio[i] > LONG_THRESHOLD && c.close > sma[i]) side = "long";
      else if (ratio[i] < SHORT_THRESHOLD && c.close < sma[i]) side = "short";
      if (side) {
        const stop =
          side === "long" ? c.close * (1 - stopPct / 100) : c.close * (1 + stopPct / 100);
        pos = { time: c.time, side, entry: c.close, stop, startIdx: i };
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
