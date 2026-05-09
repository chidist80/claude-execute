/**
 * Claude Execute — Backtest harness (Gap 7) — strategy-pluggable
 *
 * Loads a strategy module from ./strategies/<id>.js and replays it against
 * historical Binance USD-M Futures klines (free, no auth). Outputs per-trade
 * CSV + summary stats (Sharpe / MDD / win-rate / avg R / fee drag / monthly P&L
 * / 2× fee stress).
 *
 * Single-strategy mode:
 *   node backtest.js --strategy vwap-rsi-ema --symbol BTCUSDT --interval 4h --months 12
 *
 * Comparison mode (Phase 1 strategy validation):
 *   node backtest.js --compare
 *     Runs the full matrix of strategies × symbols × intervals defined below
 *     and emits a leaderboard plus a markdown report.
 */

import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";

const FAPI_BASE = process.env.BINANCE_FAPI_BASE_URL || "https://fapi.binance.com";

// ─── Args ────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = {
    strategy: "vwap-rsi-ema",
    symbol: process.env.SYMBOL || "BTCUSDT",
    interval: (process.env.TIMEFRAME || "4H").toLowerCase(),
    months: 12,
    fee: 0.0005,
    start: null,
    end: null,
    outDir: ".",
    compare: false,
    quiet: false,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--strategy") (args.strategy = v), i++;
    else if (a === "--symbol") (args.symbol = v), i++;
    else if (a === "--interval") (args.interval = v.toLowerCase()), i++;
    else if (a === "--months") (args.months = parseInt(v, 10)), i++;
    else if (a === "--fee") (args.fee = parseFloat(v)), i++;
    else if (a === "--start") (args.start = v), i++;
    else if (a === "--end") (args.end = v), i++;
    else if (a === "--out") (args.outDir = v), i++;
    else if (a === "--compare") args.compare = true;
    else if (a === "--quiet") args.quiet = true;
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
  "2h": 7_200_000,
  "4h": 14_400_000,
  "6h": 21_600_000,
  "8h": 28_800_000,
  "12h": 43_200_000,
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
        // Taker-buy base asset volume — needed by taker-flow strategy.
        takerBuyBase: parseFloat(k[9]),
      });
    }
    const lastTs = batch[batch.length - 1][0];
    if (lastTs <= cursor) break;
    cursor = lastTs + stepMs;
    await new Promise((r) => setTimeout(r, 60));
    if (out.length > 0 && out[out.length - 1].time >= endMs) break;
  }
  return out.filter((c) => c.time < endMs);
}

// ─── Stats ─────────────────────────────────────────────────────────────────

export function summarize(trades, fee) {
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

  const dayBuckets = new Map();
  for (const p of equityPath) dayBuckets.set(p.ts.slice(0, 10), p.equity);
  const dayKeys = Array.from(dayBuckets.keys()).sort();
  const dailyReturns = [];
  for (let i = 1; i < dayKeys.length; i++) {
    const prev = dayBuckets.get(dayKeys[i - 1]);
    const cur = dayBuckets.get(dayKeys[i]);
    if (prev > 0) dailyReturns.push((cur - prev) / prev);
  }
  let sharpe = 0;
  // Require ≥10 daily samples and a non-trivial std for a meaningful Sharpe.
  // Without these guards, a 5-trade run with near-identical small-loss days
  // can print a Sharpe of ±1e15 from std≈0, which is meaningless and mis-ranks
  // the leaderboard.
  if (dailyReturns.length >= 10) {
    const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const variance =
      dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) /
      (dailyReturns.length - 1);
    const std = Math.sqrt(variance);
    if (std > 1e-6) sharpe = (mean / std) * Math.sqrt(365);
  }

  const avgR = trades.reduce((a, t) => a + t.rPnl, 0) / total;

  const grossVol = trades.reduce(
    (a, t) => a + Math.abs(t.entry) + Math.abs(t.exit),
    0,
  );
  const feeDragPct = grossVol > 0 ? (grossVol * fee / grossVol) * 100 : 0;

  const spanMs =
    new Date(trades[total - 1].exitTime).getTime() -
    new Date(trades[0].entryTime).getTime();
  const years = spanMs / (365 * 24 * 60 * 60 * 1000);
  const tradesPerYear = years > 0 ? total / years : total;

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

