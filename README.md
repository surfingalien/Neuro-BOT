# Neuro Bot Terminal — self-improving crypto trading desk

An autonomous crypto paper-trading bot with a 6-agent pipeline, a target manager
that books profit/loss against daily AND weekly targets, Telegram alerts, and a
backtest mode that trains the AI Brain on historical candles in seconds.

> Paper trading by default: real Coinbase prices, fake money. Live trading on
> Coinbase is available but locked behind several gates (see "Coinbase" below).
> Nothing here is financial advice.

---

## Quickstart

```bash
# 1. install deps (bun or npm both work)
bun install

# 2. point Prisma at a local SQLite file
echo 'DATABASE_URL=file:./db/custom.db' > .env

# 3. create the schema
bun run db:push

# 4. run the dev server
bun run dev          # http://localhost:3000
```

Production:

```bash
bun run build
bun run start
```

The engine boots on the first HTTP request, restores balance/brain/positions
from SQLite, and starts its 3-second tick loop as a singleton
(safe against Next.js hot reloads via a version stamp on `globalThis`).

---

## Deploying (Railway)

The repo ships a `Dockerfile` + `railway.json`; Railway builds it automatically.

1. New Project → Deploy from GitHub repo → this repo.
2. **Add a Volume** mounted at `/data` (the SQLite file lives at `/data/custom.db`;
   without a volume, state resets on every deploy).
3. Settings → Networking → Generate Domain. No port needed: the app listens on
   `$PORT` and binds `0.0.0.0` (binding the container hostname is what causes
   "Application failed to respond").
4. Set `APP_PASSWORD` (dashboard login). Optional: `DATABASE_URL` (defaults to `file:/data/custom.db`). For Coinbase see the section above.

The container runs `prisma db push` on boot, so the schema is created/synced
automatically. The engine is a long-lived in-process loop with SQLite, so run a
**single instance** (no horizontal scaling) and use a host with a persistent
process, not serverless.

> Without `APP_PASSWORD` the control panel has no login: anyone with the URL can
> pause/reset the bot or change Telegram settings. Set it.

## Coinbase

**Market data** comes from Coinbase Advanced Trade's public API (no key needed),
with Binance and then a labelled simulation as fallbacks.

**Balance, holdings and live trading** use a Coinbase CDP API key, set as
environment variables on your host (never typed into the UI, never stored in the DB):

| Variable | Purpose |
|---|---|
| `COINBASE_API_KEY_NAME` | `organizations/{org_id}/apiKeys/{key_id}` |
| `COINBASE_API_PRIVATE_KEY` | the EC private key PEM (multi-line, or with `\n` escapes) |
| `LIVE_TRADING_ENABLED` | must be `true` before live mode can be switched on |
| `APP_PASSWORD` | dashboard login (HTTP Basic, any username). **Required for live trading** |
| `LIVE_BANKROLL_USD` | most the bot will ever manage (default `100`) |
| `LIVE_MAX_ORDER_USD` | hard cap per buy order (default `25`) |

Create the key at the Coinbase Developer Platform with **View + Trade** permissions
only (never Transfer/withdraw).

How live mode is fenced in:

- All gates above are re-checked server-side when you press GO LIVE, and you must type `ENABLE LIVE`.
- Live trades **Coinbase-listed majors only**, priced only from the real Coinbase feed (never simulated data).
- The bot's bankroll is `min(USD available, LIVE_BANKROLL_USD)`; each buy is capped by `LIVE_MAX_ORDER_USD`.
- The existing daily/weekly targets and loss-cap breakers apply to the live bankroll and sell real positions.
- Restarts always come back in paper mode. If live positions were still open, their exits keep being managed, but new entries stay locked until you re-confirm.
- Pausing stops new entries only; open live positions keep their stops and targets.
- If a sell fails the position stays open, is retried every 30s, and a Telegram alert fires (if enabled).
- `SELL ALL & GO PAPER` sells every live position and returns to the paper book. Reset is refused in live mode.

Know the limits: stops and targets are checked by this app every ~3s (they are not
resting orders on Coinbase), so if the app is down nothing is watching your positions.
Orders are market orders and pay Coinbase taker fees (all P&L is net of real fees).
The strategy is experimental; it can and will lose money. Start with a bankroll you can lose.

---

## What's inside

### 6-agent pipeline (hard handoffs, one job each)

| Agent      | Job                                                                 |
|------------|---------------------------------------------------------------------|
| SCOUT      | Coinbase 10 majors + DexScreener Solana memecoins (synthetic fallback) |
| FILTER     | 8 hard rules, one fail = killed (liquidity, bundlers, age, …)        |
| ANALYST    | 6 sub-scores → 0-100 weighted by the Brain's learned signal weights  |
| EXECUTOR   | softmax strategy pick (momentum / meanrev / breakout), ATR sizing    |
| RISK       | stop before entry, TP1 books ½ + arms trail, TP2, timeout, breakers  |
| LOGGER     | SQLite trade/log history + terminal-style live feed                  |

