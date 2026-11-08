"use client";

import type { AgentState } from "@/lib/engine/types";

const TONE: Record<string, { dot: string; text: string; ring: string }> = {
  green: { dot: "bg-emerald-400", text: "text-emerald-300", ring: "border-emerald-500/40" },
  red: { dot: "bg-rose-400", text: "text-rose-300", ring: "border-rose-500/40" },
  purple: { dot: "bg-violet-400", text: "text-violet-300", ring: "border-violet-500/40" },
  amber: { dot: "bg-amber-400", text: "text-amber-300", ring: "border-amber-500/40" },
  blue: { dot: "bg-sky-400", text: "text-sky-300", ring: "border-sky-500/40" },
  dim: { dot: "bg-slate-500", text: "text-slate-400", ring: "border-slate-600/40" },
};

const ICONS: Record<string, string> = {
  scout: "◎",
  filter: "⏳",
  analyst: "▮▮▮",
  executor: "⚡",
  risk: "◉",
  brain: "✦",
  logger: "≡",
  you: "☺",
};

export default function AgentColumn({ agents, activeId }: { agents: AgentState[]; activeId: string }) {
  return (
    <aside className="flex flex-col gap-2 lg:w-[290px] w-full shrink-0">
      {agents.map((a) => {
        const tone = TONE[a.statusTone] ?? TONE.dim;
        const active = a.id === activeId;
        return (
          <div
            key={a.id}
            className={`nb-panel px-3 py-2.5 transition-all ${active ? "border-emerald-500/50 shadow-[0_0_18px_rgba(16,185,129,0.15)]" : ""}`}
          >
            <div className="flex items-center gap-2">
              <span className={`text-[13px] ${tone.text}`}>{ICONS[a.id] ?? "•"}</span>
              <span className="text-[12px] font-semibold tracking-widest text-slate-200">{a.name}</span>
              <span
                className={`ml-auto text-[9px] tracking-wider border rounded-full px-1.5 py-0.5 ${tone.ring} ${tone.text} ${
                  a.status !== "IDLE" && a.status !== "FLAT" ? "nb-pulse" : ""
                }`}
              >
                {a.badge}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full ${tone.dot} ${active ? "nb-pulse" : ""}`} />
              <span className={`text-[10px] tracking-wider ${tone.text}`}>{a.status}</span>
            </div>
            <p className="mt-1 text-[10.5px] leading-snug text-slate-500">{a.desc}</p>
            <p className="mt-1.5 text-[10.5px] leading-snug text-slate-400 truncate" title={a.activity}>
              <span className="text-slate-600">└ </span>
              {a.activity}
            </p>
          </div>
        );
      })}
    </aside>
  );
}
