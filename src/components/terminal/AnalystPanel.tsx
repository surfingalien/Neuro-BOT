"use client";

import type { BotSnapshot } from "@/lib/engine/types";

function Gauge({ score, deciding }: { score: number; deciding: boolean }) {
  const R = 44;
  const C = 2 * Math.PI * R;
  const frac = Math.max(0, Math.min(1, score / 100));
  const color = score >= 70 ? "#34d399" : score >= 50 ? "#a78bfa" : "#fb7185";
  return (
    <div className="relative h-[120px] w-[120px] shrink-0">
      <svg viewBox="0 0 110 110" className="h-full w-full -rotate-90">
        <circle cx="55" cy="55" r={R} fill="none" stroke="#1b2740" strokeWidth="7" />
        <circle
          cx="55"
          cy="55"
          r={R}
          fill="none"
          stroke={color}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={`${C * frac} ${C}`}
          style={{ transition: "stroke-dasharray 0.9s cubic-bezier(0.22,1,0.36,1)" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-bold" style={{ color }}>
          {score}
        </span>
        <span className="text-[8.5px] tracking-widest text-slate-500 uppercase">
          {deciding ? "final score" : "score"}
        </span>
      </div>
    </div>
  );
}

export default function AnalystPanel({ snap }: { snap: BotSnapshot }) {
  const v = snap.analystView;
  return (
    <section className="nb-panel flex flex-col">
      <div className="nb-panel-head">
        <span>analyst · score 0–100</span>
        {v ? (
          <span className="text-violet-300 border border-violet-500/40 rounded-full px-2 py-0.5 text-[10px] tracking-wider">
            {v.coin}
          </span>
        ) : (
          <span className="text-slate-600">gate {snap.brain.scoreThreshold}+</span>
        )}
      </div>
      <div className="flex-1 px-4 py-3">
        {!v && (
          <div className="flex items-center justify-center text-[11px] text-slate-600 min-h-[212px]">
            waiting for a survivor…
          </div>
        )}
        {v && (
          <div className="flex gap-4 items-center">
            <div className="flex-1 flex flex-col gap-2 min-w-0">
              {v.scores.map((s) => (
                <div key={s.label} className="flex items-center gap-2">
                  <span className="text-[9.5px] text-slate-500 w-[86px] shrink-0 truncate">{s.label}</span>
                  <div className="flex-1 h-2 rounded-full bg-slate-800/80 overflow-hidden">
                    <div
                      className="nb-bar h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-400"
                      style={{ width: `${s.value}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-slate-300 w-6 text-right">{s.value}</span>
                </div>
              ))}
            </div>
            <div className="flex flex-col items-center gap-1">
              <Gauge score={v.final} deciding={v.deciding} />
            </div>
          </div>
        )}
        {v && (
          <p
            className={`mt-3 pt-2 border-t border-slate-800/70 text-[10px] ${
              v.deciding ? "text-emerald-300" : "text-slate-500"
            }`}
          >
            {v.handoff} · {snap.brain.scoreThreshold}+ moves on, below {snap.brain.scoreThreshold} is dropped
          </p>
        )}
      </div>
    </section>
  );
}
