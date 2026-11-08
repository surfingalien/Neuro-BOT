// ─── AI BRAIN: self-improving core ───
// Three learning layers, fully automated (no operator tuning):
//   1. STRATEGY weights  — reward-EMA after every close (softmax τ=0.22)
//   2. RESEARCH ENGINE   — 6 analyst signal weights learned from which
//                          signals actually predicted winning trades
//   3. STRATEGY PARAMS   — per-strategy hold / stop / TP multipliers
//                          adapted from exit-reason patterns
// Plus a scheduled deep auto-tune cycle every AUTOTUNE_EVERY closes.
import type { Regime, StrategyBrain, StrategyId, VolState } from "./types";

const STRATEGIES: StrategyId[] = ["momentum", "meanrev", "breakout"];

export const SIGNAL_LABELS = [
  "momentum",
  "unique buyers",
  "buy / sell ratio",
  "holder growth",
  "liquidity / mcap",
  "smart wallets",
] as const;

export const SIGNAL_BASE_WEIGHTS = [0.2, 0.15, 0.2, 0.15, 0.15, 0.15];
export const AUTOTUNE_EVERY = 5; // deep auto-tune cycle every N closed trades

const SIGNAL_MIN = 0.06;
const SIGNAL_MAX = 0.34;

export interface StratParams {
  holdMult: number;
  stopMult: number;
  tpMult: number;
}

export interface BrainCore {
  weights: Record<StrategyId, number>;
  strategies: Record<StrategyId, StrategyBrain>;
  lessons: string[];
  regime: Regime;
  volatility: VolState;
  scoreThreshold: number; // auto-tuned 66..82
  sizeMultiplier: number; // auto-tuned 0.5..1.25
  autotuneCount: number;
  closedSinceAutotune: number;
  signalWeights: number[]; // research engine — learned, sums to 1
  recent: { strategy: StrategyId; regime: Regime; reward: number }[]; // last 12
}

export function freshBrain(): BrainCore {
  return {
    weights: { momentum: 0.34, meanrev: 0.33, breakout: 0.33 },
    strategies: {
      momentum: blankStrategy(),
      meanrev: blankStrategy(),
      breakout: blankStrategy(),
    },
    lessons: [
      "brain online · no closed trades yet — weights start neutral 1/3 each",
      "strategy pick = brain weight × regime fit · softmax τ=0.22",
      "research engine learns which signals predict wins — 6 weights adapt",
    ],
    regime: "ranging",
    volatility: "normal",
    scoreThreshold: 70,
    sizeMultiplier: 1,
    autotuneCount: 0,
    closedSinceAutotune: 0,
    signalWeights: [...SIGNAL_BASE_WEIGHTS],
    recent: [],
  };
}

function blankStrategy(): StrategyBrain {
  return {
    weight: 0.33,
    trades: 0,
    wins: 0,
    losses: 0,
    pnl: 0,
    last10: [],
    lastReasons: [],
    holdMult: 1,
    stopMult: 1,
    tpMult: 1,
  };
}

export function stratParams(brain: BrainCore, s: StrategyId): StratParams {
  const d = brain.strategies[s];
  return { holdMult: d.holdMult, stopMult: d.stopMult, tpMult: d.tpMult };
}

/** keep each signal weight inside bounds and the sum at 1 */
function normalizeSignalWeights(w: number[]): void {
  const clamped = w.map((v) => Math.min(SIGNAL_MAX, Math.max(SIGNAL_MIN, v)));
  const sum = clamped.reduce((a, b) => a + b, 0);
  for (let i = 0; i < clamped.length; i++) clamped[i] = clamped[i] / sum;
  // re-clamp after normalize (guard drift)
  for (let i = 0; i < clamped.length; i++) w[i] = Math.min(SIGNAL_MAX, Math.max(SIGNAL_MIN, clamped[i]));
  const s2 = w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < w.length; i++) w[i] = w[i] / s2;
}

/**
 * Called after every closed trade.
 * reward ∈ [-1, 1] (normalized pnl vs planned risk)
 * entryScores = the 6 analyst sub-scores (0..100) captured at entry —
 * they drive research-engine learning: signals that were high on winners
 * get boosted, signals that were high on losers decay.
 */
