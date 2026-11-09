// ─── FILTER: 8 hard rules · ANALYST: 0-100 scoring ───
import type { AnalystResult, FilterResult, FilterRuleResult, Klines, ScoutPair } from "./types";
import { atr, bollinger, clamp, ema, emaSlope, fmtUsd, rsi, volumeConsistency } from "./indicators";

// ───────────────────────── FILTER — 8 hard rules ─────────────────────────

export function runFilter(pair: ScoutPair): FilterResult {
  const rules: FilterRuleResult[] =
    pair.market === "majors" ? majorRules(pair) : memeRules(pair);
  const failedRuleIndex = rules.findIndex((r) => !r.pass && !r.na);
  return {
    symbol: pair.symbol,
    base: pair.base,
    passed: failedRuleIndex === -1,
    rules,
    failedRuleIndex,
  };
}

function memeRules(p: ScoutPair): FilterRuleResult[] {
  const liqMcap = p.mcap > 0 ? (p.liquidity / p.mcap) * 100 : 0;
  const buySell = p.sells1h > 0 ? p.buys1h / p.sells1h : p.buys1h > 0 ? 2 : 0;
  const pump1h = p.change24h; // proxy via 24h momentum
  const avgTxn = p.txns1h > 0 ? p.volume1h / p.txns1h : Infinity; // bundlers print few huge buys
  return [
    {
      label: "pair age 20m – 14d (fresh-biased)",
      pass: p.ageHours >= 0.33 && p.ageHours <= 336,
      value: p.ageHours < 1 ? `${Math.round(p.ageHours * 60)}m old` : `${p.ageHours.toFixed(1)}h old`,
    },
    {
      label: "liquidity ≥ $45k",
      pass: p.liquidity >= 45_000,
      value: fmtUsd(p.liquidity),
    },
    {
      label: "1h volume ≥ $60k",
      pass: p.volume1h >= 60_000,
      value: fmtUsd(p.volume1h),
    },
    {
      label: "liq / mcap ≥ 4%",
      pass: liqMcap >= 4,
      value: `${liqMcap.toFixed(1)}%`,
    },
    {
      label: "buy / sell ≥ 0.8",
      pass: buySell >= 0.8,
      value: buySell.toFixed(2),
    },
    {
      label: "avg txn ≤ $5k (no bundlers)",
      pass: avgTxn <= 5_000,
      value: isFinite(avgTxn) ? `$${Math.round(avgTxn).toLocaleString()} avg` : "no txns",
    },
    {
      label: "no 24h blow-off > 150%",
      pass: Math.abs(pump1h) <= 150,
      value: `${pump1h > 0 ? "+" : ""}${pump1h.toFixed(0)}%`,
    },
    {
      label: "1h txns ≥ 120",
      pass: p.txns1h >= 120,
      value: `${p.txns1h} txns`,
    },
  ];
}

function majorRules(p: ScoutPair): FilterRuleResult[] {
  // Coinbase USD books are ~50x thinner than Binance USDT, so the bar scales by source
  const cb = p.source === "coinbase";
  const minVol = cb ? 1_000_000 : 50_000_000;
  const minLiq = cb ? 400_000 : 20_000_000;
  const minTx = cb ? 100 : 5_000;
  const volOk = p.volume24h >= minVol;
  const pump = p.change24h;
  return [
    { label: cb ? "spot pair on Coinbase" : "spot pair on Binance", pass: true, value: "verified", na: true },
    { label: `24h volume ≥ ${fmtUsd(minVol)}`, pass: volOk, value: fmtUsd(p.volume24h) },
    { label: `deep book (liq ≥ ${fmtUsd(minLiq)})`, pass: p.liquidity >= minLiq, value: fmtUsd(p.liquidity) },
    { label: "no delisting flag", pass: true, value: "clean", na: true },
    { label: "taker flow not bleeding", pass: true, value: `${p.buys1h > p.sells1h ? "+" : ""}${((p.buys1h / Math.max(1, p.sells1h)) - 1).toFixed(2)}` },
    { label: "24h range sane ≤ 15%", pass: Math.abs(pump) <= 15, value: `${pump > 0 ? "+" : ""}${pump.toFixed(1)}%` },
    { label: `quote asset ${cb ? "USD" : "USDT"}`, pass: true, value: cb ? "USD" : "USDT", na: true },
    { label: `1h txns ≥ ${cb ? minTx : "5k"}`, pass: p.txns1h >= minTx, value: `${p.txns1h.toLocaleString()} txns` },
  ];
}

