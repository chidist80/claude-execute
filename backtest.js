/**
 * Claude Execute — Backtest harness (Gap 7)
 *
 * Replays rules.json's indicator + safety check logic against historical
 * Binance USD-M Futures klines (the public, free, no-auth endpoint at
 * fapi.binance.com/fapi/v1/klines). Walks forward candle-by-candle, opens
 * positions on safety-check pass, exits on RSI re-cross / hard stop /
 * VWAP touch / EMA cross. Outputs per-trade CSV + summary stats.
 *
 * Usage:
 *   node backtest.js
 *   node backtest.js --symbol BTCUSDT --interval 4h --months 12 --fee 0.0005
 *   node backtest.js --symbol ETHUSDT --interval 1h --start 2025-05-01 --end 2026-05-01
 *
 * Defaults: SYMBOL/TIMEFRAME from .env, 12 months back, 0.05% per-side fee.
 *
 * Exit gate (per the project plan, Phase 1):
 *   - Sharpe ≥ 1.0
 *   - MDD ≤ 25%
 *   - ≥ 30 trades/year
 *   - Win-rate non-negative when fees are doubled
 */

import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";

const FAPI_BASE = process.env.BINANCE_FAPI_BASE_URL || "https://fapi.binance.com";

// ─── Args ────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = {
    symbol: process.env.SYMBOL || "BTCUSDT",
    interval: (process.env.TIMEFRAME || "4H").toLowerCase(),
    months: 12,
    fee: 0.0005,
    start: null,
    end: null,
    outDir: ".",
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--symbol") (args.symbol = v), i++;
    else if (a === "--interval") (args.interval = v.toLowerCase()), i++;
    else if (a === "--months") (args.months = parseInt(v, 10)), i++;
    else if (a === "--fee") (args.fee = parseFloat(v)), i++;
    else if (a === "--start") (args.start = v), i++;
    else if (a === "--end") (args.end = v), i++;
    else if (a === "--out") (args.outDir = v), i++;
  }
  return args;
}

// ─── Klines (paginated public fetch) ────────────────────────────────────────

const INTERVAL_MS = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
  "1w": 604_800_000,
};

async function fetchKlinesRange(symbol, interval, startMs, endMs) {
  const out = [];
  let cursor = startMs;
  const stepMs = INTERVAL_MS[interval];
  if (!stepMs) throw new Error(`Unsupported interval: ${interval}`);
  while (cursor < endMs) {
    const url = `${FAPI_BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&limit=1500`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`klines HTTP ${res.status} on ${url}`);
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const k of batch) {
      out.push({
        time: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      });
    }
    const lastTs = batch[batch.length - 1][0];
    if (lastTs <= cursor) break;
    cursor = lastTs + stepMs;
    // be polite to the public endpoint
    await new Promise((r) => setTimeout(r, 60));
    if (out.length > 0 && out[out.length - 1].time >= endMs) break;
  }
  return out.filter((c) => c.time < endMs);
}

// ─── Indicators (per-candle, walk-forward safe) ─────────────────────────────

function computeEMASeries(closes, period) {
  const ema = new Array(closes.length).fill(null);
  if (closes.length < period) return ema;
  const mult = 2 / (period + 1);
  let cur = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  ema[period - 1] = cur;
  for (let i = period; i < closes.length; i++) {
    cur = closes[i] * mult + cur * (1 - mult);
    ema[i] = cur;
  }
  return ema;
}

