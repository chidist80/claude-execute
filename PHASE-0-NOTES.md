# Phase 0 — Lead Trader Patches

This document captures the closing of the eleven Lead-Trader-specific gaps from the project
plan, plus the manual steps that must happen outside of code (testnet account, Railway Pro,
etc.). Use it as the running handoff between Phase 0 and Phase 1.

## Gap-closure status

| # | Gap | Status | Where |
|---|---|---|---|
| 1 | Spot vs futures endpoints | **Closed** | `bot.js` — execution layer rewritten on `fapi.binance.com/fapi/v1/*` (BitGet code removed) |
| 2 | Lead trader status check at startup | **Closed (gated)** | `bot.js::assertLeadTraderEnabled` — calls `GET /sapi/v1/copyTrading/futures/userStatus` and exits if `isLeadTrader !== true`. Activated by `BINANCE_REQUIRE_LEAD_TRADER=true` (off in Phase 2; on from Phase 3) |
| 3 | Symbol whitelist validation each run | **Closed (gated)** | `bot.js::validateSymbolWhitelist` — calls `GET /sapi/v1/copyTrading/futures/leadSymbol` and aborts if `SYMBOL` is not on the list. Same Phase-3 gate as #2 |
| 4 | Single-Asset Mode enforcement | **Closed** | `bot.js::assertSingleAssetMode` — calls `GET /fapi/v1/multiAssetsMargin` at every live-trading startup; throws if account is in Multi-Assets mode |
| 5 | Trailing stop removal | **Audited — clean** | `rules.json` audit found no trailing-stop logic. `rules.json::risk_limits.trailing_stop_allowed=false` and `exit_rules` clarified to use bot-managed STOP_MARKET |
| 6 | Rate-limit throttle (20/10s) | **Closed** | `bot.js::throttleOrderSlot` — sliding window applied to `placeFuturesOrder` |
| 7 | Backtest harness | **Closed** | `backtest.js` — paginated klines from `fapi.binance.com/fapi/v1/klines`, walk-forward, computes Sharpe/MDD/win-rate/avg R/fee drag/monthly P&L plus 2× fee stress test |
| 8 | AUD conversion in `trades.csv` | **Closed** | `bot.js::getUsdToAudRate` — primary Frankfurter ECB rate, fallback open.er-api.com. New columns: `AUD Rate`, `Price (AUD)`, `Net (AUD)`. Migration logic in `initCsv` rewrites the header for existing files |
| 12 (extra) | Risk-based position sizing (Phase 1.5 fix) | **Closed** | `bot.js::computeTradeSize(rules)` — was sizing the position at 1% of portfolio (under-sized 333× for the 0.3% stop). Now sizes by risk: position = (portfolio × RISK_PER_TRADE_PCT) / (stop_loss_pct), capped by `portfolio × max_leverage` and `MAX_TRADE_SIZE_USD`. Without this, $1K capital + 1% sizing on BTC at $90K rounded to 0 BTC and Binance would reject the order |
| 9 | Static outbound IP | **Phase 3 deferred** | Railway Pro toggle, not a code change. Procedure documented in `docs/exchanges/binance.md` and project plan §5 Phase 3 |
| 10 | Leverage hard cap (5x) | **Closed** | `rules.json::risk_limits.max_leverage=5`; `bot.js` applies via `POST /fapi/v1/leverage` at startup |
| 11 | Drawdown kill switch | **Closed** | `rules.json::risk_limits` (max_daily_loss_pct=3, max_7d_drawdown_pct=10, halt_on_trip=true); `bot.js::checkDrawdownHalt` samples account equity each run into `equity-history.json` and halts when the circuit trips |

## What ships in this branch

- `bot.js` — Binance USD-M Futures execution + Lead Trader checks + drawdown circuit-breaker + AUD conversion
- `backtest.js` — Phase 1 harness, runnable now
- `rules.json` — risk_limits block added
- `.env.example` — Binance shape, including `BINANCE_REQUIRE_LEAD_TRADER` flag
- `package.json` — name/desc updated, ESM declared, `npm run backtest` script
- `docs/exchanges/binance.md` — full Phase 2 + Phase 3 + testnet setup
- `PHASE-0-NOTES.md` (this file)