export function learnFromTrade(
  brain: BrainCore,
  strategy: StrategyId,
  regime: Regime,
  reward: number,
  pnlUsd: number,
  won: boolean,
  reason: string,
  entryScores: number[]
): string[] {
  const s = brain.strategies[strategy];
  s.trades += 1;
  s.pnl += pnlUsd;
  if (won) s.wins += 1;
  else s.losses += 1;
  s.last10.push(reward);
  if (s.last10.length > 10) s.last10.shift();
  s.lastReasons.push(reason);
  if (s.lastReasons.length > 8) s.lastReasons.shift();

  brain.recent.push({ strategy, regime, reward });
  if (brain.recent.length > 12) brain.recent.shift();

  // ── layer 1: strategy weight — EMA toward outcome ──
  const target = Math.max(0.02, Math.min(1, 0.5 + 0.5 * reward));
  s.weight = 0.82 * s.weight + 0.18 * target;
  const sum = STRATEGIES.reduce((a, k) => a + Math.max(0.05, brain.strategies[k].weight), 0);
  for (const k of STRATEGIES) {
    brain.strategies[k].weight = Math.max(0.05, brain.strategies[k].weight) / sum;
  }
  brain.weights = {
    momentum: brain.strategies.momentum.weight,
    meanrev: brain.strategies.meanrev.weight,
    breakout: brain.strategies.breakout.weight,
  };

  const events: string[] = [];
  events.push(
    `BRAIN ${strategy} ${won ? "win" : "loss"} → reward ${reward >= 0 ? "+" : ""}${reward.toFixed(2)} · weight ${(s.weight * 100).toFixed(0)}%`
  );

  // ── layer 2: research engine — signal weights from outcome correlation ──
  if (entryScores.length === 6) {
    const α = 0.14;
    let moved = false;
    for (let i = 0; i < 6; i++) {
      const n = Math.max(0, Math.min(1, entryScores[i] / 100)); // normalized 0..1
      const delta = α * reward * (n - 0.5); // high score + win → up · high + loss → down
      if (Math.abs(delta) > 0.0005) moved = true;
      brain.signalWeights[i] += delta;
    }
    if (moved) {
      normalizeSignalWeights(brain.signalWeights);
      const topIdx = brain.signalWeights.indexOf(Math.max(...brain.signalWeights));
      const chg = brain.signalWeights[topIdx] - SIGNAL_BASE_WEIGHTS[topIdx];
      if (Math.abs(chg) >= 0.02) {
        events.push(
          `RESEARCH '${SIGNAL_LABELS[topIdx]}' now ${(brain.signalWeights[topIdx] * 100).toFixed(0)}% weight (factory ${(SIGNAL_BASE_WEIGHTS[topIdx] * 100).toFixed(0)}%) — predicting ${chg > 0 ? "wins" : "noise"}`
        );
      }
    }
  }

  // ── layer 3: strategy params — adapt from exit-reason patterns ──
  events.push(...tuneStrategyParams(brain, strategy));

  // ── scheduled deep auto-tune (fully automatic) ──
  brain.closedSinceAutotune += 1;
  if (brain.closedSinceAutotune >= AUTOTUNE_EVERY) {
    events.push(...deepAutoTune(brain));
  }

  brain.lessons = generateLessons(brain);
  return events;
}

/** per-strategy exit-reason adaptation: stop-outs widen stop, timeouts shorten hold, big winners stretch TP */
function tuneStrategyParams(brain: BrainCore, strategy: StrategyId): string[] {
  const s = brain.strategies[strategy];
  if (s.lastReasons.length < 4) return [];
  const win = s.lastReasons.slice(-5);
  const count = (r: string) => win.filter((x) => x === r).length;
  const out: string[] = [];

  // stop-outs dominate → give trades more room (max ×1.35)
  if (count("stop") >= 3 && s.stopMult < 1.35) {
    const before = s.stopMult;
    s.stopMult = Math.min(1.35, s.stopMult + 0.06);
    out.push(`PARAMS ${strategy}: ${count("stop")}/5 stop-outs → stop ×${before.toFixed(2)}→${s.stopMult.toFixed(2)} (room to breathe)`);
  }
  // timeouts dominate and bleed → recycle capital faster (min ×0.55)
  if (count("timeout") >= 3 && s.last10.slice(-5).every((r) => r <= 0.1)) {
    const before = s.holdMult;
    s.holdMult = Math.max(0.55, s.holdMult - 0.1);
    out.push(`PARAMS ${strategy}: timeouts not paying → hold ×${before.toFixed(2)}→${s.holdMult.toFixed(2)} (faster recycling)`);
  }
  // strong trail/tp2 wins → let winners run further (max ×1.5)
  if (count("trail") + count("tp2") >= 2 && s.tpMult < 1.5 && win.some((_, i) => s.last10.slice(-5)[i] > 0.6)) {
    const before = s.tpMult;
    s.tpMult = Math.min(1.5, s.tpMult + 0.05);
    out.push(`PARAMS ${strategy}: runners paying → TP ×${before.toFixed(2)}→${s.tpMult.toFixed(2)} (stretch targets)`);
  }
  return out;
}

