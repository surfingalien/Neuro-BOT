// ─── Autonomous research desk ───
// A self-running loop that never places orders. Every day it:
//   1. re-downloads real hourly Coinbase candles,
//   2. runs a fee-aware walk-forward on each strategy family (judged only on unseen windows),
//   3. re-tunes each family on the latest 120 days and ADOPTS the new parameters only if they beat the
//      current ones by a margin and the current version is old enough (so it improves without thrashing),
//   4. keeps every adopted version under a FORWARD TEST: it is replayed on data that did not exist when its
//      parameters were chosen, with real fees,
//   5. PROMOTES a family only when walk-forward passed AND the forward test is profitable over 28+ days;
//      DEMOTES it when the evidence turns bad.
// Every decision is written to a journal. Promotion makes a strategy *eligible* for live trading;
// real money still needs the operator's ENABLE LIVE (and the existing validation + risk limits).

import { db } from "@/lib/db";
import { MAJOR_SYMBOLS } from "./market";
import {
  DEFAULT_SIM,
  appendHourly,
  bestOnWindow,
  bestRotationOnWindow,
  breakout,
  buyAndHold,
  indicators,
  loadHourly,
  pullback,
  simulate,
  simulateRotation,
  walkForward,
  walkForwardRotation,
  type Ind,
  type SimCfg,
  type SimResult,
  type WalkForward,
} from "./research";
import type { Candle } from "./types";

export type Family = "rotation" | "breakout" | "pullback";
export const FAMILIES: Family[] = ["rotation", "breakout", "pullback"];
export const FAMILY_LABEL: Record<Family, string> = {
  rotation: "weekly momentum rotation",
  breakout: "1h trend breakout",
  pullback: "1h uptrend pullback",
};

import { takerFee } from "./fees";
const FEE = () => takerFee(); // the account's real taker fee (0.6% until Coinbase reports the tier)
const DAYS = 460;
const WARMUP = 400;
const TRAIN = 24 * 120;
const TEST = 24 * 60;
const FORWARD_MIN_DAYS = 28;
const ADOPT_MIN_AGE_DAYS = 14;
const ADOPT_MARGIN = 0.01; // new params must beat the current ones by 1% on the latest training window
const RESEARCH_EVERY_MS = 24 * 3_600_000;
const FORWARD_EVERY_MS = 55 * 60_000;

type Params = Record<string, number>;
const breakoutGrid = (() => {
  const g: { look: number; stopAtr: number; trailAtr: number; hold: number }[] = [];
  for (const look of [24, 72, 168]) for (const stopAtr of [2, 3]) for (const trailAtr of [3, 4]) g.push({ look, stopAtr, trailAtr, hold: 240 });
  return g;
})();
const pullbackGrid = (() => {
  const g: { rsiBelow: number; stopAtr: number; trailAtr: number; hold: number }[] = [];
  for (const rsiBelow of [30, 40]) for (const stopAtr of [2, 3]) for (const trailAtr of [0, 3]) g.push({ rsiBelow, stopAtr, trailAtr, hold: 120 });
  return g;
})();
const rotationGrid = (() => {
  const g: { lookback: number; topK: number; every: number; trend: number }[] = [];
  for (const lookback of [72, 168, 336]) for (const topK of [2, 3, 5]) for (const trend of [0, 1]) g.push({ lookback, topK, every: 168, trend });
  return g;
})();

// ───────────────────────── state ─────────────────────────

export interface WfSummary {
  ranAt: number;
  net: number; // compounded net return over the unseen windows (fraction)
  buyHold: number;
  positive: number;
  windows: number;
  worstWindow: number;
  worstDD: number;
  trades: number;
  passed: boolean;
  reasons: string[];
}
export interface ForwardStats {
  startedAt: number;
  updatedAt: number;
  days: number;
  net: number;
  buyHold: number;
  trades: number;
  maxDD: number;
  fees: number;
}
export interface FamilyState {
  family: Family;
  status: "waiting" | "forward-testing" | "promoted";
  version: { n: number; params: Params; adoptedAt: number; reason: string } | null;
  walkForward: WfSummary | null;
  forward: ForwardStats | null;
  holding: string[]; // what this strategy would hold right now (shadow only)
}
export interface JournalEntry {
  t: number;
  kind: "research" | "adopt" | "promote" | "demote" | "info" | "error";
  text: string;
}
export interface DeskState {
  running: boolean;
  phase: string;
  lastResearchAt: number;
  lastForwardAt: number;
  champion: Family | null;
  families: Record<Family, FamilyState>;
  journal: JournalEntry[];
  dataSpan: { from: string; to: string; bars: number } | null;
}

