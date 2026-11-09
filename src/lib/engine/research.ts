// ─── Research harness: fee-aware, walk-forward strategy validation on real Coinbase hourly candles ───
// Pure functions (plus one data loader). Used by scripts/research.ts and by the live-trading validation gate.
//
// Rules that keep the numbers honest:
//  • decisions use bar t's CLOSE; fills happen at bar t+1's OPEN (no look-ahead)
//  • stops are checked against each bar's LOW (gap-through fills at the open)
//  • every entry and exit pays the exchange fee + slippage
//  • parameters are chosen on a TRAIN window and judged only on the NEXT, unseen TEST window

import type { Candle } from "./types";
import { cbCandles, toProductId } from "./coinbase";

// ───────────────────────── data ─────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** real hourly candles from Coinbase, paged backwards; gaps (hours with no trades) forward-filled; all coins trimmed to one window */
export async function loadHourly(symbols: string[], days: number): Promise<Record<string, Candle[]>> {
  const bars = Math.round(days * 24);
  const raw: Record<string, Map<number, Candle>> = {};
  for (const sym of symbols) {
    const id = toProductId(sym);
    const byHour = new Map<number, Candle>();
    let end = Math.floor(Date.now() / 1000);
    for (let got = 0; got < bars; got += 300) {
      const n = Math.min(300, bars - got);
      let page: Candle[] = [];
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          page = await cbCandles(id, "ONE_HOUR", n, end);
          break;
        } catch (e) {
          if (attempt === 3) throw e;
          await sleep(500 * 2 ** attempt);
        }
      }
      for (const c of page) byHour.set(Math.floor(c.t / 3_600_000), c);
      end -= n * 3600;
      await sleep(120);
    }
    raw[sym] = byHour;
  }
  const grids: Record<string, Candle[]> = {};
  for (const [sym, m] of Object.entries(raw)) {
    if (m.size === 0) continue;
    const keys = [...m.keys()].sort((a, b) => a - b);
    const out: Candle[] = [];
    let prev = m.get(keys[0])!;
    for (let h = keys[0]; h <= keys[keys.length - 1]; h++) {
      const c = m.get(h);
      if (c) {
        out.push(c);
        prev = c;
      } else out.push({ t: h * 3_600_000, o: prev.c, h: prev.c, l: prev.c, c: prev.c, v: 0 });
    }
    grids[sym] = out;
  }
  const syms = Object.keys(grids);
  const t0 = Math.max(...syms.map((s) => grids[s][0].t));
  const t1 = Math.min(...syms.map((s) => grids[s][grids[s].length - 1].t));
  for (const s of syms) grids[s] = grids[s].filter((c) => c.t >= t0 && c.t <= t1);
  return grids;
}

// ───────────────────────── indicators (full series) ─────────────────────────