// ───────────────────────── ANALYST — 6 sub-scores → 0-100 ─────────────────────────

const BASE_WEIGHTS = [0.2, 0.15, 0.2, 0.15, 0.15, 0.15];

export function runAnalyst(
  pair: ScoutPair,
  k: Klines,
  threshold: number,
  signalWeights?: number[]
): AnalystResult {
  const closes = k.m1.map((c) => c.c);
  const vols = k.m1.map((c) => c.v);
  const last = closes[closes.length - 1] ?? pair.price;

  // 1. momentum — EMA alignment + RSI sweet zone
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const slope = emaSlope(closes, 9, 10);
  const r = rsi(closes);
  let momentum = 40;
  if (e9[e9.length - 1] > e21[e21.length - 1]) momentum += 25;
  if (r >= 52 && r <= 72) momentum += 20;
  else if (r > 72) momentum += 5;
  momentum += clamp(slope * 12, -10, 15);

  const majors = pair.market === "majors" && !analystCfg.legacyMajorSignals;

  // 2. unique buyers proxy (memecoins) / relative volume (majors)
  // Majors used to score a CONSTANT here (txns were synthesized from volume with fixed ratios), so the
  // "research" layer was learning from numbers that never moved. Majors now use real candle data.
  let buyers: number;
  if (majors) {
    const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const v60 = avg(vols.slice(-60));
    const rv = v60 > 0 ? avg(vols.slice(-5)) / v60 : 1; // last 5 minutes vs the last hour
    buyers = clamp(20 + (rv - 0.5) * 32, 5, 100);
  } else {
    const txnIntensity = pair.liquidity > 0 ? (pair.txns1h * 2200) / pair.liquidity : 0;
    buyers = clamp(30 + txnIntensity * 90, 5, 100);
  }

  // 3. buy/sell ratio (memecoins) / buying pressure (majors: volume-weighted close location in each candle's range)
  let buySell: number;
  if (majors) {
    let num = 0;
    let den = 0;
    for (const c of k.m1.slice(-30)) {
      const range = c.h - c.l;
      num += (range > 0 ? (c.c - c.l - (c.h - c.c)) / range : 0) * c.v;
      den += c.v;
    }
    buySell = clamp(50 + (den > 0 ? num / den : 0) * 50, 5, 100);
  } else {
    const bs =
      pair.market === "majors"
        ? 1 + (pair.buys1h - pair.sells1h) / Math.max(1, pair.buys1h + pair.sells1h) // legacy: constant for majors
        : pair.sells1h > 0
          ? pair.buys1h / pair.sells1h
          : 1.6;
    buySell = clamp((bs / 1.8) * 100, 5, 100);
  }

  // 4. holder growth proxy — consistent uptrend in closes
  const lookback = closes.slice(-40);
  const upBars = lookback.filter((c, i) => i > 0 && c > lookback[i - 1]).length;
  const holderGrowth = clamp((upBars / Math.max(1, lookback.length - 1)) * 130 - 10, 5, 100);

  // 5. liquidity / mcap quality (memecoins) / higher-timeframe trend (majors; was a constant 85)
  let liqScore: number;
  if (majors) {
    const h = k.h1.map((c) => c.c);
    if (h.length >= 22) {
      const e = ema(h, 20);
      const last1h = h[h.length - 1];
      const dist = ((last1h - e[e.length - 1]) / e[e.length - 1]) * 100; // % above/below the 20h EMA
      const slope1h = e[e.length - 1] - e[e.length - 6];
      liqScore = clamp(50 + clamp(dist * 12, -35, 35) + (slope1h > 0 ? 10 : -10), 5, 100);
    } else liqScore = 50;
  } else {
    liqScore = pair.market === "majors" ? 85 : clamp(pair.mcap > 0 ? (pair.liquidity / pair.mcap) * 1600 : 10, 5, 100);
  }

  // 6. smart money proxy — volume consistency + BB squeeze (coiled spring)
  const vc = volumeConsistency(vols);
  const bb = bollinger(closes);
  const squeeze = bb.widthPct > 0 ? clamp(30 - bb.widthPct, 0, 30) : 0;
  const smart = clamp(vc * 70 + squeeze + 10, 5, 100);

  const raw = [momentum, buyers, buySell, holderGrowth, liqScore, smart];
  // research-engine learned weights (fall back to factory when brain cold)
  const W =
    signalWeights &&
    signalWeights.length === 6 &&
    Math.abs(signalWeights.reduce((a, b) => a + b, 0) - 1) < 0.05
      ? signalWeights
      : BASE_WEIGHTS;
  const final = Math.round(
    raw.reduce((acc, v, i) => acc + clamp(v, 0, 100) * W[i], 0)
  );

  return {
    symbol: pair.symbol,
    base: pair.base,
    scores: [
      { label: "momentum", value: Math.round(clamp(momentum, 0, 100)) },
      { label: majors ? "rel. volume" : "unique buyers", value: Math.round(buyers) },
      { label: majors ? "buy pressure" : "buy / sell ratio", value: Math.round(buySell) },
      { label: "holder growth", value: Math.round(holderGrowth) },
      { label: majors ? "1h trend" : "liquidity / mcap", value: Math.round(liqScore) },
      { label: "smart wallets", value: Math.round(smart) },
    ],
    final,
    passed: final >= threshold,
  };
}

