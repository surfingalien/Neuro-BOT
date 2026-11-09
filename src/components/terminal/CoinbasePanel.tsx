"use client";

import { useCallback, useEffect, useState } from "react";
import type { BotSnapshot } from "@/lib/engine/types";

interface Holding { currency: string; qty: number; hold: number; price: number; usdValue: number }
interface CbInfo {
  configured: boolean;
  liveAllowed: boolean;
  liveProblems: string[];
  limits: { bankrollCap: number; maxOrderUsd: number };
  validation: {
    ok: boolean;
    skipped: boolean;
    reason: string;
    record: {
      ranAt: number; passed: boolean; net: number; gross: number; firstHalf: number; secondHalf: number;
      trades: number; winRate: number; maxDD: number; days: number; feeRate: number; simulated: boolean; reasons: string[];
    } | null;
  };
  keyInfo: { name: string; nameLooksRight: boolean; keyType: string; keyError?: string } | null;
  live: {
    mode: "paper" | "live";
    entriesLocked: boolean;
    bankroll: number | null;
    openLive: number;
    feed: string;
    gate: number;
    running: boolean;
    diag: { lastSkip: string; lastSkipAt: number; lastError: string; lastErrorAt: number; buys: number; sells: number; lastOrderAt: number };
  };
  holdings: Holding[];
  usd: number;
  totalUsd: number;
  error?: string;
  outboundIp?: string;
}

interface Exec {
  id: string; base: string; strategy: string; status: string; entryPrice: number; exitPrice: number | null;
  sizeUsd: number; realizedPnl: number; exitReason: string | null; openedAt: string; closedAt: string | null;
}
const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qtyFmt = (n: number) => (n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n.toPrecision(6).replace(/\.?0+$/, ""));