export const emaSeries = (x: number[], n: number): number[] => {
  const k = 2 / (n + 1);
  const out: number[] = [];
  let e = x[0];
  for (let i = 0; i < x.length; i++) {
    e = i === 0 ? x[0] : x[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
};

export const atrSeries = (c: Candle[], n = 24): number[] => {
  const out: number[] = [];
  let a = 0;
  for (let i = 0; i < c.length; i++) {
    const tr = i === 0 ? c[0].h - c[0].l : Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
    a = i < n ? (a * i + tr) / (i + 1) : (a * (n - 1) + tr) / n;
    out.push(a);
  }
  return out;
};

export const rsiSeries = (x: number[], n = 14): number[] => {
  const out: number[] = [50];
  let up = 0;
  let dn = 0;
  for (let i = 1; i < x.length; i++) {
    const d = x[i] - x[i - 1];
    const u = Math.max(d, 0);
    const dd = Math.max(-d, 0);
    if (i <= n) {
      up += u / n;
      dn += dd / n;
    } else {
      up = (up * (n - 1) + u) / n;
      dn = (dn * (n - 1) + dd) / n;
    }
    out.push(dn === 0 ? 100 : 100 - 100 / (1 + up / dn));
  }
  return out;
};

/** highest high of the previous n bars (excludes the current bar) */
export const prevHigh = (c: Candle[], n: number): number[] =>
  c.map((_, i) => {
    let m = -Infinity;
    for (let j = Math.max(0, i - n); j < i; j++) m = Math.max(m, c[j].h);
    return i === 0 ? c[0].h : m;
  });

export interface Ind {
  c: Candle[];
  close: number[];
  ema50: number[];
  ema100: number[];
  ema200: number[];
  ema400: number[];
  atr: number[];
  rsi: number[];
  hh24: number[];
  hh48: number[];
  hh72: number[];
  hh168: number[];
}

export function indicators(c: Candle[]): Ind {
  const close = c.map((x) => x.c);
  return {
    c,
    close,
    ema50: emaSeries(close, 50),
    ema100: emaSeries(close, 100),
    ema200: emaSeries(close, 200),
    ema400: emaSeries(close, 400),
    atr: atrSeries(c, 24),
    rsi: rsiSeries(close, 14),
    hh24: prevHigh(c, 24),
    hh48: prevHigh(c, 48),
    hh72: prevHigh(c, 72),
    hh168: prevHigh(c, 168),
  };
}

// ───────────────────────── simulator ─────────────────────────

export interface SimCfg {
  feeRate: number; // per side, fraction (0.006 = 0.6%)
  slip: number; // per side, fraction
  maxPos: number;
  posFrac: number; // fraction of equity per position
  startEq: number;
}
export const DEFAULT_SIM: SimCfg = { feeRate: 0.006, slip: 0.0005, maxPos: 4, posFrac: 0.25, startEq: 1000 };

export interface Strat {
  name: string;
  params: Record<string, number>;
  enter: (i: number, d: Ind) => boolean;
  /** discretionary exit evaluated on the close, filled at the next open */
  exit?: (i: number, d: Ind) => boolean;
  stopAtr: number; // initial stop distance in ATRs below the entry
  trailAtr: number; // trailing stop distance in ATRs below the highest close (0 = off)
  maxHold: number; // bars
}

export interface SimTrade { sym: string; pnl: number; pnlPct: number; bars: number; reason: string }
export interface SimResult {
  ret: number; // net return, fraction
  grossRet: number; // return if fees + slippage were zero... approximated by adding fees back
  trades: SimTrade[];
  winRate: number;
  maxDD: number; // fraction
  fees: number;
  equity: number[];
}

interface Pos { sym: string; qty: number; entry: number; stop: number; trail: number; openedAt: number; cost: number }

export function simulate(data: Record<string, Ind>, strat: Strat, cfg: SimCfg, from: number, to: number): SimResult {
  const syms = Object.keys(data);
  let cash = cfg.startEq;
  let fees = 0;
  const open: Pos[] = [];
  const trades: SimTrade[] = [];
  const equity: number[] = [];
  let pendingEntries: string[] = [];
  let pendingExits = new Set<string>();

  const sell = (p: Pos, px: number, i: number, reason: string) => {
    const fill = px * (1 - cfg.slip);
    const gross = fill * p.qty;
    const fee = gross * cfg.feeRate;
    cash += gross - fee;
    fees += fee;
    const pnl = gross - fee - p.cost;
    trades.push({ sym: p.sym, pnl, pnlPct: pnl / p.cost, bars: i - p.openedAt, reason });
    open.splice(open.indexOf(p), 1);
  };

  for (let i = from; i < to; i++) {
    // 1) fills decided at the previous close, executed at this bar's open
    for (const p of [...open]) if (pendingExits.has(p.sym)) sell(p, data[p.sym].c[i].o, i, "signal");
    pendingExits = new Set();
    const eqOpen = cash + open.reduce((a, p) => a + p.qty * data[p.sym].c[i].o, 0);
    for (const sym of pendingEntries) {
      if (open.length >= cfg.maxPos || open.some((p) => p.sym === sym)) continue;
      const d = data[sym];
      const px = d.c[i].o * (1 + cfg.slip);
      const notional = Math.min(cash / (1 + cfg.feeRate), eqOpen * cfg.posFrac);
      if (notional < 10) continue;
      const fee = notional * cfg.feeRate;
      const qty = notional / px;
      cash -= notional + fee;
      fees += fee;
      const a = d.atr[i - 1];
      open.push({ sym, qty, entry: px, stop: px - strat.stopAtr * a, trail: 0, openedAt: i, cost: notional + fee });
    }
    pendingEntries = [];

    // 2) intrabar stops (bar low; gap-through fills at the open)
    for (const p of [...open]) {
      const b = data[p.sym].c[i];
      const level = Math.max(p.stop, p.trail);
      if (b.o <= level) sell(p, b.o, i, "stop");
      else if (b.l <= level) sell(p, level, i, "stop");
    }

    // 3) on the close: update trailing stops, queue exits and entries for the next open
    for (const p of open) {
      const d = data[p.sym];
      if (strat.trailAtr > 0) p.trail = Math.max(p.trail, d.close[i] - strat.trailAtr * d.atr[i]);
      if (i - p.openedAt >= strat.maxHold) pendingExits.add(p.sym);
      else if (strat.exit?.(i, d)) pendingExits.add(p.sym);
    }
    if (open.length < cfg.maxPos) {
      const cands = syms.filter((s) => !open.some((p) => p.sym === s) && strat.enter(i, data[s]));
      // strongest relative momentum first (24h return), so limited slots go to the leaders
      cands.sort((a, b) => data[b].close[i] / data[b].close[i - 24] - data[a].close[i] / data[a].close[i - 24]);
      pendingEntries = cands.slice(0, cfg.maxPos - open.length);
    }
    equity.push(cash + open.reduce((a, p) => a + p.qty * data[p.sym].c[i].c, 0));
  }
  for (const p of [...open]) sell(p, data[p.sym].c[to - 1].c, to - 1, "end");

  const final = cash;
  let peak = cfg.startEq;
  let maxDD = 0;
  for (const e of equity) {
    peak = Math.max(peak, e);
    maxDD = Math.max(maxDD, (peak - e) / peak);
  }
  const wins = trades.filter((t) => t.pnl > 0).length;
  return {
    ret: final / cfg.startEq - 1,
    grossRet: (final + fees) / cfg.startEq - 1,
    trades,
    winRate: trades.length ? wins / trades.length : 0,
    maxDD,
    fees,
    equity,
  };
}

/** weekly-style rotation: hold the strongest coins that are in an uptrend; trade only when the target set changes */
export function simulateRotation(
  data: Record<string, Ind>,
  p: { lookback: number; topK: number; every: number; trend: number },
  cfg: SimCfg,
  from: number,
  to: number
): SimResult {
  const syms = Object.keys(data);
  let cash = cfg.startEq;
  let fees = 0;
  const held = new Map<string, { qty: number; cost: number; openedAt: number }>();
  const trades: SimTrade[] = [];
  const equity: number[] = [];
  let target: string[] | null = null;

  for (let i = from; i < to; i++) {
    if (target) {
      // execute at this open
      for (const [s, h] of [...held]) {
        if (!target.includes(s)) {
          const fill = data[s].c[i].o * (1 - cfg.slip);
          const gross = fill * h.qty;
          const fee = gross * cfg.feeRate;
          cash += gross - fee;
          fees += fee;
          const pnl = gross - fee - h.cost;
          trades.push({ sym: s, pnl, pnlPct: pnl / h.cost, bars: i - h.openedAt, reason: "rotate" });
          held.delete(s);
        }
      }
      const eq = cash + [...held].reduce((a, [s, h]) => a + h.qty * data[s].c[i].o, 0);
      const slots = Math.max(1, target.length);
      for (const s of target) {
        if (held.has(s)) continue;
        const notional = Math.min(cash / (1 + cfg.feeRate), eq / slots);
        if (notional < 10) continue;
        const px = data[s].c[i].o * (1 + cfg.slip);
        const fee = notional * cfg.feeRate;
        cash -= notional + fee;
        fees += fee;
        held.set(s, { qty: notional / px, cost: notional + fee, openedAt: i });
      }
      target = null;
    }
    if ((i - from) % p.every === 0) {
      const ranked = syms
        .map((s) => ({ s, r: data[s].close[i] / data[s].close[i - p.lookback] - 1, up: p.trend ? data[s].close[i] > data[s].ema400[i] : true }))
        .filter((x) => x.up && x.r > 0)
        .sort((a, b) => b.r - a.r)
        .slice(0, p.topK)
        .map((x) => x.s);
      target = ranked;
    }
    equity.push(cash + [...held].reduce((a, [s, h]) => a + h.qty * data[s].c[i].c, 0));
  }
  for (const [s, h] of [...held]) {
    const gross = data[s].c[to - 1].c * (1 - cfg.slip) * h.qty;
    const fee = gross * cfg.feeRate;
    cash += gross - fee;
    fees += fee;
    const pnl = gross - fee - h.cost;
    trades.push({ sym: s, pnl, pnlPct: pnl / h.cost, bars: to - 1 - h.openedAt, reason: "end" });
  }
  let peak = cfg.startEq;
  let maxDD = 0;
  for (const e of equity) {
    peak = Math.max(peak, e);
    maxDD = Math.max(maxDD, (peak - e) / peak);
  }
  const wins = trades.filter((t) => t.pnl > 0).length;
  return { ret: cash / cfg.startEq - 1, grossRet: (cash + fees) / cfg.startEq - 1, trades, winRate: trades.length ? wins / trades.length : 0, maxDD, fees, equity };
}

/** equal-weight buy-and-hold of every coin over the same window, after fees + slippage */
export function buyAndHold(data: Record<string, Ind>, cfg: SimCfg, from: number, to: number): number {
  const r = Object.values(data).map((d) => {
    const p0 = d.c[from].o * (1 + cfg.slip) * (1 + cfg.feeRate);
    const p1 = d.c[to - 1].c * (1 - cfg.slip) * (1 - cfg.feeRate);
    return p1 / p0 - 1;
  });
  return r.reduce((a, b) => a + b, 0) / r.length;
}

// ───────────────────────── candidate strategies ─────────────────────────

/** long-only, uptrend-gated breakout: new N-hour high while the fast EMA is above the slow EMA */
export const breakout = (p: { look: number; stopAtr: number; trailAtr: number; hold: number }): Strat => ({
  name: "trend-breakout",
  params: p,
  enter: (i, d) => {
    const hh = p.look <= 24 ? d.hh24 : p.look <= 48 ? d.hh48 : p.look <= 72 ? d.hh72 : d.hh168;
    return i > 400 && d.ema100[i] > d.ema400[i] && d.close[i] > d.ema200[i] && d.close[i] > hh[i];
  },
  exit: (i, d) => d.close[i] < d.ema100[i],
  stopAtr: p.stopAtr,
  trailAtr: p.trailAtr,
  maxHold: p.hold,
});

/** long-only pullback in an uptrend: oversold dip that has started to turn up */
export const pullback = (p: { rsiBelow: number; stopAtr: number; trailAtr: number; hold: number }): Strat => ({
  name: "uptrend-pullback",
  params: p,
  enter: (i, d) => i > 400 && d.ema100[i] > d.ema400[i] && d.close[i] > d.ema400[i] && d.rsi[i - 1] < p.rsiBelow && d.close[i] > d.close[i - 1],
  exit: (i, d) => d.close[i] < d.ema400[i],
  stopAtr: p.stopAtr,
  trailAtr: p.trailAtr,
  maxHold: p.hold,
});

// ───────────────────────── walk-forward ─────────────────────────

export interface WindowResult {
  from: number;
  to: number;
  picked: Record<string, number>;
  ret: number;
  grossRet: number;
  bh: number;
  trades: number;
  winRate: number;
  maxDD: number;
  fees: number;
}
export interface WalkForward {
  name: string;
  windows: WindowResult[];
  compounded: number;
  bhCompounded: number;
  positiveWindows: number;
  worstWindow: number;
  worstDD: number;
  totalTrades: number;
  passed: boolean;
  reasons: string[];
}

/** pass criteria: the strategy must make money after fees across separate unseen windows, with bounded drawdown */
export function judge(name: string, windows: WindowResult[]): WalkForward {
  const compounded = windows.reduce((a, w) => a * (1 + w.ret), 1) - 1;
  const bhCompounded = windows.reduce((a, w) => a * (1 + w.bh), 1) - 1;
  const positive = windows.filter((w) => w.ret > 0).length;
  const worst = Math.min(...windows.map((w) => w.ret));
  const worstDD = Math.max(...windows.map((w) => w.maxDD));
  const totalTrades = windows.reduce((a, w) => a + w.trades, 0);
  const reasons: string[] = [];
  if (compounded <= 0) reasons.push(`net return after fees is ${(compounded * 100).toFixed(1)}% (needs > 0)`);
  if (positive < Math.ceil(windows.length * 0.6)) reasons.push(`only ${positive}/${windows.length} unseen windows were profitable (needs ≥ 60%)`);
  if (worst < -0.08) reasons.push(`worst window lost ${(worst * 100).toFixed(1)}% (limit −8%)`);
  if (worstDD > 0.15) reasons.push(`max drawdown ${(worstDD * 100).toFixed(1)}% (limit 15%)`);
  if (totalTrades < 20) reasons.push(`only ${totalTrades} trades — too few to trust`);
  return { name, windows, compounded, bhCompounded, positiveWindows: positive, worstWindow: worst, worstDD, totalTrades, passed: reasons.length === 0, reasons };
}

/** rolling walk-forward: pick params on `trainBars`, test on the next `testBars`, slide forward by testBars */
export function walkForward<P extends Record<string, number>>(
  name: string,
  data: Record<string, Ind>,
  grid: P[],
  build: (p: P) => Strat,
  cfg: SimCfg,
  opts: { warmup: number; trainBars: number; testBars: number; total: number }
): WalkForward {
  const out: WindowResult[] = [];
  for (let t0 = opts.warmup + opts.trainBars; t0 + opts.testBars <= opts.total; t0 += opts.testBars) {
    let best: { p: P; ret: number } | null = null;
    for (const p of grid) {
      const r = simulate(data, build(p), cfg, t0 - opts.trainBars, t0);
      if (r.trades.length >= 5 && (!best || r.ret > best.ret)) best = { p, ret: r.ret };
    }
    const p = best?.p ?? grid[0];
    const r = simulate(data, build(p), cfg, t0, t0 + opts.testBars);
    out.push({ from: t0, to: t0 + opts.testBars, picked: p, ret: r.ret, grossRet: r.grossRet, bh: buyAndHold(data, cfg, t0, t0 + opts.testBars), trades: r.trades.length, winRate: r.winRate, maxDD: r.maxDD, fees: r.fees });
  }
  return judge(name, out);
}

export function walkForwardRotation(
  data: Record<string, Ind>,
  grid: { lookback: number; topK: number; every: number; trend: number }[],
  cfg: SimCfg,
  opts: { warmup: number; trainBars: number; testBars: number; total: number }
): WalkForward {
  const out: WindowResult[] = [];
  for (let t0 = opts.warmup + opts.trainBars; t0 + opts.testBars <= opts.total; t0 += opts.testBars) {
    let best: { p: (typeof grid)[number]; ret: number } | null = null;
    for (const p of grid) {
      const r = simulateRotation(data, p, cfg, t0 - opts.trainBars, t0);
      if (!best || r.ret > best.ret) best = { p, ret: r.ret };
    }
    const p = best?.p ?? grid[0];
    const r = simulateRotation(data, p, cfg, t0, t0 + opts.testBars);
    out.push({ from: t0, to: t0 + opts.testBars, picked: p, ret: r.ret, grossRet: r.grossRet, bh: buyAndHold(data, cfg, t0, t0 + opts.testBars), trades: r.trades.length, winRate: r.winRate, maxDD: r.maxDD, fees: r.fees });
  }
  return judge("momentum-rotation", out);
}