// ───────────────────────── ATR-adaptive targets ─────────────────────────

export interface TargetMults {
  stopMult?: number;
  tpMult?: number;
}

/** research switch: true restores the old majors scoring (three constant signals) for A/B experiments. Default false. */
export const analystCfg = { legacyMajorSignals: false };

/** tunable for research (backtest experiments); the live defaults are unchanged */
export const targetCfg = { stopFloorPct: 1.0, tp1Mult: 1.1, tp2Mult: 2.2 };

export function computeTargets(
  entry: number,
  market: "majors" | "memecoin",
  k: Klines,
  mults?: TargetMults
): { stopLoss: number; tp1: number; tp2: number; trailAct: number } {
  const stopM = mults?.stopMult && isFinite(mults.stopMult) ? Math.max(0.85, Math.min(1.35, mults.stopMult)) : 1;
  const tpM = mults?.tpMult && isFinite(mults.tpMult) ? Math.max(0.8, Math.min(1.5, mults.tpMult)) : 1;
  const a = atr(k.m1, 14);
  const atrPct = (a / entry) * 100;
  if (market === "majors") {
    const slPct = clamp(Math.max(targetCfg.stopFloorPct, atrPct * 1.6 * stopM), targetCfg.stopFloorPct, Math.max(5, targetCfg.stopFloorPct));
    return {
      stopLoss: entry * (1 - slPct / 100),
      tp1: entry * (1 + (slPct * targetCfg.tp1Mult * tpM) / 100),
      tp2: entry * (1 + (slPct * targetCfg.tp2Mult * tpM) / 100),
      trailAct: entry * (1 + (slPct * targetCfg.tp2Mult * tpM) / 100),
    };
  }
  return {
    stopLoss: entry * (1 - 0.08 * stopM),
    tp1: entry * (1 + 0.08 * tpM),
    tp2: entry * (1 + 0.2 * tpM),
    trailAct: entry * (1 + 0.12 * tpM),
  };
}
