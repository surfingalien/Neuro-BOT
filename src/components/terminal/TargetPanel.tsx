"use client";

import type { BotSnapshot } from "@/lib/engine/types";

/** target manager — books profit at the daily + weekly targets, books loss at the caps */
export default function TargetPanel({ snap }: { snap: BotSnapshot }) {
  const t = snap.targets;
  const hit = t.targetHit;
  const capped = t.lossCapped;
  const wHit = t.weekTargetHit;
  const wCapped = t.weekLossCapped;

  const status = wCapped
    ? { text: "WEEK CAPPED", cls: "border-rose-500/50 text-rose-300 bg-rose-500/10 nb-pulse" }
    : wHit
      ? { text: "WEEK BOOKED", cls: "border-emerald-500/50 text-emerald-300 bg-emerald-500/10" }
      : capped
        ? { text: "LOSS CAPPED", cls: "border-rose-500/50 text-rose-300 bg-rose-500/10 nb-pulse" }
        : hit
          ? { text: "TARGET BOOKED", cls: "border-emerald-500/50 text-emerald-300 bg-emerald-500/10" }
          : { text: "HUNTING", cls: "border-slate-700 text-slate-400" };

  return (
    <section className="nb-panel flex flex-col">
      <div className="nb-panel-head">
        <span>target manager · books profit &amp; loss</span>
        <span className={`text-[9px] tracking-wider rounded-full px-2 py-0.5 border ${status.cls}`}>{status.text}</span>
      </div>

      <div className="px-4 py-3 flex flex-col gap-3 flex-1">
        {/* daily P&L bar: loss cap ← 0 → profit target */}
        <DayWeekBar
          capPct={t.dailyLossCapPct}
          targetPct={t.dailyProfitTargetPct}
          capUsd={t.capUsd}
          targetUsd={t.targetUsd}
          pnl={t.dayPnl}
          pnlPct={t.dayPnlPct}
          progress={Math.max(-100, Math.min(100, t.progressPct))}
          leftLabel={t.dayKey || "—"}
          rightLabel={`day ${t.dayKey ? "" : "—"}${hit ? " · profit locked" : ""}`}
          horizon="day"
        />

        {/* weekly P&L bar */}
        <DayWeekBar
          capPct={t.weeklyLossCapPct}
          targetPct={t.weeklyProfitTargetPct}
          capUsd={t.weekCapUsd}
          targetUsd={t.weekTargetUsd}
          pnl={t.weekPnl}
          pnlPct={t.weekPnlPct}
          progress={Math.max(-100, Math.min(100, t.weekProgressPct))}
          leftLabel={t.weekKey || "—"}
          rightLabel={wHit ? " · week locked" : wCapped ? " · breaker down" : ""}
          horizon="week"
        />

        {/* booking rules */}
        <div className="pt-2 border-t border-slate-800/70 grid grid-cols-3 gap-2 text-center">
          <div>
            <div className="text-[9px] tracking-widest text-slate-600 uppercase">on target</div>
            <div className={`text-[10.5px] ${hit || wHit ? "text-emerald-300" : "text-slate-300"}`}>
              {t.closeOnTarget ? "close all · lock" : "stop entries"}
            </div>
          </div>
          <div>
            <div className="text-[9px] tracking-widest text-slate-600 uppercase">on cap</div>
            <div className="text-[10.5px] text-rose-300">breaker · book loss</div>
          </div>
          <div>
            <div className="text-[9px] tracking-widest text-slate-600 uppercase">auto-rearm</div>
            <div className="text-[10.5px] text-slate-300">next day / next week</div>
          </div>
        </div>
      </div>
    </section>
  );
}

function DayWeekBar({
  capPct,
  targetPct,
  capUsd,
  targetUsd,
  pnl,
  pnlPct,
  progress,
  leftLabel,
  rightLabel,
  horizon,
}: {
  capPct: number;
  targetPct: number;
  capUsd: number;
  targetUsd: number;
  pnl: number;
  pnlPct: number;
  progress: number;
  leftLabel: string;
  rightLabel: string;
  horizon: "day" | "week";
}) {
  const span = targetPct + capPct;
  const zeroPct = span > 0 ? (capPct / span) * 100 : 50;
  const width = (Math.abs(progress) / 100) * (progress >= 0 ? 100 - zeroPct : zeroPct);
  const fillPct = progress >= 0 ? zeroPct : zeroPct - width;

  return (
    <div>
      <div className="flex items-center justify-between text-[9.5px] mb-1.5">
        <span className="text-rose-400">cap −{capPct}% · ${capUsd.toFixed(0)}</span>
        <span className="flex items-center gap-1.5">
          <span className="text-[8.5px] tracking-widest text-slate-600 uppercase border border-slate-800 rounded px-1.5 py-0.5">{horizon}</span>
          <span className={`text-[11px] font-semibold ${pnl >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
            {pnl >= 0 ? "+" : "–"}${Math.abs(pnl).toFixed(2)} ({pnlPct >= 0 ? "+" : ""}
            {pnlPct.toFixed(2)}%)
          </span>
        </span>
        <span className="text-emerald-400">target +{targetPct}% · ${targetUsd.toFixed(0)}</span>
      </div>
      <div className="relative h-3.5 rounded-full bg-slate-800/80 border border-slate-800 overflow-hidden">
        <div className="absolute top-0 bottom-0 w-px bg-slate-500/70" style={{ left: `${zeroPct}%` }} />
        <div
          className={`absolute top-0 bottom-0 ${progress >= 0 ? "bg-gradient-to-r from-emerald-600 to-emerald-400" : "bg-gradient-to-l from-rose-600 to-rose-400"}`}
          style={{ left: `${fillPct}%`, width: `${width}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-[8.5px] text-slate-600 mt-1">
        <span>{leftLabel}</span>
        <span>{rightLabel || `${progress >= 0 ? "" : ""}${progress.toFixed(0)}% of the way to target`}</span>
      </div>
    </div>
  );
}
