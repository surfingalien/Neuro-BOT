// ─── BACKTEST MODE: replay history through the same 6-agent pipeline ───
// Purpose: train & validate the AI Brain in seconds instead of days.
// The walk-forward loop reuses the LIVE engine's exact modules —
// runFilter, runAnalyst, pickStrategy, checkEntrySignal, computeTargets,
// learnFromTrade — against historical 1m candles (Binance for majors,
// regime-switching synthetic paths for memecoins which have no free OHLC).
// The brain that comes out can be applied to the live bot with one click.

import {
  freshBrain,
  learnFromTrade,
  stratParams,
  type BrainCore,
} from "./brain";
import { computeTargets, runAnalyst, runFilter } from "./rules";
import { checkEntrySignal, pickStrategy } from "./strategies";
import { MAJOR_SYMBOLS } from "./market";
import { cbCandles, toProductId } from "./coinbase";
import { takerFee } from "./fees";
import { isoWeekKey } from "./util";
import { fetchMemecoins } from "./market";
import type { Candle, Klines, MarketFocus, ScoutPair, StrategyId } from "./types";
import { clamp } from "./indicators";

export interface BacktestParams {
  scope: MarketFocus; // majors | memecoins | both
  bars: number; // 1m bars per symbol, 300..3000
  useLiveBrain: boolean; // start from the live brain snapshot instead of fresh
  feeRate?: number; // exchange fee per side as a fraction (0.006 = 0.6%); default: realistic Coinbase taker fee for majors
  startBalance: number;
}

export interface BrainView {
  weights: Record<StrategyId, number>;
  scoreThreshold: number;
  sizeMultiplier: number;
  signalWeights: number[];
  stratParams: Record<StrategyId, { holdMult: number; stopMult: number; tpMult: number }>;
  autotuneCount: number;
}

export interface BacktestReport {
  id: string;
  ranAt: number;
  simulated: boolean; // true when no outbound network — synthetic candles
  scope: MarketFocus;
  symbols: string[];
  bars: number;
  spanHours: number;
  startBalance: number;
  endBalance: number;
  endEquity: number; // balance + unrealized
  pnl: number;
  pnlPct: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  maxDrawdownPct: number;
  dailyTargetHits: number;
  dailyBreakerHits: number;
  weeklyTargetHits: number;
  weeklyBreakerHits: number;
  equityCurve: { i: number; eq: number }[];
  perStrategy: { strategy: StrategyId; trades: number; wins: number; pnl: number }[];
  brainBefore: BrainView;
  brainAfter: BrainView;
  lessons: string[];
  log: string[];
  feeRate: number;
  feesPaid: number; // total fees charged in the replay (already inside pnl)
  byReason: Record<string, { n: number; pnl: number }>;
}

interface BtPosition {
  symbol: string;
  base: string;
  market: "majors" | "memecoin";
  strategy: StrategyId;
  entryPrice: number;
  qty: number;
  sizeUsd: number;
  score: number;
  regime: "trending_up" | "trending_down" | "ranging";
  stopLoss: number;
  tp1: number;
  tp2: number;
  trailGapPct: number;
  trailActive: boolean;
  trailPeak: number;
  openedBar: number;
  tp1Booked: boolean;
  entryScores: number[];
}

const WARMUP = 130; // bars needed before first decision (indicators + 24h proxies)
const TRAIL_GAP_PCT = 15; // mirrors live engine default
const MAX_POSITIONS = 5;
const MAX_POSITION_PCT = 8;
const DAILY_TARGET_PCT = 4;
const DAILY_CAP_PCT = 15;
const WEEKLY_TARGET_PCT = 15;
const WEEKLY_CAP_PCT = 25;
const MAX_HOLD_BARS = 360;

const g = globalThis as unknown as { __nbBacktest?: { running: boolean; last: BacktestReport | null } };
const btState = (): { running: boolean; last: BacktestReport | null } =>
  (g.__nbBacktest ??= { running: false, last: null });
export const backtestBusy = (): boolean => btState().running;
export const lastReport = (): BacktestReport | null => btState().last;

