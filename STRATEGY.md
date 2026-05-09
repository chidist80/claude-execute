# Strategy Validation — Phase 1

**Status as of 2026-05-10:** Phase 1 exit gate **NOT met**. The current upstream
strategy is unprofitable on a 12-month sample, and only one of the three candidate
strategies passes on a single symbol — not the multi-symbol edge the gate requires.
The gap to "ready for Phase 2 capital deployment" is documented at the bottom.

## What was tested

Three strategy modules under `strategies/`, each backtested across at least three
USD-M Futures symbols on multiple intervals over the last 12 months from
`fapi.binance.com/fapi/v1/klines` (free, no auth):

| Strategy | Type | Source of edge | Aux data |
|---|---|---|---|
| `vwap-rsi-ema` | Counter-trend scalper | Mean reversion in trend | None (klines only) |
| `funding-mean-revert` | Counter-trend, multi-period | Fade extreme funding-rate prints | `/fapi/v1/fundingRate` history |
| `taker-flow-momentum` | Trend-follower | Aggressive flow imbalance vs medium-term price | Klines (taker-buy volume field) |

`taker-flow-momentum` substitutes for the project plan's "order-book imbalance
momentum (uses /fapi/v1/depth)" — Binance only exposes the *current* order book,
not history. Klines, however, include the per-candle taker-buy base-asset
volume, which captures the same intent (aggressive flow imbalance) and is fully
backtestable from free public data.

## Phase 1 exit gate

A strategy must pass **all four** to advance:

- Sharpe (annualised) ≥ 1.0
- Max drawdown ≤ 25%
- ≥ 30 trades / year
- Net positive at 2× fee (the plan's stress test)

## Headline result

```
node backtest.js --compare --months 12

✅ GATE  funding-mean-revert    SOLUSDT  1h    Sharpe 3.10 | net  +7.93% | MDD  3.92% | t/yr 56 | 2×fee +4.12%
   ❌    taker-flow-momentum    SOLUSDT  1h    Sharpe 1.44 | net  +9.13% | MDD 12.08% | t/yr 91 | 2×fee  -0.16%
   ❌    vwap-rsi-ema           BTCUSDT  4h    Sharpe -3.16 | net  -3.23% | MDD  4.81% | t/yr 40 | 2×fee  -6.75%
   ❌    vwap-rsi-ema           ETHUSDT  4h    Sharpe -6.45 | net  -5.71% | MDD  6.35% | t/yr 44 | 2×fee  -9.32%
   ❌    vwap-rsi-ema           SOLUSDT  4h    Sharpe -55.2 | net  -9.77% | MDD  9.77% | t/yr 29 | 2×fee -12.19%
   ❌    vwap-rsi-ema           BTCUSDT  1h    Sharpe -5.95 | net -29.15% | MDD 30.34% | t/yr 378 | 2×fee -51.13%
   ❌    vwap-rsi-ema           ETHUSDT  1h    Sharpe -2.40 | net -20.70% | MDD 25.35% | t/yr 354 | 2×fee -44.09%
   ❌    vwap-rsi-ema           SOLUSDT  1h    Sharpe -4.07 | net -25.54% | MDD 30.43% | t/yr 333 | 2×fee -46.17%
   ❌    taker-flow-momentum    BTCUSDT  1h    Sharpe -2.95 | net -22.00% | MDD 22.72% | t/yr 212 | 2×fee -36.61%
   ❌    taker-flow-momentum    ETHUSDT  1h    Sharpe -3.04 | net -12.13% | MDD 16.18% | t/yr  96 | 2×fee -20.03%
   ❌    funding-mean-revert    BTCUSDT  1h    0 trades — funding band too narrow on BTC for any threshold > 0.001%
   ❌    funding-mean-revert    ETHUSDT  1h    4 trades, -0.90% — too few signals to be robust
   ❌    taker-flow-momentum    {ETH,SOL} 4h    0 trades — entry conditions too tight on 4h smoothed flow
   ❌    taker-flow-momentum    BTCUSDT  4h    5 trades, -2.96% — too few to evaluate
```

Full machine-readable results: `phase-1-comparison.json`.

## Findings

1. **The upstream VWAP + RSI(3) + EMA(8) scalping strategy is unprofitable.** 12-month results are negative across all six tested cells (BTC/ETH/SOL × 1h/4h). The Phase 0 6-month backtest (`Sharpe 1.44, +0.37% net`) was a favourable subwindow — the prior six months wiped that out. Conclusion: do NOT deploy `rules.json` as currently committed against real capital.

2. **Funding-rate mean reversion works, but only on alt-coins with wide funding bands.** SOLUSDT 1h with a 0.02% threshold passes the gate convincingly (Sharpe 3.10, MDD 3.92%, 56 trades/yr, +4.12% at 2× fee). BTC/ETH funding bands are too tight in the current regime — even at 0.02% threshold, BTC produced 0 trades over 12 months. Probed extension to DOGE/AVAX/XRP/PEPE: all four flat-to-losing, with PEPE catastrophic (MDD 24.79%, -20.05% net). The signal is **SOLUSDT-specific** in this regime, not a generalising edge.

3. **Taker-flow momentum is marginally profitable on SOL only.** SOLUSDT 1h: +9.13% net, Sharpe 1.44 — but fails the 2× fee gate at -0.16%, meaning the edge is fee-fragile. On 4h it generates too few trades to evaluate. On BTC/ETH 1h it loses heavily (-22% / -12%).

4. **The PDF's "order-book imbalance" strategy could not be backtested as written.** `/fapi/v1/depth` is real-time only. Substituted with `taker-flow-momentum` using kline taker-buy volume — captures the same intent and is fully historical.

## Implications for Phase 2

The Phase 1 → Phase 2 transition assumed "one strategy with documented edge across
multiple symbols and regimes." That hasn't been demonstrated. Options:

- **(A) Halt and redesign.** Treat the current scaffold as the harness, not the
  strategy. The honest path. Funding-mean-revert on SOL is a starting lead but
  needs (i) per-symbol adaptive thresholds (e.g., 2σ of recent funding rather
  than a fixed 0.02%), (ii) regime-aware filtering (turn off in low-vol periods),
  and (iii) more symbols passing.
- **(B) Single-symbol SOL pilot.** Deploy funding-mean-revert on SOLUSDT 1h only,
  with a much smaller capital footprint than the $2K plan ($200–300). Treat as a
  live forward test of the SOL-specific edge. Acceptable if you accept the
  fragility (one regime shift on SOL or one Binance funding-cap change voids
  the edge) and size accordingly.
- **(C) Iterate parameters.** Risk: overfitting. Should be confined to:
  per-symbol funding thresholds based on rolling rate distribution, not arbitrary
  knob-twiddling. Still doesn't solve BTC/ETH (their funding is fundamentally
  too tightly arbed for this strategy).