/** scheduled full-tune: gate, size, signal normalization, lesson refresh */
function deepAutoTune(brain: BrainCore): string[] {
  brain.closedSinceAutotune = 0;
  brain.autotuneCount += 1;
  const out: string[] = [`AUTOTUNE cycle #${brain.autotuneCount} — full sweep`];

  const last8 = brain.recent.slice(-8);
  if (last8.length >= 5) {
    const wr = last8.filter((r) => r.reward > 0).length / last8.length;
    if (wr < 0.34 && brain.scoreThreshold < 82) {
      brain.scoreThreshold += 2;
      brain.sizeMultiplier = Math.max(0.5, brain.sizeMultiplier * 0.85);
      out.push(`AUTOTUNE win-rate ${(wr * 100).toFixed(0)}% < 34% → score gate →${brain.scoreThreshold} · size ×${brain.sizeMultiplier.toFixed(2)}`);
    } else if (wr > 0.62 && brain.scoreThreshold > 66) {
      brain.scoreThreshold -= 1;
      brain.sizeMultiplier = Math.min(1.25, brain.sizeMultiplier * 1.06);
      out.push(`AUTOTUNE win-rate ${(wr * 100).toFixed(0)}% > 62% → score gate →${brain.scoreThreshold} · size ×${brain.sizeMultiplier.toFixed(2)}`);
    } else {
      out.push(`AUTOTUNE win-rate ${(wr * 100).toFixed(0)}% in band — gate ${brain.scoreThreshold} held · size ×${brain.sizeMultiplier.toFixed(2)}`);
    }
  }
  // research engine sanity: renormalize + report dominant signal
  normalizeSignalWeights(brain.signalWeights);
  const topIdx = brain.signalWeights.indexOf(Math.max(...brain.signalWeights));
  const weakIdx = brain.signalWeights.indexOf(Math.min(...brain.signalWeights));
  out.push(
    `AUTOTUNE research: top signal '${SIGNAL_LABELS[topIdx]}' ${(brain.signalWeights[topIdx] * 100).toFixed(0)}% · weakest '${SIGNAL_LABELS[weakIdx]}' ${(brain.signalWeights[weakIdx] * 100).toFixed(0)}%`
  );
  return out;
}

export function generateLessons(brain: BrainCore): string[] {
  const out: string[] = [];
  const ranked = STRATEGIES.map((s) => ({ s, d: brain.strategies[s] })).sort(
    (a, b) => b.d.weight - a.d.weight
  );
  if (ranked[0].d.trades > 0) {
    out.push(
      `leader: ${ranked[0].s} — weight ${(ranked[0].d.weight * 100).toFixed(0)}% · ${ranked[0].d.wins}W/${ranked[0].d.losses}L · ${fmtPnl(ranked[0].d.pnl)}`
    );
  }
  const worst = ranked[ranked.length - 1];
  if (worst.d.trades >= 3 && worst.d.pnl < 0) {
    out.push(`demoted: ${worst.s} bleeding ${fmtPnl(worst.d.pnl)} — weight cut to ${(worst.d.weight * 100).toFixed(0)}%`);
  }
  // research engine headline — biggest learned signal drift
  const drift = brain.signalWeights
    .map((w, i) => ({ i, d: w - SIGNAL_BASE_WEIGHTS[i] }))
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0];
  if (Math.abs(drift.d) >= 0.02) {
    out.push(
      `research: '${SIGNAL_LABELS[drift.i]}' ${drift.d > 0 ? "up" : "down"} to ${(brain.signalWeights[drift.i] * 100).toFixed(0)}% — it ${drift.d > 0 ? "predicts winners" : "was noise"}`
    );
  }
  // param adaptation headline
  const tuned = STRATEGIES.map((s) => brain.strategies[s]).find(
    (d) => d.holdMult !== 1 || d.stopMult !== 1 || d.tpMult !== 1
  );
  if (tuned) {
    const name = STRATEGIES.find((s) => brain.strategies[s] === tuned)!;
    out.push(
      `params ${name}: stop ×${tuned.stopMult.toFixed(2)} · hold ×${tuned.holdMult.toFixed(2)} · TP ×${tuned.tpMult.toFixed(2)} — tuned by exits`
    );
  }
  // per-regime reading
  for (const reg of ["trending_up", "ranging"] as Regime[]) {
    const rs = brain.recent.filter((r) => r.regime === reg);
    if (rs.length >= 3) {
      const avg = rs.reduce((a, b) => a + b.reward, 0) / rs.length;
      const best = STRATEGIES.map((s) => ({ s, v: avgReward(brain, s, reg) })).sort((a, b) => b.v - a.v)[0];
      out.push(
        `${reg === "ranging" ? "ranging regime" : "up-trend regime"}: ${best.s} pays best (avg ${best.v >= 0 ? "+" : ""}${best.v.toFixed(2)}) · sample ${rs.length}`
      );
      if (avg < -0.2) out.push(`${reg}: everything struggling — size cut by brain`);
    }
  }
  if (brain.autotuneCount > 0) {
    out.push(`auto-tune ran ${brain.autotuneCount}× · gate now ${brain.scoreThreshold} · size ×${brain.sizeMultiplier.toFixed(2)}`);
  }
  return out.slice(0, 6);
}

function avgReward(brain: BrainCore, s: StrategyId, reg: Regime): number {
  const rs = brain.recent.filter((r) => r.strategy === s && r.regime === reg);
  if (rs.length === 0) return 0;
  return rs.reduce((a, b) => a + b.reward, 0) / rs.length;
}

function fmtPnl(n: number): string {
  return `${n >= 0 ? "+" : "–"}$${Math.abs(n).toFixed(2)}`;
}
