"use client";

import { useEffect, useRef } from "react";
import type { BotSnapshot } from "@/lib/engine/types";

const LEVEL_COLOR: Record<string, string> = {
  WIN: "text-emerald-300",
  LOSS: "text-rose-300",
  KILL: "text-rose-400/90",
  ENTER: "text-sky-300",
  SCORE: "text-violet-300",
  TRAIL: "text-amber-300",
  STOP: "text-amber-400",
  PASS: "text-slate-500",
  BRAIN: "text-fuchsia-300",
  BOOT: "text-sky-400",
  RISK: "text-amber-300",
  INFO: "text-slate-500",
};

export default function LogPanel({ snap }: { snap: BotSnapshot }) {
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // stay pinned to newest (logs arrive newest-first)
  }, [snap.logs]);

  return (
    <section className="nb-panel flex flex-col min-h-0">
      <div className="nb-panel-head">
        <span>$ tail -f neuro.log</span>
        <span className="text-slate-600 normal-case tracking-normal">
          line #{String(snap.logs[0]?.n ?? 0).padStart(3, "0")} · {snap.phase.toLowerCase()}
        </span>
      </div>
      <div ref={boxRef} className="flex-1 min-h-0 overflow-y-auto nb-scroll px-3 py-2 flex flex-col gap-[3px]">
        {snap.logs.map((l) => {
          const time = new Date(l.ts).toLocaleTimeString("en-US", { hour12: false });
          return (
            <div key={l.n} className="text-[10.5px] leading-snug flex gap-2">
              <span className="text-slate-700 shrink-0">{time}</span>
              <span className={`shrink-0 font-semibold w-[46px] ${LEVEL_COLOR[l.level] ?? "text-slate-500"}`}>
                {l.level}
              </span>
              <span className="text-slate-400 min-w-0 break-words">{l.text}</span>
            </div>
          );
        })}
        {snap.logs.length === 0 && <div className="text-[10.5px] text-slate-600">line #001 · boot…</div>}
      </div>
    </section>
  );
}
