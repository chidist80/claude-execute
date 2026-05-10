# Bot state — auto-updated by Railway bot

This branch is overwritten on every cron fire by the deployed bot. Files that appear here:

- `last-run.json` — latest cron summary (timestamp, mode, decision)
- `safety-check-log.json` — full append-only decision log
- `equity-history.json` — account equity samples (live mode only)
- `trades.csv` — tax-ready trade record with AUD basis
- `rules.json` — current strategy config

**Do not edit this branch by hand.** Changes get overwritten on the next cron fire.

To view bot state from anywhere, point the dashboard at this branch's raw URL:

```bash
npm run dashboard
open "http://localhost:3737/?source=https://raw.githubusercontent.com/chidist80/claude-execute/bot-state"
```

See `PHASE-0-NOTES.md` for the full hosted-dashboard setup.