const fresh = (): DeskState => ({
  running: false,
  phase: "idle",
  lastResearchAt: 0,
  lastForwardAt: 0,
  champion: null,
  families: Object.fromEntries(
    FAMILIES.map((f) => [f, { family: f, status: "waiting", version: null, walkForward: null, forward: null, holding: [] } as FamilyState])
  ) as Record<Family, FamilyState>,
  journal: [],
  dataSpan: null,
});

interface Cache { grids: Record<string, Candle[]>; ind: Record<string, Ind>; at: number }
const g = globalThis as unknown as { __nbDesk?: { state: DeskState; cache: Cache | null; loaded: boolean; timer: ReturnType<typeof setInterval> | null } };
const box = (g.__nbDesk ??= { state: fresh(), cache: null, loaded: false, timer: null });

const journal = (kind: JournalEntry["kind"], text: string) => {
  box.state.journal.unshift({ t: Date.now(), kind, text });
  if (box.state.journal.length > 150) box.state.journal.length = 150;
};

async function persist() {
  try {
    await db.deskState.upsert({ where: { id: "main" }, update: { json: JSON.stringify(box.state) }, create: { id: "main", json: JSON.stringify(box.state) } });
  } catch { /* non-fatal */ }
}

export async function loadDesk(): Promise<DeskState> {
  if (box.loaded) return box.state;
  box.loaded = true;
  try {
    const row = await db.deskState.findUnique({ where: { id: "main" } });
    if (row?.json) {
      const parsed = JSON.parse(row.json) as DeskState;
      if (parsed && parsed.families) {
        box.state = { ...fresh(), ...parsed, running: false, phase: "idle", families: { ...fresh().families, ...parsed.families } };
      }
    }
  } catch { /* start fresh */ }
  return box.state;
}

export const deskSnapshot = () => ({ ...box.state, fee: FEE(), forwardMinDays: FORWARD_MIN_DAYS, researchEveryHours: RESEARCH_EVERY_MS / 3_600_000 });

// ───────────────────────── family plumbing ─────────────────────────

const cfg = (): SimCfg => ({ ...DEFAULT_SIM, feeRate: FEE() });

function simFamily(f: Family, p: Params, data: Record<string, Ind>, from: number, to: number): SimResult {
  if (f === "rotation") return simulateRotation(data, p as { lookback: number; topK: number; every: number; trend: number }, cfg(), from, to);
  const strat = f === "breakout" ? breakout(p as { look: number; stopAtr: number; trailAtr: number; hold: number }) : pullback(p as { rsiBelow: number; stopAtr: number; trailAtr: number; hold: number });
  return simulate(data, strat, cfg(), from, to);
}

async function walkFamily(f: Family, data: Record<string, Ind>, total: number): Promise<WalkForward> {
  const opts = { warmup: WARMUP, trainBars: TRAIN, testBars: TEST, total };
  if (f === "rotation") return walkForwardRotation(data, rotationGrid, cfg(), opts);
  if (f === "breakout") return walkForward("trend-breakout", data, breakoutGrid, breakout, cfg(), opts);
  return walkForward("uptrend-pullback", data, pullbackGrid, pullback, cfg(), opts);
}

async function bestFamily(f: Family, data: Record<string, Ind>, from: number, to: number): Promise<{ p: Params; ret: number } | null> {
  if (f === "rotation") return bestRotationOnWindow(data, rotationGrid, cfg(), from, to);
  if (f === "breakout") return bestOnWindow(data, breakoutGrid, breakout, cfg(), from, to);
  return bestOnWindow(data, pullbackGrid, pullback, cfg(), from, to);
}

// ───────────────────────── data ─────────────────────────