// ─── Strategy loader ────────────────────────────────────────────────────────

async function loadStrategy(id) {
  const mod = await import(`./strategies/${id}.js`);
  return mod;
}

// ─── Single-run ────────────────────────────────────────────────────────────

async function runSingle(opts) {
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  const strat = await loadStrategy(opts.strategy);

  const endMs = opts.end ? new Date(opts.end).getTime() : Date.now();
  const startMs = opts.start
    ? new Date(opts.start).getTime()
    : endMs - opts.months * 30 * 24 * 60 * 60 * 1000;

  if (!opts.quiet) {
    console.log("═══════════════════════════════════════════════════════════");
    console.log(`  Strategy   : ${strat.meta.name} (${strat.meta.id})`);
    console.log(`  Symbol     : ${opts.symbol}`);
    console.log(`  Interval   : ${opts.interval}`);
    console.log(
      `  Range      : ${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}`,
    );
    console.log(`  Per-side fee: ${(opts.fee * 100).toFixed(3)}%`);
    console.log("═══════════════════════════════════════════════════════════");
  }

  const candles = await fetchKlinesRange(opts.symbol, opts.interval, startMs, endMs);
  if (!opts.quiet) console.log(`  ${candles.length} candles fetched`);

  if (candles.length < 50) {
    if (!opts.quiet) console.log("\n⚠️  Not enough candles to backtest.");
    return null;
  }

  const aux = strat.loadAuxData
    ? await strat.loadAuxData({ symbol: opts.symbol, startMs, endMs })
    : {};

  const trades = strat.runBacktest({ candles, aux, rules, fee: opts.fee });
  if (!opts.quiet) console.log(`  ${trades.length} trades simulated`);

  const stats = summarize(trades, opts.fee);

  // 2x-fee stress
  const stressTrades = strat.runBacktest({ candles, aux, rules, fee: opts.fee * 2 });
  const stress = summarize(stressTrades, opts.fee * 2);

  if (!opts.quiet) {
    console.log("\n── Summary ──────────────────────────────────────────────\n");
    console.log(`  Trades              : ${stats.trades}`);
    console.log(`  Net return          : ${stats.net_return_pct.toFixed(2)}%`);
    console.log(`  Win rate            : ${(stats.win_rate * 100).toFixed(2)}%`);
    console.log(`  Avg R               : ${stats.avg_R.toFixed(2)}`);
    console.log(`  Sharpe (annualised) : ${stats.sharpe.toFixed(2)}`);
    console.log(`  Max drawdown        : ${stats.mdd_pct.toFixed(2)}%`);
    console.log(`  Fee drag            : ${stats.fee_drag_pct.toFixed(3)}%`);
    console.log(`  Trades / year       : ${stats.trades_per_year.toFixed(1)}`);
    console.log(`\n  Stress: at 2× fee  : net ${stress.net_return_pct.toFixed(2)}%, win-rate ${(stress.win_rate * 100).toFixed(2)}%`);

    const stem = `backtest-${opts.strategy}-${opts.symbol}-${opts.interval}-${new Date(startMs).toISOString().slice(0, 10)}`;
    const csvPath = `${opts.outDir.replace(/\/$/, "")}/${stem}.csv`;
    const header = "EntryTime,ExitTime,Side,Entry,Exit,Stop,ExitReason,GrossPct,NetPct,R";
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
    console.log("\n═══════════════════════════════════════════════════════════\n");
  }

  return { stats, stress, trades };
}

// ─── Compare matrix ────────────────────────────────────────────────────────