// ───────────────────────── data loading ─────────────────────────

const SIM_PRICE_ANCHORS: Record<string, number> = {
  BTCUSDT: 76000, ETHUSDT: 2750, SOLUSDT: 148, BNBUSDT: 590, XRPUSDT: 1.85,
  DOGEUSDT: 0.16, ADAUSDT: 0.52, LINKUSDT: 13.4, AVAXUSDT: 18.2, SUIUSDT: 2.1,
};

/** real 1m candles from Coinbase, paged backwards 300 at a time (public endpoint, no key).
 *  Retries rate-limit errors, and returns a COMPLETE minute grid: Coinbase omits minutes with no trades,
 *  so gaps are forward-filled (flat candle, zero volume). That keeps every symbol's index i = the same minute. */
async function coinbase1m(symbol: string, bars: number): Promise<Candle[]> {
  const id = toProductId(symbol);
  const byMinute = new Map<number, Candle>();
  let end = Math.floor(Date.now() / 1000);
  let minutes = 0;
  try {
    while (minutes < bars) {
      const n = Math.min(300, bars - minutes);
      let page: Candle[] = [];
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          page = await cbCandles(id, "ONE_MINUTE", n, end);
          break;
        } catch (e) {
          if (attempt === 3) throw e;
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt)); // 0.5s, 1s, 2s
        }
      }
      for (const c of page) byMinute.set(Math.floor(c.t / 60000), c);
      minutes += n; // the window advances by n minutes whether or not every minute traded
      end -= n * 60;
      await new Promise((r) => setTimeout(r, 120)); // stay well under the public rate limit
    }
  } catch {
    /* use what we have */
  }
  if (byMinute.size === 0) return [];
  const keys = [...byMinute.keys()].sort((a, b) => a - b);
  const out: Candle[] = [];
  let prev = byMinute.get(keys[0])!;
  for (let m = keys[0]; m <= keys[keys.length - 1]; m++) {
    const c = byMinute.get(m);
    if (c) {
      out.push(c);
      prev = c;
    } else {
      out.push({ t: m * 60000, o: prev.c, h: prev.c, l: prev.c, c: prev.c, v: 0 }); // no trades this minute
    }
  }
  return out;
}

