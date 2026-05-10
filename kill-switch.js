/**
 * Kill switch — emergency operations
 *
 * Cancels all open orders AND flattens all open positions for the configured
 * symbol on Binance USD-M Futures. Self-contained (no bot.js import) so it
 * runs regardless of bot state.
 *
 * Usage:
 *   node kill-switch.js                  # uses .env config; cancels + flattens SYMBOL
 *   node kill-switch.js --symbol BTCUSDT # override symbol
 *   node kill-switch.js --all-symbols    # flatten EVERY open position (be careful)
 *   node kill-switch.js --cancel-only    # only cancel orders, don't close positions
 *   node kill-switch.js --dry-run        # show what would happen, don't send
 *
 * Operationally: wire this to a host alert (e.g. PagerDuty webhook). Test it on
 * testnet first. Run it via Railway one-shot if the cron service is misbehaving.
 */

import "dotenv/config";
import crypto from "crypto";

const FAPI = process.env.BINANCE_FAPI_BASE_URL || "https://fapi.binance.com";
const API_KEY = process.env.BINANCE_API_KEY;
const SECRET = process.env.BINANCE_SECRET_KEY;

if (!API_KEY || !SECRET) {
  console.error("Missing BINANCE_API_KEY / BINANCE_SECRET_KEY — refusing to run.");
  process.exit(2);
}

function parseArgs() {
  const args = {
    symbol: process.env.SYMBOL || "BTCUSDT",
    allSymbols: false,
    cancelOnly: false,
    dryRun: false,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--symbol") (args.symbol = v), i++;
    else if (a === "--all-symbols") args.allSymbols = true;
    else if (a === "--cancel-only") args.cancelOnly = true;
    else if (a === "--dry-run") args.dryRun = true;
  }
  return args;
}

function signQuery(params) {
  const qs = new URLSearchParams(params).toString();
  const sig = crypto.createHmac("sha256", SECRET).update(qs).digest("hex");
  return `${qs}&signature=${sig}`;
}

async function signedRequest(path, method, params = {}) {
  const fullParams = { ...params, timestamp: Date.now(), recvWindow: 5000 };
  const url = `${FAPI}${path}?${signQuery(fullParams)}`;
  const res = await fetch(url, {
    method,
    headers: { "X-MBX-APIKEY": API_KEY },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path} non-JSON: ${text}`);
  }
  if (!res.ok || (data && data.code && data.code < 0)) {
    throw new Error(`${method} ${path} ${res.status}: ${text}`);
  }
  return data;
}

async function main() {
  const args = parseArgs();
  const banner = args.dryRun ? "DRY RUN" : "LIVE";
  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log(`  KILL SWITCH (${banner})`);
  console.log(`  Symbol scope : ${args.allSymbols ? "ALL OPEN POSITIONS" : args.symbol}`);
  console.log(`  Mode         : ${args.cancelOnly ? "cancel orders only" : "cancel + flatten"}`);
  console.log(`══════════════════════════════════════════════════════════════════════\n`);

  // 1. Find positions
  const positionRisk = await signedRequest("/fapi/v2/positionRisk", "GET");
  const openPositions = positionRisk.filter((p) => parseFloat(p.positionAmt) !== 0);
  if (args.allSymbols) {
    console.log(`  ${openPositions.length} open position(s) across all symbols:`);
    for (const p of openPositions) {
      console.log(
        `    ${p.symbol.padEnd(12)} ${p.positionAmt.padStart(12)} @ entry ${parseFloat(p.entryPrice).toFixed(2)}  uPnL ${parseFloat(p.unRealizedProfit).toFixed(2)}`,
      );
    }
  } else {
    const p = openPositions.find((x) => x.symbol === args.symbol);
    if (p) {
      console.log(
        `  ${p.symbol} position: ${p.positionAmt} @ entry ${parseFloat(p.entryPrice).toFixed(2)}  uPnL ${parseFloat(p.unRealizedProfit).toFixed(2)}`,
      );
    } else {
      console.log(`  ${args.symbol}: no open position`);
    }
  }

  // 2. Cancel open orders
  const symbolsToProcess = args.allSymbols
    ? Array.from(new Set([...openPositions.map((p) => p.symbol), args.symbol]))
    : [args.symbol];

  console.log(`\n  Cancelling open orders on: ${symbolsToProcess.join(", ")}`);
  for (const sym of symbolsToProcess) {
    if (args.dryRun) {
      console.log(`    [DRY] DELETE /fapi/v1/allOpenOrders?symbol=${sym}`);
      continue;
    }
    try {
      await signedRequest("/fapi/v1/allOpenOrders", "DELETE", { symbol: sym });
      console.log(`    ✅ cancelled ${sym}`);
    } catch (err) {
      console.log(`    ⚠️  ${sym}: ${err.message}`);
    }
  }

  if (args.cancelOnly) {
    console.log(`\n  --cancel-only set. Positions left untouched.\n`);
    return;
  }

  // 3. Close positions with reduceOnly market orders
  const positionsToClose = args.allSymbols
    ? openPositions
    : openPositions.filter((p) => p.symbol === args.symbol);

  if (positionsToClose.length === 0) {
    console.log(`\n  No positions to close.\n`);
    return;
  }

  console.log(`\n  Flattening ${positionsToClose.length} position(s):`);
  for (const p of positionsToClose) {
    const amt = parseFloat(p.positionAmt);
    const side = amt > 0 ? "SELL" : "BUY"; // close long with SELL, short with BUY
    const quantity = Math.abs(amt).toString();
    if (args.dryRun) {
      console.log(`    [DRY] POST /fapi/v1/order ${p.symbol} ${side} ${quantity} reduceOnly`);
      continue;
    }
    try {
      const order = await signedRequest("/fapi/v1/order", "POST", {
        symbol: p.symbol,
        side,
        type: "MARKET",
        quantity,
        reduceOnly: "true",
      });
      console.log(`    ✅ ${p.symbol} flattened — order ${order.orderId}`);
    } catch (err) {
      console.log(`    ❌ ${p.symbol}: ${err.message}`);
    }
  }

  console.log(`\n  Kill switch complete.\n`);
}

main().catch((err) => {
  console.error("Kill-switch error:", err.message);
  process.exit(1);
});
