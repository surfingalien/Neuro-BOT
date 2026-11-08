"use client";

import type { BotSnapshot } from "@/lib/engine/types";

const NODE_TONE: Record<string, string> = {
  green: "border-emerald-500/50 text-emerald-300",
  red: "border-rose-500/50 text-rose-300",
  purple: "border-violet-500/50 text-violet-300",
  amber: "border-amber-500/50 text-amber-300",
  blue: "border-sky-500/50 text-sky-300",
};

const NODE_ICON: Record<string, string> = {
  scout: "◎",
  filter: "⏳",
  analyst: "▮",
  executor: "⚡",
  risk: "◉",
  logger: "≡",
};

export default function FlowPipeline({ snap }: { snap: BotSnapshot }) {
  return (
    <section className="nb-panel">
      <div className="nb-panel-head">
        <span>live flow · hard handoffs · one job each</span>
        <span className="text-slate-600 normal-case tracking-normal">
          {snap.running ? "auto-pilot" : "paused"} · phase {snap.phase.toLowerCase()}
        </span>
      </div>
      <div className="p-4">
        {/* ticker */}
        <div className="overflow-hidden border-b border-slate-800/70 pb-3 mb-4">
          <div className="nb-ticker-track">
            {[...snap.ticker, ...snap.ticker].map((t, i) => (
              <span key={i} className="text-[10.5px] inline-flex items-baseline gap-1.5">
                <span className={t.tone === "up" ? "text-emerald-300" : "text-rose-300"}>{t.base}</span>
                <span className="text-slate-600">{t.sub}</span>
              </span>
            ))}
          </div>
        </div>
        {/* pipeline nodes */}
        <div className="flex items-center justify-between gap-1 overflow-x-auto nb-scroll pb-1">
          {snap.flow.map((n, i) => (
            <div key={n.id} className="flex items-center gap-1 shrink-0">
              <div className="flex flex-col items-center gap-1.5 w-[86px]">
                <div
                  className={`nb-node h-11 w-11 rounded-full border bg-slate-900/80 flex items-center justify-center text-base ${
                    NODE_TONE[n.tone] ?? "border-slate-600 text-slate-400"
                  } ${n.active ? "nb-node-active" : "opacity-80"}`}
                >
                  {NODE_ICON[n.id] ?? "•"}
                </div>
                <span className="text-[9px] tracking-widest text-slate-500">{n.label}</span>
                <span className={`text-[10px] ${n.active ? "text-slate-200" : "text-slate-500"}`}>{n.count}</span>
              </div>
              {i < snap.flow.length - 1 && (
                <div className={`h-px w-6 md:w-10 ${n.active ? "bg-emerald-500/60" : "bg-slate-700/70"}`} />
              )}
            </div>
          ))}
        </div>
        <p className="mt-3 text-[10px] text-slate-500 text-center">
          {snap.phaseDetail}
        </p>
      </div>
    </section>
  );
}
