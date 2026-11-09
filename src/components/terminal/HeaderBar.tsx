"use client";

import type { BotSnapshot } from "@/lib/engine/types";

function fmtUp(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return [h, m, ss].map((x) => String(x).padStart(2, "0")).join(":");
}

export default function HeaderBar({
  snap,
  onStartPause,
  onReset,
  onForceScan,
  onOpenSettings,
  onOpenBacktest,
}: {
  snap: BotSnapshot;
  onStartPause: () => void;
  onReset: () => void;
  onForceScan: () => void;
  onOpenSettings: () => void;
  onOpenBacktest: () => void;
}) {
  const pnl = snap.stats.balance - snap.stats.startBalance;
  const pnlPct = (pnl / snap.stats.startBalance) * 100;
  const up = pnl >= 0;

  return (
    <header className="flex flex-col gap-4">
      {/* top strip */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[10px] tracking-widest text-slate-600">
        <div className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-500/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/70" />
        </div>
        <span className="mx-auto hidden md:block">neuro-bot · crypto-desk · six agents · hard handoffs</span>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2 [&>*]:whitespace-nowrap">
          <button
            onClick={onOpenBacktest}
            className="border border-violet-500/40 rounded-full px-2.5 py-1 text-[10px] text-violet-300 hover:bg-violet-500/10 transition-colors"
          >
            ⧗ backtest
          </button>
          <button
            onClick={onOpenSettings}
            className="border border-slate-700 rounded-full px-2.5 py-1 text-[10px] text-slate-400 hover:text-slate-200 hover:border-slate-500 transition-colors"
          >
            ⚙ settings
          </button>
          <span
            className={`border rounded-full px-2.5 py-1 text-[10px] ${
              snap.mode === "paper"
                ? "border-emerald-500/50 text-emerald-300"
                : "border-rose-500/50 text-rose-300"
            }`}
          >
            {snap.mode} {snap.mode === "paper" ? "✓" : "•"}
          </span>
          <a
            href="#coinbase"
            title="Coinbase balance & live trading"
            className={`border rounded-full px-2.5 py-1 text-[10px] transition-colors ${
              snap.mode === "live"
                ? "border-rose-500/60 text-rose-300 bg-rose-500/10 nb-pulse"
                : "border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500"
            }`}
          >
            {snap.mode === "live" ? "● live" : "go live ↓"}
          </a>
        </div>
      </div>

      {/* main header */}
      <div className="nb-panel px-5 py-4">
        <div className="flex flex-col lg:flex-row lg:items-center gap-5">
          {/* avatar + title */}
          <div className="flex items-center gap-4 min-w-0">
            <div
              className={`h-14 w-14 rounded-full bg-gradient-to-br from-violet-500 via-indigo-500 to-sky-500 flex items-center justify-center nb-avatar-glow shrink-0`}
            >
              <span className="text-xl text-white">{snap.running ? "▶" : "‖"}</span>
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-lg font-bold tracking-tight">
                  <span className="text-sky-400">Neuro</span>
                  <span className="text-slate-100"> Bot </span>
                  <span className="text-slate-100">Terminal</span>
                </h1>
                <span className="text-[9px] border border-violet-500/40 text-violet-300 rounded-full px-2 py-0.5 tracking-wider">
                  AI-BRAIN v1
                </span>
                <span
                  className={`text-[9px] border rounded-full px-2 py-0.5 tracking-wider ${
                    snap.dataSource === "live"
                      ? "border-emerald-500/40 text-emerald-300"
                      : "border-amber-500/40 text-amber-300"
                  }`}
                  title={snap.dataSource === "live" ? "real market data" : "sandbox has no outbound network — simulated feed"}
                >
                  {snap.dataSource === "live" ? "LIVE DATA" : "SIM DATA"}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2 flex-wrap text-[11px]">
                <span className={`flex items-center gap-1.5 ${snap.running ? "text-emerald-400" : "text-amber-400"}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${snap.running ? "bg-emerald-400 nb-pulse" : "bg-amber-400"}`} />
                  {snap.running ? "running" : "paused"} · {fmtUp(snap.uptimeMs)}
                </span>
                <span className="text-slate-600">·</span>
                <span
                  className={`border rounded-full px-2 py-0.5 text-[10px] tracking-wide ${
                    snap.phase === "HALTED"
                      ? "border-rose-500/50 text-rose-300"
                      : "border-slate-700 text-slate-400"
                  }`}
                >
                  {snap.currentStageLine}
                </span>
              </div>
              <p className="mt-1 text-[10px] text-slate-600 tracking-wide">
                one prompt · six agents · self-improving brain · no coin picked by hand
              </p>
            </div>
          </div>

          {/* balance */}
          <div className="lg:ml-auto lg:text-right shrink-0">
            <div className={`text-3xl md:text-4xl font-bold tracking-tight ${up ? "text-emerald-400" : "text-rose-400"}`}>
              ${snap.stats.balance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5">
              paper balance · started ${snap.stats.startBalance.toFixed(2)} ·{" "}
              <span className={up ? "text-emerald-400" : "text-rose-400"}>
                {up ? "+" : ""}
                {pnlPct.toFixed(1)}%
              </span>
            </div>
            <div className="text-[10px] text-slate-500">
              {snap.stats.trades} trades ·{" "}
              <span className="text-emerald-400">{snap.stats.wins}W</span> ·{" "}
              <span className="text-rose-400">{snap.stats.losses}L</span>
              {snap.stats.openPositions > 0 && (
                <span className="text-sky-400"> · {snap.stats.openPositions} open</span>
              )}
            </div>
          </div>

          {/* controls */}
          <div className="flex lg:flex-col gap-2 shrink-0">
            <button
              onClick={onStartPause}
              className={`rounded-lg px-4 py-2 text-[11px] font-semibold tracking-wider transition-all ${
                snap.running
                  ? "bg-amber-500/15 text-amber-300 border border-amber-500/40 hover:bg-amber-500/25"
                  : "bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/25"
              }`}
            >
              {snap.running ? "‖ PAUSE BOT" : "▶ RESUME BOT"}
            </button>
            <button
              onClick={onForceScan}
              className="rounded-lg px-4 py-2 text-[11px] tracking-wider border border-sky-500/40 text-sky-300 hover:bg-sky-500/10 transition-all"
            >
              ⟳ FORCE SCAN
            </button>
            <button
              onClick={onReset}
              className="rounded-lg px-4 py-2 text-[11px] tracking-wider border border-rose-500/30 text-rose-400/80 hover:bg-rose-500/10 transition-all"
            >
              ✕ RESET
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
