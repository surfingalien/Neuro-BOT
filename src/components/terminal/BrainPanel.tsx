"use client";

import { Line, LineChart, ResponsiveContainer } from "recharts";
import type { BotSnapshot, StrategyId } from "@/lib/engine/types";

const STRAT_META: Record<StrategyId, { label: string; hint: string }> = {
  momentum: { label: "MOMENTUM", hint: "EMA9/21 cross + volume burst" },
  meanrev: { label: "MEANREV", hint: "RSI dip + BB lower band" },
  breakout: { label: "BREAKOUT", hint: "BB squeeze + MACD confirm" },
};

const REGIME_LABEL: Record<string, string> = {
  trending_up: "↗ trend up",
  trending_down: "↘ trend down",
  ranging: "→ ranging",
  unknown: "… reading",
};

export default function BrainPanel({ snap }: { snap: BotSnapshot }) {
  const b = snap.brain;
  const eq = b.equityCurve.map((v, i) => ({ i, v }));
  const equidistant = eq.length < 2;
  const up = eq.length > 1 && eq[eq.length - 1].v >= eq[0].v;

  return (
    <section className="nb-panel flex flex-col">
      <div className="nb-panel-head">
        <span>ai brain · self-improving</span>
        <span className="text-violet-300">
          {REGIME_LABEL[b.regime]} · {b.volatility}
        </span>
      </div>
      <div className="px-4 py-3 flex flex-col gap-3 flex-1">
        {/* weights */}
        <div className="flex flex-col gap-2">
          {(Object.keys(STRAT_META) as StrategyId[]).map((s) => {
            const d = b.strategies[s];
            const w = b.weights[s] ?? 0.33;
            return (
              <div key={s} className="flex items-center gap-2">
                <div className="w-[74px] shrink-0">
                  <div className="text-[10px] tracking-wider text-slate-300">{STRAT_META[s].label}</div>
                  <div className="text-[8.5px] text-slate-600 truncate">{STRAT_META[s].hint}</div>
                </div>
                <div className="flex-1 h-3 rounded-full bg-slate-800/80 overflow-hidden border border-slate-800">
                  <div
                    className="nb-bar h-full rounded-full bg-gradient-to-r from-violet-600 via-fuchsia-500 to-violet-400"
                    style={{ width: `${Math.round(w * 100)}%` }}
                  />
                </div>
                <div className="w-[86px] text-right shrink-0">
                  <span className="text-[10px] text-violet-300">{Math.round(w * 100)}%</span>
                  <span className="text-[8.5px] text-slate-600 ml-1">
                    {d.trades > 0 ? `${d.wins}W/${d.losses}L` : "no data"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* equity spark */}
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 px-2 pt-1">
          <div className="flex items-center justify-between px-1">
            <span className="text-[9px] tracking-widest text-slate-600 uppercase">equity · live</span>
            <span className={`text-[10px] ${up ? "text-emerald-400" : "text-rose-400"}`}>
              ${snap.stats.balance.toFixed(2)}
            </span>
          </div>
          <div className="h-[52px]">
            {equidistant ? (
              <div className="h-full flex items-center justify-center text-[9.5px] text-slate-600">
                curve draws after the first close
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={eq} margin={{ top: 4, right: 6, left: 6, bottom: 2 }}>
                  <Line
                    type="monotone"
                    dataKey="v"
                    stroke={up ? "#34d399" : "#fb7185"}
                    strokeWidth={1.6}
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* lessons */}
        <div className="flex-1 min-h-0">
          <div className="text-[9px] tracking-widest text-slate-600 uppercase mb-1.5">what the brain learned</div>
          <ul className="flex flex-col gap-1.5">
            {b.lessons.slice(0, 4).map((l, i) => (
              <li key={i} className="text-[10px] leading-snug text-slate-400 flex gap-1.5">
                <span className="text-violet-400 shrink-0">▸</span>
                <span className="min-w-0">{l}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* research engine — learned signal weights */}
        <div>
          <div className="text-[9px] tracking-widest text-slate-600 uppercase mb-1.5">
            research engine · what signals pay
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            {b.signalWeights.map((sw) => {
              const drift = sw.now - sw.base;
              const pct = Math.round(sw.now * 100);
              return (
                <div key={sw.label} className="flex items-center gap-1.5">
                  <span className="text-[8.5px] text-slate-500 w-[86px] truncate shrink-0">{sw.label}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-slate-800/80 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${drift >= 0.015 ? "bg-emerald-400" : drift <= -0.015 ? "bg-slate-500" : "bg-fuchsia-500/80"}`}
                      style={{ width: `${Math.round(sw.now * 290)}%` }}
                    />
                  </div>
                  <span className={`text-[9px] w-[46px] text-right shrink-0 ${drift >= 0.015 ? "text-emerald-300" : drift <= -0.015 ? "text-slate-500" : "text-fuchsia-300"}`}>
                    {pct}%
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="pt-2 border-t border-slate-800/70 flex items-center justify-between text-[9.5px] text-slate-600">
          <span>
            auto-tune every {b.autotuneEvery} closes · next in {b.nextAutotuneIn} · ran {b.autotuneCount}×
          </span>
          <span className="text-slate-500">gate {b.scoreThreshold} · size ×{b.sizeMultiplier.toFixed(2)}</span>
        </div>
        <div className="text-[8.5px] text-slate-600 -mt-1.5">
          learning stack: strategy weights (reward-EMA) · research signals (outcome correlation) · exit params (stop/hold/TP) — all automatic, no operator
        </div>
      </div>
    </section>
  );
}
