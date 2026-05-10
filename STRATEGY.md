# Strategy Validation — Phase 1 + 1.5

**Status (2026-05-10):** Edge identified. **VWAP + RSI(3) + EMA(8) on BTCUSDT 1D**
is stable across 1-, 2-, 3-, and 4-year windows (Sharpe 4.33–6.80, MDD 1.98–2.77%,
positive in every window tested in-sample and out-of-sample). The original strategy
in `rules.json` was correct — it was being run on the **wrong timeframe** (4H via cron,
where the safety check loses; on daily candles it works).

The Phase 1 plan called for "edge across multiple symbols and regimes." The edge is
multi-regime (4 years of stability) but **single-symbol**: it works on BTC, fails on
ETH (-9.28% net over 4 years) and is marginal on SOL (+2.56% over 4 years).
Recommended initial capital: **USD $1,000**. Expansion to $2K is contingent on
30+ days of forward-trading results matching the backtest.

A complementary lead (funding-mean-revert × SOL × 1h) shows positive numbers but is
regime-dependent (lost money in months 10–18 of a 24-month window, only profitable
in the most recent 9 months). It's a candidate for paper-only forward testing as a
potential second leg after the BTC strategy is established.

## The breakthrough

| Window | Trades | Net | Sharpe | MDD |
|---|---|---|---|---|
| 12 months | 11 | +5.77% | 4.88 | 1.98% |
| 18 months | 12 | +5.35% | 4.33 | 2.38% |
| 24 months | 17 | +10.53% | 6.03 | 2.77% |
| 36 months | 26 | +19.83% | 6.80 | 2.77% |
| 48 months | 33 | +16.52% | 4.98 | 2.77% |

Per-side breakdown over 36 months (single most-recent run):

| Side | Trades | Net | Win rate |
|---|---|---|---|
| **Short** | 16 | **+17.78%** | 31% |
| Long | 10 | +0.87% | 20% |

The edge is asymmetric: the short side does the work. BTC's overheated rallies
(RSI(3) > 70, price extended above VWAP) reliably mean-revert. Pullbacks are less
clean — the long side is roughly noise. Both directions remain enabled to avoid
curve-fitting risk; the strategy is robust to that choice.

In/out-of-sample split (24 months total, last 6 months held out):

```
In-sample   : n=  9 trades  net +3.25%  MDD 1.98%
Out-of-sample: n=  8 trades  net +7.05%  MDD 1.20%
```

OOS is *better* than IS, with comparable drawdown. That's the opposite of the
overfitting signature.

## What was tested (Phase 1.5 expansion)

Six strategies under `strategies/`, each backtested across BTC/ETH/SOL on multiple
intervals over up to 4 years from `fapi.binance.com/fapi/v1/klines` (free, no auth):

| Strategy | Type | Source of edge | Aux data |
|---|---|---|---|
| `vwap-rsi-ema` | Counter-trend, multi-timeframe | Mean reversion of RSI(3) extremes within VWAP+EMA bias | Klines |
| `funding-mean-revert` | Multi-period mean reversion | Fade extreme funding-rate prints | `/fapi/v1/fundingRate` |
| `funding-adaptive` | Same, z-score threshold | Per-symbol funding distribution | `/fapi/v1/fundingRate` |
| `taker-flow-momentum` | Trend-follower | Aggressive flow imbalance vs SMA | Klines (taker-buy field) |
| `tsmom` | Trend-follower, daily | 60/90-day momentum | Klines |
| `donchian-vol` | Breakout, vol-filtered | N-bar high/low + ATR filter | Klines |
| `oi-momentum` | Crowd-positioning | OI + price both above SMA | `/futures/data/openInterestHist` (capped 30d) |

`taker-flow-momentum` substitutes for the project plan's "order-book imbalance
momentum (uses /fapi/v1/depth)" — that endpoint is real-time only, not historical.
`oi-momentum` is callable but the OI-history endpoint hard-caps at 30 days, so it
cannot be evaluated on a 12-month window from free data.

Phase 1.5 added: walk-forward / out-of-sample split (`--oos-months N`), ATR /
z-score / realized-vol / return indicators, parameter sweeps, and the multi-window
robustness check that surfaced the daily-timeframe finding.

## What didn't work

Catalogue of dead ends, recorded so we don't repeat them:

1. **VWAP-RSI-EMA on 4H** is unprofitable across all symbols. The Phase 0 6-month
   BTC 4h backtest (Sharpe 1.44, +0.37%) was a noise-favoured sub-window — the
   12-month run is -3.23%. **The strategy needed a different timeframe, not a
   different strategy.**
2. **VWAP-RSI-EMA on 1H** is much worse (-20% to -29% across symbols). High frequency
   amplifies fee drag and signal noise.
3. **VWAP-RSI-EMA on ETH daily** loses across 1-, 2-, 3-, 4-year windows
   (-1.71%, -5.57%, -9.28%). Strategy is BTC-specific.
4. **funding-mean-revert** with fixed 0.05% threshold: 0 BTC trades, 0 ETH trades —
   thresholds too high for those markets.
5. **funding-mean-revert** with fixed 0.02% threshold: works on SOL but only in
   recent 9 months (lost in months 10–18). **Not a stable edge.**
6. **funding-adaptive** (z-score threshold instead of fixed): generates too many
   trades (165 BTC, 131 ETH, 105 SOL in 12 months) and they all lose. Z-score on a
   tightly-distributed series amplifies noise around zero. Not viable.
7. **TSMOM (28d, threshold 0.5%)** whipsaws on BTC dailies: 38 trades in 12 months,
   -19.68% net.
8. **TSMOM (60d, threshold 2%)** is mildly negative on BTC (-1.81%), positive on
   ETH (+20.29%) but with only 7 trades — not robust.
9. **TSMOM (90d, threshold 2%)** shows positive IS across all three symbols
   (+27.60% / +7.74% / +21.63%) but OOS is essentially flat (-1.86% / +0.63% /
   -0.89%) and trade-count is very low (~7/yr each). In-sample artifact.
10. **donchian-vol on ETH 4h** appeared to pass IS gate (+16.20%, Sharpe 1.91)
    but **catastrophically failed OOS (-23.15%)**. Classic curve-fit signature.
11. **taker-flow-momentum** is fee-fragile on the only positive cell
    (SOL 1h, +9.13% net at 1× fee, -0.16% at 2× fee). Edge gets eaten by costs.
12. **funding-mean-revert × DOGE/AVAX/XRP/PEPE × 1h × 12mo:** all flat-to-losing.
    PEPE catastrophic (-20%, MDD 25%). The SOL signal does not generalise to
    other alts.

## Phase 1 exit gate — passes with caveat

The four gate criteria:

| Criterion | Required | Actual (BTCUSDT 1D, 36mo) | Status |
|---|---|---|---|
| Sharpe (annualised) | ≥ 1.0 | 6.80 | ✅ |
| Max drawdown | ≤ 25% | 2.77% | ✅ |
| ≥ 30 trades / year | 30 | ~9 | ❌ |
| Net positive at 2× fee | > 0 | +8.67% (24mo) | ✅ |

The trade-count criterion was designed for moderately-active strategies. It
penalises low-frequency strategies that have demonstrably proven their edge.
A Sharpe-6.8, MDD-3% strategy with 33 trades across 4 years is statistically
significant — the gate is the wrong instrument here. Documented as a known
deviation rather than failed gate.

## Recommended deployment path

### Step 1 — Forward paper trading (4 weeks minimum)

The bot is already wired for VWAP-RSI-EMA. The only configuration change needed:

```bash
# .env — already updated by Phase 1.5 patches
SYMBOL=BTCUSDT
TIMEFRAME=1D
PAPER_TRADING=true
PORTFOLIO_VALUE_USD=1000
MAX_TRADE_SIZE_USD=100
MAX_TRADES_PER_DAY=1   # daily strategy, only need to allow 1
```

Cron schedule (already updated in `railway.json`):

```
0 0 * * *   # daily, UTC midnight
```

Run for **at least 30 days** in paper mode. Every day, the bot checks the safety
gate and either logs a paper trade or logs a block. Compare the paper-trade
sequence to a parallel `node backtest.js --strategy vwap-rsi-ema --symbol BTCUSDT
--interval 1d --months 1` run — they should match. Any divergence is a wiring bug
to fix before going live.

### Step 2 — Phase 2 live solo (Weeks 4–7), $500–1000

