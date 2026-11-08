"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Line, LineChart, ResponsiveContainer, ReferenceLine, YAxis } from "recharts";
import type { BotSnapshot } from "@/lib/engine/types";

interface BacktestReport {
  id: string;
  ranAt: number;
  simulated: boolean;
  scope: string;
  symbols: string[];
  bars: number;
  spanHours: number;
  startBalance: number;
  endEquity: number;
  pnl: number;
  pnlPct: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  maxDrawdownPct: number;
  dailyTargetHits: number;
  dailyBreakerHits: number;
  weeklyTargetHits: number;
  weeklyBreakerHits: number;
  equityCurve: { i: number; eq: number }[];
  perStrategy: { strategy: string; trades: number; wins: number; pnl: number }[];
  brainBefore: { weights: Record<string, number>; scoreThreshold: number; sizeMultiplier: number; autotuneCount: number };
  brainAfter: { weights: Record<string, number>; scoreThreshold: number; sizeMultiplier: number; autotuneCount: number };
  lessons: string[];
  log: string[];
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  snap: BotSnapshot;
  onApplied: () => void;
}

const SCOPES = [
  { id: "majors", label: "MAJORS" },
  { id: "memecoins", label: "MEMECOINS" },
  { id: "both", label: "BOTH" },
] as const;

const BAR_OPTS = [500, 1000, 2000, 3000];

