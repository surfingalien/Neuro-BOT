"use client";

import { Area, AreaChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { BotSnapshot } from "@/lib/engine/types";

const STRATEGY_LABEL: Record<string, string> = {
  momentum: "MOMENTUM SCALP",
  meanrev: "MEAN REVERSION",
  breakout: "BREAKOUT TREND",
};

export default function PositionPanel({ snap }: { snap: BotSnapshot }) {
  const pos = snap.position;
  const closed = snap.closedPreview && !pos ? snap.closedPreview : null;

  if (!pos && closed) {
    return (
      <section className="nb-panel flex flex-col">
        <div className="nb-panel-head">
          <span>executor + risk · position</span>
          <span className="text-slate-600">trade detail</span>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-2 py-10">
          <span className="text-[12px] text-slate-300">
            {closed.base} · CLOSED · {closed.reason}
          </span>
          <span className={`text-2xl font-bold ${closed.pnlUsd >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
            {closed.pnlUsd >= 0 ? "+" : "–"}${Math.abs(closed.pnlUsd).toFixed(2)}
          </span>
          <span className="text-[10px] text-slate-600">risk agent freed the slot · scanning next candidate</span>
        </div>
      </section>
    );
  }

  if (!pos) {
    return (
      <section className="nb-panel flex flex-col">
        <div className="nb-panel-head">
          <span>executor + risk · position</span>
          <span className="text-slate-600">trade detail</span>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center py-10 gap-1">
          <span className="text-[12px] tracking-widest text-slate-400">FLAT</span>
          <span className="text-[10px] text-slate-600">waiting for a {snap.brain.scoreThreshold}+ · stop armed before entry</span>
        </div>
      </section>
    );
  }

  const data = pos.series.map((s, i) => ({ i, p: s.p }));
  const entry = pos.entryPrice;
  const trailStop = pos.trailActive ? pos.trailPeak * (1 - Number(snap.settings.trailGapPct) / 100) : null;
  const peak = pos.trailPeak;

  return (
    <section className="nb-panel flex flex-col">
      <div className="nb-panel-head">
        <span>executor + risk · position</span>
        <span className="text-slate-600">
          {pos.source === "sim" || snap.dataSource === "sim" ? "sim feed" : "live feed"} · paper fill
        </span>
      </div>
      <div className="px-4 pt-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-bold text-slate-100">{pos.base}</span>
            <span
              className={`text-[9px] tracking-wider border rounded-full px-2 py-0.5 ${
                pos.trailActive
                  ? "border-emerald-500/50 text-emerald-300"
                  : "border-sky-500/50 text-sky-300"
              }`}
            >
              {pos.trailActive ? "TRAILING" : STRATEGY_LABEL[pos.strategy] ?? pos.strategy}
            </span>
            <span className="text-[9px] text-slate-500 border border-slate-700 rounded-full px-2 py-0.5">
              {pos.market} · score {pos.score}
            </span>
          </div>
          <span className={`text-xl font-bold ${pos.pnlPct >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
            {pos.pnlPct >= 0 ? "+" : ""}
            {pos.pnlPct.toFixed(1)}%
            <span className="text-[11px] font-normal text-slate-500 ml-2">
              {pos.pnlUsd >= 0 ? "+" : "–"}${Math.abs(pos.pnlUsd).toFixed(2)}
            </span>
          </span>
        </div>
      </div>
      <div className="h-[170px] px-1 pt-2">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 6, right: 46, left: 6, bottom: 0 }}>
            <defs>
              <linearGradient id="posFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={pos.pnlPct >= 0 ? "#34d399" : "#fb7185"} stopOpacity={0.35} />
                <stop offset="100%" stopColor={pos.pnlPct >= 0 ? "#34d399" : "#fb7185"} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <XAxis dataKey="i" hide />
            <YAxis
              domain={["dataMin", "dataMax"]}
              orientation="right"
              tick={{ fill: "#64748b", fontSize: 9 }}
              width={44}
              tickCount={5}
            />
            <Tooltip
              contentStyle={{
                background: "#0c1220",
                border: "1px solid #1b2740",
                borderRadius: 8,
                fontSize: 10,
              }}
              labelFormatter={() => ""}
              formatter={(v: number) => [`$${v.toPrecision(6)}`, "price"]}
            />
            <Area
              type="monotone"
              dataKey="p"
              stroke={pos.pnlPct >= 0 ? "#34d399" : "#fb7185"}
              strokeWidth={1.6}
              fill="url(#posFill)"
              isAnimationActive={false}
            />
            <ReferenceLine
              y={entry}
              stroke="#64748b"
              strokeDasharray="4 4"
              label={{ value: "entry", fill: "#64748b", fontSize: 9, position: "right" }}
            />
            <ReferenceLine
              y={pos.stopLoss}
              stroke="#fb7185"
              strokeDasharray="3 3"
              label={{ value: "stop", fill: "#fb7185", fontSize: 9, position: "right" }}
            />
            <ReferenceLine
              y={pos.tp1}
              stroke="#34d399"
              strokeDasharray="2 4"
              label={{ value: "tp1 ½", fill: "#34d399", fontSize: 9, position: "right" }}
            />
            {trailStop !== null && (
              <ReferenceLine
                y={trailStop}
                stroke="#fbbf24"
                label={{ value: "trail", fill: "#fbbf24", fontSize: 9, position: "right" }}
              />
            )}
            {pos.trailActive && peak > entry && (
              <ReferenceLine
                y={peak}
                stroke="#a78bfa"
                strokeDasharray="1 3"
                label={{ value: "peak", fill: "#a78bfa", fontSize: 9, position: "right" }}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 px-4 pb-4 pt-1 text-[10px]">
        <div className="rounded-lg bg-slate-900/60 border border-slate-800 px-2.5 py-1.5">
          <div className="text-slate-600">size</div>
          <div className="text-slate-300">${pos.sizeUsd.toFixed(2)} · {((pos.sizeUsd / Number(snap.settings.balance)) * 100).toFixed(1)}%</div>
        </div>
        <div className="rounded-lg bg-slate-900/60 border border-slate-800 px-2.5 py-1.5">
          <div className="text-slate-600">entry</div>
          <div className="text-slate-300">${entry.toPrecision(6)}</div>
        </div>
        <div className="rounded-lg bg-slate-900/60 border border-slate-800 px-2.5 py-1.5">
          <div className="text-rose-400/80">stop −{Math.abs((1 - pos.stopLoss / entry) * 100).toFixed(1)}%</div>
          <div className="text-slate-300">${pos.stopLoss.toPrecision(6)}</div>
        </div>
        <div className="rounded-lg bg-slate-900/60 border border-slate-800 px-2.5 py-1.5">
          <div className={pos.trailActive ? "text-amber-300" : "text-slate-600"}>
            {pos.trailActive ? `trail on · ${Number(snap.settings.trailGapPct)}% gap` : `tp2 +${((pos.tp2 / entry - 1) * 100).toFixed(1)}%`}
          </div>
          <div className="text-slate-300">${pos.trailActive ? pos.trailPeak.toPrecision(6) : pos.tp2.toPrecision(6)}</div>
        </div>
      </div>
    </section>
  );
}