async function ensureData(full: boolean): Promise<Cache> {
  if (full || !box.cache) {
    box.state.phase = "downloading ~1 year of hourly candles";
    const grids = await loadHourly([...MAJOR_SYMBOLS], DAYS);
    box.cache = { grids, ind: {}, at: Date.now() };
  } else {
    box.state.phase = "refreshing the latest candles";
    box.cache.grids = await appendHourly(box.cache.grids);
    box.cache.at = Date.now();
  }
  const ind: Record<string, Ind> = {};
  for (const [s, c] of Object.entries(box.cache.grids)) ind[s] = indicators(c);
  box.cache.ind = ind;
  const first = Object.values(box.cache.grids)[0];
  box.state.dataSpan = { from: new Date(first[0].t).toISOString().slice(0, 10), to: new Date(first[first.length - 1].t).toISOString().slice(0, 10), bars: first.length };
  return box.cache;
}

const totalBars = (c: Cache) => Math.min(...Object.values(c.ind).map((d) => d.c.length));
const lastBarT = (c: Cache) => Object.values(c.ind)[0].c[totalBars(c) - 1].t;

// ───────────────────────── forward test + status ─────────────────────────

function forwardUpdate(c: Cache) {
  const total = totalBars(c);
  for (const f of FAMILIES) {
    const fs = box.state.families[f];
    if (!fs.version) continue;
    const ref = Object.values(c.ind)[0].c;
    // the forward test may only use bars that did not exist when the parameters were chosen
    let from = ref.findIndex((x) => x.t > fs.version!.adoptedAt);
    if (from < 0 || total - from < 2) {
      // adopted on the newest bar: nothing unseen yet. Never fall back to older (in-sample) data.
      fs.forward = null;
      fs.holding = simFamily(f, fs.version.params, c.ind, total - TRAIN, total).holding; // what it would hold right now
      continue;
    }
    from = Math.max(from, WARMUP + 2);
    const r = simFamily(f, fs.version.params, c.ind, from, total);
    fs.holding = r.holding;
    fs.forward = {
      startedAt: fs.version.adoptedAt,
      updatedAt: ref[total - 1].t,
      days: (total - from) / 24,
      net: r.ret,
      buyHold: buyAndHold(c.ind, cfg(), from, total),
      trades: r.trades.length,
      maxDD: r.maxDD,
      fees: r.fees,
    };
  }
  box.state.lastForwardAt = Date.now();
}

function evaluate() {
  for (const f of FAMILIES) {
    const fs = box.state.families[f];
    const before = fs.status;
    const wf = fs.walkForward;
    const fw = fs.forward;
    if (!fs.version) {
      fs.status = "waiting";
    } else {
      const earned = !!wf?.passed && !!fw && fw.days >= FORWARD_MIN_DAYS && fw.net > 0 && fw.trades >= 5 && fw.maxDD <= 0.15;
      const broke = before === "promoted" && (!wf?.passed || (fw !== null && fw.net < -0.03));
      fs.status = earned && !broke ? "promoted" : "forward-testing";
    }
    if (before !== "promoted" && fs.status === "promoted") journal("promote", `${FAMILY_LABEL[f]} PROMOTED: walk-forward passed and ${fw!.days.toFixed(0)} days of forward testing are profitable (${(fw!.net * 100).toFixed(1)}% after fees). Eligible for live; real money still needs your ENABLE LIVE.`);
    if (before === "promoted" && fs.status !== "promoted") journal("demote", `${FAMILY_LABEL[f]} DEMOTED: the evidence no longer supports it (walk-forward ${wf?.passed ? "passed" : "failed"}, forward ${fw ? (fw.net * 100).toFixed(1) + "%" : "n/a"}).`);
  }
  const promoted = FAMILIES.filter((f) => box.state.families[f].status === "promoted").sort((a, b) => (box.state.families[b].forward?.net ?? 0) - (box.state.families[a].forward?.net ?? 0));
  const prev = box.state.champion;
  box.state.champion = promoted[0] ?? null;
  if (prev !== box.state.champion) journal("info", box.state.champion ? `champion is now ${FAMILY_LABEL[box.state.champion]}` : "no champion: the desk stays in cash / paper");
}

// ───────────────────────── cycles ─────────────────────────

let busy = false;
export const deskBusy = () => busy;

