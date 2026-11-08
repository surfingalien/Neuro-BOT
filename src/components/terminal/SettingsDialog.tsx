"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { BotSnapshot } from "@/lib/engine/types";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  snap: BotSnapshot;
  onSaved: () => void;
}

function NumField({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] tracking-wider text-slate-400 uppercase">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="bg-slate-900/80 border border-slate-700 rounded-lg px-2.5 py-1.5 text-[12px] text-slate-200 focus:outline-none focus:border-violet-500/60"
      />
      <span className="text-[9px] text-slate-600">{hint}</span>
    </label>
  );
}

export default function SettingsDialog({ open, onOpenChange, snap, onSaved }: Props) {
  const s = snap.settings;
  const [form, setForm] = useState<Record<string, number>>({
    maxPositionPct: Number(s.maxPositionPct),
    stopLossPct: Number(s.stopLossPct),
    tp1Pct: Number(s.tp1Pct),
    tp2Pct: Number(s.tp2Pct),
    trailActivationPct: Number(s.trailActivationPct),
    trailGapPct: Number(s.trailGapPct),
    maxPositions: Number(s.maxPositions),
    maxHoldMinutes: Number(s.maxHoldMinutes),
    dailyLossCapPct: Number(s.dailyLossCapPct),
    dailyProfitTargetPct: Number(s.dailyProfitTargetPct ?? 4),
    weeklyProfitTargetPct: Number(s.weeklyProfitTargetPct ?? 15),
    weeklyLossCapPct: Number(s.weeklyLossCapPct ?? 25),
    startBalance: Number(s.startBalance ?? 1000),
  });
  const [closeOnTarget, setCloseOnTarget] = useState<boolean>(s.closeOnTarget !== false);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [tgToken, setTgToken] = useState("");
  const [tgChatId, setTgChatId] = useState("");
  const [tgEnabled, setTgEnabled] = useState<boolean>(snap.tg.enabled);
  const [tgEvents, setTgEvents] = useState<Record<string, boolean>>({ target: true, breaker: true, trades: true, brain: true });
  const [tgTestMsg, setTgTestMsg] = useState("");
  const [tgTesting, setTgTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  const set = (k: string) => (v: number) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          closeOnTarget,
          binanceKey: apiKey || undefined,
          binanceSecret: apiSecret || undefined,
          tgToken: tgToken || undefined,
          tgChatId: tgChatId || undefined,
          tgEnabled,
          tgEvents,
        }),
      });
      onSaved();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTgTesting(true);
    setTgTestMsg("");
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tgToken: tgToken || undefined, tgChatId: tgChatId || undefined, tgTest: true }),
      });
      const j = (await res.json()) as { tgTest?: { ok: boolean; error: string } };
      setTgTestMsg(j.tgTest?.ok ? "sent ✓ check your chat" : `failed — ${j.tgTest?.error ?? "unknown"}`);
    } catch {
      setTgTestMsg("failed — network error");
    } finally {
      setTgTesting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="nb-panel border-slate-700 max-w-2xl max-h-[85vh] overflow-y-auto nb-scroll text-slate-300">
        <DialogHeader>
          <DialogTitle className="text-slate-100 tracking-wide text-[14px]">ENGINE SETTINGS · risk & targets</DialogTitle>
          <DialogDescription className="text-[10.5px] text-slate-500">
            the risk agent enforces every number below · targets auto-adapt to ATR on majors
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <NumField label="daily profit target %" hint="day P&L ≥ this → book & lock" value={form.dailyProfitTargetPct} min={0.5} max={50} step={0.5} onChange={set("dailyProfitTargetPct")} />
          <NumField label="daily loss cap %" hint="day P&L ≤ −this → breaker books loss" value={form.dailyLossCapPct} min={2} max={60} step={1} onChange={set("dailyLossCapPct")} />
          <label className="flex flex-col gap-1">
            <span className="text-[10px] tracking-wider text-slate-400 uppercase">on target hit</span>
            <button
              type="button"
              onClick={() => setCloseOnTarget((v) => !v)}
              className={`rounded-lg px-2.5 py-1.5 text-[11px] border transition-colors ${
                closeOnTarget
                  ? "bg-emerald-600/20 border-emerald-500/50 text-emerald-300"
                  : "bg-slate-900/80 border-slate-700 text-slate-400"
              }`}
            >
              {closeOnTarget ? "close all opens · lock profit" : "stop new entries only"}
            </button>
            <span className="text-[9px] text-slate-600">daily auto-rearms next UTC day</span>
          </label>
          <NumField label="weekly profit target %" hint="week P&L ≥ this → book week · flat till next week" value={form.weeklyProfitTargetPct} min={1} max={200} step={1} onChange={set("weeklyProfitTargetPct")} />
          <NumField label="weekly loss cap %" hint="week P&L ≤ −this → weekly breaker" value={form.weeklyLossCapPct} min={2} max={200} step={1} onChange={set("weeklyLossCapPct")} />
          <div className="flex flex-col gap-1">
            <span className="text-[10px] tracking-wider text-slate-400 uppercase">weekly semantics</span>
            <span className="text-[9.5px] text-slate-500 leading-snug">weekly target books &amp; goes flat until the next UTC week · weekly breaker auto-clears on rollover (or press RESUME)</span>
          </div>
          <NumField label="position size %" hint="share of balance per trade" value={form.maxPositionPct} min={1} max={25} step={0.5} onChange={set("maxPositionPct")} />
          <NumField label="stop loss %" hint="memecoin hard stop (majors = ATR)" value={form.stopLossPct} min={1} max={30} step={0.5} onChange={set("stopLossPct")} />
          <NumField label="take profit 1 %" hint="book ½ here · arms the trail" value={form.tp1Pct} min={1} max={50} step={0.5} onChange={set("tp1Pct")} />
          <NumField label="take profit 2 %" hint="close runner fully" value={form.tp2Pct} min={2} max={100} step={1} onChange={set("tp2Pct")} />
          <NumField label="trail activation %" hint="trail turns on after this gain" value={form.trailActivationPct} min={2} max={50} step={1} onChange={set("trailActivationPct")} />
          <NumField label="trail gap %" hint="exit if price falls this % under peak" value={form.trailGapPct} min={3} max={40} step={1} onChange={set("trailGapPct")} />
          <NumField label="max open positions" hint="concurrent slots" value={form.maxPositions} min={1} max={10} step={1} onChange={set("maxPositions")} />
          <NumField label="max hold (min)" hint="time stop · brain tunes ×per strategy" value={form.maxHoldMinutes} min={5} max={1440} step={5} onChange={set("maxHoldMinutes")} />
          <NumField label="start balance $" hint="used on reset" value={form.startBalance} min={50} max={100000} step={50} onChange={set("startBalance")} />
        </div>

        {/* telegram alerts */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-3">
          <div className="flex items-center justify-between">
            <span className="text-[10.5px] tracking-wider text-slate-300 uppercase">telegram alerts · target / breaker events</span>
            <div className="flex items-center gap-2">
              {snap.tg.configured && (
                <span className="text-[9px] border border-slate-700 text-slate-500 rounded-full px-2 py-0.5" title={snap.tg.masked}>
                  bot {snap.tg.masked} · {snap.tg.sentCount} sent
                </span>
              )}
              <button
                type="button"
                onClick={() => setTgEnabled((v) => !v)}
                className={`rounded-lg px-2.5 py-1.5 text-[10px] border transition-colors ${
                  tgEnabled
                    ? "bg-emerald-600/20 border-emerald-500/50 text-emerald-300"
                    : "bg-slate-900/80 border-slate-700 text-slate-400"
                }`}
              >
                {tgEnabled ? "ALERTS ON" : "ALERTS OFF"}
              </button>
            </div>
          </div>
          <p className="mt-1 text-[9.5px] text-slate-500 leading-snug">
            create a bot with @BotFather → paste the token here → send any message to your bot → grab the chat id
            (e.g. via @userinfobot) → paste it → test. token + chat id are stored server-side and never echoed back.
          </p>
          <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input
              type="password"
              placeholder="TELEGRAM BOT TOKEN (123456:ABC-DEF…)"
              value={tgToken}
              onChange={(e) => setTgToken(e.target.value)}
              className="bg-slate-900/80 border border-slate-700 rounded-lg px-2.5 py-1.5 text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-violet-500/60"
            />
            <input
              type="text"
              placeholder="TELEGRAM CHAT ID (e.g. 123456789)"
              value={tgChatId}
              onChange={(e) => setTgChatId(e.target.value)}
              className="bg-slate-900/80 border border-slate-700 rounded-lg px-2.5 py-1.5 text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-violet-500/60"
            />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {([
              ["target", "🎯 target booked"],
              ["breaker", "🛑 loss breaker"],
              ["trades", "✅ trade closes"],
              ["brain", "🧠 brain autotune"],
            ] as const).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setTgEvents((e) => ({ ...e, [k]: !e[k] }))}
                className={`rounded-full px-2.5 py-1 text-[9.5px] border transition-colors ${
                  tgEvents[k]
                    ? "border-violet-500/50 bg-violet-600/20 text-violet-200"
                    : "border-slate-700 text-slate-600 hover:text-slate-400"
                }`}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => void sendTest()}
              disabled={tgTesting}
              className="ml-auto rounded-lg border border-sky-500/40 text-sky-300 hover:bg-sky-500/10 px-3 py-1.5 text-[10px] tracking-wider transition-colors disabled:opacity-50"
            >
              {tgTesting ? "SENDING…" : "SEND TEST"}
            </button>
          </div>
          {(tgTestMsg || snap.tg.lastError) && (
            <div className={`mt-1.5 text-[9.5px] ${tgTestMsg.startsWith("sent") ? "text-emerald-400" : "text-rose-400"}`}>
              {tgTestMsg || `last send error: ${snap.tg.lastError}`}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-3">
          <div className="flex items-center justify-between">
            <span className="text-[10.5px] tracking-wider text-slate-300 uppercase">live trading · binance keys</span>
            <span className="text-[9px] border border-amber-500/40 text-amber-300 rounded-full px-2 py-0.5">
              OFF in sandbox
            </span>
          </div>
          <p className="mt-1 text-[9.5px] text-slate-500 leading-snug">
            paper mode trades real prices with fake money. to go live later: paste API keys here (stored encrypted, never
            echoed back), flip mode to live and enable withdrawals-off trade-only keys. live execution stays disabled in
            this build until you host it with your own keys.
          </p>
          <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input
              type="password"
              placeholder="BINANCE API KEY"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="bg-slate-900/80 border border-slate-700 rounded-lg px-2.5 py-1.5 text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-violet-500/60"
            />
            <input
              type="password"
              placeholder="BINANCE API SECRET"
              value={apiSecret}
              onChange={(e) => setApiSecret(e.target.value)}
              className="bg-slate-900/80 border border-slate-700 rounded-lg px-2.5 py-1.5 text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-violet-500/60"
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-[9px] text-slate-600">
            not financial advice · memecoins can go to zero · the brain improves odds, it does not remove risk
          </span>
          <button
            onClick={save}
            disabled={saving}
            className="rounded-lg bg-violet-600/80 hover:bg-violet-600 px-4 py-2 text-[11px] font-semibold tracking-wider text-white transition-colors disabled:opacity-50"
          >
            {saving ? "SAVING…" : "SAVE SETTINGS"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