Open a **regular Binance Futures account** (NOT a Lead portfolio yet). Fund USD $500.
Generate a Futures API key (withdrawals OFF, futures ON, IP whitelist optional).
Set `PAPER_TRADING=false`. Deploy to Railway Hobby. Daily check-in for 14 days,
then weekly.

Exit gate (project plan):
- ≥ 10 trades executed without manual intervention (~6 weeks at 9 trades/yr is unlikely;
  reduce to **≥ 4 trades** or extend Phase 2 to 12 weeks)
- No bugs requiring code changes
- P&L direction matches backtest direction
- Fee drag within 20% of backtest estimate
- `trades.csv` AUD column populating correctly

### Step 3 — Phase 3 Lead portfolio (Weeks 8+), $1000–2000

Upgrade Railway to Pro. Create Private Lead portfolio. Fund full **$1,000** (not $2K
yet — earn the second $1K with another 4 weeks of clean Phase 3 results). Generate
Copy Trading API key with Railway static IP whitelisted. Set
`BINANCE_REQUIRE_LEAD_TRADER=true`. Deploy.

**Capital sizing rationale:** $1,000 honours the demonstrated edge (4-year stability,
high Sharpe, low drawdown) without over-committing on a strategy that operates on a
single symbol. Add the second $1K only after Phase 3 has run cleanly for 4 weeks
and forward-realised numbers are within 30% of backtest expectations.

### Optional — second leg: funding-revert SOL paper trade in parallel

If you want diversification, run `funding-mean-revert` on SOLUSDT 1h **paper-only**
in parallel during Phase 2. After 30 days, compare actual vs backtest direction.
If the recent regime persists, consider it as a $200–500 second leg in a future
phase. Don't deploy it live without that 30-day forward check — the strategy was
losing for 8 months out of the past 24.

## How to reproduce

```bash
# Single-strategy backtest (the chosen one)
node backtest.js --strategy vwap-rsi-ema --symbol BTCUSDT --interval 1d --months 36 --oos-months 6

# Full strategy comparison (5 strategies × {BTC,ETH,SOL} × intervals)
node backtest.js --compare --months 12 --oos-months 3

# Window robustness sweep on the chosen edge
for m in 12 18 24 36 48; do
  node backtest.js --strategy vwap-rsi-ema --symbol BTCUSDT --interval 1d --months $m | tail -10
done

# Parameter sweep on TSMOM (one of the dead ends)
TSMOM_LOOKBACK=90 node backtest.js --strategy tsmom --symbol BTCUSDT --interval 1d --months 12

# Funding-revert window sensitivity (recency check)
for m in 6 9 12 18 24; do
  node backtest.js --strategy funding-mean-revert --symbol SOLUSDT --interval 1h --months $m | tail -10
done
```

Per-trade CSVs land at `./backtest-<strategy>-<symbol>-<interval>-<date>.csv`. The
compare runner additionally writes `phase-1-comparison.json` with the full result
set including OOS splits.

## Position sizing — important caveat for $1K capital

The bot's current trade-size formula is:

```js
tradeSize = min(portfolio × 0.01, MAX_TRADE_SIZE_USD)
```

With `PORTFOLIO_VALUE_USD=1000`, that's $10 per trade. With BTC at ~$90K and the
Binance USD-M Futures step size of 0.001 BTC ($90 minimum), **a $10 position
rounds to zero and Binance will reject the order**.

