/**
 * Claude Execute — Binance USD-M Futures Lead Trader bot
 *
 * Cloud mode: runs on Railway on a cron schedule. Pulls candle data direct from
 * Binance public API (free, no auth), calculates indicators, runs safety check,
 * executes via Binance USD-M Futures (signed, optionally Lead Trader copy key).
 *
 * Local mode: run manually — node bot.js
 * Cloud mode: deploy to Railway (Pro for static outbound IP), set env vars, cron schedule.
 *
 * Designed for the Binance Lead Trader Copy Trading API (Phase 3+). Constraints:
 *   - USDT margin only, Single-Asset Mode (Multi-Assets banned)
 *   - Symbol must be on the dynamic whitelist (/sapi/v1/copyTrading/futures/leadSymbol)
 *   - No TRAILING_STOP_MARKET orders (bot manages stops itself)
 *   - Order rate limit: 20 per 10 seconds
 *   - IP whitelist mandatory on the API key
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["BINANCE_API_KEY", "BINANCE_SECRET_KEY"];
  const missing = required.filter((k) => !process.env[k]);

  if (!existsSync(".env")) {
    console.log(
      "\n⚠️  No .env file found — opening it for you to fill in...\n",
    );
    writeFileSync(
      ".env",
      [
        "# Binance USD-M Futures credentials (no passphrase — Binance doesn't use one)",
        "# Restrict the key to: Enable Reading + Enable Futures. Withdrawals OFF.",
        "# Lead Trader keys also require IP whitelist ON (Railway Pro static IP).",
        "BINANCE_API_KEY=",
        "BINANCE_SECRET_KEY=",
        "",
        "# API base URLs — defaults are mainnet. Override for testnet:",
        "#   BINANCE_FAPI_BASE_URL=https://testnet.binancefuture.com",
        "# (testnet has no /sapi copy-trading endpoints; the bot auto-skips them)",
        "BINANCE_FAPI_BASE_URL=https://fapi.binance.com",
        "BINANCE_SAPI_BASE_URL=https://api.binance.com",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "SYMBOL=BTCUSDT",
        "TIMEFRAME=4H",
      ].join("\n") + "\n",
    );
    try {
      execSync("open .env");
    } catch {}
    console.log(
      "Fill in your Binance Futures credentials in .env then re-run: node bot.js\n",
    );
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
    console.log("Opening .env for you now...\n");
    try {
      execSync("open .env");
    } catch {}
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }

  // Always print the CSV location so users know where to find their trade log
  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

const FAPI_BASE = process.env.BINANCE_FAPI_BASE_URL || "https://fapi.binance.com";
const SAPI_BASE = process.env.BINANCE_SAPI_BASE_URL || "https://api.binance.com";
const IS_TESTNET = /testnet/i.test(FAPI_BASE);

const CONFIG = {
  symbol: process.env.SYMBOL || "BTCUSDT",
  timeframe: process.env.TIMEFRAME || "4H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  binance: {
    apiKey: process.env.BINANCE_API_KEY,
    secretKey: process.env.BINANCE_SECRET_KEY,
    fapiBase: FAPI_BASE,
    sapiBase: SAPI_BASE,
    testnet: IS_TESTNET,
    recvWindow: 5000,
  },
};

const LOG_FILE = "safety-check-log.json";
const EQUITY_FILE = "equity-history.json";

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

function loadEquityHistory() {
  if (!existsSync(EQUITY_FILE)) return { samples: [] };
  return JSON.parse(readFileSync(EQUITY_FILE, "utf8"));
}

function saveEquityHistory(hist) {
  writeFileSync(EQUITY_FILE, JSON.stringify(hist, null, 2));
}

// ─── Market Data (Binance Futures public API — free, no auth) ───────────────

async function fetchCandles(symbol, interval, limit = 100) {
  const intervalMap = {
    "1m": "1m",
    "3m": "3m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "1H": "1h",
    "4H": "4h",
    "1D": "1d",
    "1W": "1w",
  };
  const binanceInterval = intervalMap[interval] || "1m";

  // Futures klines, NOT spot — must be fapi.binance.com/fapi/v1/klines
  const url = `${CONFIG.binance.fapiBase}/fapi/v1/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance klines error: ${res.status}`);
  const data = await res.json();

  return data.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// VWAP — session-based, resets at midnight UTC
function calcVWAP(candles) {
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (sessionCandles.length === 0) return null;
  const cumTPV = sessionCandles.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume,
    0,
  );
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ─── Safety Check ───────────────────────────────────────────────────────────

function runSafetyCheck(price, ema8, vwap, rsi3, rules) {
  const results = [];
  let bias = "neutral";

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check ─────────────────────────────────────────\n");

  const bullishBias = price > vwap && price > ema8;
  const bearishBias = price < vwap && price < ema8;

  if (bullishBias) {
    bias = "long";
    console.log("  Bias: BULLISH — checking long entry conditions\n");

    check(
      "Price above VWAP (buyers in control)",
      `> ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price > vwap,
    );
    check(
      "Price above EMA(8) (uptrend confirmed)",
      `> ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price > ema8,
    );
    check(
      "RSI(3) below 30 (snap-back setup in uptrend)",
      "< 30",
      rsi3.toFixed(2),
      rsi3 < 30,
    );

    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else if (bearishBias) {
    bias = "short";
    console.log("  Bias: BEARISH — checking short entry conditions\n");

    check(
      "Price below VWAP (sellers in control)",
      `< ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price < vwap,
    );
    check(
      "Price below EMA(8) (downtrend confirmed)",
      `< ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price < ema8,
    );
    check(
      "RSI(3) above 70 (reversal setup in downtrend)",
      "> 70",
      rsi3.toFixed(2),
      rsi3 > 70,
    );

    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else {
    console.log("  Bias: NEUTRAL — no clear direction. No trade.\n");
    results.push({
      label: "Market bias",
      required: "Bullish or bearish",
      actual: "Neutral",
      pass: false,
    });
  }

  const allPass = results.every((r) => r.pass);
  return { results, allPass, bias };
}

// ─── Trade Sizing ────────────────────────────────────────────────────────────
//
// Risk-based sizing: target a fixed % of portfolio at risk per trade, then
// derive the position notional from the strategy's stop distance. This is the
// standard sizing for systematic strategies and is what "risk maximum 1% of
// portfolio per trade" in rules.json::risk_rules actually means.
//
//   risk_per_trade_usd = portfolio × risk_per_trade_pct
//   position_usd       = risk_per_trade_usd / (stop_loss_pct / 100)
//   tradeSize          = min(position_usd, portfolio × max_leverage, MAX_TRADE_SIZE_USD)
//
// The previous behaviour (`min(portfolio × 0.01, maxTradeSizeUSD)`) sized the
// POSITION at 1% of portfolio, not the RISK at 1%. For a 0.3% stop that is
// 333× under-sized and produced sub-tick quantities on majors like BTC.

function computeTradeSize(rules) {
  const stopPct = rules?.risk_limits?.stop_loss_pct ?? 0.3;
  const riskPct = parseFloat(process.env.RISK_PER_TRADE_PCT || "1.0");
  const maxLeverage = rules?.risk_limits?.max_leverage ?? 5;

  const riskUSD = (CONFIG.portfolioValue * riskPct) / 100;
  const positionByRisk = riskUSD / (stopPct / 100);
  const positionByLeverage = CONFIG.portfolioValue * maxLeverage;
  const tradeSize = Math.min(
    positionByRisk,
    positionByLeverage,
    CONFIG.maxTradeSizeUSD,
  );
  return {
    tradeSize,
    riskUSD,
    stopPct,
    riskPct,
    maxLeverage,
    cappedBy:
      tradeSize === positionByRisk
        ? "risk"
        : tradeSize === positionByLeverage
          ? "leverage"
          : "maxTradeSizeUSD",
  };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log, rules) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }

  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );

  const sz = computeTradeSize(rules);
  console.log(
    `✅ Trade size: $${sz.tradeSize.toFixed(2)} — risk $${sz.riskUSD.toFixed(2)} (${sz.riskPct}% of portfolio) at ${sz.stopPct}% stop, capped by ${sz.cappedBy}`,
  );

  return true;
}

// ─── Drawdown Circuit Breaker (Gap 11) ────────────────────────────────────

function checkDrawdownHalt(rules, equityHist) {
  const limits = rules.risk_limits;
  if (!limits || !limits.halt_on_trip) return { halt: false, reasons: [] };

  const now = Date.now();
  const samples = (equityHist.samples || []).filter(
    (s) => now - new Date(s.ts).getTime() < 7 * 24 * 60 * 60 * 1000,
  );
  if (samples.length < 2) return { halt: false, reasons: [] };

  const reasons = [];

  // 1-day P&L %
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  const dayWindow = samples.filter((s) => new Date(s.ts).getTime() >= oneDayAgo);
  if (dayWindow.length >= 2) {
    const start = dayWindow[0].equity;
    const end = dayWindow[dayWindow.length - 1].equity;
    const dayPct = ((end - start) / start) * 100;
    console.log(`  1-day P&L: ${dayPct.toFixed(2)}%`);
    if (dayPct < -Math.abs(limits.max_daily_loss_pct)) {
      reasons.push(
        `1-day P&L ${dayPct.toFixed(2)}% breaches max_daily_loss_pct ${limits.max_daily_loss_pct}%`,
      );
    }
  }

  // 7-day MDD: largest peak-to-trough drawdown over the window
  let peak = samples[0].equity;
  let mdd = 0;
  for (const s of samples) {
    if (s.equity > peak) peak = s.equity;
    const dd = ((peak - s.equity) / peak) * 100;
    if (dd > mdd) mdd = dd;
  }
  console.log(`  7-day MDD: ${mdd.toFixed(2)}%`);
  if (mdd > Math.abs(limits.max_7d_drawdown_pct)) {
    reasons.push(
      `7-day MDD ${mdd.toFixed(2)}% breaches max_7d_drawdown_pct ${limits.max_7d_drawdown_pct}%`,
    );
  }

  return { halt: reasons.length > 0, reasons };
}

// ─── Binance Futures Signed Request Layer ────────────────────────────────

function signQuery(params) {
  const qs = new URLSearchParams(params).toString();
  const sig = crypto
    .createHmac("sha256", CONFIG.binance.secretKey)
    .update(qs)
    .digest("hex");
  return `${qs}&signature=${sig}`;
}

async function signedRequest(base, path, method, params = {}) {
  const fullParams = {
    ...params,
    timestamp: Date.now(),
    recvWindow: CONFIG.binance.recvWindow,
  };
  const qs = signQuery(fullParams);
  const url = `${base}${path}?${qs}`;
  const res = await fetch(url, {
    method,
    headers: { "X-MBX-APIKEY": CONFIG.binance.apiKey },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Binance ${method} ${path} non-JSON response: ${text}`);
  }
  if (!res.ok || (data && data.code && data.code < 0)) {
    throw new Error(`Binance ${method} ${path} ${res.status}: ${text}`);
  }
  return data;
}

const fapiSigned = (path, method, params) =>
  signedRequest(CONFIG.binance.fapiBase, path, method, params);
const sapiSigned = (path, method, params) =>
  signedRequest(CONFIG.binance.sapiBase, path, method, params);

// ─── Lead Trader Startup Checks (Gaps 2, 3, 4) ──────────────────────────────

async function assertSingleAssetMode() {
  // Gap 4: Multi-Assets Mode is forbidden for copy trading API keys.
  const data = await fapiSigned("/fapi/v1/multiAssetsMargin", "GET");
  if (data.multiAssetsMargin === true) {
    throw new Error(
      "Account is in Multi-Assets Mode. Lead Trader / Copy Trading requires Single-Asset Mode. " +
        "Switch on Binance: Futures → Preferences → Asset Mode → Single-Asset.",
    );
  }
  console.log("  ✅ Single-Asset Mode confirmed");
}

async function assertLeadTraderEnabled() {
  // Gap 2: Refuse to run if the API key isn't on a lead portfolio.
  if (CONFIG.binance.testnet) {
    console.log("  ⏭  Skipping lead-trader status check (testnet has no /sapi)");
    return;
  }
  let data;
  try {
    data = await sapiSigned("/sapi/v1/copyTrading/futures/userStatus", "GET");
  } catch (err) {
    // During Phase 2 (regular Futures account, not lead portfolio), this endpoint
    // returns an error / 403. That's expected. Refuse to run only if explicitly
    // expecting Lead Trader mode (BINANCE_REQUIRE_LEAD_TRADER=true).
    if (process.env.BINANCE_REQUIRE_LEAD_TRADER === "true") {
      throw new Error(
        `Lead-trader status check failed and BINANCE_REQUIRE_LEAD_TRADER=true: ${err.message}`,
      );
    }
    console.log(
      "  ⏭  Lead-trader status endpoint not callable (regular Futures key — Phase 2). " +
        "Set BINANCE_REQUIRE_LEAD_TRADER=true once on a Lead key.",
    );
    return;
  }
  if (data.isLeadTrader !== true) {
    throw new Error(
      `Lead-trader status check failed (isLeadTrader=${data.isLeadTrader}). ` +
        "This API key is not on a Lead portfolio. Aborting.",
    );
  }
  console.log("  ✅ Lead-trader status confirmed");
}

async function validateSymbolWhitelist(symbol) {
  // Gap 3: Validate SYMBOL against the dynamic Lead Trader whitelist each run.
  if (CONFIG.binance.testnet) {
    console.log("  ⏭  Skipping symbol whitelist check (testnet has no /sapi)");
    return;
  }
  if (process.env.BINANCE_REQUIRE_LEAD_TRADER !== "true") {
    console.log(
      "  ⏭  Skipping symbol whitelist check (BINANCE_REQUIRE_LEAD_TRADER is not true)",
    );
    return;
  }
  const data = await sapiSigned("/sapi/v1/copyTrading/futures/leadSymbol", "GET");
  // Defensive parse: Binance returns the list under .data, sometimes as objects with .symbol
  const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
  const symbols = list.map((e) => (typeof e === "string" ? e : e.symbol)).filter(Boolean);
  if (!symbols.includes(symbol)) {
    throw new Error(
      `SYMBOL ${symbol} is not on the Lead Trader whitelist. ` +
        `Whitelisted (first 10): ${symbols.slice(0, 10).join(", ")}…`,
    );
  }
  console.log(`  ✅ ${symbol} is on the Lead Trader whitelist`);
}

async function setLeverage(symbol, leverage) {
  await fapiSigned("/fapi/v1/leverage", "POST", { symbol, leverage });
  console.log(`  ✅ Leverage set to ${leverage}x for ${symbol}`);
}

// ─── Order Throttle (Gap 6) ────────────────────────────────────────────────

const ORDER_RATE_LIMIT = 20; // 20 orders
const ORDER_RATE_WINDOW_MS = 10_000; // per 10 seconds
const orderTimestamps = [];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function throttleOrderSlot() {
  const now = Date.now();
  while (orderTimestamps.length && now - orderTimestamps[0] > ORDER_RATE_WINDOW_MS) {
    orderTimestamps.shift();
  }
  if (orderTimestamps.length >= ORDER_RATE_LIMIT) {
    const wait = ORDER_RATE_WINDOW_MS - (now - orderTimestamps[0]) + 50;
    console.log(`  ⏸  Order throttle: sleeping ${wait}ms to honour 20/10s limit`);
    await sleep(wait);
    return throttleOrderSlot();
  }
  orderTimestamps.push(Date.now());
}

// ─── Account / Position Helpers ────────────────────────────────────────────

async function fetchAccountEquity() {
  const data = await fapiSigned("/fapi/v2/account", "GET");
  const wallet = parseFloat(data.totalWalletBalance || "0");
  const upnl = parseFloat(data.totalUnrealizedProfit || "0");
  return { equity: wallet + upnl, walletBalance: wallet, unrealizedPnl: upnl };
}

async function getOpenPositions() {
  const data = await fapiSigned("/fapi/v2/positionRisk", "GET");
  return data.filter((p) => parseFloat(p.positionAmt) !== 0);
}

// ─── Binance Futures Order Placement (Gap 1) ──────────────────────────────

async function placeFuturesOrder(symbol, side, sizeUSD, price) {
  // side: "BUY" (open long, or close short) | "SELL" (open short, or close long)
  // Quantity is in base asset. Round to a sensible precision; per-symbol tickSize/stepSize
  // is enforced by Binance — we use 3 decimals as a safe default for BTCUSDT/ETHUSDT.
  // Production-grade rounding requires /fapi/v1/exchangeInfo lookup; that's a Phase 1 deliverable.
  const quantity = (sizeUSD / price).toFixed(3);

  await throttleOrderSlot();

  const params = {
    symbol,
    side,
    type: "MARKET",
    quantity,
  };
  return fapiSigned("/fapi/v1/order", "POST", params);
}

// ─── AUD Conversion (Gap 8) ───────────────────────────────────────────────

let _audRateCache = null;

// Primary: Frankfurter (ECB rates, no auth, free). Fallback: open.er-api.com.
const FX_SOURCES = [
  {
    name: "frankfurter.dev",
    url: "https://api.frankfurter.dev/v1/latest?base=USD&symbols=AUD",
    extract: (d) => d?.rates?.AUD,
  },
  {
    name: "open.er-api.com",
    url: "https://open.er-api.com/v6/latest/USD",
    extract: (d) => d?.rates?.AUD,
  },
];

async function getUsdToAudRate() {
  if (_audRateCache !== null) return _audRateCache;
  for (const src of FX_SOURCES) {
    try {
      const res = await fetch(src.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const rate = src.extract(data);
      if (typeof rate !== "number" || rate <= 0) throw new Error(`bad rate from ${src.name}: ${rate}`);
      _audRateCache = rate;
      console.log(`  💱 USD→AUD rate: ${rate.toFixed(4)} (${src.name})`);
      return rate;
    } catch (err) {
      console.log(`  ⚠️  ${src.name} failed: ${err.message}`);
    }
  }
  console.log(`  ⚠️  All FX sources failed — AUD columns will be blank for this run`);
  _audRateCache = 0; // sentinel: 0 means "unknown"
  return 0;
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";

const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "AUD Rate",
  "Price (AUD)",
  "Net (AUD)",
  "Order ID",
  "Mode",
  "Notes",
].join(",");

function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(
      `📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
    return;
  }
  // Migration: rewrite header if column count differs (we added AUD columns).
  // Existing rows are padded with empty AUD cells so prior history is preserved.
  const lines = readFileSync(CSV_FILE, "utf8").split("\n");
  if (lines.length === 0) return;
  const newCols = CSV_HEADERS.split(",").length;
  const oldCols = lines[0].split(",").length;
  if (oldCols === newCols) return;

  const padTarget = (line) => {
    if (!line) return line;
    // Existing rows had columns: ...Net Amount, Order ID, Mode, Notes
    // New rows have: ...Net Amount, AUD Rate, Price (AUD), Net (AUD), Order ID, Mode, Notes
    // Insert 3 blank cells before the last 3 (Order ID, Mode, Notes).
    const cols = line.split(",");
    if (cols.length === newCols) return line;
    if (cols.length === oldCols) {
      const head = cols.slice(0, oldCols - 3); // up to and including Net Amount
      const tail = cols.slice(oldCols - 3);    // Order ID, Mode, Notes
      return [...head, "", "", "", ...tail].join(",");
    }
    return line; // unknown shape — leave alone
  };

  const rewritten = [CSV_HEADERS, ...lines.slice(1).map(padTarget)].join("\n");
  writeFileSync(CSV_FILE, rewritten);
  console.log(
    `📄 Migrated ${CSV_FILE} header to include AUD columns (preserved ${lines.length - 1} prior rows).`,
  );
}

function writeTradeCsv(logEntry, audRate) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "";
  let quantity = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let priceAud = "";
  let netAud = "";
  let orderId = "";
  let mode = "";
  let notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else {
    side = logEntry.bias === "short" ? "SELL" : "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    // Binance USD-M Futures: ~0.04% maker / 0.05% taker. Use 0.05% for market orders.
    fee = (logEntry.tradeSize * 0.0005).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    if (audRate > 0) {
      priceAud = (logEntry.price * audRate).toFixed(2);
      netAud = (parseFloat(netAmount) * audRate).toFixed(2);
    }
    orderId = logEntry.orderId || "";
    mode = logEntry.paperTrading ? "PAPER" : "LIVE";
    notes = logEntry.error
      ? `Error: ${logEntry.error}`
      : "All conditions met";
  }

  const audRateCol = audRate > 0 ? audRate.toFixed(4) : "";

  const row = [
    date,
    time,
    "Binance-USDM",
    logEntry.symbol,
    side,
    quantity,
    logEntry.price.toFixed(2),
    totalUSD,
    fee,
    netAmount,
    audRateCol,
    priceAud,
    netAud,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  // Mode column is now at index 14 (was 11 — added 3 columns).
  const live = rows.filter((r) => r[14] === "LIVE");
  const paper = rows.filter((r) => r[14] === "PAPER");
  const blocked = rows.filter((r) => r[14] === "BLOCKED");

  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);
  const totalAud = live.reduce((sum, r) => sum + parseFloat(r[12] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total volume (AUD)     : $${totalAud.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Execute — Binance USD-M Futures Lead Trader");
  console.log(`  ${new Date().toISOString()}`);
  console.log(
    `  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}` +
      (CONFIG.binance.testnet ? " (TESTNET)" : ""),
  );
  console.log("═══════════════════════════════════════════════════════════");

  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbol: ${CONFIG.symbol} | Timeframe: ${CONFIG.timeframe}`);

  // Lead Trader startup checks (Gaps 2, 3, 4) — only when actually trading
  if (!CONFIG.paperTrading) {
    console.log("\n── Startup Checks ─────────────────────────────────────\n");
    await assertSingleAssetMode();
    await assertLeadTraderEnabled();
    await validateSymbolWhitelist(CONFIG.symbol);

    const maxLev = rules.risk_limits?.max_leverage ?? 5;
    await setLeverage(CONFIG.symbol, maxLev);
  }

  // Equity sample + drawdown halt (Gap 11) — live mode only
  if (!CONFIG.paperTrading) {
    console.log("\n── Equity & Drawdown ──────────────────────────────────\n");
    const eq = await fetchAccountEquity();
    console.log(
      `  Wallet: $${eq.walletBalance.toFixed(2)} | uPnL: $${eq.unrealizedPnl.toFixed(2)} | Equity: $${eq.equity.toFixed(2)}`,
    );
    const equityHist = loadEquityHistory();
    equityHist.samples = equityHist.samples || [];
    equityHist.samples.push({ ts: new Date().toISOString(), equity: eq.equity });
    // Trim to 8 days of history to keep the file small
    const cutoff = Date.now() - 8 * 24 * 60 * 60 * 1000;
    equityHist.samples = equityHist.samples.filter(
      (s) => new Date(s.ts).getTime() >= cutoff,
    );
    saveEquityHistory(equityHist);

    const { halt, reasons } = checkDrawdownHalt(rules, equityHist);
    if (halt) {
      console.log(`\n🚫 DRAWDOWN HALT TRIPPED:`);
      reasons.forEach((r) => console.log(`   - ${r}`));
      console.log(
        `\nBot stopping. Set rules.risk_limits.halt_on_trip=false to disable, or wait for the window to clear.`,
      );
      const log = loadLog();
      log.trades.push({
        timestamp: new Date().toISOString(),
        symbol: CONFIG.symbol,
        haltedByDrawdownLimits: true,
        reasons,
      });
      saveLog(log);
      return;
    }
  }

  const log = loadLog();
  const withinLimits = checkTradeLimits(log, rules);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  // Position concentration: only one open symbol at a time (until proven otherwise)
  if (!CONFIG.paperTrading) {
    const open = await getOpenPositions();
    const maxOpen = rules.risk_limits?.max_open_positions ?? 1;
    if (open.length >= maxOpen) {
      const symbols = open.map((p) => `${p.symbol}(${p.positionAmt})`).join(", ");
      console.log(
        `\n⏸  Position concentration limit hit (${open.length}/${maxOpen} open: ${symbols}). Skipping new entry.`,
      );
      return;
    }
  }

  console.log("\n── Fetching market data from Binance Futures ──────────\n");
  const candles = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 500);
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  console.log(`  Current price: $${price.toFixed(2)}`);

  const ema8 = calcEMA(closes, 8);
  const vwap = calcVWAP(candles);
  const rsi3 = calcRSI(closes, 3);

  console.log(`  EMA(8):  $${ema8.toFixed(2)}`);
  console.log(`  VWAP:    $${vwap ? vwap.toFixed(2) : "N/A"}`);
  console.log(`  RSI(3):  ${rsi3 ? rsi3.toFixed(2) : "N/A"}`);

  if (!vwap || !rsi3) {
    console.log("\n⚠️  Not enough data to calculate indicators. Exiting.");
    return;
  }

  const { results, allPass, bias } = runSafetyCheck(price, ema8, vwap, rsi3, rules);

  const sizingInfo = computeTradeSize(rules);
  const tradeSize = sizingInfo.tradeSize;

  const audRate = await getUsdToAudRate();

  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol: CONFIG.symbol,
    timeframe: CONFIG.timeframe,
    price,
    indicators: { ema8, vwap, rsi3 },
    bias,
    conditions: results,
    allPass,
    tradeSize,
    sizing: sizingInfo,
    audRate,
    orderPlaced: false,
    orderId: null,
    paperTrading: CONFIG.paperTrading,
    testnet: CONFIG.binance.testnet,
    limits: {
      maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday: countTodaysTrades(log),
    },
  };

  if (!allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`🚫 TRADE BLOCKED`);
    console.log(`   Failed conditions:`);
    failed.forEach((f) => console.log(`   - ${f}`));
  } else {
    const orderSide = bias === "short" ? "SELL" : "BUY";
    console.log(`✅ ALL CONDITIONS MET — bias: ${bias.toUpperCase()}`);

    if (CONFIG.paperTrading) {
      console.log(
        `\n📋 PAPER TRADE — would ${orderSide} ${CONFIG.symbol} ~$${tradeSize.toFixed(2)} at market`,
      );
      console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
    } else {
      console.log(
        `\n🔴 PLACING LIVE ORDER — $${tradeSize.toFixed(2)} ${orderSide} ${CONFIG.symbol}`,
      );
      try {
        const order = await placeFuturesOrder(
          CONFIG.symbol,
          orderSide,
          tradeSize,
          price,
        );
        logEntry.orderPlaced = true;
        logEntry.orderId = String(order.orderId);
        console.log(`✅ ORDER PLACED — ${order.orderId}`);
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }
  }

  log.trades.push(logEntry);
  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);

  writeTradeCsv(logEntry, audRate);

  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
