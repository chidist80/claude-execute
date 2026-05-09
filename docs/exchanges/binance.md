# Binance USD-M Futures — API Key Setup

The bot is a **Binance USD-M Futures** trader, designed to run as a Binance Lead Trader once
the strategy is validated (Phase 3+). This guide covers both the regular Futures account
(Phase 2) and the Lead Trader portfolio (Phase 3+).

## What you'll get
- API Key
- Secret Key
- No passphrase (Binance doesn't use one)

---

## Phase 2 — Regular Futures account key

Use this for live solo validation with $500 of your own capital.

1. Log into Binance at binance.com
2. Click your profile icon (top right) → **API Management**
3. Click **Create API**
4. Choose **System generated** → **Next**
5. Label it `claude-execute-phase2` (or similar)
6. Complete email + 2FA verification

### Permissions

- **Enable Reading** — ON ✓
- **Enable Futures** — ON ✓ (required — this is a futures-only bot)
- **Enable Spot & Margin Trading** — OFF (we don't trade spot)
- **Enable Withdrawals** — **OFF** — never turn this on
- **Restrict access to trusted IPs only** — recommended (skip if your home IP is dynamic)

7. **Save**, complete verification again.
8. Copy both keys immediately — the **Secret Key is shown only once**.

### .env values

```
BINANCE_API_KEY=your_api_key_here
BINANCE_SECRET_KEY=your_secret_key_here
BINANCE_FAPI_BASE_URL=https://fapi.binance.com
BINANCE_SAPI_BASE_URL=https://api.binance.com
BINANCE_REQUIRE_LEAD_TRADER=false   # leave false in Phase 2
```

### Account preferences

Before flipping `PAPER_TRADING=false`:
- Futures → Preferences → **Asset Mode** → **Single-Asset Mode** (the bot will refuse
  to run in Multi-Assets Mode — Lead Trader Copy Trading bans it).
- Futures → Preferences → **Position Mode** → **One-way Mode** (default).

---

## Phase 3+ — Lead Trader Copy Trading API key

Use this once you've created a Private Lead portfolio.

1. Binance → Futures → **Copy Trading** → My Lead → **Create Lead Portfolio**
2. Set portfolio type to **Private**, fund with USD $2,000.
3. Confirm the portfolio is in **Single-Asset Mode** (not Multi-Assets).
4. On the portfolio card, click the **[API]** button to generate a Copy Trading key.
   - **Enable Futures**: ON
   - **Restrict access to trusted IPs only**: ON — paste your Railway static outbound IP
   - Don't generate a 2nd key yet (1 of 2 max — keep one in reserve)

### .env values for Phase 3+

```
BINANCE_API_KEY=your_lead_trader_api_key
BINANCE_SECRET_KEY=your_lead_trader_secret
BINANCE_FAPI_BASE_URL=https://fapi.binance.com
BINANCE_SAPI_BASE_URL=https://api.binance.com
BINANCE_REQUIRE_LEAD_TRADER=true   # bot now refuses to run unless on a Lead portfolio
```

When `BINANCE_REQUIRE_LEAD_TRADER=true`, the bot calls
`GET /sapi/v1/copyTrading/futures/userStatus` at startup and exits if `isLeadTrader`
is not `true`. It also validates `SYMBOL` against
`GET /sapi/v1/copyTrading/futures/leadSymbol` on every run.

---

## Testnet (Phase 0)

For testnet smoke-tests, register at <https://testnet.binancefuture.com>, generate
testnet keys, and override the FAPI base URL:

```
BINANCE_FAPI_BASE_URL=https://testnet.binancefuture.com
```

Testnet has no `/sapi` copy-trading endpoints, so the bot auto-skips the lead-trader and
symbol-whitelist checks. Multi-Assets Mode and leverage calls still work.

---

## Notes

- Binance API keys deactivate after **90 days of inactivity**. Hit any signed endpoint
  occasionally to keep the key alive.
- **Lead Trader API key lifecycle**: keys auto-delete when the portfolio closes.
- **Order rate limit on Lead Trader keys**: 20 orders / 10 seconds — the bot honours
  this internally via a sliding-window throttle.
- **Trailing stop orders are banned** for Lead Trader. The bot manages stops itself with
  STOP_MARKET orders re-priced each candle (Phase 1 deliverable).
- See [Binance Lead Trader Copy Trading API docs](https://developers.binance.com/docs/copy_trading/future-copy-trading)
  and the [USD-M Futures API docs](https://developers.binance.com/docs/derivatives/usds-margined-futures).
