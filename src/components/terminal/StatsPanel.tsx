"use client";

import type { BotSnapshot } from "@/lib/engine/types";

function Row({
  label,
  value,
  tone,
  barPct,
  barTone,
}: {
  label: string;
  value: string;
  tone: string;
  barPct: number;
  barTone: string;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-[10px] text-slate-500 w-[118px] shrink-0">{label}</span>
      <div className="flex-1 h-1.5 rounded-full bg-slate-800/70 overflow-hidden">
        <div className={`h-full rounded-full ${barTone}`} style={{ width: `${Math.min(100, barPct)}%` }} />
      </div>
      <span className={`text-[10.5px] w-[74px] text-right shrink-0 ${tone}`}>{value}</span>
    </div>
  );
}

export default function StatsPanel({ snap }: { snap: BotSnapshot }) {
  const s = snap.stats;
  const max = Math.max(s.seen, 1);
  return (
    <section className="nb-panel flex flex-col">
      <div className="nb-panel-head">
        <span>stats from the run</span>
        <span className="text-slate-600 normal-case tracking-normal">paper · live prices</span>
      </div>
      <div className="px-4 py-3 flex flex-col gap-2 flex-1">
        <Row label="pairs scanned" value={s.seen.toLocaleString()} tone="text-slate-300" barPct={100} barTone="bg-sky-500/70" />
        <Row
          label="killed by filter"
          value={`${s.killed.toLocaleString()} · ${((s.killed / Math.max(1, s.seen)) * 100).toFixed(0)}%`}
          tone="text-rose-300"
          barPct={(s.killed / max) * 100}
          barTone="bg-rose-500/70"
        />
        <Row
          label="scored by analyst"
          value={s.scored.toLocaleString()}
          tone="text-violet-300"
          barPct={(s.scored / max) * 100}
          barTone="bg-violet-500/70"
        />
        <Row
          label="trades taken"
          value={s.trades.toLocaleString()}
          tone="text-emerald-300"
          barPct={(s.trades / max) * 100}
          barTone="bg-emerald-500/70"
        />
        <Row
          label="wins / losses"
          value={`${s.wins}W · ${s.losses}L`}
          tone="text-slate-200"
          barPct={(s.wins / Math.max(1, s.trades)) * 100}
          barTone="bg-emerald-400"
        />
        <Row
          label="best trade"
          value={s.bestTrade > 0 ? `+$${s.bestTrade.toFixed(2)}` : "—"}
          tone="text-emerald-300"
          barPct={s.bestTrade > 0 ? 80 : 0}
          barTone="bg-emerald-500/70"
        />
        <Row
          label="worst trade"
          value={s.worstTrade < 0 ? `–$${Math.abs(s.worstTrade).toFixed(2)}` : "—"}
          tone="text-rose-300"
          barPct={s.worstTrade < 0 ? 60 : 0}
          barTone="bg-rose-500/70"
        />
        <div className="mt-1 pt-2 border-t border-slate-800/70 grid grid-cols-3 gap-2 text-center">
          <div>
            <div className="text-[9px] tracking-widest text-slate-600 uppercase">open now</div>
            <div className="text-[11px] text-sky-300">{s.openPositions}</div>
          </div>
          <div>
            <div className="text-[9px] tracking-widest text-slate-600 uppercase">rotations</div>
            <div className="text-[11px] text-slate-300">{s.cycle}</div>
          </div>
          <div>
            <div className="text-[9px] tracking-widest text-slate-600 uppercase">win rate</div>
            <div className="text-[11px] text-emerald-300">
              {s.trades > 0 ? Math.round((s.wins / Math.max(1, s.wins + s.losses)) * 100) : 0}%
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