/** Coinbase account — real balance + holdings, and the (heavily gated) live-trading switch */
export default function CoinbasePanel({ snap, onChanged }: { snap: BotSnapshot; onChanged: () => void }) {
  const [info, setInfo] = useState<CbInfo | null>(null);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [execs, setExecs] = useState<Exec[]>([]);
  const [validating, setValidating] = useState(false);
  const [valMsg, setValMsg] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/coinbase", { cache: "no-store" });
      if (r.ok) setInfo(await r.json());
    } catch { /* retry */ }
  }, []);

  const loadExecs = useCallback(async () => {
    try {
      const r = await fetch("/api/trades?mode=live", { cache: "no-store" });
      if (r.ok) setExecs(((await r.json()) as { trades: Exec[] }).trades.slice(0, 8));
    } catch { /* retry */ }
  }, []);

  useEffect(() => {
    void load();
    void loadExecs();
    const t = setInterval(() => { void load(); void loadExecs(); }, 10_000);
    return () => clearInterval(t);
  }, [load, loadExecs]);

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

  const runValidation = async () => {
    setValidating(true);
    setValMsg("");
    try {
      const r = await fetch("/api/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "validate" }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) setValMsg(j.error ?? `validation failed (${r.status})`);
      void load();
    } catch {
      setValMsg("network error — retry");
    } finally {
      setValidating(false);
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
            {info.keyInfo && (
              <p className="text-[9.5px] text-slate-500">
                key loaded: <span className="text-slate-300">{info.keyInfo.name}</span> · {info.keyInfo.keyType}
                {!info.keyInfo.nameLooksRight && (
                  <span className="text-amber-300"> · name should look like organizations/…/apiKeys/…</span>
                )}
              </p>
            )}
            {info.error ? (
              <div className="flex flex-col gap-1.5">
                <p className="text-[10.5px] text-rose-400">{info.error}</p>
                {info.outboundIp && (
                  <p className="text-[10px] text-slate-400 leading-snug">
                    This server currently reaches Coinbase from{" "}
                    <code className="text-slate-200">{info.outboundIp}</code>. If the key has an IP allowlist, this address
                    must be on it (or remove the allowlist). Railway&apos;s outbound IP can change after a redeploy.
                  </p>
                )}
              </div>
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

            {isLive && (
              <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 flex flex-col gap-1.5">
                <div className="text-[9px] tracking-widest text-slate-600 uppercase">live status</div>
                <div className="text-[10.5px] text-slate-300 flex flex-wrap gap-x-4 gap-y-1">
                  <span>feed: <b className={info.live.feed === "coinbase" ? "text-emerald-400" : "text-rose-400"}>{info.live.feed}</b></span>
                  <span>bot: <b className={info.live.running ? "text-emerald-400" : "text-amber-300"}>{info.live.running ? "running" : "paused"}</b></span>
                  <span>entries: <b className={info.live.entriesLocked ? "text-amber-300" : "text-emerald-400"}>{info.live.entriesLocked ? "locked" : "open"}</b></span>
                  <span>score gate: <b>{info.live.gate}</b></span>
                  <span>orders: <b>{info.live.diag.buys}</b> buys · <b>{info.live.diag.sells}</b> sells{info.live.diag.lastOrderAt ? ` · last ${ago(info.live.diag.lastOrderAt)}` : ""}</span>
                  <span>open: <b>{info.live.openLive}</b></span>
                </div>
                {info.live.diag.lastError && (
                  <p className="text-[10px] text-rose-400 leading-snug">last order error ({ago(info.live.diag.lastErrorAt)}): {info.live.diag.lastError}</p>
                )}
                {info.live.diag.lastSkip && (
                  <p className="text-[10px] text-amber-300/90 leading-snug">last skipped entry ({ago(info.live.diag.lastSkipAt)}): {info.live.diag.lastSkip}</p>
                )}
                {info.live.diag.buys === 0 && !info.live.diag.lastError && !info.live.diag.lastSkip && (
                  <p className="text-[10px] text-slate-500 leading-snug">
                    No orders yet. The bot only enters setups scoring {info.live.gate}+ on Coinbase majors, so it can be quiet for hours. Nothing is wrong unless an error appears above.
                  </p>
                )}
              </div>
            )}

            {execs.length > 0 && (
              <div className="overflow-x-auto">
                <div className="text-[9px] tracking-widest text-slate-600 uppercase mb-1">recent live executions</div>
                <table className="w-full text-[10px]">
                  <thead>
                    <tr className="text-slate-600 text-left">
                      <th className="font-normal py-0.5">asset</th><th className="font-normal">strategy</th>
                      <th className="font-normal text-right">size</th><th className="font-normal text-right">entry</th>
                      <th className="font-normal text-right">exit</th><th className="font-normal text-right">net P&amp;L</th>
                      <th className="font-normal text-right">status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {execs.map((e) => (
                      <tr key={e.id} className="text-slate-300 border-t border-slate-800/60">
                        <td className="py-0.5">{e.base}</td><td>{e.strategy}</td>
                        <td className="text-right">{usd(e.sizeUsd)}</td><td className="text-right">{usd(e.entryPrice)}</td>
                        <td className="text-right">{e.exitPrice ? usd(e.exitPrice) : "—"}</td>
                        <td className={`text-right ${e.realizedPnl > 0 ? "text-emerald-400" : e.realizedPnl < 0 ? "text-rose-400" : ""}`}>
                          {e.status === "closed" ? `${e.realizedPnl >= 0 ? "+" : "–"}${usd(Math.abs(e.realizedPnl))}` : "open"}
                        </td>
                        <td className="text-right text-slate-500">{e.status === "closed" ? e.exitReason ?? "closed" : "open"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {!isLive && (
              <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[9px] tracking-widest text-slate-600 uppercase">strategy validation · required before live</span>
                  <span
                    className={`text-[9px] tracking-wider rounded-full px-2 py-0.5 border ${
                      info.validation.ok
                        ? "border-emerald-500/40 text-emerald-300"
                        : info.validation.record && !info.validation.record.passed
                          ? "border-rose-500/50 text-rose-300"
                          : "border-amber-500/40 text-amber-300"
                    }`}
                  >
                    {info.validation.skipped ? "SKIPPED (override)" : info.validation.ok ? "PASSED" : info.validation.record?.passed === false ? "FAILED" : "NOT RUN"}
                  </span>
                </div>
                {info.validation.record && (
                  <p className="text-[10px] text-slate-400 leading-snug">
                    last run {ago(info.validation.record.ranAt)} · {info.validation.record.days.toFixed(1)} days of real Coinbase data · fees{" "}
                    {(info.validation.record.feeRate * 100).toFixed(1)}%/side · {info.validation.record.trades} trades · win{" "}
                    {info.validation.record.winRate.toFixed(0)}% · before fees{" "}
                    <b>{info.validation.record.gross >= 0 ? "+" : ""}{info.validation.record.gross.toFixed(1)}%</b> · after fees{" "}
                    <b className={info.validation.record.net >= 0 ? "text-emerald-400" : "text-rose-400"}>
                      {info.validation.record.net >= 0 ? "+" : ""}{info.validation.record.net.toFixed(1)}%
                    </b>
                  </p>
                )}
                {!info.validation.ok && <p className="text-[10px] text-amber-300/90 leading-snug">{info.validation.reason}</p>}
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    disabled={validating}
                    onClick={() => void runValidation()}
                    className="border border-violet-500/40 text-violet-300 rounded-lg px-3 py-1.5 text-[10px] hover:bg-violet-500/10 disabled:opacity-50"
                  >
                    {validating ? "VALIDATING… (about a minute)" : "RUN VALIDATION"}
                  </button>
                  {valMsg && <span className="text-[10px] text-rose-400">{valMsg}</span>}
                </div>
              </div>
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
                      disabled={busy || confirm.trim() !== "ENABLE LIVE" || !info.validation.ok}
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