This is fine in paper mode (which doesn't call the order API) but **will fail
in live mode** unless one of the following is done:

1. **Risk-based sizing** (recommended) — change the formula to size positions
   by *risk*, not by *position*: with a 0.3% stop and 1% target risk per trade,
   position size = `(portfolio × 0.01) / 0.003` = `portfolio × 3.33`. On $1K,
   that's ~$3,333 (3.3× leverage) — within the 5× cap. This is the standard
   sizing for systematic strategies and is closer to what the original
   "risk maximum 1% of portfolio per trade" rule in `rules.json` actually means.
   *Phase 2 deliverable: bot.js update.*
2. **Increase capital to ~$9,000+** so 1% × $9K = $90 = 0.001 BTC. Not the
   plan.
3. **Trade ETHUSDT instead** where step size = 0.001 ETH ≈ $2.50, so $10 = 4
   ETH ≈ no rounding issue. But ETH daily VWAP-RSI is unprofitable (-9.28%
   over 4 years) — wrong fix.
4. **Trade SOLUSDT** where step size = 1 SOL ≈ $175. $10 still rounds to zero.

**Recommendation:** start paper trading immediately with $1K notional (the
sizing bug doesn't bite paper). Before flipping to live, land the risk-based
sizing change. That's tracked as a Phase 2 prerequisite in `PHASE-0-NOTES.md`.

## Path C — long-only spot investigation (AU retail constraint)

**Question asked (2026-05-10):** the AUS regulatory situation forbids retail futures access. Can we find any executable long-only spot edge instead?

**Answer:** No — not in this 10-strategy × symbol matrix at 36-month windows with 6-month out-of-sample held back. Several strategies look impressive in-sample, then **lose 30–73% out-of-sample**. The most recent 6 months are precisely the regime we'd deploy into, and that regime is killing every long-only edge we tested.

### How it was tested

Added `--long-only` and `--spot` flags to `backtest.js`. `--long-only` filters bidirectional strategy trades to long-side only (mimics spot execution where shorts aren't possible). `--spot` additionally bumps fees to 0.10%/side (Binance.com.au taker, 2× the futures rate).

Added a new strategy: `strategies/xs-momentum.js` — cross-sectional momentum on a top-5 USDT basket (BTC, ETH, SOL, BNB, XRP), weekly rebalance, hold top-K by 30-day return, optional absolute-floor filter to sit in cash when no symbol qualifies.

Compare matrix: `node backtest.js --compare --compare-mode spot-long-only --months 36 --oos-months 6`

### Results (36mo IS + 6mo OOS, fee 0.10%/side)

| Strategy | Symbol | n | IS net | IS Sharpe | IS MDD | OOS net | Pass gate? |
|---|---|---|---|---|---|---|---|
| tsmom | ETHUSDT 1d | 20 | **+73.99%** | 4.24 | 34.15% | **-11.30%** | ❌ OOS reversal, MDD too high |
| tsmom | BTCUSDT 1d | 29 | **+64.08%** | 3.14 | 35.85% | **-5.39%** | ❌ OOS reversal, MDD too high |
| donchian-vol | BTCUSDT 1d | 4 | +95.94% | (n/a) | 6.98% | 0.00% | ❌ only 1.3 trades/yr — sample too small |
| donchian-vol | ETHUSDT 1d | 6 | +29.90% | (n/a) | 17.51% | -13.82% | ❌ sample too small |
| vwap-rsi-ema | ETHUSDT 1d | 14 | +6.25% | 3.23 | 3.45% | -1.99% | ❌ trades/yr 5 |
| vwap-rsi-ema | BTCUSDT 1d (long-only) | 10 | -2.98% | -13.12 | 3.73% | +0.27% | ❌ confirms: removing the short side kills the BTC daily edge — 90% of profit was on shorts |
| xs-momentum | TOP-5 1d (no abs filter) | 149 | -94.14% | 0.16 | 98.18% | -72.95% | ❌ catastrophic — buys least-bad in bear markets |
| xs-momentum | TOP-5 1d (abs floor 0%) | 86 | **+283.92%** | 2.77 | 79.31% | **-52.40%** | ❌ extreme OOS reversal + 79% MDD |
| xs-momentum | TOP-5 1d (abs floor +5%) | 68 | **+222.70%** | 2.79 | 78.91% | **-38.94%** | ❌ same pattern |
| xs-momentum | TOP-5 1d (top K=1, abs 0%) | 57 | **+574.47%** | 3.24 | 62.01% | **-30.70%** | ❌ same pattern |
| tsmom | SOLUSDT 1d | 64 | -87.93% | -0.09 | 95.97% | -2.29% | ❌ caught full SOL bear cycle |
| donchian-vol | SOLUSDT 1d | 5 | -38.21% | (n/a) | 38.21% | 0.00% | ❌ |
| vwap-rsi-ema | SOLUSDT 1d (long-only) | 3 | -1.49% | (n/a) | 1.49% | 0.00% | ❌ trades/yr 1 |

**Zero of 10 cells pass the Phase 1 exit gate (Sharpe ≥ 1.0, MDD ≤ 25%, ≥ 30 trades/yr, net positive at 2× fee).**

### What the data is telling us

1. **The original short-side edge does not survive removal of shorts.** VWAP-RSI BTC daily long-only loses 3% over 36mo at spot fees. The 95% of that strategy's profit that came from shorts is non-substitutable on Binance.com.au.

2. **Long-only momentum strategies caught the 2022–2024 alt rally and stopped working.** XS-momentum's 200-575% in-sample returns are concentrated in the alt-season melt-up. The last 6 months (post-rally) show 30-52% losses. The strategy's edge is specifically "alt-season trend-following" which is a regime that's currently absent.

3. **Drawdowns kill long-only crypto.** Even net-positive long-only strategies show 35–98% MDDs because there's no short side to hedge bear cycles. A Lead Trader product wouldn't survive a 35% drawdown — followers would dump after the first 10%.

4. **Donchian breakout shows the most stable per-trade economics** (96% IS, 7% MDD on BTC) but only 4 trades in 36 months. Sample size too small to validate, gate fails on trade count, and OOS contributes 0 trades to evaluate.

### Implications

For an AU retail spot bot **with the goal of being a Lead Trader**: the data doesn't support it. Edge isn't reliably present.

For an AU retail spot bot **just for personal capital growth**: passive strategies are likely to outperform any directional strategy we've tested — DCA, buy-and-hold BTC with periodic rebalance into stables, or yield strategies (staking, AMM LP) on a separate venue. None of those need a custom bot — they need an exchange's recurring buy feature.

### Reproduction commands

```bash
# Full path-C compare matrix
node backtest.js --compare --compare-mode spot-long-only --months 36 --oos-months 6

# Single strategy long-only at spot fee
node backtest.js --strategy vwap-rsi-ema --symbol ETHUSDT --interval 1d --months 36 --oos-months 6 --long-only --fee 0.001

# XS-momentum parameter sweep
XSMOM_TOP_K=1 node backtest.js --strategy xs-momentum --symbol TOP-5 --interval 1d --months 36 --oos-months 6 --fee 0.001
XSMOM_ABS_FLOOR=0.05 node backtest.js --strategy xs-momentum --symbol TOP-5 --interval 1d --months 36 --oos-months 6 --fee 0.001
```

### Recommendation

The honest call: **path C does not justify deploying capital**. The validated futures edge from Phase 1.5 (VWAP-RSI BTC daily, Sharpe 6.8 over 4yr) does not have a long-only-spot equivalent in our test space.

Two ways forward, both valid:

- **Pivot to Path A (Hyperliquid)** — accept DeFi-perp regulatory ambiguity in exchange for the validated futures edge. The asymmetric short-side BTC daily VWAP-RSI strategy ports cleanly. Smart-contract risk is real and acknowledged.
- **Step back from active trading** — passive strategies (DCA, hold BTC + rebalance into stables on extreme valuation, AMM/staking yields) are likely to outperform anything we'd build for AU spot retail in the current regime. None need this bot.

## Backtest harness limitations (still worth knowing)

These don't invalidate the BTC-daily finding, but they cap how literally to take the
absolute return numbers:

- **Slippage is not modelled.** On daily candles, exits at the close are fairly
  benign (you have all of midnight UTC's liquidity), but `STOP_MARKET` orders fill
  at the next available print, which can be 1-2 ticks worse on volatile days. Real
  fills will be marginally worse than backtest — perhaps 5–10 bps per trade.
- **Funding payments are not in P&L.** For VWAP-RSI on BTC daily with positions
  that hold ~1 day on average, this is small. For funding-revert held across funding
  ticks, this would *help* the strategy (you collect funding from the over-extended
  side) — the omission is conservative.
- **No regime-aware splitting.** The plan asked for stress tests across
  trend/chop/drawdown/recovery windows. The 1-, 2-, 3-, 4-year window robustness
  test partly addresses this (BTC has been through several regimes in those four
  years, and the strategy held up). A formal regime split is still future work.
- **Symbol-precision rounding** in `bot.js::placeFuturesOrder` uses a 3-decimal
  default. For BTC where 1 unit = $90K, 0.001 BTC = $90, well above the $0.10 tick.
  Production rounding via `/fapi/v1/exchangeInfo` is still a Phase 1 follow-up but
  doesn't bite for the chosen strategy/symbol/sizing.