## What's still required from a human

These are deliberate hand-off points — they need an account, money, identity, or a deploy
that is unsafe to automate.

1. **Binance Futures testnet account** — register at <https://testnet.binancefuture.com>,
   generate testnet API keys, drop them in `.env`, set `BINANCE_FAPI_BASE_URL=https://testnet.binancefuture.com`,
   run `PAPER_TRADING=false node bot.js` end-to-end for the Phase 0 exit gate (3+ days clean).
   Note: the chosen strategy is **daily**, so "3+ days clean" means 3+ daily fires, not
   3+ runs — plan for 4–5 days of testnet residence to give the 0:00 UTC cron several
   shots.
2. **Phase 1 strategy validation — DONE.** `STRATEGY.md` has the full finding. Selected:
   **VWAP + RSI(3) + EMA(8) on BTCUSDT 1D**. Stable across 1-, 2-, 3-, 4-year windows
   (Sharpe 4.33–6.80, MDD 1.98–2.77%, IS+OOS positive, asymmetric short-side edge).
   Fails the trade-count gate (~9/yr vs required 30/yr) but passes Sharpe / MDD /
   2× fee — a documented exception, not an actual failure.
3. **Phase 2 live solo account** — open a regular Binance Futures account, fund **$500–$1000**
   (the recommended initial seed for this strategy), generate a Futures API key (withdrawals
   OFF, futures ON), set `BINANCE_REQUIRE_LEAD_TRADER=false`, deploy to Railway Hobby with
   `cronSchedule: "0 0 * * *"`. **Forward-paper for 30 days first** before flipping
   `PAPER_TRADING=false`. Phase 2 exit gate: P&L direction matches backtest, fee drag within
   20% of estimate, AUD column populating.
4. **Phase 3 lead portfolio** — upgrade Railway to Pro for static outbound IP, create a
   Private Lead portfolio, fund $1000 (earn the second $1K with another 4 weeks of clean
   Phase 3 results — see STRATEGY.md capital sizing rationale), generate a Copy Trading
   API key with that IP whitelisted, flip `BINANCE_REQUIRE_LEAD_TRADER=true`.
5. **Kill switch script — DONE.** `node kill-switch.js` cancels all open orders and
   flattens positions on the configured symbol (or `--all-symbols` for everything).
   Self-contained (no bot.js import). Use `--dry-run` to preview, `--cancel-only`
   to leave positions intact. Wire to a Railway one-shot or PagerDuty webhook for
   emergency response.
6. **Forward-test verifier — DONE.** `node verify-forward-test.js --days 30`
   compares the bot's logged daily decisions to what the strategy module would
   have decided for the same days. Run daily during the 30-day paper test;
   100% match before flipping `PAPER_TRADING=false`.
7. **Symbol-precision rounding — DONE.** `bot.js::placeFuturesOrder` now calls
   `/fapi/v1/exchangeInfo` and floors quantity to the symbol's step size. A
   pre-flight check in paper mode also surfaces sub-`minQty` / sub-`minNotional`
   issues before they bite at first real-money order.

## Verification commands

```bash
# Onboarding bootstraps a Binance-shaped .env
rm .env && node bot.js   # creates .env template, exits cleanly

# Paper-mode end-to-end against live Binance Futures public API
node bot.js              # pulls klines, runs safety check, blocks/passes, writes CSV

# Tax summary
node bot.js --tax-summary

# Backtest the chosen edge (the validated one)
npm run backtest -- --strategy vwap-rsi-ema --symbol BTCUSDT --interval 1d --months 36 --oos-months 6

# Forward-test verifier (run daily during the 30-day paper test)
npm run verify -- --days 30

# Kill switch (operations)
npm run kill-switch -- --dry-run         # preview what would happen
npm run kill-switch -- --cancel-only     # only cancel orders
npm run kill-switch                      # cancel + flatten SYMBOL

# Dashboard
npm run dashboard        # http://localhost:3737
```