function computeRSISeries(closes, period = 14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsi;
  for (let i = period; i < closes.length; i++) {
    let gains = 0,
      losses = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = closes[j] - closes[j - 1];
      if (diff > 0) gains += diff;
      else losses -= diff;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

// Session VWAP, resets at each midnight UTC. Returns array aligned with candles.
function computeVWAPSeries(candles) {
  const vwap = new Array(candles.length).fill(null);
  let dayKey = null;
  let cumTPV = 0,
    cumVol = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const utc = new Date(c.time);
    const key = `${utc.getUTCFullYear()}-${utc.getUTCMonth()}-${utc.getUTCDate()}`;
    if (key !== dayKey) {
      dayKey = key;
      cumTPV = 0;
      cumVol = 0;
    }
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.volume;
    cumVol += c.volume;
    vwap[i] = cumVol > 0 ? cumTPV / cumVol : null;
  }
  return vwap;
}

// ─── Entry check (mirrors bot.js runSafetyCheck) ───────────────────────────

function checkEntry(price, ema8, vwap, rsi3) {
  if (ema8 == null || vwap == null || rsi3 == null) return { bias: null };
  const distFromVWAP = (Math.abs(price - vwap) / vwap) * 100;
  if (distFromVWAP >= 1.5) return { bias: null };
  if (price > vwap && price > ema8 && rsi3 < 30) return { bias: "long" };
  if (price < vwap && price < ema8 && rsi3 > 70) return { bias: "short" };
  return { bias: null };
}

// ─── Exit logic (mirrors rules.json exit_rules) ────────────────────────────

function checkExit(position, candle, ema8, vwap, rsi3, prevRsi3, prevClose, stopPct) {
  if (rsi3 == null || vwap == null || ema8 == null) return null;
  const { side, entry, stop } = position;

  // Hard stop (intra-candle, use low/high to detect breach)
  if (side === "long" && candle.low <= stop) {
    return { reason: "stop", price: stop };
  }
  if (side === "short" && candle.high >= stop) {
    return { reason: "stop", price: stop };
  }

  // RSI(3) cross-back-through 50
  if (
    side === "long" &&
    prevRsi3 != null &&
    prevRsi3 < 50 &&
    rsi3 >= 50
  ) {
    return { reason: "rsi-cross", price: candle.close };
  }
  if (
    side === "short" &&
    prevRsi3 != null &&
    prevRsi3 > 50 &&
    rsi3 <= 50
  ) {
    return { reason: "rsi-cross", price: candle.close };
  }

  // VWAP touch (price crosses VWAP)
  if (
    side === "long" &&
    prevClose != null &&
    prevClose > vwap &&
    candle.close <= vwap
  ) {
    return { reason: "vwap-touch", price: candle.close };
  }
  if (
    side === "short" &&
    prevClose != null &&
    prevClose < vwap &&
    candle.close >= vwap
  ) {
    return { reason: "vwap-touch", price: candle.close };
  }

  // EMA(8) cross
  if (
    side === "long" &&
    prevClose != null &&
    prevClose > ema8 &&
    candle.close <= ema8
  ) {
    return { reason: "ema-cross", price: candle.close };
  }
  if (
    side === "short" &&
    prevClose != null &&
    prevClose < ema8 &&
    candle.close >= ema8
  ) {
    return { reason: "ema-cross", price: candle.close };
  }

  return null;
}

// ─── Walk forward ──────────────────────────────────────────────────────────

function runBacktest(candles, rules, fee) {
  const closes = candles.map((c) => c.close);
  const ema8 = computeEMASeries(closes, 8);
  const rsi3 = computeRSISeries(closes, 3);
  const vwap = computeVWAPSeries(candles);
  const stopPct = rules.risk_limits?.stop_loss_pct ?? 0.3;

  const trades = [];
  let position = null;

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];

    if (position) {
      const exit = checkExit(
        position,
        c,
        ema8[i],
        vwap[i],
        rsi3[i],
        rsi3[i - 1],
        candles[i - 1].close,
        stopPct,
      );
      if (exit) {
        // Round-trip cost
        const grossPctRaw =
          position.side === "long"
            ? (exit.price - position.entry) / position.entry
            : (position.entry - exit.price) / position.entry;
        const netPct = grossPctRaw - 2 * fee;
        trades.push({
          entryTime: new Date(position.time).toISOString(),
          exitTime: new Date(c.time).toISOString(),
          side: position.side,
          entry: position.entry,
          exit: exit.price,
          stop: position.stop,
          reason: exit.reason,
          grossPct: grossPctRaw * 100,
          netPct: netPct * 100,
          rPnl: grossPctRaw / (stopPct / 100),
        });
        position = null;
      }
    }

    if (!position) {
      const entry = checkEntry(c.close, ema8[i], vwap[i], rsi3[i]);
      if (entry.bias) {
        const stop =
          entry.bias === "long"
            ? c.close * (1 - stopPct / 100)
            : c.close * (1 + stopPct / 100);
        position = {
          time: c.time,
          side: entry.bias,
          entry: c.close,
          stop,
        };
      }
    }
  }

  return trades;
}

// ─── Stats ─────────────────────────────────────────────────────────────────

