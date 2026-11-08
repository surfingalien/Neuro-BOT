"use client";

import { useCallback, useEffect, useState } from "react";
import type { BotSnapshot } from "@/lib/engine/types";

interface Holding { currency: string; qty: number; hold: number; price: number; usdValue: number }
interface CbInfo {
  configured: boolean;
  liveAllowed: boolean;
  liveProblems: string[];
  limits: { bankrollCap: number; maxOrderUsd: number };
  live: { mode: "paper" | "live"; entriesLocked: boolean; bankroll: number | null; openLive: number };
  holdings: Holding[];
  usd: number;
  totalUsd: number;
  error?: string;
}

const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qtyFmt = (n: number) => (n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n.toPrecision(6).replace(/\.?0+$/, ""));

/** Coinbase account — real balance + holdings, and the (heavily gated) live-trading switch */
export default function CoinbasePanel({ snap, onChanged }: { snap: BotSnapshot; onChanged: () => void }) {
  const [info, setInfo] = useState<CbInfo | null>(null);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/coinbase", { cache: "no-store" });
      if (r.ok) setInfo(await r.json());
    } catch { /* retry */ }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (action: "liveOn" | "liveOff") => {
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch("/api/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, confirm }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) setMsg(j.error ?? "request failed");
      else setConfirm("");
      onChanged();
      void load();
    } finally {
      setBusy(false);
    }
  };

  const isLive = snap.mode === "live";
  const locked = info?.live.entriesLocked;

  return (
    <section id="coinbase" className="nb-panel flex flex-col scroll-mt-4">
      <div className="nb-panel-head">
        <span>coinbase · balance &amp; holdings</span>
        <span
          className={`text-[9px] tracking-wider rounded-full px-2 py-0.5 border ${
            isLive ? "border-rose-500/60 text-rose-300 bg-rose-500/10 nb-pulse" : "border-emerald-500/40 text-emerald-300"
          }`}
        >
          {isLive ? (locked ? "LIVE · ENTRIES LOCKED" : "LIVE · REAL MONEY") : "PAPER"}
        </span>
      </div>

      <div className="px-4 py-3 flex flex-col gap-3">
        {!info ? (
          <p className="text-[10px] text-slate-600">loading…</p>
        ) : !info.configured ? (
          <p className="text-[10.5px] text-slate-500 leading-snug">
            Coinbase key not connected. Market data already comes from Coinbase (public). To see your balance and enable
            live trading, set <code className="text-slate-300">COINBASE_API_KEY_NAME</code> and{" "}
            <code className="text-slate-300">COINBASE_API_PRIVATE_KEY</code> in your Railway variables.
          </p>
        ) : (
          <>
            {info.error ? (
              <p className="text-[10.5px] text-rose-400">{info.error}</p>
            ) : (
              <>
                <div className="flex items-baseline gap-4">
                  <div>
                    <div className="text-[9px] tracking-widest text-slate-600 uppercase">total value</div>
                    <div className="text-lg text-slate-100">{usd(info.totalUsd)}</div>
                  </div>
                  <div>
                    <div className="text-[9px] tracking-widest text-slate-600 uppercase">cash (USD)</div>
                    <div className="text-sm text-slate-300">{usd(info.usd)}</div>
                  </div>
                  {isLive && info.live.bankroll !== null && (
                    <div>
                      <div className="text-[9px] tracking-widest text-slate-600 uppercase">bot bankroll</div>
                      <div className="text-sm text-rose-300">{usd(info.live.bankroll)}</div>
                    </div>
                  )}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[10.5px]">
                    <thead>
                      <tr className="text-slate-600 text-left">
                        <th className="font-normal py-1">asset</th>
                        <th className="font-normal text-right">amount</th>
                        <th className="font-normal text-right">price</th>
                        <th className="font-normal text-right">value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {info.holdings.length === 0 && (
                        <tr><td colSpan={4} className="text-slate-600 py-2">no balances</td></tr>
                      )}
                      {info.holdings.map((h) => (
                        <tr key={h.currency} className="text-slate-300 border-t border-slate-800/60">
                          <td className="py-1">{h.currency}</td>
                          <td className="text-right">{qtyFmt(h.qty)}{h.hold > 0 ? " *" : ""}</td>
                          <td className="text-right">{h.price ? usd(h.price) : "—"}</td>
                          <td className="text-right">{usd(h.usdValue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {info.holdings.some((h) => h.hold > 0) && <p className="text-[9px] text-slate-600">* includes funds on hold</p>}
                </div>
              </>
            )}

            <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3">
              {!info.liveAllowed && !isLive ? (
                <p className="text-[10px] text-amber-300/90 leading-snug">
                  Live trading is locked: {info.liveProblems.join(" · ")}.
                </p>
              ) : isLive ? (
                <div className="flex flex-col gap-2">
                  <p className="text-[10px] text-rose-300 leading-snug">
                    Real market orders are being placed on Coinbase · majors only · max order {usd(info.limits.maxOrderUsd)} ·
                    bankroll cap {usd(info.limits.bankrollCap)}. Stops are checked by this app every ~3s (not resting
                    exchange orders).
                  </p>
                  <div className="flex gap-2 flex-wrap">
                    {locked && (
                      <>
                        <input
                          value={confirm}
                          onChange={(e) => setConfirm(e.target.value)}
                          placeholder="type ENABLE LIVE to allow new entries"
                          className="flex-1 min-w-[200px] bg-slate-900/80 border border-slate-700 rounded-lg px-2.5 py-1.5 text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-rose-500/60"
                        />
                        <button disabled={busy} onClick={() => void act("liveOn")} className="border border-rose-500/50 text-rose-300 rounded-lg px-3 py-1.5 text-[10px] hover:bg-rose-500/10">
                          UNLOCK ENTRIES
                        </button>
                      </>
                    )}
                    <button disabled={busy} onClick={() => void act("liveOff")} className="border border-slate-600 text-slate-200 rounded-lg px-3 py-1.5 text-[10px] hover:bg-slate-800">
                      SELL ALL &amp; GO PAPER
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <p className="text-[10px] text-slate-500 leading-snug">
                    Live mode trades real money from your Coinbase USD balance: at most {usd(info.limits.bankrollCap)} bankroll,{" "}
                    {usd(info.limits.maxOrderUsd)} per order, Coinbase-listed majors only. The bot is experimental and can
                    lose money. Reverts to paper on every restart.
                  </p>
                  <div className="flex gap-2 flex-wrap">
                    <input
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      placeholder="type ENABLE LIVE"
                      className="flex-1 min-w-[160px] bg-slate-900/80 border border-slate-700 rounded-lg px-2.5 py-1.5 text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-rose-500/60"
                    />
                    <button
                      disabled={busy || confirm.trim() !== "ENABLE LIVE"}
                      onClick={() => void act("liveOn")}
                      className="border border-rose-500/50 text-rose-300 rounded-lg px-3 py-1.5 text-[10px] hover:bg-rose-500/10 disabled:opacity-40"
                    >
                      GO LIVE
                    </button>
                  </div>
                </div>
              )}
              {msg && <p className="mt-1.5 text-[10px] text-rose-400">{msg}</p>}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