Recommended path: **(A) for the major capital, (B) optionally on the side**. Do
NOT take Phase 0's `rules.json` to live capital based on Phase 0's noisy 6-month
backtest.

## How to reproduce

```bash
# Single backtest — any strategy, any symbol/interval
node backtest.js --strategy funding-mean-revert --symbol SOLUSDT --interval 1h --months 12

# Full comparison matrix (15 cells, ~30s)
node backtest.js --compare --months 12

# Override funding threshold sweep
FUNDING_THRESHOLD=0.0002 node backtest.js --strategy funding-mean-revert --symbol SOLUSDT --interval 1h --months 12
```

Per-trade CSVs are written to `./backtest-<strategy>-<symbol>-<interval>-<date>.csv`.
The compare runner additionally writes `phase-1-comparison.json` with the full result set.

## Backtest harness limitations (worth knowing)

- **Slippage is not modelled.** Real fills on SOL 1h candle closes can vary by
  several basis points around the printed close, especially during volatile
  funding-tick periods. Fee at 2× already partly proxies for slippage; production
  numbers will be slightly worse than backtest.
- **Funding payments are not in P&L.** The funding-mean-revert strategy assumes
  you exit before the next funding settlement. If real-world execution slips past
  settlement, you collect (or pay) funding — this would generally help the
  strategy (you're betting on the side opposite the over-extended crowd, who pay
  funding). The omission is conservative.
- **No regime-aware splitting.** The PDF asked for stress tests across
  trend/chop/drawdown/recovery windows. The current harness reports monthly P&L,
  which is a weak proxy. A proper regime split (e.g., realised-vol quartiles) is
  Phase 1 follow-up work.
- **Symbol-precision rounding** in `bot.js::placeFuturesOrder` uses a 3-decimal
  default. Production rounding via `/fapi/v1/exchangeInfo` is still a Phase 1
  TODO — backtest assumes infinite precision.