const COMPARE_MATRIX = [
  // [strategyId, symbol, interval]
  ["vwap-rsi-ema", "BTCUSDT", "4h"],
  ["vwap-rsi-ema", "ETHUSDT", "4h"],
  ["vwap-rsi-ema", "SOLUSDT", "4h"],
  ["vwap-rsi-ema", "BTCUSDT", "1h"],
  ["vwap-rsi-ema", "ETHUSDT", "1h"],
  ["vwap-rsi-ema", "SOLUSDT", "1h"],

  ["funding-mean-revert", "BTCUSDT", "1h"],
  ["funding-mean-revert", "ETHUSDT", "1h"],
  ["funding-mean-revert", "SOLUSDT", "1h"],

  ["taker-flow-momentum", "BTCUSDT", "4h"],
  ["taker-flow-momentum", "ETHUSDT", "4h"],
  ["taker-flow-momentum", "SOLUSDT", "4h"],
  ["taker-flow-momentum", "BTCUSDT", "1h"],
  ["taker-flow-momentum", "ETHUSDT", "1h"],
  ["taker-flow-momentum", "SOLUSDT", "1h"],
];

function passesGate(stats, stress) {
  return (
    stats.sharpe >= 1.0 &&
    stats.mdd_pct <= 25.0 &&
    stats.trades_per_year >= 30 &&
    stress.net_return_pct > 0
  );
}

async function runCompare(opts) {
  const results = [];
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Phase 1 strategy comparison`);
  console.log(`  Months back : ${opts.months}`);
  console.log(`  Per-side fee: ${(opts.fee * 100).toFixed(3)}%`);
  console.log(`  Matrix size : ${COMPARE_MATRIX.length} runs`);
  console.log("═══════════════════════════════════════════════════════════\n");

  for (const [strategy, symbol, interval] of COMPARE_MATRIX) {
    process.stdout.write(`  ${strategy.padEnd(22)} ${symbol.padEnd(8)} ${interval.padEnd(4)} ... `);
    const t0 = Date.now();
    try {
      const r = await runSingle({ ...opts, strategy, symbol, interval, quiet: true });
      if (!r) {
        console.log("(no data)");
        continue;
      }
      const ms = Date.now() - t0;
      const gate = passesGate(r.stats, r.stress);
      console.log(
        `${r.stats.trades.toString().padStart(4)} trades | net ${r.stats.net_return_pct.toFixed(2).padStart(7)}% | Sharpe ${r.stats.sharpe.toFixed(2).padStart(5)} | MDD ${r.stats.mdd_pct.toFixed(2).padStart(5)}% | t/yr ${r.stats.trades_per_year.toFixed(0).padStart(3)} | 2×fee ${r.stress.net_return_pct.toFixed(2).padStart(7)}% | ${gate ? "✅ GATE" : "❌"} (${ms}ms)`,
      );
      results.push({
        strategy,
        symbol,
        interval,
        stats: r.stats,
        stress: r.stress,
        gate,
      });
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
    }
  }

  // Group by strategy and emit a markdown comparison report
  console.log("\n── Leaderboard (passes gate first, then by Sharpe) ─────\n");
  const sorted = results.slice().sort((a, b) => {
    if (a.gate !== b.gate) return a.gate ? -1 : 1;
    return b.stats.sharpe - a.stats.sharpe;
  });
  for (const r of sorted.slice(0, 10)) {
    console.log(
      `  ${r.gate ? "✅" : "  "} ${r.strategy.padEnd(22)} ${r.symbol.padEnd(8)} ${r.interval.padEnd(4)}  Sharpe ${r.stats.sharpe.toFixed(2).padStart(5)} | net ${r.stats.net_return_pct.toFixed(2).padStart(7)}% | MDD ${r.stats.mdd_pct.toFixed(2).padStart(5)}%`,
    );
  }

  // Write a JSON dump for machine consumption + a markdown report
  writeFileSync(
    "phase-1-comparison.json",
    JSON.stringify({ generatedAt: new Date().toISOString(), opts: { months: opts.months, fee: opts.fee }, results }, null, 2),
  );
  console.log("\n  Full results → phase-1-comparison.json");

  return results;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  if (args.compare) {
    await runCompare(args);
  } else {
    await runSingle(args);
  }
}

main().catch((err) => {
  console.error("Backtest error:", err);
  process.exit(1);
});