Plus the **BRAIN** agent watching over everything (see below).

### AI Brain — three learning layers, fully automatic

1. **Strategy weights** — reward-EMA (α=0.18) after every close, softmax τ=0.22
2. **Research engine** — the 6 analyst signal weights drift toward the signals
   that actually predicted winning trades (`learnFromTrade` correlation update)
3. **Strategy params** — per-strategy stop / hold / TP multipliers adapt from
   exit-reason patterns (stop-outs widen stops, timeouts shorten holds, runners
   stretch TPs)

A deep **auto-tune cycle** runs every 5 closed trades: win-rate outside 34-62%
moves the score gate (66-82) and the position-size multiplier (0.5-1.25).
Everything survives restarts (persisted in `BrainState` + rebuilt from trades).

### Target manager — books profit & loss by targets

- **Daily** profit target / loss cap (default +4% / −15%)
- **Weekly** profit target / loss cap (default +15% / −25%)
- At a target: book the P&L, close all opens (configurable), stop entries,
  auto-re-arm on the next UTC day / week
- At a cap: circuit breaker, book the loss, close everything; daily breaker
  needs a manual RESUME, weekly breaker auto-clears on week rollover
- Both horizons rendered as live progress bars in the Target Manager panel

### Backtest mode — train the Brain on history

`⧗ backtest` in the header opens the replay trainer:

- Replays 1-minute candles (Binance, up to 3000 bars ≈ 50h) through the **same**
  filter → analyst → strategist → risk pipeline as the live bot
- Memecoins get regime-switching synthetic paths (no free OHLC exists) — marked
  `SIM DATA` when used
- Every close calls the real `learnFromTrade`, so the Brain trains over
  hundreds of bars in seconds (weights, signal weights, params, autotunes)
- The replay also runs the daily/weekly target manager, counting target hits
  and breakers inside the sim
- **APPLY BRAIN TO LIVE BOT** imports the trained weights / gate / size /
  signal weights / params into the running bot and persists them
- Optionally start the replay from the **live brain** to A/B test it

### Telegram alerts

Settings → Telegram alerts: paste a BotFather token + chat id, flip ALERTS ON,
press SEND TEST. Fires (individually toggleable) on:

- 🎯 daily / weekly profit target booked
- 🛑 daily / weekly loss-cap breaker
- ✅ / ❌ every position close with P&L
- 🧠 brain auto-tune + param adaptations

Sends are serialized (≥900 ms apart) so bursts never hit rate limits; the
token/chat id are stored server-side and never echoed to any client.

---

## API

| Route            | Method | Purpose                                                    |
|------------------|--------|------------------------------------------------------------|
| `/api/state`     | GET    | full bot snapshot (agents, targets, brain, logs, tg)       |
| `/api/control`   | POST   | `start` `pause` `reset` `forceScan` `focus` `closePosition` `liveOn` `liveOff`|
| `/api/settings`  | GET/POST | risk + targets + telegram config (token never echoed)    |
| `/api/trades`    | GET    | closed trade history                                       |
| `/api/coinbase`  | GET    | real Coinbase balance + holdings, live-mode gate status    |
| `/api/backtest`  | GET/POST | GET last report · POST `{action:"run"|"apply", scope, bars, useLiveBrain}` |

## Layout

```
prisma/schema.prisma          Setting · Trade · LogEvent · BrainState
src/lib/engine/
  types.ts                    shared types (snapshots, position, targets)
  indicators.ts               EMA/RSI/MACD/BB/ATR — pure functions, no deps
  market.ts                   Binance + DexScreener feeds + synthetic fallback
  rules.ts                    FILTER 8 rules · ANALYST 6-signal scoring · ATR targets
  strategies.ts               entry triggers per strategy + softmax strategist
  brain.ts                    3-layer learning core + deep auto-tune
  backtest.ts                 walk-forward replay trainer
  telegram.ts                 queued Telegram notifier
  engine.ts                   singleton orchestrator (3s tick, 6 agents)
src/app/api/…                 state / control / settings / trades / backtest
src/components/terminal/…     HeaderBar, FlowPipeline, FilterPanel, AnalystPanel,
                              PositionPanel, BrainPanel, TargetPanel, StatsPanel,
                              LogPanel, AgentColumn, SettingsDialog, BacktestDialog
```

## Notes & limits

- Paper mode fills real prices with fake money and includes realistic slippage
  (0.04% majors / 0.4% memecoins). Memecoins (DexScreener/Solana) are paper-only:
  they can't be traded on Coinbase.
- Memecoin OHLC is synthesized around live DexScreener quotes (DexScreener has
  no free candle API); the UI marks simulated data everywhere it appears.
- The sandbox this was built in has no outbound Telegram access — SEND TEST
  will report a network error there; on any host with normal egress it works.
- Crypto is extremely high risk. The Brain improves odds; it does not remove
  risk. Memecoins can go to zero.