export default function BacktestDialog({ open, onOpenChange, snap, onApplied }: Props) {
  const [scope, setScope] = useState<(typeof SCOPES)[number]["id"]>("majors");
  const [bars, setBars] = useState(1000);
  const [useLiveBrain, setUseLiveBrain] = useState(false);
  const [running, setRunning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<BacktestReport | null>(null);

  const run = async () => {
    setRunning(true);
    setError("");
    try {
      const res = await fetch("/api/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run", scope, bars, useLiveBrain, startBalance: Number(snap.settings.startBalance) || 1000 }),
      });
      const j = (await res.json()) as { ok?: boolean; report?: BacktestReport; error?: string };
      if (j.report) setReport(j.report);
      else setError(j.error ?? "backtest failed");
    } catch {
      setError("network error — retry");
    } finally {
      setRunning(false);
    }
  };

  const apply = async () => {
    setApplying(true);
    try {
      await fetch("/api/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "apply" }),
      });
      onApplied();
    } finally {
      setApplying(false);
    }
  };

  const r = report;
  const eqData = r?.equityCurve.map((p) => ({ i: p.i, eq: p.eq })) ?? [];
  const eqUp = eqData.length > 1 && eqData[eqData.length - 1].eq >= eqData[0].eq;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="nb-panel border-slate-700 max-w-3xl max-h-[88vh] overflow-y-auto nb-scroll text-slate-300">
        <DialogHeader>
          <DialogTitle className="text-slate-100 tracking-wide text-[14px]">BACKTEST · train the brain on history</DialogTitle>
          <DialogDescription className="text-[10.5px] text-slate-500">
            replays 1-minute candles through the same scout → filter → analyst → executor → risk pipeline · every close
            teaches the brain (weights, signals, params) · then apply the trained brain to the live bot
          </DialogDescription>
        </DialogHeader>

        {/* controls */}
        <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-800 bg-slate-900/50 p-3">
          <div className="flex flex-col gap-1">
            <span className="text-[10px] tracking-wider text-slate-400 uppercase">market</span>
            <div className="flex border border-slate-700 rounded-lg overflow-hidden">
              {SCOPES.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setScope(s.id)}
                  className={`px-3 py-1.5 text-[10px] tracking-wider transition-colors ${
                    scope === s.id ? "bg-violet-600/70 text-white" : "text-slate-500 hover:text-slate-300 hover:bg-slate-800/50"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] tracking-wider text-slate-400 uppercase">history (1m bars)</span>
            <div className="flex border border-slate-700 rounded-lg overflow-hidden">
              {BAR_OPTS.map((b) => (
                <button
                  key={b}
                  onClick={() => setBars(b)}
                  className={`px-3 py-1.5 text-[10px] transition-colors ${
                    bars === b ? "bg-sky-600/70 text-white" : "text-slate-500 hover:text-slate-300 hover:bg-slate-800/50"
                  }`}
                >
                  {b}
                </button>
              ))}
            </div>
          </div>
          <button
            onClick={() => setUseLiveBrain((v) => !v)}
            className={`rounded-lg px-3 py-2 text-[10px] tracking-wider border transition-colors ${
              useLiveBrain
                ? "bg-fuchsia-600/20 border-fuchsia-500/50 text-fuchsia-300"
                : "bg-slate-900/80 border-slate-700 text-slate-400 hover:text-slate-300"
            }`}
          >
            {useLiveBrain ? "🧠 start from LIVE brain" : "✦ start from FRESH brain"}
          </button>
          <button
            onClick={() => void run()}
            disabled={running}
            className="ml-auto rounded-lg bg-violet-600/80 hover:bg-violet-600 px-5 py-2 text-[11px] font-semibold tracking-wider text-white transition-colors disabled:opacity-50"
          >
            {running ? "REPLAYING…" : "▶ RUN BACKTEST"}
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-300">{error}</div>
        )}

        {running && (
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-6 text-center">
            <div className="text-[12px] text-violet-300 nb-pulse">replaying history through the 6-agent pipeline…</div>
            <div className="text-[9.5px] text-slate-600 mt-1">fetching candles → filter → score → strategy signals → risk → brain learning</div>
          </div>
        )}

        {!running && !r && (
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-6 text-center text-[11px] text-slate-600">
            no result yet — pick a market + history depth and press RUN BACKTEST
          </div>
        )}

        {!running && r && (
          <div className="flex flex-col gap-3">
            {/* headline KPIs */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Kpi label="net P&L" value={`${r.pnl >= 0 ? "+" : "–"}$${Math.abs(r.pnl).toFixed(2)}`} sub={`${r.pnlPct >= 0 ? "+" : ""}${r.pnlPct.toFixed(1)}%`} tone={r.pnl >= 0 ? "up" : "down"} />
              <Kpi label="win rate" value={`${r.winRate.toFixed(0)}%`} sub={`${r.wins}W / ${r.losses}L`} tone={r.winRate >= 50 ? "up" : "down"} />
              <Kpi label="trades" value={String(r.trades)} sub={`${r.symbols.length} pairs · ${r.spanHours}h`} tone="neutral" />
              <Kpi label="max drawdown" value={`−${r.maxDrawdownPct.toFixed(1)}%`} sub={`peak-to-valley`} tone={r.maxDrawdownPct > 20 ? "down" : "neutral"} />
            </div>

            {/* equity curve */}
            <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-2">
              <div className="flex items-center justify-between px-1 mb-1">
                <span className="text-[9px] tracking-widest text-slate-600 uppercase">equity curve · {r.bars} bars</span>
                <span className="flex items-center gap-2">
                  {r.simulated && <span className="text-[8.5px] border border-amber-500/40 text-amber-300 rounded-full px-2 py-0.5">SIM DATA</span>}
                  <span className={`text-[10px] ${eqUp ? "text-emerald-400" : "text-rose-400"}`}>
                    ${r.endEquity.toFixed(2)} from ${r.startBalance.toFixed(0)}
                  </span>
                </span>
              </div>
              <div className="h-[120px]">
                {eqData.length < 2 ? (
                  <div className="h-full flex items-center justify-center text-[10px] text-slate-600">flat run — no marks</div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={eqData} margin={{ top: 4, right: 6, left: 6, bottom: 2 }}>
                      <YAxis hide domain={["dataMin - 3", "dataMax + 3"]} />
                      <ReferenceLine y={r.startBalance} stroke="#475569" strokeDasharray="3 3" strokeOpacity={0.6} />
                      <Line type="monotone" dataKey="eq" stroke={eqUp ? "#34d399" : "#fb7185"} strokeWidth={1.6} dot={false} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            {/* target manager behavior in the replay */}
            <div className="grid grid-cols-4 gap-2 text-center">
              <Mini label="day target hits" value={r.dailyTargetHits} tone="emerald" />
              <Mini label="day breakers" value={r.dailyBreakerHits} tone="rose" />
              <Mini label="week target hits" value={r.weeklyTargetHits} tone="emerald" />
              <Mini label="week breakers" value={r.weeklyBreakerHits} tone="rose" />
            </div>

            {/* per-strategy */}
            <div className="rounded-xl border border-slate-800 overflow-hidden">
              <table className="w-full text-[10px]">
                <thead>
                  <tr className="bg-slate-900/80 text-slate-500 tracking-wider">
                    <th className="text-left px-3 py-1.5 font-medium">strategy</th>
                    <th className="text-right px-3 py-1.5 font-medium">trades</th>
                    <th className="text-right px-3 py-1.5 font-medium">wins</th>
                    <th className="text-right px-3 py-1.5 font-medium">pnl</th>
                    <th className="text-right px-3 py-1.5 font-medium">brain weight</th>
                  </tr>
                </thead>
                <tbody>
                  {r.perStrategy.map((s) => (
                    <tr key={s.strategy} className="border-t border-slate-800/60">
                      <td className="px-3 py-1.5 text-slate-300 uppercase tracking-wider">{s.strategy}</td>
                      <td className="px-3 py-1.5 text-right text-slate-400">{s.trades}</td>
                      <td className="px-3 py-1.5 text-right text-emerald-400">{s.wins}</td>
                      <td className={`px-3 py-1.5 text-right ${s.pnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                        {s.pnl >= 0 ? "+" : "–"}${Math.abs(s.pnl).toFixed(2)}
                      </td>
                      <td className="px-3 py-1.5 text-right text-violet-300">
                        {((r.brainAfter.weights[s.strategy] ?? 0.33) * 100).toFixed(0)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* brain before → after */}
            <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-3 flex flex-col gap-1.5">
              <div className="text-[9px] tracking-widest text-slate-600 uppercase">brain · before → after the replay</div>
              <div className="grid grid-cols-3 gap-2 text-[10.5px]">
                <Delta label="score gate" a={r.brainBefore.scoreThreshold} b={r.brainAfter.scoreThreshold} fmt={(v) => String(v)} />
                <Delta label="size mult" a={r.brainBefore.sizeMultiplier} b={r.brainAfter.sizeMultiplier} fmt={(v) => `×${v.toFixed(2)}`} />
                <Delta label="autotunes" a={r.brainBefore.autotuneCount} b={r.brainAfter.autotuneCount} fmt={(v) => `${v}×`} />
              </div>
              {r.lessons.slice(0, 3).map((l, i) => (
                <div key={i} className="text-[9.5px] text-slate-500 flex gap-1.5">
                  <span className="text-violet-400 shrink-0">▸</span>
                  <span>{l}</span>
                </div>
              ))}
            </div>

            {/* replay log */}
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-2 max-h-[140px] overflow-y-auto nb-scroll">
              {r.log.slice(-24).map((l, i) => (
                <div key={i} className="text-[9.5px] text-slate-500 leading-relaxed font-mono whitespace-pre-wrap">{l}</div>
              ))}
            </div>

            {/* apply */}
            <div className="flex items-center justify-between gap-3 pt-1">
              <span className="text-[9px] text-slate-600">
                applying imports weights · score gate · size multiplier · signal weights · per-strategy params into the live bot
              </span>
              <button
                onClick={() => void apply()}
                disabled={applying}
                className="rounded-lg bg-emerald-600/80 hover:bg-emerald-600 px-4 py-2 text-[11px] font-semibold tracking-wider text-white transition-colors disabled:opacity-50"
              >
                {applying ? "APPLYING…" : "🧠 APPLY BRAIN TO LIVE BOT"}
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: "up" | "down" | "neutral" }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-2">
      <div className="text-[8.5px] tracking-widest text-slate-600 uppercase">{label}</div>
      <div className={`text-[15px] font-semibold ${tone === "up" ? "text-emerald-400" : tone === "down" ? "text-rose-400" : "text-slate-200"}`}>{value}</div>
      <div className="text-[8.5px] text-slate-600">{sub}</div>
    </div>
  );
}

function Mini({ label, value, tone }: { label: string; value: number; tone: "emerald" | "rose" }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 py-1.5">
      <div className={`text-[13px] font-semibold ${tone === "emerald" ? "text-emerald-400" : "text-rose-400"}`}>{value}</div>
      <div className="text-[8px] tracking-wider text-slate-600 uppercase">{label}</div>
    </div>
  );
}

function Delta({ label, a, b, fmt }: { label: string; a: number; b: number; fmt: (v: number) => string }) {
  const changed = Math.abs(b - a) > 1e-9;
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 px-2.5 py-1.5">
      <div className="text-[8.5px] tracking-widest text-slate-600 uppercase">{label}</div>
      <div className="text-[11px] text-slate-300">
        {fmt(a)} <span className="text-slate-600">→</span>{" "}
        <span className={changed ? "text-fuchsia-300 font-semibold" : "text-slate-300"}>{fmt(b)}</span>
      </div>
    </div>
  );
}