async function binance1m(symbol: string, bars: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let endTime = 0;
  try {
    while (out.length < bars) {
      const limit = Math.min(1000, bars - out.length);
      const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=${limit}${endTime ? `&endTime=${endTime}` : ""}`;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(t);
      if (!res.ok) break;
      const arr = (await res.json()) as unknown[][];
      if (!Array.isArray(arr) || arr.length === 0) break;
      const page: Candle[] = arr.map((a) => ({
        t: Number(a[0]), o: parseFloat(String(a[1])), h: parseFloat(String(a[2])),
        l: parseFloat(String(a[3])), c: parseFloat(String(a[4])), v: parseFloat(String(a[5])),
      }));
      out.unshift(...page);
      endTime = page[0].t - 1;
      if (arr.length < limit) break;
    }
  } catch {
    return out;
  }
  return out;
}

/** regime-switching GBM with pump/dump events — stands in for memecoin OHLC */
function synthCandles(startPrice: number, bars: number, vol: number, seed: number): Candle[] {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const out: Candle[] = [];
  const t0 = Date.now() - bars * 60_000;
  let p = startPrice;
  let drift = 0;
  let regimeLeft = 60 + Math.floor(rnd() * 180);
  for (let i = 0; i < bars; i++) {
    if (--regimeLeft <= 0) {
      drift = (rnd() - 0.42) * vol * 0.5; // slight upward bias across regimes
      regimeLeft = 90 + Math.floor(rnd() * 240);
      if (rnd() < 0.16) drift *= 4; // pump / dump leg
    }
    const shock = rnd() < 0.006 ? (rnd() - 0.5) * vol * 14 : 0; // sudden prints
    p = Math.max(startPrice * 0.15, p * (1 + drift + (rnd() - 0.5) * vol + shock));
    const o = p * (1 - (rnd() - 0.5) * vol * 0.6);
    const h = Math.max(p, o) * (1 + rnd() * vol * 0.7);
    const l = Math.min(p, o) * (1 - rnd() * vol * 0.7);
    out.push({ t: t0 + i * 60_000, o, h, l, c: p, v: 900 + rnd() * 1900 });
  }
  return out;
}

async function loadSymbolData(
  scope: MarketFocus,
  bars: number
): Promise<{ symbol: string; base: string; name: string; market: "majors" | "memecoin"; candles: Candle[]; liq: number; mcapMult: number; avgTxn: number; simulatedAll: boolean }[]> {
  const out: { symbol: string; base: string; name: string; market: "majors" | "memecoin"; candles: Candle[]; liq: number; mcapMult: number; avgTxn: number; simulatedAll: boolean }[] = [];
  let anyLive = false;

  if (scope === "majors" || scope === "both") {
    const syms = (scope === "majors" ? MAJOR_SYMBOLS : MAJOR_SYMBOLS.slice(0, 4)) as readonly string[];
    // real Coinbase candles first (Binance blocks US hosts); 2 symbols at a time to respect the public rate limit
    const pages: Candle[][] = [];
    for (let i = 0; i < syms.length; i += 2) {
      pages.push(...(await Promise.all(syms.slice(i, i + 2).map(async (s) => {
        const cb = await coinbase1m(s, bars);
        return cb.length >= 200 ? cb : binance1m(s, bars);
      }))));
    }
    syms.forEach((s, idx) => {
      const candles = pages[idx];
      if (candles.length >= 200) {
        anyLive = true;
        out.push({ symbol: s, base: s.replace("USDT", ""), name: s, market: "majors", candles, liq: 0, mcapMult: 1, avgTxn: 0, simulatedAll: false });
      } else {
        const anchor = SIM_PRICE_ANCHORS[s] ?? 100;
        out.push({ symbol: s, base: s.replace("USDT", ""), name: s, market: "majors", candles: synthCandles(anchor, bars, 0.0016, 77 + idx), liq: 0, mcapMult: 1, avgTxn: 0, simulatedAll: true });
      }
    });
  }

  // align every real majors grid to the common time window so candle index i is the same minute everywhere
  const realMajors = out.filter((o) => o.market === "majors" && !o.simulatedAll && o.candles.length > 0);
  if (realMajors.length > 1) {
    const t0 = Math.max(...realMajors.map((o) => o.candles[0].t));
    const t1 = Math.min(...realMajors.map((o) => o.candles[o.candles.length - 1].t));
    for (const o of realMajors) o.candles = o.candles.filter((c) => c.t >= t0 && c.t <= t1);
  }

  if (scope === "memecoins" || scope === "both") {
    // try live quotes to anchor synthetic paths (DexScreener has no free OHLC)
    const { rows } = await fetchMemecoins();
    const live = rows.filter((r) => r.market === "memecoin").slice(0, 4);
    const n = scope === "memecoins" ? 6 : 4;
    for (let i = 0; i < n; i++) {
      const anchor = live[i]?.price ?? 0.0004 + (i % 5) * 0.004;
      const candles = synthCandles(anchor, bars, 0.0085, 1337 + i * 17);
      out.push({
        symbol: live[i]?.symbol ?? `SIMM${i}`,
        base: live[i]?.base ?? `$SIMM${i}`,
        name: live[i]?.name ?? `synthetic memecoin ${i + 1}`,
        market: "memecoin",
        candles,
        liq: live[i]?.liquidity ?? 60_000 + (i % 5) * 70_000,
        mcapMult: 7,
        avgTxn: 420,
        simulatedAll: true,
      });
    }
  }

  // simulated flag: true only when EVERY majors feed came from the synthesizer
  const majorsPart = out.filter((o) => o.market === "majors");
  const simulated = majorsPart.length > 0 ? majorsPart.every((o) => o.simulatedAll) : !anyLive;
  return out.map((o) => ({ ...o, simulatedAll: simulated }));
}

// ───────────────────────── window builders ─────────────────────────

function majorsPair(symbol: string, candles: Candle[], i: number): ScoutPair {
  const c = candles[i];
  const back24 = Math.max(0, i - 1440);
  // Binance kline volume is BASE asset — convert to USD quote volume like the live feed does
  const vol24 = candles.slice(back24, i + 1).reduce((a, x) => a + x.v * x.c, 0);
  const vol1h = candles.slice(Math.max(0, i - 59), i + 1).reduce((a, x) => a + x.v * x.c, 0);
  const ref = candles[back24].c;
  return {
    symbol,
    base: symbol.replace("USDT", ""),
    name: symbol,
    market: "majors",
    price: c.c,
    change24h: ref > 0 ? ((c.c - ref) / ref) * 100 : 0,
    volume24h: vol24,
    volume1h: vol1h,
    liquidity: vol24 * 0.4,
    mcap: c.c * 1e12,
    ageHours: 99999,
    txns1h: Math.round(vol24 / 8000),
    buys1h: Math.round(vol24 / 16000),
    sells1h: Math.round(vol24 / 16000),
    source: "coinbase", // same filter thresholds as the live feed
  };
}

function memePair(meta: { symbol: string; base: string; name: string; liq: number; mcapMult: number; avgTxn: number }, candles: Candle[], i: number, phase: number): ScoutPair {
  const c = candles[i];
  const back24 = Math.max(0, i - 1440);
  const vol1h = candles.slice(Math.max(0, i - 59), i + 1).reduce((a, x) => a + x.v, 0);
  const vol24 = candles.slice(back24, i + 1).reduce((a, x) => a + x.v, 0) * 6;
  const ref = candles[back24].c;
  const txns = Math.max(40, Math.round(vol1h / meta.avgTxn));
  const buyShare = clamp(0.5 + 0.28 * Math.sin(phase * 0.017) + (c.c > c.o ? 0.08 : -0.06), 0.2, 0.85);
  return {
    symbol: meta.symbol,
    base: meta.base,
    name: meta.name,
    market: "memecoin",
    price: c.c,
    change24h: ref > 0 ? ((c.c - ref) / ref) * 100 : 0,
    volume24h: vol24,
    volume1h: vol1h,
    liquidity: meta.liq,
    mcap: meta.liq * meta.mcapMult,
    ageHours: 30 + (i % 200),
    txns1h: txns,
    buys1h: Math.round(txns * buyShare),
    sells1h: Math.max(1, txns - Math.round(txns * buyShare)),
    source: "backtest",
  };
}

function windowKlines(candles: Candle[], i: number): Klines {
  const m1 = candles.slice(Math.max(0, i - 119), i + 1);
  const h1: Candle[] = [];
  for (let j = Math.max(0, i - 60 * 59); j <= i; j += 60) {
    const seg = candles.slice(j, Math.min(j + 60, i + 1));
    if (seg.length === 0) continue;
    h1.push({
      t: seg[0].t,
      o: seg[0].o,
      h: Math.max(...seg.map((x) => x.h)),
      l: Math.min(...seg.map((x) => x.l)),
      c: seg[seg.length - 1].c,
      v: seg.reduce((a, x) => a + x.v, 0),
    });
  }
  return { m1, h1, simulated: false };
}

function regimeFromRef(candles: Candle[], i: number): { regime: "trending_up" | "trending_down" | "ranging"; vol: "calm" | "normal" | "volatile" } {
  const closes = candles.slice(Math.max(0, i - 1440), i + 1).filter((_, idx) => (i - idx) % 60 === 0).map((c) => c.c);
  if (closes.length < 50) return { regime: "ranging", vol: "normal" };
  const e20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const e50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
  const chg = ((closes[closes.length - 1] - closes[closes.length - 12]) / closes[closes.length - 12]) * 100;
  const regime = e20 > e50 * 1.001 && chg > 0.3 ? "trending_up" : e20 < e50 * 0.999 && chg < -0.3 ? "trending_down" : "ranging";
  const range = Math.abs(chg);
  return { regime, vol: range > 2.5 ? "volatile" : range > 1 ? "normal" : "calm" };
}

function brainView(b: BrainCore): BrainView {
  return {
    weights: { ...b.weights },
    scoreThreshold: b.scoreThreshold,
    sizeMultiplier: b.sizeMultiplier,
    signalWeights: [...b.signalWeights],
    stratParams: {
      momentum: { ...b.strategies.momentum },
      meanrev: { ...b.strategies.meanrev },
      breakout: { ...b.strategies.breakout },
    } as Record<StrategyId, { holdMult: number; stopMult: number; tpMult: number }>,
    autotuneCount: b.autotuneCount,
  };
}

const fmt = (n: number) => `${n >= 0 ? "+" : "–"}$${Math.abs(n).toFixed(2)}`;

// ───────────────────────── the replay loop ─────────────────────────

export async function runBacktest(params: BacktestParams, liveBrain: BrainCore | null): Promise<BacktestReport> {
  const st = btState();
  if (st.running) throw new Error("backtest already running");
  st.running = true;
  try {
    const bars = Math.round(Math.max(300, Math.min(10000, params.bars || 1000)));
    const scope = params.scope || "majors";
    const startBalance = Math.max(100, Math.min(1_000_000, params.startBalance || 1000));

    const brain: BrainCore = params.useLiveBrain && liveBrain ? JSON.parse(JSON.stringify(liveBrain)) : freshBrain();
    const brainBefore = brainView(brain);

    const data = await loadSymbolData(scope, bars);
    if (data.length === 0) throw new Error("no market data available");
    const simulated = data.some((d) => d.simulatedAll);
    const minLen = Math.min(...data.map((d) => d.candles.length));
    if (minLen < WARMUP + 60) throw new Error("not enough history fetched");

    // fees: paper/backtest used to charge only 0.04% slippage; Coinbase market orders cost ~0.6%/side at low volume tiers
    const feeRate = typeof params.feeRate === "number" && params.feeRate >= 0 ? Math.min(0.02, params.feeRate) : scope === "memecoins" ? 0.003 : takerFee();
    let feesPaid = 0;
    const byReason: Record<string, { n: number; pnl: number }> = {};
    let balance = startBalance;
    const positions: BtPosition[] = [];
    const eqCurve: { i: number; eq: number }[] = [];
    const logLines: string[] = [];
    const pushLog = (s: string) => {
      logLines.push(s);
      if (logLines.length > 60) logLines.shift();
    };

    let trades = 0, wins = 0, losses = 0;
    const stratStats: Record<StrategyId, { trades: number; wins: number; pnl: number }> = {
      momentum: { trades: 0, wins: 0, pnl: 0 },
      meanrev: { trades: 0, wins: 0, pnl: 0 },
      breakout: { trades: 0, wins: 0, pnl: 0 },
    };
    let dailyTargetHits = 0, dailyBreakerHits = 0, weeklyTargetHits = 0, weeklyBreakerHits = 0;
    let peakEq = startBalance, maxDd = 0;

    // target-manager bookkeeping (mirrors live engine)
    let dayKey = "", dayPnl = 0, dayStart = balance, dayLocked = false, dayHalted = false;
    let weekKey = "", weekPnl = 0, weekStart = balance, weekLocked = false, weekHalted = false;
    let reg: { regime: "trending_up" | "trending_down" | "ranging"; vol: "calm" | "normal" | "volatile" } = { regime: "ranging", vol: "normal" };
    const refCandles = data[0].candles; // regime reference (first symbol, like BTC in live)

    for (let i = WARMUP; i < minLen; i++) {
      const bar = refCandles[i];
      const dKey = new Date(bar.t).toISOString().slice(0, 10);
      const wKey = isoWeekKey(bar.t);

      // ── day / week rollover ──
      if (dKey !== dayKey) {
        dayKey = dKey; dayPnl = 0; dayStart = balance; dayLocked = false; dayHalted = false;
      }
      if (wKey !== weekKey) {
        if (weekKey) pushLog(`[${dKey} ${String(new Date(bar.t).getUTCHours()).padStart(2, "0")}:00] WEEK ROLLOVER ${wKey} — weekly bookkeeping reset`);
        weekKey = wKey; weekPnl = 0; weekStart = balance; weekLocked = false; weekHalted = false;
      }

      // regime refresh hourly (like live refreshRegime every 20 ticks)
      if (i % 60 === 0 || !reg) reg = regimeFromRef(refCandles, i);

      // ── manage open positions on this bar (pessimistic: stop before tp) ──
      for (const pos of [...positions]) {
        const sym = data.find((d) => d.symbol === pos.symbol);
        if (!sym || i >= sym.candles.length) continue;
        const c = sym.candles[i];
        const holdMult = brain.strategies[pos.strategy].holdMult;
        const heldBars = i - pos.openedBar;
        const trailStop = pos.trailPeak * (1 - pos.trailGapPct / 100);

        let reason: "stop" | "trail" | "tp2" | "timeout" | null = null;
        if (c.l <= pos.stopLoss) reason = "stop";
        else if (pos.trailActive && c.l <= trailStop) reason = "trail";
        else if (c.h >= pos.tp2) reason = "tp2";
        else if (heldBars > Math.max(5, Math.round(MAX_HOLD_BARS * holdMult))) reason = "timeout";

        if (reason) {
          const exitPx = reason === "stop" ? Math.min(c.o, pos.stopLoss) : reason === "trail" ? Math.min(c.o, trailStop) : reason === "tp2" ? pos.tp2 : c.c;
          closeBt(pos, exitPx, reason, i);
          continue;
        }
        // TP1 book-half + arm trail
        if (!pos.tp1Booked && c.h >= pos.tp1) {
          const halfFee = pos.tp1 * (pos.qty / 2) * feeRate;
          feesPaid += halfFee;
          const booked = ((pos.tp1 - pos.entryPrice) * pos.qty) / 2 - halfFee;
          balance += booked;
          pos.tp1Booked = true;
          pos.trailActive = true;
          pos.trailPeak = Math.max(c.h, pos.tp1);
          pushLog(`[bar ${i}] TRAIL ${pos.base} booked ½ ${fmt(booked)} · trailing ${pos.trailGapPct}% under peak`);
        }
        if (c.h > pos.trailPeak) pos.trailPeak = c.h;
      }

      // ── target manager check (realized day / week pnl) ──
      const dayPct = dayStart > 0 ? (dayPnl / dayStart) * 100 : 0;
      const weekPct = weekStart > 0 ? (weekPnl / weekStart) * 100 : 0;
      if (!dayLocked && dayPct >= DAILY_TARGET_PCT) {
        dayLocked = true; dailyTargetHits += 1;
        for (const p of [...positions]) closeBt(p, priceOf(p, i), "target", i);
        pushLog(`[${dKey}] TARGET HIT day ${dayPct.toFixed(2)}% ≥ ${DAILY_TARGET_PCT}% — booked ${fmt(dayPnl)} · flat until next day`);
      }
      if (!dayHalted && dayPct <= -DAILY_CAP_PCT) {
        dayHalted = true; dailyBreakerHits += 1;
        for (const p of [...positions]) closeBt(p, priceOf(p, i), "circuit", i);
        pushLog(`[${dKey}] DAILY LOSS CAP day ${dayPct.toFixed(2)}% — breaker, flat rest of day`);
      }
      if (!weekLocked && weekPct >= WEEKLY_TARGET_PCT) {
        weekLocked = true; weeklyTargetHits += 1;
        for (const p of [...positions]) closeBt(p, priceOf(p, i), "target", i);
        pushLog(`[${dKey}] WEEKLY TARGET HIT ${weekPct.toFixed(2)}% — booked ${fmt(weekPnl)} · flat rest of week`);
      }
      if (!weekHalted && weekPct <= -WEEKLY_CAP_PCT) {
        weekHalted = true; weeklyBreakerHits += 1;
        for (const p of [...positions]) closeBt(p, priceOf(p, i), "circuit", i);
        pushLog(`[${dKey}] WEEKLY LOSS CAP ${weekPct.toFixed(2)}% — breaker, flat rest of week`);
      }

      const entriesBlocked = dayLocked || dayHalted || weekLocked || weekHalted;

      // ── entries: one candidate scan per symbol per bar ──
      if (!entriesBlocked && positions.length < MAX_POSITIONS) {
        for (const sym of data) {
          if (positions.length >= MAX_POSITIONS) break;
          if (positions.some((p) => p.symbol === sym.symbol)) continue;
          const pair = sym.market === "majors" ? majorsPair(sym.symbol, sym.candles, i) : memePair(sym, sym.candles, i, i);
          if (!runFilter(pair).passed) continue;
          const k = windowKlines(sym.candles, i);
          const res = runAnalyst(pair, k, brain.scoreThreshold, brain.signalWeights);
          if (!res.passed) continue;
          const decision = pickStrategy(reg.regime, brain.weights);
          // executor takes the first CONFIRMED setup: brain pick first, then the
          // other strategies in weight order — mirrors a desk trading what's live
          const order: StrategyId[] = [decision.strategy, ...(["momentum", "meanrev", "breakout"] as StrategyId[]).filter((s) => s !== decision.strategy).sort((a, b) => brain.weights[b] - brain.weights[a])];
          let fired: { strategy: StrategyId; detail: string } | null = null;
          for (const s of order) {
            const sig = checkEntrySignal(s, k);
            if (sig.ok) {
              fired = { strategy: s, detail: sig.detail };
              break;
            }
          }
          if (!fired) continue;

          const conf = clamp(0.6 + (0.8 * (res.final - brain.scoreThreshold)) / 30, 0.6, 1.4);
          const sizePct = clamp(MAX_POSITION_PCT * conf * brain.sizeMultiplier, 1, 15);
          const sizeUsd = (balance * sizePct) / 100;
          if (sizeUsd < 5) continue;
          const slip = sym.market === "majors" ? 0.0004 : 0.004;
          const entry = pair.price * (1 + slip);
          const sp = stratParams(brain, fired.strategy);
          const t = computeTargets(entry, sym.market, k, { stopMult: sp.stopMult, tpMult: sp.tpMult });
          positions.push({
            symbol: sym.symbol, base: pair.base, market: sym.market,
            strategy: fired.strategy, entryPrice: entry, qty: sizeUsd / entry,
            sizeUsd, score: res.final, regime: reg.regime,
            stopLoss: t.stopLoss, tp1: t.tp1, tp2: t.tp2,
            trailGapPct: TRAIL_GAP_PCT, trailActive: false, trailPeak: entry,
            openedBar: i, tp1Booked: false, entryScores: res.scores.map((x) => x.value),
          });
          pushLog(`[bar ${i}] ENTER ${pair.base} ${fired.strategy} ${fmtUsd2(sizeUsd)} · score ${res.final} · ${reg.regime.replace("trending_", "trend ")}${fired.strategy !== decision.strategy ? " · fallback pick" : ""}`);
        }
      }

      // equity mark
      if (i % 5 === 0 || i === minLen - 1) {
        const unreal = positions.reduce((a, p) => {
          const sym = data.find((d) => d.symbol === p.symbol);
          const px = sym ? sym.candles[i].c : p.entryPrice;
          const openQty = p.qty * (p.tp1Booked ? 0.5 : 1);
          const banked = p.tp1Booked ? ((p.tp1 - p.entryPrice) * p.qty) / 2 : 0;
          return a + (px - p.entryPrice) * openQty + banked;
        }, 0);
        const eq = balance + unreal;
        eqCurve.push({ i, eq });
        peakEq = Math.max(peakEq, eq);
        maxDd = Math.max(maxDd, ((peakEq - eq) / peakEq) * 100);
      }
    }

    // close anything left at the final bar
    for (const p of [...positions]) closeBt(p, priceOf(p, minLen - 1), "timeout", minLen - 1);

    const endEquity = balance;
    const pnl = endEquity - startBalance;
    const spanHours = Math.round(((refCandles[minLen - 1].t - refCandles[WARMUP].t) / 3_600_000) * 10) / 10;

    // downsample equity curve to ≤150 pts
    const step = Math.max(1, Math.ceil(eqCurve.length / 150));
    const equity = eqCurve.filter((_, idx) => idx % step === 0 || idx === eqCurve.length - 1);

    const report: BacktestReport = {
      id: `bt-${Date.now()}`,
      ranAt: Date.now(),
      simulated,
      scope,
      symbols: data.map((d) => d.base),
      bars: minLen,
      spanHours,
      startBalance,
      endBalance: endEquity,
      endEquity,
      pnl,
      pnlPct: (pnl / startBalance) * 100,
      trades,
      wins,
      losses,
      winRate: trades > 0 ? (wins / trades) * 100 : 0,
      maxDrawdownPct: maxDd,
      dailyTargetHits,
      dailyBreakerHits,
      weeklyTargetHits,
      weeklyBreakerHits,
      equityCurve: equity,
      perStrategy: (["momentum", "meanrev", "breakout"] as StrategyId[]).map((s) => ({
        strategy: s, trades: stratStats[s].trades, wins: stratStats[s].wins, pnl: stratStats[s].pnl,
      })),
      brainBefore,
      brainAfter: brainView(brain),
      lessons: [...brain.lessons],
      log: logLines,
      feeRate,
      feesPaid,
      byReason,
    };
    st.last = report;
    return report;

    // ── nested helpers sharing loop state ──
    function priceOf(p: BtPosition, i: number): number {
      const sym = data.find((d) => d.symbol === p.symbol);
      return sym && i < sym.candles.length ? sym.candles[i].c : p.entryPrice;
    }

    function closeBt(pos: BtPosition, px: number, reason: string, i: number) {
      const idx = positions.indexOf(pos);
      if (idx >= 0) positions.splice(idx, 1);
      const remainingQty = pos.qty * (pos.tp1Booked ? 0.5 : 1);
      const entryFee = pos.sizeUsd * feeRate;
      const exitFee = px * remainingQty * feeRate;
      const bankedNet = pos.tp1Booked ? ((pos.tp1 - pos.entryPrice) * pos.qty) / 2 - pos.tp1 * (pos.qty / 2) * feeRate : 0;
      const realized = (px - pos.entryPrice) * remainingQty - exitFee - entryFee + bankedNet;
      feesPaid += entryFee + exitFee;
      const pnlPct = ((px - pos.entryPrice) / pos.entryPrice) * 100;
      const plannedRiskPct = Math.abs(((pos.stopLoss - pos.entryPrice) / pos.entryPrice) * 100) || 8;
      const reward = clamp((reason === "stop" ? -plannedRiskPct : pnlPct) / plannedRiskPct, -1, 1);
      balance += realized - bankedNet; // the TP1 half was already added to balance when it booked
      (byReason[reason] ??= { n: 0, pnl: 0 }).n += 1;
      byReason[reason].pnl += realized;
      dayPnl += realized;
      weekPnl += realized;
      trades += 1;
      if (realized >= 0) wins += 1; else losses += 1;
      stratStats[pos.strategy].trades += 1;
      stratStats[pos.strategy].pnl += realized;
      if (realized >= 0) stratStats[pos.strategy].wins += 1;

      const events = learnFromTrade(brain, pos.strategy, pos.regime, reward, realized, realized >= 0, reason, pos.entryScores);
      pushLog(`[bar ${i}] CLOSE ${pos.base} ${fmt(realized)} · ${reason} · day ${fmt(dayPnl)}${events.some((e) => e.startsWith("AUTOTUNE")) ? " · autotune ran" : ""}`);
    }
  } finally {
    st.running = false;
  }
}

function fmtUsd2(n: number): string {
  return `$${n.toFixed(n < 10 ? 2 : 0)}`;
}
