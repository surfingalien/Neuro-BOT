"use client";

import { useCallback, useEffect, useState } from "react";

interface Wf { ranAt: number; net: number; buyHold: number; positive: number; windows: number; worstWindow: number; worstDD: number; trades: number; passed: boolean; reasons: string[] }
interface Fw { startedAt: number; updatedAt: number; days: number; net: number; buyHold: number; trades: number; maxDD: number; fees: number }
interface Fam {
  family: string;
  status: "waiting" | "forward-testing" | "promoted";
  version: { n: number; params: Record<string, number>; adoptedAt: number; reason: string } | null;
  walkForward: Wf | null;
  forward: Fw | null;
  holding: string[];
}
interface Desk {
  running: boolean;
  busy: boolean;
  phase: string;
  lastResearchAt: number;
  lastForwardAt: number;
  champion: string | null;
  families: Record<string, Fam>;
  journal: { t: number; kind: string; text: string }[];
  dataSpan: { from: string; to: string; bars: number } | null;
  fee: number;
  forwardMinDays: number;
  researchEveryHours: number;
}

const LABEL: Record<string, string> = {
  rotation: "weekly momentum rotation",
  breakout: "1h trend breakout",
  pullback: "1h uptrend pullback",
};
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const tone = (x: number) => (x > 0 ? "text-emerald-400" : x < 0 ? "text-rose-400" : "text-slate-300");
const ago = (t: number) => {
  if (!t) return "never";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 172800 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
const KIND_CLS: Record<string, string> = {
  promote: "text-emerald-400",
  demote: "text-rose-400",
  adopt: "text-violet-300",
  error: "text-rose-400",
  research: "text-slate-400",
  info: "text-slate-500",
};

/** autonomous research desk — researches, re-tunes, forward-tests and promotes strategies on its own (paper only) */
export default function DeskPanel() {
  const [d, setD] = useState<Desk | null>(null);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/desk", { cache: "no-store" });
      if (r.ok) setD(await r.json());
    } catch { /* retry */ }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const t = setInterval(() => void load(), 5000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  const run = async () => {
    setMsg("");
    const r = await fetch("/api/desk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "research" }) });
    if (!r.ok) setMsg(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "could not start");
    void load();
  };

  const working = !!d && (d.busy || d.running);

  return (
    <section id="desk" className="nb-panel flex flex-col scroll-mt-4">
      <div className="nb-panel-head">
        <span>autonomous desk · research → forward-test → promote</span>
        <span
          className={`text-[9px] tracking-wider rounded-full px-2 py-0.5 border ${
            d?.champion ? "border-emerald-500/50 text-emerald-300" : "border-slate-700 text-slate-400"
          }`}
        >
          {d?.champion ? `CHAMPION · ${LABEL[d.champion] ?? d.champion}` : "NO CHAMPION · STAYING IN PAPER"}
        </span>
      </div>

      <div className="px-4 py-3 flex flex-col gap-3">
        {!d ? (
          <p className="text-[10px] text-slate-600">loading…</p>
        ) : (
          <>
            <p className="text-[10.5px] text-slate-500 leading-snug">
              Every {d.researchEveryHours}h the desk re-downloads real Coinbase candles, tests each strategy on windows it has never seen (fees{" "}
              {(d.fee * 100).toFixed(1)}%/side), re-tunes it, and forward-tests the new version. A strategy is promoted only after {d.forwardMinDays}+ days of
              profitable forward testing, and demoted when the evidence turns. It never places orders: live still needs your ENABLE LIVE.
            </p>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-slate-500">
              <span>last research: <b className="text-slate-300">{ago(d.lastResearchAt)}</b></span>
              <span>last forward update: <b className="text-slate-300">{ago(d.lastForwardAt)}</b></span>
              {d.dataSpan && <span>data: <b className="text-slate-300">{d.dataSpan.from} → {d.dataSpan.to}</b> ({d.dataSpan.bars.toLocaleString()} h)</span>}
              <span className={working ? "text-amber-300" : ""}>status: <b>{working ? d.phase : "idle"}</b></span>
              <button
                disabled={working}
                onClick={() => void run()}
                className="ml-auto border border-violet-500/40 text-violet-300 rounded-lg px-3 py-1 text-[10px] hover:bg-violet-500/10 disabled:opacity-50"
              >
                {working ? "WORKING…" : "RUN RESEARCH NOW"}
              </button>
            </div>
            {msg && <p className="text-[10px] text-rose-400">{msg}</p>}

            <div className="overflow-x-auto">
              <table className="w-full text-[10.5px]">
                <thead>
                  <tr className="text-slate-600 text-left">
                    <th className="font-normal py-1">strategy</th>
                    <th className="font-normal">status</th>
                    <th className="font-normal text-right">walk-forward (unseen)</th>
                    <th className="font-normal text-right">forward test</th>
                    <th className="font-normal text-right">version</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.values(d.families).map((f) => (
                    <tr key={f.family} className="text-slate-300 border-t border-slate-800/60 align-top">
                      <td className="py-1.5">
                        {LABEL[f.family] ?? f.family}
                        {f.holding.length > 0 && <div className="text-[9px] text-slate-500">shadow holds: {f.holding.map((s) => s.replace("USDT", "")).join(", ")}</div>}
                      </td>
                      <td>
                        <span
                          className={`text-[9px] tracking-wider rounded-full px-2 py-0.5 border ${
                            f.status === "promoted" ? "border-emerald-500/50 text-emerald-300" : f.status === "forward-testing" ? "border-amber-500/40 text-amber-300" : "border-slate-700 text-slate-500"
                          }`}
                        >
                          {f.status.toUpperCase()}
                        </span>
                      </td>
                      <td className="text-right">
                        {f.walkForward ? (
                          <>
                            <span className={tone(f.walkForward.net)}>{pct(f.walkForward.net)}</span>
                            <span className="text-slate-600"> vs {pct(f.walkForward.buyHold)} hold</span>
                            <div className="text-[9px] text-slate-500">
                              {f.walkForward.positive}/{f.walkForward.windows} windows · worst {pct(f.walkForward.worstWindow)} · {f.walkForward.passed ? "passed" : "failed"}
                            </div>
                          </>
                        ) : (
                          <span className="text-slate-600">not yet</span>
                        )}
                      </td>
                      <td className="text-right">
                        {f.forward ? (
                          <>
                            <span className={tone(f.forward.net)}>{pct(f.forward.net)}</span>
                            <div className="text-[9px] text-slate-500">
                              {f.forward.days.toFixed(1)}/{d.forwardMinDays}d · {f.forward.trades} trades · fees ${f.forward.fees.toFixed(0)}
                            </div>
                          </>
                        ) : (
                          <span className="text-slate-600">starting</span>
                        )}
                      </td>
                      <td className="text-right text-slate-500">{f.version ? `v${f.version.n}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-2 max-h-[150px] overflow-y-auto nb-scroll">
              <div className="text-[9px] tracking-widest text-slate-600 uppercase mb-1">desk journal</div>
              {d.journal.length === 0 && <p className="text-[10px] text-slate-600">nothing yet — the first research cycle starts shortly after the app boots.</p>}
              {d.journal.slice(0, 14).map((j, i) => (
                <div key={i} className="text-[9.5px] leading-relaxed flex gap-2">
                  <span className="text-slate-600 shrink-0">{ago(j.t)}</span>
                  <span className={KIND_CLS[j.kind] ?? "text-slate-400"}>{j.text}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
