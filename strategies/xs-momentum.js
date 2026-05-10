// Strategy: Cross-Sectional Momentum (long-only, top-K of N basket)
//
// At each rebalance period, rank a fixed universe of spot symbols by their
// LOOKBACK-day return. Hold the top K equally weighted. Rebalance weekly.
//
// Long-only by design — only ever holds long positions, perfect for spot
// venues that don't allow shorting (e.g. Binance.com.au, AU retail).
//
// Why this can work where single-symbol momentum fails on majors: the
// strategy adapts to which symbol is "winning" right now. Even if BTC is
// in a chop regime, an alt may be trending. The basket smooths idiosyncratic
// risk while still capturing trend-following edge.
//
// Universe: top liquid USDT spot pairs with multi-year history. Backtest
// data is from Binance Futures klines (same prices as spot in practice) so
// historical depth is uniform.

const FAPI_BASE = process.env.BINANCE_FAPI_BASE_URL || "https://fapi.binance.com";

export const meta = {
  id: "xs-momentum",
  name: "Cross-Sectional Momentum (long-only)",
  description:
    "Rank top-5 USDT pairs by 30-day return weekly; hold top 2 equally weighted. Long-only by design. Suitable for AU spot deployment.",
  auxData: ["multiSymbolKlines"],
  multiSymbol: true,
};

const UNIVERSE = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"];
const LOOKBACK_BARS = parseInt(process.env.XSMOM_LOOKBACK || "30", 10);
const HOLD_TOP_K = parseInt(process.env.XSMOM_TOP_K || "2", 10);
const REBALANCE_EVERY_BARS = parseInt(process.env.XSMOM_REBALANCE || "7", 10);

const INTERVAL_MS = {
  "1d": 86_400_000,
  "12h": 43_200_000,
  "8h": 28_800_000,
  "4h": 14_400_000,
};

async function fetchKlinesRange(symbol, interval, startMs, endMs) {
  const stepMs = INTERVAL_MS[interval];
  if (!stepMs) throw new Error(`xs-momentum: unsupported interval ${interval}`);
  const out = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `${FAPI_BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&limit=1500`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`klines ${symbol} HTTP ${res.status}`);
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const k of batch) {
      out.push({
        time: k[0],
        open: parseFloat(k[1]),
        close: parseFloat(k[4]),
      });
    }
    const lastTs = batch[batch.length - 1][0];
    if (lastTs <= cursor) break;
    cursor = lastTs + stepMs;
    await new Promise((r) => setTimeout(r, 60));
  }
  return out.filter((c) => c.time < endMs);
}

export async function loadAuxData({ startMs, endMs, interval = "1d" }) {
  // Pad the lookback window so we have warmup return data.
  const stepMs = INTERVAL_MS[interval] || 86_400_000;
  const padStart = startMs - (LOOKBACK_BARS + 5) * stepMs;
  const symbolKlines = {};
  for (const sym of UNIVERSE) {
    try {
      symbolKlines[sym] = await fetchKlinesRange(sym, interval, padStart, endMs);
    } catch (err) {
      symbolKlines[sym] = [];
    }
  }
  return { symbolKlines, lookback: LOOKBACK_BARS, topK: HOLD_TOP_K, rebalance: REBALANCE_EVERY_BARS };
}

export function runBacktest({ aux, rules, fee }) {
  const { symbolKlines } = aux;
  if (!symbolKlines) return [];

  // Align symbols on common time index. Use BTCUSDT as the master timeline;
  // for each candle time, look up that symbol's close (skip if absent).
  const master = symbolKlines.BTCUSDT || [];
  if (master.length < LOOKBACK_BARS + 2) return [];

  const symbolByTime = {};
  for (const sym of UNIVERSE) {
    symbolByTime[sym] = new Map();
    for (const c of symbolKlines[sym] || []) symbolByTime[sym].set(c.time, c.close);
  }

  const trades = [];
  const holdings = {}; // sym -> { entryTime, entryPrice }
  let lastRebalanceIdx = -REBALANCE_EVERY_BARS;

  // Walk forward through master timeline. NO daily stop-loss for long-only
  // spot: rebalance cadence + absolute filter is the risk control. A daily
  // stop would whipsaw on normal volatility and re-enter on the next
  // rebalance, compounding losses. The strategy IS the rotation.
  const stopPct = 100; // dummy for closeTrade R-multiple calc
  for (let i = LOOKBACK_BARS; i < master.length; i++) {
    const t = master[i].time;
    const since = i - lastRebalanceIdx;

    // Rebalance every REBALANCE_EVERY_BARS bars
    if (since < REBALANCE_EVERY_BARS) continue;
    lastRebalanceIdx = i;

    // Score each universe member by lookback return at this candle
    const scores = [];
    for (const sym of UNIVERSE) {
      const cur = symbolByTime[sym]?.get(t);
      const past = symbolByTime[sym]?.get(master[i - LOOKBACK_BARS]?.time);
      if (cur == null || past == null || past <= 0) continue;
      const ret = (cur - past) / past;
      scores.push({ sym, ret, cur });
    }
    if (scores.length === 0) continue;

    // Rank descending. Apply absolute-trend filter: only hold a symbol if its
    // lookback return is above the floor. When NO symbols qualify, the
    // strategy holds cash for the period — avoids buying into bear markets.
    // Floor defaults to 0 (positive return required); env-overridable for
    // sweeps (e.g. require >2% momentum to enter, more conservative).
    const ABS_FLOOR = parseFloat(process.env.XSMOM_ABS_FLOOR || "0.0");
    scores.sort((a, b) => b.ret - a.ret);
    const eligibleScores = scores.filter((s) => s.ret > ABS_FLOOR);
    const target = new Set(eligibleScores.slice(0, HOLD_TOP_K).map((s) => s.sym));

    // Sell what's leaving
    for (const sym of Object.keys(holdings)) {
      if (!target.has(sym)) {
        const cur = symbolByTime[sym]?.get(t);
        if (cur != null) {
          trades.push(closeTrade(holdings[sym], sym, t, cur, "rebalance-out", stopPct, fee));
        }
        delete holdings[sym];
      }
    }
    // Buy what's entering (filtered by absolute floor — see above)
    for (const { sym, cur } of eligibleScores.slice(0, HOLD_TOP_K)) {
      if (!holdings[sym]) {
        holdings[sym] = { entryTime: t, entryPrice: cur };
      }
    }
  }

  // Close any still-open holdings at the end of the data — for fair P&L tally.
  const lastTime = master[master.length - 1].time;
  for (const sym of Object.keys(holdings)) {
    const cur = symbolByTime[sym]?.get(lastTime);
    if (cur != null) {
      trades.push(closeTrade(holdings[sym], sym, lastTime, cur, "end-of-data", 8, fee));
    }
  }

  return trades;
}

function closeTrade(pos, symbol, exitTime, exitPrice, reason, stopPct, fee) {
  const grossPctRaw = (exitPrice - pos.entryPrice) / pos.entryPrice;
  return {
    entryTime: new Date(pos.entryTime).toISOString(),
    exitTime: new Date(exitTime).toISOString(),
    side: "long",
    symbol,
    entry: pos.entryPrice,
    exit: exitPrice,
    stop: pos.entryPrice * (1 - stopPct / 100),
    reason,
    grossPct: grossPctRaw * 100,
    netPct: (grossPctRaw - 2 * fee) * 100,
    rPnl: grossPctRaw / (stopPct / 100),
  };
}
