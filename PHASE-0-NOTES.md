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
2. **Phase 1 strategy validation** — `npm run backtest -- --symbol BTCUSDT --interval 4h --months 12`
   then iterate on `rules.json` until the Phase 1 gate passes (Sharpe ≥ 1.0, MDD ≤ 25%,
   ≥ 30 trades/yr, net positive at 2× fee). The current default scalping rules pass Sharpe
   and MDD on a 6-month BTCUSDT 4h sample but go negative at 2× fee — refinement is expected.
3. **Phase 2 live solo account** — open a regular Binance Futures account, fund $500, generate
   a Futures API key (withdrawals OFF, futures ON), set `BINANCE_REQUIRE_LEAD_TRADER=false`,
   deploy to Railway Hobby.
4. **Phase 3 lead portfolio** — upgrade Railway to Pro for static outbound IP, create a
   Private Lead portfolio, generate a Copy Trading API key with that IP whitelisted, flip
   `BINANCE_REQUIRE_LEAD_TRADER=true`.
5. **Kill switch script** — one-liner shell command that pauses the Railway service and
   cancels all open positions. Worth writing in Phase 2 once a real Railway service exists.

## Verification commands

```bash
# Onboarding still bootstraps a Binance-shaped .env
rm .env && node bot.js   # creates .env template, exits cleanly

# Paper-mode end-to-end against live Binance Futures public API
node bot.js              # pulls klines, runs safety check, blocks/passes, writes CSV

# Tax summary
node bot.js --tax-summary

# Backtest sanity (fast — 6 months at 4h)
node backtest.js --symbol BTCUSDT --interval 4h --months 6

# Dashboard
npm run dashboard        # http://localhost:3737
```
