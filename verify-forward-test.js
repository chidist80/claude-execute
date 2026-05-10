/**
 * Forward-test verifier
 *
 * For each day in the bot's recent decision log, check whether the
 * strategy module would have made the same decision when run against the
 * historical klines for that day. Used during the 30-day paper-trade
 * forward test (Phase 2 prerequisite per STRATEGY.md) to surface any
 * wiring drift between bot.js and the chosen strategy module.
 *
 * Pass criterion: strategy decision matches bot decision on every day.
 *
 * Usage:
 *   node verify-forward-test.js
 *   node verify-forward-test.js --days 14
 *   node verify-forward-test.js --strategy vwap-rsi-ema --symbol BTCUSDT --interval 1d --days 30
 *
 * Exit codes:
 *   0 — all days match
 *   1 — at least one day diverged (review the table; investigate)
 *   2 — could not run (missing log, no strategy, etc.)
 */

import "dotenv/config";
import { readFileSync, existsSync } from "fs";

const FAPI_BASE = process.env.BINANCE_FAPI_BASE_URL || "https://fapi.binance.com";
const LOG_FILE = "safety-check-log.json";

function parseArgs() {
  const args = {
    strategy: process.env.STRATEGY || "vwap-rsi-ema",
    symbol: process.env.SYMBOL || "BTCUSDT",
    interval: (process.env.TIMEFRAME || "1D").toLowerCase(),
    days: 30,
    fee: 0.0005,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--strategy") (args.strategy = v), i++;
    else if (a === "--symbol") (args.symbol = v), i++;
    else if (a === "--interval") (args.interval = v.toLowerCase()), i++;
    else if (a === "--days") (args.days = parseInt(v, 10)), i++;
    else if (a === "--fee") (args.fee = parseFloat(v)), i++;
  }
  return args;
}

const INTERVAL_MS = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

async function fetchClosedKlines(symbol, interval, startMs, endMs) {
  const stepMs = INTERVAL_MS[interval];
  if (!stepMs) throw new Error(`Unsupported interval: ${interval}`);
  const out = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `${FAPI_BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&limit=1500`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`klines HTTP ${r.status}`);
    const batch = await r.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const k of batch) {
      // closeTime <= now → fully closed candle. Filters out the still-open one.
      if (k[6] <= Date.now()) {
        out.push({
          time: k[0],
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
          takerBuyBase: parseFloat(k[9]),
          closeTime: k[6],
        });
      }
    }
    const lastTs = batch[batch.length - 1][0];
    if (lastTs <= cursor) break;
    cursor = lastTs + stepMs;
    await new Promise((r) => setTimeout(r, 60));
  }
  return out.filter((c) => c.time < endMs);
}

async function main() {
  const args = parseArgs();

  if (!existsSync(LOG_FILE)) {
    console.error(`No ${LOG_FILE} — bot has not run yet. Nothing to verify.`);
    process.exit(2);
  }
  const log = JSON.parse(readFileSync(LOG_FILE, "utf8"));
  const allEntries = (log.trades || []).filter((e) => e.timestamp && !e.haltedByDrawdownLimits);

  if (allEntries.length === 0) {
    console.error(`No decision entries in ${LOG_FILE}. Has the bot fired yet?`);
    process.exit(2);
  }

  // Dedupe to ONE entry per day (the latest run on each calendar UTC day).
  const byDay = new Map();
  for (const e of allEntries) {
    const day = e.timestamp.slice(0, 10);
    const existing = byDay.get(day);
    if (!existing || e.timestamp > existing.timestamp) byDay.set(day, e);
  }
  const cutoff = Date.now() - args.days * 24 * 60 * 60 * 1000;
  const recent = Array.from(byDay.entries())
    .filter(([day]) => new Date(day + "T23:59:59Z").getTime() >= cutoff)
    .sort()
    .map(([, entry]) => entry);

  if (recent.length === 0) {
    console.log(`No bot decisions in the last ${args.days} days.`);
    process.exit(0);
  }

  const strat = await import(`./strategies/${args.strategy}.js`);
  if (!strat.runBacktest) {
    console.error(`Strategy ${args.strategy} has no runBacktest export.`);
    process.exit(2);
  }
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));

  // Fetch enough closed klines to give the strategy warmup + the verification window.
  // 60 days warmup is plenty for indicators (longest is EMA(8) on 1D).
  const startMs = cutoff - 60 * 24 * 60 * 60 * 1000;
  const candles = await fetchClosedKlines(args.symbol, args.interval, startMs, Date.now());
  const aux = strat.loadAuxData
    ? await strat.loadAuxData({ symbol: args.symbol, startMs, endMs: Date.now() })
    : {};
  const stratTrades = strat.runBacktest({ candles, aux, rules, fee: args.fee });

  // Build per-day strategy decision: did the strategy enter or exit on this UTC date?
  const stratByDay = new Map();
  for (const t of stratTrades) {
    const entryDay = t.entryTime.slice(0, 10);
    const exitDay = t.exitTime.slice(0, 10);
    const cur = stratByDay.get(entryDay) || {};
    stratByDay.set(entryDay, { ...cur, entry: t.side });
    const cur2 = stratByDay.get(exitDay) || {};
    stratByDay.set(exitDay, { ...cur2, exit: t.reason });
  }

  console.log("\n══════════════════════════════════════════════════════════════════════");
  console.log(`  Forward-test verification`);
  console.log(`  Strategy : ${strat.meta?.name || args.strategy}`);
  console.log(`  Symbol   : ${args.symbol} ${args.interval}`);
  console.log(`  Window   : last ${args.days} days, ${recent.length} bot decisions`);
  console.log("══════════════════════════════════════════════════════════════════════\n");
  console.log("  Day         Bot decision         Strategy decision    Match");
  console.log("  ──────────  ───────────────────  ───────────────────  ─────");

  let matches = 0;
  let diverges = 0;
  for (const e of recent) {
    const day = e.timestamp.slice(0, 10);
    const botDecision = e.allPass
      ? `OPEN-${(e.bias || "?").toUpperCase()}`
      : `NO-TRADE (${e.bias || "neutral"})`;

    const sd = stratByDay.get(day);
    const stratDecision = sd?.entry
      ? `OPEN-${sd.entry.toUpperCase()}`
      : sd?.exit
        ? `EXIT (${sd.exit})`
        : "NO-ENTRY";

    // Match logic: an OPEN bot decision should correspond to an OPEN strat entry on the same side.
    // A NO-TRADE bot decision matches NO-ENTRY or EXIT (both non-entries).
    const botOpened = botDecision.startsWith("OPEN-");
    const stratOpened = stratDecision.startsWith("OPEN-");
    let match;
    if (botOpened && stratOpened) {
      match = botDecision.split("-")[1].split(" ")[0] === stratDecision.split("-")[1];
    } else {
      match = botOpened === stratOpened;
    }
    if (match) matches++;
    else diverges++;

    console.log(
      `  ${day}  ${botDecision.padEnd(19)}  ${stratDecision.padEnd(19)}  ${match ? "✅" : "❌"}`,
    );
  }

  console.log(`\n  Matches: ${matches} / ${recent.length}   Diverges: ${diverges}`);
  if (diverges === 0) {
    console.log(`\n  ✅ Forward test verified — bot and strategy agree on every day.\n`);
    process.exit(0);
  } else {
    console.log(
      `\n  ❌ Divergences found. Investigate before flipping PAPER_TRADING=false.\n` +
        `     Common causes: bot ran before today's daily candle closed; rules.json edited\n` +
        `     between bot run and verifier run; strategy module updated since.\n`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Verifier error:", err);
  process.exit(2);
});
