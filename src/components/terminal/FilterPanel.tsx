"use client";

import type { BotSnapshot } from "@/lib/engine/types";

export default function FilterPanel({ snap }: { snap: BotSnapshot }) {
  const view = snap.filterView;
  return (
    <section className="nb-panel flex flex-col">
      <div className="nb-panel-head">
        <span>filter · 8 hard rules</span>
        {view ? (
          <span className="text-violet-300 border border-violet-500/40 rounded-full px-2 py-0.5 text-[10px] tracking-wider">
            {view.coin}
          </span>
        ) : (
          <span className="text-slate-600">—</span>
        )}
      </div>
      <div className="flex-1 px-4 py-3 flex flex-col">
        {!view && (
          <div className="flex-1 flex items-center justify-center text-[11px] text-slate-600 min-h-[180px]">
            waiting for a candidate…
          </div>
        )}
        {view && (
          <>
            <div className="flex flex-col gap-1.5 min-h-[212px]">
              {view.rules.map((r, i) => (
                <div
                  key={i}
                  className={`flex items-center gap-2 text-[11px] rounded-md px-2 py-1.5 ${
                    r.pass
                      ? "bg-emerald-500/5 text-slate-300"
                      : "bg-rose-500/10 text-rose-200 border border-rose-500/30"
                  }`}
                >
                  <span className={r.pass ? "text-emerald-400" : "text-rose-400"}>{r.pass ? "✓" : "✕"}</span>
                  <span className="flex-1 truncate">{r.label}</span>
                  <span className={r.pass ? "text-emerald-300/80" : "text-rose-300 font-semibold"}>{r.value}</span>
                </div>
              ))}
            </div>
            <p className="mt-3 pt-2 border-t border-slate-800/70 text-[10px] text-slate-500">{view.checkLine}</p>
          </>
        )}
      </div>
    </section>
  );
}
