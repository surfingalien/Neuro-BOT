"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BotSnapshot, MarketFocus } from "@/lib/engine/types";
import AgentColumn from "@/components/terminal/AgentColumn";
import HeaderBar from "@/components/terminal/HeaderBar";
import FlowPipeline from "@/components/terminal/FlowPipeline";
import FilterPanel from "@/components/terminal/FilterPanel";
import AnalystPanel from "@/components/terminal/AnalystPanel";
import PositionPanel from "@/components/terminal/PositionPanel";
import BrainPanel from "@/components/terminal/BrainPanel";
import TargetPanel from "@/components/terminal/TargetPanel";
import StatsPanel from "@/components/terminal/StatsPanel";
import LogPanel from "@/components/terminal/LogPanel";
import SettingsDialog from "@/components/terminal/SettingsDialog";
import BacktestDialog from "@/components/terminal/BacktestDialog";

const PHASE_ACTIVE: Record<string, string> = {
  SCANNING: "scout",
  FILTERING: "filter",
  SCORING: "analyst",
  DECIDING: "executor",
  MANAGING: "risk",
  PAUSED: "you",
  HALTED: "risk",
  BOOKED: "risk",
  BOOT: "logger",
};

const FOCUS_OPTS: { id: MarketFocus; label: string }[] = [
  { id: "majors", label: "MAJORS" },
  { id: "memecoins", label: "MEMECOINS" },
  { id: "both", label: "BOTH" },
];

export default function Home() {
  const [snap, setSnap] = useState<BotSnapshot | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [backtestOpen, setBacktestOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const posRef = useRef<HTMLDivElement>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (res.ok) setSnap(await res.json());
    } catch {
      /* retry next tick */
    }
  }, []);

  useEffect(() => {
    void poll();
    const t = setInterval(() => void poll(), 2000);
    return () => clearInterval(t);
  }, [poll]);

  const control = useCallback(
    async (action: string, extra: Record<string, unknown> = {}) => {
      setBusy(true);
      try {
        const res = await fetch("/api/control", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ...extra }),
        });
        if (res.ok) {
          const j = await res.json();
          if (j.snapshot) setSnap(j.snapshot as BotSnapshot);
        }
      } finally {
        setBusy(false);
      }
    },
    []
  );

  if (!snap) {
    return (
      <div className="nb-root flex items-center justify-center">
        <div className="text-center">
          <div className="mx-auto h-14 w-14 rounded-full bg-gradient-to-br from-violet-500 to-sky-500 nb-avatar-glow flex items-center justify-center text-xl text-white nb-pulse">
            ✦
          </div>
          <p className="mt-4 text-[12px] tracking-widest text-slate-400">NEURO BOT TERMINAL</p>
          <p className="mt-1 text-[10px] text-slate-600">booting agents · warming market feeds…</p>
        </div>
      </div>
    );
  }

  const activeAgent = PHASE_ACTIVE[snap.phase] ?? "scout";
  const pnl = snap.stats.balance - snap.stats.startBalance;

  return (
    <div className="nb-root">
      <main className="mx-auto max-w-[1440px] px-3 md:px-5 py-4 flex flex-col gap-4 pb-16">
        <HeaderBar
          snap={snap}
          onStartPause={() => void control(snap.running ? "pause" : "start")}
          onReset={() => void control("reset")}
          onForceScan={() => void control("forceScan")}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenBacktest={() => setBacktestOpen(true)}
        />

        {/* market focus segmented control */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] tracking-widest text-slate-600 uppercase">market desk</span>
          <div className="flex border border-slate-700 rounded-lg overflow-hidden">
            {FOCUS_OPTS.map((f) => (
              <button
                key={f.id}
                disabled={busy}
                onClick={() => void control("focus", { focus: f.id })}
                className={`px-3.5 py-1.5 text-[10px] tracking-wider transition-colors ${
                  snap.marketFocus === f.id
                    ? "bg-violet-600/70 text-white"
                    : "text-slate-500 hover:text-slate-300 hover:bg-slate-800/50"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          {snap.phase === "HALTED" && (
            <span className="text-[10px] border border-rose-500/50 text-rose-300 rounded-full px-3 py-1 nb-pulse">
              {snap.targets.weekLossCapped ? "weekly loss cap hit" : "daily loss cap hit"} — press RESUME to continue
            </span>
          )}
          {snap.phase === "BOOKED" && (
            <span className="text-[10px] border border-emerald-500/50 text-emerald-300 rounded-full px-3 py-1">
              {snap.targets.weekTargetHit
                ? `weekly profit target booked +$${Math.abs(snap.targets.weekPnl).toFixed(2)} — re-arms next UTC week`
                : `daily profit target booked ${snap.targets.dayPnl >= 0 ? "+" : "–"}$${Math.abs(snap.targets.dayPnl).toFixed(2)} — re-arms next UTC day`}
            </span>
          )}
          {pnl !== 0 && (
            <span className={`text-[10px] ${pnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
              realized {pnl >= 0 ? "+" : "–"}${Math.abs(pnl).toFixed(2)} all-time
            </span>
          )}
        </div>

        {/* main grid */}
        <div className="flex flex-col lg:flex-row gap-4">
          <AgentColumn agents={snap.agents} activeId={activeAgent} />
          <div ref={posRef} className="flex-1 min-w-0 flex flex-col gap-4">
            <FlowPipeline snap={snap} />
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <FilterPanel snap={snap} />
              <AnalystPanel snap={snap} />
            </div>
            <PositionPanel snap={snap} />
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <BrainPanel snap={snap} />
              <div className="flex flex-col gap-4 min-h-0">
                <TargetPanel snap={snap} />
                <StatsPanel snap={snap} />
                <div className="h-[240px] flex">
                  <LogPanel snap={snap} />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* footer */}
        <footer className="mt-2 text-center text-[9.5px] text-slate-600 leading-relaxed">
          one result · not typical · crypto is extremely high risk and you can lose everything · paper trading fills
          real prices with fake money · nothing here is financial advice
          <br />
          neuro-bot terminal · six agents · target manager · self-improving brain · built for research
        </footer>
      </main>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        snap={snap}
        onSaved={() => void poll()}
      />

      <BacktestDialog
        open={backtestOpen}
        onOpenChange={setBacktestOpen}
        snap={snap}
        onApplied={() => void poll()}
      />
    </div>
  );
}