function summarize(trades, candles, fee) {
  const total = trades.length;
  if (total === 0) {
    return {
      trades: 0,
      net_return_pct: 0,
      win_rate: 0,
      avg_R: 0,
      sharpe: 0,
      mdd_pct: 0,
      fee_drag_pct: 0,
      trades_per_year: 0,
      monthly_pnl: {},
    };
  }

  const wins = trades.filter((t) => t.netPct > 0).length;
  const winRate = wins / total;

  // Equity curve in % returns space (compounding)
  let equity = 1;
  let peak = 1;
  let mdd = 0;
  const equityPath = [{ ts: trades[0].entryTime, equity }];
  for (const t of trades) {
    equity *= 1 + t.netPct / 100;
    equityPath.push({ ts: t.exitTime, equity });
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > mdd) mdd = dd;
  }
  const netReturnPct = (equity - 1) * 100;

  // Sharpe — bucket equity by UTC day, compute daily pct change, σ-normalize, annualize.
  const dayBuckets = new Map();
  for (const p of equityPath) {
    const day = p.ts.slice(0, 10);
    dayBuckets.set(day, p.equity); // last-seen equity for the day
  }
  const dayKeys = Array.from(dayBuckets.keys()).sort();
  const dailyReturns = [];
  for (let i = 1; i < dayKeys.length; i++) {
    const prev = dayBuckets.get(dayKeys[i - 1]);
    const cur = dayBuckets.get(dayKeys[i]);
    if (prev > 0) dailyReturns.push((cur - prev) / prev);
  }
  let sharpe = 0;
  if (dailyReturns.length > 1) {
    const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const variance =
      dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) /
      (dailyReturns.length - 1);
    const std = Math.sqrt(variance);
    if (std > 0) sharpe = (mean / std) * Math.sqrt(365);
  }

  const avgR = trades.reduce((a, t) => a + t.rPnl, 0) / total;

  const grossVol = trades.reduce(
    (a, t) => a + Math.abs(t.entry) + Math.abs(t.exit),
    0,
  );
  const feeCost = grossVol * fee;
  const feeDragPct = grossVol > 0 ? (feeCost / grossVol) * 100 : 0;

  const spanMs =
    new Date(trades[total - 1].exitTime).getTime() -
    new Date(trades[0].entryTime).getTime();
  const years = spanMs / (365 * 24 * 60 * 60 * 1000);
  const tradesPerYear = years > 0 ? total / years : total;

  // Monthly P&L (additive in % space — simple, not compounded)
  const monthly = {};
  for (const t of trades) {
    const m = t.exitTime.slice(0, 7);
    monthly[m] = (monthly[m] || 0) + t.netPct;
  }

  return {
    trades: total,
    net_return_pct: netReturnPct,
    win_rate: winRate,
    avg_R: avgR,
    sharpe,
    mdd_pct: mdd * 100,
    fee_drag_pct: feeDragPct,
    trades_per_year: tradesPerYear,
    monthly_pnl: monthly,
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));

  const endMs = args.end ? new Date(args.end).getTime() : Date.now();
  const startMs = args.start
    ? new Date(args.start).getTime()
    : endMs - args.months * 30 * 24 * 60 * 60 * 1000;

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Execute — Backtest");
  console.log(`  Symbol     : ${args.symbol}`);
  console.log(`  Interval   : ${args.interval}`);
  console.log(`  Range      : ${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}`);
  console.log(`  Per-side fee: ${(args.fee * 100).toFixed(3)}%`);
  console.log(`  Strategy   : ${rules.strategy.name}`);
  console.log("═══════════════════════════════════════════════════════════");

  console.log("\nFetching klines (paginated)...");
  const candles = await fetchKlinesRange(args.symbol, args.interval, startMs, endMs);
  console.log(`  ${candles.length} candles fetched`);

  if (candles.length < 50) {
    console.log("\n⚠️  Not enough candles to backtest. Exiting.");
    process.exit(1);
  }

  console.log("\nWalking forward...");
  const trades = runBacktest(candles, rules, args.fee);
  console.log(`  ${trades.length} trades simulated`);

  const stats = summarize(trades, candles, args.fee);

  console.log("\n── Summary ──────────────────────────────────────────────\n");
  console.log(`  Trades              : ${stats.trades}`);
  console.log(`  Net return          : ${stats.net_return_pct.toFixed(2)}%`);
  console.log(`  Win rate            : ${(stats.win_rate * 100).toFixed(2)}%`);
  console.log(`  Avg R               : ${stats.avg_R.toFixed(2)}`);
  console.log(`  Sharpe (annualised) : ${stats.sharpe.toFixed(2)}`);
  console.log(`  Max drawdown        : ${stats.mdd_pct.toFixed(2)}%`);
  console.log(`  Fee drag            : ${stats.fee_drag_pct.toFixed(3)}%`);
  console.log(`  Trades / year       : ${stats.trades_per_year.toFixed(1)}`);
  console.log("\n  Phase 1 exit gate : Sharpe ≥ 1.0, MDD ≤ 25%, ≥ 30 trades/yr, win-rate non-negative when fees doubled");

  // Doubled-fee stress test
  const stressTrades = runBacktest(candles, rules, args.fee * 2);
  const stress = summarize(stressTrades, candles, args.fee * 2);
  console.log(`\n  Stress: at 2× fee  : net ${stress.net_return_pct.toFixed(2)}%, win-rate ${(stress.win_rate * 100).toFixed(2)}%`);

  // Per-trade CSV
  const stem = `backtest-${args.symbol}-${args.interval}-${new Date(startMs)
    .toISOString()
    .slice(0, 10)}`;
  const csvPath = `${args.outDir.replace(/\/$/, "")}/${stem}.csv`;
  const header =
    "EntryTime,ExitTime,Side,Entry,Exit,Stop,ExitReason,GrossPct,NetPct,R";
  const rows = trades.map((t) =>
    [
      t.entryTime,
      t.exitTime,
      t.side,
      t.entry.toFixed(2),
      t.exit.toFixed(2),
      t.stop.toFixed(2),
      t.reason,
      t.grossPct.toFixed(4),
      t.netPct.toFixed(4),
      t.rPnl.toFixed(3),
    ].join(","),
  );
  writeFileSync(csvPath, header + "\n" + rows.join("\n") + "\n");
  console.log(`\n  Per-trade CSV → ${csvPath}`);

  // Monthly P&L
  console.log("\n  Monthly P&L (% additive):");
  Object.entries(stats.monthly_pnl)
    .sort()
    .forEach(([m, pct]) => console.log(`    ${m}  ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`));

  console.log("\n═══════════════════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("Backtest error:", err);
  process.exit(1);
});
