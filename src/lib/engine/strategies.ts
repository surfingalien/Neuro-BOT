// ─── Strategy signals: momentum scalper · mean reversion · breakout trend ───
import type { Klines, StrategyDecision, StrategyId } from "./types";
import { bollinger, ema, emaSlope, macd, rsi } from "./indicators";

export interface SignalCheck {
  ok: boolean;
  detail: string;
}

/** Entry confirmation per strategy — all run on 1m closes */
export function checkEntrySignal(
  strategy: StrategyId,
  k: Klines
): SignalCheck {
  const closes = k.m1.map((c) => c.c);
  if (closes.length < 30) return { ok: false, detail: "thin history" };
  const last = closes[closes.length - 1];

  if (strategy === "momentum") {
    const e9 = ema(closes, 9);
    const e21 = ema(closes, 21);
    const r = rsi(closes);
    const crossUp = e9[e9.length - 1] > e21[e21.length - 1];
    const freshCross =
      e9[e9.length - 2] <= e21[e21.length - 2] || crossUp; // allow riding trend
    const volSpike =
      k.m1[k.m1.length - 1].v > k.m1.slice(-20, -1).reduce((a, c) => a + c.v, 0) / 19 * 1.1;
    const ok = crossUp && freshCross && r > 50 && r < 74;
    return {
      ok,
      detail: `EMA9/21 ${crossUp ? "bull" : "bear"} · RSI ${r.toFixed(0)} · vol ${volSpike ? "spike" : "flat"}`,
    };
  }

  if (strategy === "meanrev") {
    const r = rsi(closes, 14);
    const bb = bollinger(closes);
    const nearLower = last <= bb.mid * 0.995;
    const ok = r < 42 && nearLower && last > bb.lower * 0.995;
    return {
      ok,
      detail: `RSI ${r.toFixed(0)} < 42 · price ${nearLower ? "below" : "above"} mid · BB lower ${bb.lower.toFixed(4)}`,
    };
  }

  // breakout
  const bb = bollinger(closes, 20, 2);
  const m = macd(closes);
  const slopeUp = emaSlope(closes, 21, 10) > -0.05;
  const breakout = last >= bb.upper * 0.999;
  const macdOk = m.hist > 0;
  const ok = (breakout || (macdOk && slopeUp)) && slopeUp;
  return {
    ok,
    detail: `BB upper ${bb.upper.toFixed(4)} · MACD hist ${m.hist >= 0 ? "+" : ""}${m.hist.toFixed(4)} · slope ${slopeUp ? "up" : "flat"}`,
  };
}

/** STRATEGIST: pick strategy given regime + brain weights (softmax, regime-fit bonus, ε-greedy exploration) */
export function pickStrategy(
  regime: "trending_up" | "trending_down" | "ranging",
  weights: Record<StrategyId, number>,
  explore = true // false in LIVE mode: no random strategy samples with real money
): StrategyDecision {
  const all: StrategyId[] = ["momentum", "meanrev", "breakout"];
  // ε-greedy exploration: 8% of entries sample any strategy so the brain
  // keeps collecting outcome data — no strategy goes unlearned
  if (explore && Math.random() < 0.08) {
    const explore = all[Math.floor(Math.random() * all.length)];
    return {
      strategy: explore,
      reason: `exploring ${explore} — brain collecting outcome data (ε=8%)`,
      fitBonus: 1,
    };
  }
  const fit: Record<StrategyId, number> =
    regime === "ranging"
      ? { momentum: 0.9, meanrev: 1.45, breakout: 0.75 }
      : regime === "trending_up"
        ? { momentum: 1.4, meanrev: 0.7, breakout: 1.35 }
        : { momentum: 0.8, meanrev: 1.2, breakout: 1.3 };
  const adjusted = (["momentum", "meanrev", "breakout"] as StrategyId[]).map((s) => ({
    s,
    v: Math.max(0.02, weights[s]) * fit[s],
  }));
  const total = adjusted.reduce((a, b) => a + b.v, 0);
  // weighted sample: P(strategy) = weight × regime-fit / total. The old "softmax" never normalised its
  // probabilities, so it fell through to momentum ~98% of the time and the learned weights barely mattered.
  let roll = Math.random() * total;
  let chosen = adjusted[adjusted.length - 1].s;
  for (const a of adjusted) {
    if (roll < a.v) {
      chosen = a.s;
      break;
    }
    roll -= a.v;
  }
  const regimeName =
    regime === "ranging" ? "ranging regime" : regime === "trending_up" ? "up-trend regime" : "down-trend regime";
  const reasons: Record<StrategyId, string> = {
    momentum: `EMA cross + volume burst fits ${regimeName}`,
    meanrev: `RSI extremes pay in ${regimeName}`,
    breakout: `BB squeeze + MACD confirm fits ${regimeName}`,
  };
  return {
    strategy: chosen,
    reason: reasons[chosen],
    fitBonus: fit[chosen],
  };
}
