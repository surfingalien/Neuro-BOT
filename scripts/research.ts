// Strategy research runner:  bun run scripts/research.ts [days=460]
// Walk-forward test of candidate strategies on real Coinbase hourly candles, after fees.
// Nothing here places orders. Data is cached in the OS temp dir so re-runs are fast.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAJOR_SYMBOLS } from "@/lib/engine/market";
import {
  DEFAULT_SIM,
  breakout,
  indicators,
  loadHourly,
  pullback,
  walkForward,
  walkForwardRotation,
  type Ind,
  type SimCfg,
  type WalkForward,
} from "@/lib/engine/research";
import type { Candle } from "@/lib/engine/types";

const days = Number(process.argv[2]) || 460;
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;

function report(r: WalkForward) {
  console.log(`\n── ${r.name}`);
  console.log("window  picked-params                                   net     gross   buy&hold  trades  win   maxDD  fees$");
  r.windows.forEach((w, i) =>
    console.log(
      `  #${i + 1}    ${JSON.stringify(w.picked).padEnd(46)} ${pct(w.ret).padStart(7)} ${pct(w.grossRet).padStart(8)} ${pct(w.bh).padStart(9)} ${String(w.trades).padStart(6)} ${(w.winRate * 100).toFixed(0).padStart(4)}% ${(w.maxDD * 100).toFixed(1).padStart(6)}% ${w.fees.toFixed(0).padStart(6)}`
    )
  );
  console.log(`  TOTAL (compounded, unseen windows only): net ${pct(r.compounded)}  vs buy&hold ${pct(r.bhCompounded)} · profitable windows ${r.positiveWindows}/${r.windows.length} · worst ${pct(r.worstWindow)} · worst DD ${(r.worstDD * 100).toFixed(1)}% · trades ${r.totalTrades}`);
  console.log(`  VERDICT: ${r.passed ? "PASS ✅" : "FAIL ❌  " + r.reasons.join("; ")}`);
}

(async () => {
  const cache = path.join(os.tmpdir(), `neurobot-hourly-${days}.json`);
  let raw: Record<string, Candle[]>;
  if (fs.existsSync(cache)) raw = JSON.parse(fs.readFileSync(cache, "utf8"));
  else {
    console.log(`downloading ${days} days of hourly candles for ${MAJOR_SYMBOLS.length} coins (one-off, ~1-2 min)…`);
    raw = await loadHourly([...MAJOR_SYMBOLS], days);
    fs.writeFileSync(cache, JSON.stringify(raw));
  }
  const data: Record<string, Ind> = {};
  for (const [s, c] of Object.entries(raw)) data[s] = indicators(c);
  const total = Math.min(...Object.values(data).map((d) => d.c.length));
  const first = new Date(Object.values(data)[0].c[0].t).toISOString().slice(0, 10);
  const last = new Date(Object.values(data)[0].c[total - 1].t).toISOString().slice(0, 10);
  console.log(`data: ${Object.keys(data).length} coins · ${total} hourly bars · ${first} → ${last}`);

  const opts = { warmup: 400, trainBars: 24 * 120, testBars: 24 * 60, total };
  const breakoutGrid: { look: number; stopAtr: number; trailAtr: number; hold: number }[] = [];
  for (const look of [24, 72, 168]) for (const stopAtr of [2, 3]) for (const trailAtr of [3, 4]) breakoutGrid.push({ look, stopAtr, trailAtr, hold: 240 });
  const pullbackGrid: { rsiBelow: number; stopAtr: number; trailAtr: number; hold: number }[] = [];
  for (const rsiBelow of [30, 40]) for (const stopAtr of [2, 3]) for (const trailAtr of [0, 3]) pullbackGrid.push({ rsiBelow, stopAtr, trailAtr, hold: 120 });
  const rotGrid: { lookback: number; topK: number; every: number; trend: number }[] = [];
  for (const lookback of [72, 168, 336]) for (const topK of [2, 3, 5]) for (const trend of [0, 1]) rotGrid.push({ lookback, topK, every: 168, trend });

  for (const [label, fee] of [["Coinbase taker 0.60%/side", 0.006], ["lower tier 0.25%/side", 0.0025]] as const) {
    const cfg: SimCfg = { ...DEFAULT_SIM, feeRate: fee };
    console.log(`\n==================== FEES: ${label} ====================`);
    report(walkForward("trend-breakout", data, breakoutGrid, breakout, cfg, opts));
    report(walkForward("uptrend-pullback", data, pullbackGrid, pullback, cfg, opts));
    report(walkForwardRotation(data, rotGrid, cfg, opts));
  }
})();