/** the daily research cycle: walk-forward, re-tune, adopt, forward test, promote/demote */
export async function researchCycle(reason = "scheduled"): Promise<void> {
  if (busy) return;
  busy = true;
  box.state.running = true;
  journal("research", `research cycle started (${reason})`);
  try {
    const c = await ensureData(true);
    const total = totalBars(c);
    const asOf = lastBarT(c);
    for (const f of FAMILIES) {
      box.state.phase = `walk-forward: ${FAMILY_LABEL[f]}`;
      const wf = await walkFamily(f, c.ind, total);
      const fs = box.state.families[f];
      fs.walkForward = {
        ranAt: Date.now(),
        net: wf.compounded,
        buyHold: wf.bhCompounded,
        positive: wf.positiveWindows,
        windows: wf.windows.length,
        worstWindow: wf.worstWindow,
        worstDD: wf.worstDD,
        trades: wf.totalTrades,
        passed: wf.passed,
        reasons: wf.reasons,
      };
      journal("research", `${FAMILY_LABEL[f]}: walk-forward ${(wf.compounded * 100).toFixed(1)}% after fees vs buy&hold ${(wf.bhCompounded * 100).toFixed(1)}% · ${wf.positiveWindows}/${wf.windows.length} windows profitable · ${wf.passed ? "PASS" : "FAIL (" + wf.reasons[0] + ")"}`);

      // re-tune on the latest training window; adopt only with a clear improvement (or if there is no version yet)
      box.state.phase = `re-tuning: ${FAMILY_LABEL[f]}`;
      const best = await bestFamily(f, c.ind, total - TRAIN, total);
      if (!best) continue;
      if (!fs.version) {
        fs.version = { n: 1, params: best.p, adoptedAt: asOf, reason: `first version: best on the last ${TRAIN / 24} days (${(best.ret * 100).toFixed(1)}%)` };
        journal("adopt", `${FAMILY_LABEL[f]}: v1 adopted ${JSON.stringify(best.p)} — forward test starts now`);
      } else if ((asOf - fs.version.adoptedAt) / 86_400_000 >= ADOPT_MIN_AGE_DAYS && JSON.stringify(best.p) !== JSON.stringify(fs.version.params)) {
        const cur = simFamily(f, fs.version.params, c.ind, total - TRAIN, total).ret;
        if (best.ret - cur >= ADOPT_MARGIN) {
          fs.version = { n: fs.version.n + 1, params: best.p, adoptedAt: asOf, reason: `beat v${fs.version.n} by ${((best.ret - cur) * 100).toFixed(1)}% on the latest ${TRAIN / 24} days` };
          fs.forward = null;
          fs.status = "forward-testing";
          journal("adopt", `${FAMILY_LABEL[f]}: v${fs.version.n} adopted ${JSON.stringify(best.p)} (${fs.version.reason}) — forward test restarts`);
        }
      }
    }
    box.state.phase = "forward-testing adopted versions";
    forwardUpdate(c);
    evaluate();
    box.state.lastResearchAt = Date.now();
    journal("research", "research cycle finished");
  } catch (e) {
    journal("error", `research cycle failed: ${e instanceof Error ? e.message : "error"}`);
  } finally {
    box.state.running = false;
    box.state.phase = "idle";
    busy = false;
    await persist();
  }
}

/** hourly: pull the newest candles, extend every forward test, re-judge promotions */
export async function forwardCycle(): Promise<void> {
  if (busy) return;
  busy = true;
  box.state.running = true;
  try {
    const c = await ensureData(!box.cache);
    forwardUpdate(c);
    evaluate();
  } catch (e) {
    journal("error", `forward update failed: ${e instanceof Error ? e.message : "error"}`);
  } finally {
    box.state.running = false;
    box.state.phase = "idle";
    busy = false;
    await persist();
  }
}

async function deskTick() {
  if (busy) return;
  const now = Date.now();
  if (!box.state.lastResearchAt || now - box.state.lastResearchAt >= RESEARCH_EVERY_MS) await researchCycle("scheduled");
  else if (now - box.state.lastForwardAt >= FORWARD_EVERY_MS) await forwardCycle();
}

export const deskAutorun = () => process.env.DESK_AUTORUN === "true" || (process.env.NODE_ENV === "production" && process.env.DESK_AUTORUN !== "false");

/** start the background loop once per process (checks every minute, works on its own schedule) */
export async function startDesk(): Promise<void> {
  await loadDesk();
  if (box.timer || !deskAutorun()) return;
  box.timer = setInterval(() => void deskTick().catch(() => undefined), 60_000);
  setTimeout(() => void deskTick().catch(() => undefined), 20_000);
}

// test hooks (used by the verification scripts, harmless in production)
export const _deskState = () => box.state;
export const _evaluateDesk = evaluate;
