// ─── Engine orchestrator: 6-agent pipeline with hard handoffs ───
// Singleton on globalThis so Next.js hot reloads don't duplicate the loop.
import { db } from "@/lib/db";
import {
  AUTOTUNE_EVERY,
  SIGNAL_BASE_WEIGHTS,
  SIGNAL_LABELS,
  freshBrain,
  generateLessons,
  learnFromTrade,
  stratParams,
  type BrainCore,
} from "./brain";
import { dataSourceBadge, fetchKlines, fetchMajors, fetchMemecoins } from "./market";
import { computeTargets, runAnalyst, runFilter } from "./rules";
import { checkEntrySignal, pickStrategy } from "./strategies";
import type {
  AgentState,
  BotSnapshot,
  LogLine,
  MarketFocus,
  Position,
  Regime,
  ScoutPair,
  StrategyId,
  VolState,
} from "./types";
import { clamp, fmtUsd } from "./indicators";
import { TG_DEFAULT_EVENTS, tgConfigure, tgConfig, tgEnabledFor, tgNotify, type TgEventsConfig } from "./telegram";
import type { BrainView } from "./backtest";

const TICK_MS = 3000;
const ENGINE_VERSION = 9; // bump to force engine rebuild on code change (dev HMR)

interface Settings {
  mode: "paper" | "live";
  running: boolean;
  marketFocus: MarketFocus;
  startBalance: number;
  balance: number;
  maxPositionPct: number;
  stopLossPct: number;
  tp1Pct: number;
  tp2Pct: number;
  trailActivationPct: number;
  trailGapPct: number;
  maxPositions: number;
  scoreThreshold: number;
  maxHoldMinutes: number;
  dailyLossCapPct: number;
  dailyProfitTargetPct: number;
  closeOnTarget: boolean;
  weeklyProfitTargetPct: number;
  weeklyLossCapPct: number;
}

class Engine {
  version = ENGINE_VERSION;
  settings: Settings = {
    mode: "paper",
    running: true,
    marketFocus: "both",
    startBalance: 1000,
    balance: 1000,
    maxPositionPct: 8,
    stopLossPct: 8,
    tp1Pct: 8,
    tp2Pct: 20,
    trailActivationPct: 12,
    trailGapPct: 15,
    maxPositions: 5,
    scoreThreshold: 70,
    maxHoldMinutes: 360,
    dailyLossCapPct: 15,
    dailyProfitTargetPct: 4,
    closeOnTarget: true,
    weeklyProfitTargetPct: 15,
    weeklyLossCapPct: 25,
  };

  brain: BrainCore = freshBrain();
  positions: Position[] = [];
  logs: LogLine[] = [];
  logSeq = 0;
  dbLogPending: { level: string; text: string }[] = [];

  seen = 0;
  killed = 0;
  scored = 0;
  tradeCount = 0;
  wins = 0;
  losses = 0;
  bestTrade = 0;
  worstTrade = 0;
  cycle = 0;
  dayStartBalance = 1000;
  halted = false;
  // ── target manager state ──
  dayKey = "";
  dayPnl = 0;
  weekKey = "";
  weekPnl = 0;
  weekStartBalance = 1000;
  targetHit = false;
  weekTargetHit = false;
  weekHalted = false;
  tgEvents: TgEventsConfig = { ...TG_DEFAULT_EVENTS };

  regime: Regime = "ranging";
  volatility: VolState = "normal";

  universe: ScoutPair[] = [];
  queue: ScoutPair[] = [];
  universeAt = 0;

  phase = "BOOT";
  phaseDetail = "waking agents up";
  filterView: BotSnapshot["filterView"] = null;
  analystView: BotSnapshot["analystView"] = null;
  filterProgress: { pair: ScoutPair; revealed: number; rules: ReturnType<typeof runFilter>["rules"] } | null = null;
  pendingAnalyst: ScoutPair | null = null;
  closedPreview: BotSnapshot["closedPreview"] = null;

  startedAt = Date.now();
  timer: ReturnType<typeof setInterval> | null = null;
  tickN = 0;
  ticking = false; // tick mutex — never let overlapping async ticks race the target manager
  booted = false;

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.booted = false;
  }

  // ───────────── lifecycle ─────────────

  async init() {
    if (this.booted) return;
    this.booted = true;
    try {
      const s = await db.setting.upsert({ where: { id: "main" }, update: {}, create: { id: "main" } });
      this.settings = {
        mode: s.mode === "live" ? "paper" : "paper", // live gated in UI; force paper boot
        running: s.running,
        marketFocus: (["majors", "memecoins", "both"].includes(s.marketFocus) ? s.marketFocus : "both") as MarketFocus,
        startBalance: s.startBalance,
        balance: s.balance,
        maxPositionPct: s.maxPositionPct,
        stopLossPct: s.stopLossPct,
        tp1Pct: s.tp1Pct,
        tp2Pct: s.tp2Pct,
        trailActivationPct: s.trailActivationPct,
        trailGapPct: s.trailGapPct,
        maxPositions: s.maxPositions,
        scoreThreshold: s.scoreThreshold,
        maxHoldMinutes: s.maxHoldMinutes,
        dailyLossCapPct: s.dailyLossCapPct,
        dailyProfitTargetPct: s.dailyProfitTargetPct,
        closeOnTarget: s.closeOnTarget,
        weeklyProfitTargetPct: s.weeklyProfitTargetPct,
        weeklyLossCapPct: s.weeklyLossCapPct,
      };
      // telegram alert config — token/chat never leave the server
      let tgEvents = { ...TG_DEFAULT_EVENTS };
      try {
        const parsed = JSON.parse(s.tgEventsJson) as Partial<TgEventsConfig>;
        if (parsed && typeof parsed === "object") tgEvents = { ...tgEvents, ...parsed };
      } catch { /* defaults */ }
      this.tgEvents = tgEvents;
      tgConfigure({ token: s.tgToken, chatId: s.tgChatId, enabled: s.tgEnabled, events: tgEvents });
      this.tgSavedToken = s.tgToken;
      this.tgSavedChatId = s.tgChatId;
      this.brain.scoreThreshold = s.scoreThreshold;
      // target manager: restore day/week bookkeeping (rollover if stale)
      this.dayKey = s.dayKey;
      this.dayPnl = s.dayPnl;
      this.dayStartBalance = s.dayStartBalance || s.balance;
      this.weekKey = s.weekKey;
      this.weekPnl = s.weekPnl;
      this.weekStartBalance = s.weekStartBalance || s.balance;
      this.targetHit = s.targetHit; // booking survives restarts until the day rolls over
      this.weekTargetHit = s.weekTargetHit;
      this.weekHalted = s.weekHalted;
      this.rolloverIfNeeded();

      const bs = await db.brainState.findUnique({ where: { id: "main" } });
      if (bs) {
        try {
          const w = JSON.parse(bs.weightsJson) as BrainCore["weights"];
          if (w.momentum !== undefined) this.brain.weights = w;
        } catch { /* fresh */ }
        this.brain.scoreThreshold = bs.scoreThreshold;
        this.brain.autotuneCount = bs.autotuneCount;
        this.brain.closedSinceAutotune = bs.closedSinceAutotune;
        try {
          const sw = JSON.parse(bs.signalWeightsJson) as number[];
          if (Array.isArray(sw) && sw.length === 6 && sw.every((v) => isFinite(v))) this.brain.signalWeights = sw;
        } catch { /* fresh */ }
        try {
          const sp = JSON.parse(bs.stratParamsJson) as Record<string, { holdMult: number; stopMult: number; tpMult: number }>;
          for (const k of ["momentum", "meanrev", "breakout"] as StrategyId[]) {
            const p = sp[k];
            if (p && isFinite(p.holdMult) && isFinite(p.stopMult) && isFinite(p.tpMult)) {
              this.brain.strategies[k].holdMult = p.holdMult;
              this.brain.strategies[k].stopMult = p.stopMult;
              this.brain.strategies[k].tpMult = p.tpMult;
            }
          }
        } catch { /* fresh */ }
      }

      // rebuild brain + run-stats history from closed trades — self-improvement survives restarts
      await this.restoreHistoryFromDb();

      // reopen persisted open trades
      const openTrades = await db.trade.findMany({ where: { status: "open" } });
      for (const t of openTrades) {
        this.positions.push({
          id: t.id,
          symbol: t.symbol,
          base: t.name || t.symbol,
          name: t.name,
          market: t.market as "majors" | "memecoin",
          strategy: t.strategy as StrategyId,
          entryPrice: t.entryPrice,
          price: t.entryPrice,
          qty: t.qty,
          sizeUsd: t.sizeUsd,
          score: t.score,
          regime: t.regime as Regime,
          stopLoss: t.stopLoss,
          tp1: t.tp1,
          tp2: t.tp2,
          trailActive: t.trailActive,
          trailPeak: t.peakPrice,
          openedAt: t.openedAt.getTime(),
          pnlPct: 0,
          pnlUsd: 0,
          series: [],
          tp1Booked: t.realizedPnl !== 0,
          entryScores: restoreEntryScores(t.featuresJson),
          source: "restored",
        });
      }

      this.startedAt = Date.now();
      this.log("BOOT", `engine booted · mode ${this.settings.mode} · balance $${this.settings.balance.toFixed(2)}`);
      if (this.positions.length) this.log("INFO", `restored ${this.positions.length} open position(s) from db`);

      this.timer = setInterval(() => {
        void this.tick().catch(() => undefined);
      }, TICK_MS);
    } catch {
      this.booted = true;
      this.timer = setInterval(() => {
        void this.tick().catch(() => undefined);
      }, TICK_MS);
    }
  }

  async persistSettings() {
    try {
      await db.setting.upsert({
        where: { id: "main" },
        update: {
          mode: this.settings.mode,
          running: this.settings.running,
          marketFocus: this.settings.marketFocus,
          startBalance: this.settings.startBalance,
          balance: this.settings.balance,
          maxPositionPct: this.settings.maxPositionPct,
          stopLossPct: this.settings.stopLossPct,
          tp1Pct: this.settings.tp1Pct,
          tp2Pct: this.settings.tp2Pct,
          trailActivationPct: this.settings.trailActivationPct,
          trailGapPct: this.settings.trailGapPct,
          maxPositions: this.settings.maxPositions,
          scoreThreshold: this.brain.scoreThreshold,
          maxHoldMinutes: this.settings.maxHoldMinutes,
          dailyLossCapPct: this.settings.dailyLossCapPct,
          dailyProfitTargetPct: this.settings.dailyProfitTargetPct,
          closeOnTarget: this.settings.closeOnTarget,
          weeklyProfitTargetPct: this.settings.weeklyProfitTargetPct,
          weeklyLossCapPct: this.settings.weeklyLossCapPct,
          dayKey: this.dayKey,
          dayPnl: this.dayPnl,
          weekKey: this.weekKey,
          weekPnl: this.weekPnl,
          dayStartBalance: this.dayStartBalance,
          targetHit: this.targetHit,
          weekStartBalance: this.weekStartBalance,
          weekTargetHit: this.weekTargetHit,
          weekHalted: this.weekHalted,
        },
        create: { id: "main" },
      });
    } catch { /* non-fatal */ }
  }

  log(level: string, text: string) {
    this.logSeq += 1;
    const line: LogLine = { n: this.logSeq, level, text, ts: Date.now() };
    this.logs.push(line);
    if (this.logs.length > 80) this.logs.shift();
    this.dbLogPending.push({ level, text });
  }

  async flushLogs() {
    if (this.dbLogPending.length === 0) return;
    const batch = this.dbLogPending.splice(0, this.dbLogPending.length);
    try {
      await db.logEvent.createMany({ data: batch.map((b) => ({ level: b.level, text: b.text })) });
      // trim
      const cnt = await db.logEvent.count();
      if (cnt > 700) {
        const old = await db.logEvent.findMany({ orderBy: { id: "asc" }, take: cnt - 600, select: { id: true } });
        await db.logEvent.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
      }
    } catch { /* drop */ }
  }

  // ───────────── market / universe ─────────────

  /** UTC day key "2026-11-08" · ISO week key "2026-W45" */
  timeKeys(): { day: string; week: string } {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const jan1 = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((now.getTime() - jan1.getTime()) / 86_400_000 + jan1.getUTCDay() + 1) / 7);
    return { day, week: `${now.getUTCFullYear()}-W${String(week).padStart(2, "0")}` };
  }

  /** new UTC day / week → reset bookkeeping · daily/weekly targets auto-rearm · loss-cap halts need manual resume */
  rolloverIfNeeded() {
    const { day, week } = this.timeKeys();
    if (this.dayKey !== day) {
      const wasTarget = this.targetHit;
      this.dayKey = day;
      this.dayPnl = 0;
      this.dayStartBalance = this.settings.balance;
      this.targetHit = false;
      if (wasTarget) this.log("TARGET", `new UTC day ${day} — daily profit target re-armed · hunting again`);
    }
    if (this.weekKey !== week) {
      const wasWeekTarget = this.weekTargetHit;
      const wasWeekHalt = this.weekHalted;
      this.weekKey = week;
      this.weekPnl = 0;
      this.weekStartBalance = this.settings.balance;
      this.weekTargetHit = false;
      this.weekHalted = false;
      if (wasWeekTarget) this.log("TARGET", `new week ${week} — weekly profit target re-armed · hunting again`);
      if (wasWeekHalt) this.log("RISK", `new week ${week} — weekly loss-cap breaker cleared automatically`);
    }
  }

  /** target manager — book profit at target, book loss at cap, both close everything (daily + weekly) */
  async checkTargets() {
    this.rolloverIfNeeded();
    const dayPnlPct = this.dayStartBalance > 0 ? (this.dayPnl / this.dayStartBalance) * 100 : 0;
    const weekPnlPct = this.weekStartBalance > 0 ? (this.weekPnl / this.weekStartBalance) * 100 : 0;

    // daily profit target — book it, lock it
    if (!this.targetHit && this.settings.dailyProfitTargetPct > 0 && dayPnlPct >= this.settings.dailyProfitTargetPct) {
      this.targetHit = true;
      this.log(
        "TARGET",
        `daily profit target HIT · day P&L ${dayPnlPct >= 0 ? "+" : ""}${dayPnlPct.toFixed(2)}% ≥ ${this.settings.dailyProfitTargetPct}% — booking ${fmtUsd(this.dayPnl)}${this.settings.closeOnTarget ? " · closing all opens to lock it" : ""}`
      );
      if (this.settings.closeOnTarget && this.positions.length > 0) {
        await this.closeAll("target");
      }
      if (tgEnabledFor("target")) {
        tgNotify("target", "🎯 Daily profit target booked", `day P&L ${dayPnlPct >= 0 ? "+" : ""}${dayPnlPct.toFixed(2)}% (${fmtUsd(this.dayPnl)}) ≥ target ${this.settings.dailyProfitTargetPct}%
${this.settings.closeOnTarget ? "all opens closed · profit locked" : "new entries stopped"}
balance ${fmtUsd(this.settings.balance)} · re-arms next UTC day`);
      }
    }

    // daily loss cap — circuit breaker, book the loss
    if (!this.halted && this.settings.dailyLossCapPct > 0 && dayPnlPct <= -this.settings.dailyLossCapPct) {
      this.halted = true;
      this.log(
        "RISK",
        `daily loss cap HIT · day P&L ${dayPnlPct.toFixed(2)}% ≤ −${this.settings.dailyLossCapPct}% — circuit breaker, closing all opens, new entries halted`
      );
      if (this.positions.length > 0) await this.closeAll("circuit");
      if (tgEnabledFor("breaker")) {
        tgNotify("breaker", "🛑 Daily loss cap — circuit breaker", `day P&L ${dayPnlPct.toFixed(2)}% ≤ −${this.settings.dailyLossCapPct}%
all opens closed · new entries halted until you resume
balance ${fmtUsd(this.settings.balance)}`);
      }
    }

    // weekly profit target — book the week, flat until next UTC week
    if (!this.weekTargetHit && this.settings.weeklyProfitTargetPct > 0 && weekPnlPct >= this.settings.weeklyProfitTargetPct) {
      this.weekTargetHit = true;
      this.log(
        "TARGET",
        `weekly profit target HIT · week P&L ${weekPnlPct >= 0 ? "+" : ""}${weekPnlPct.toFixed(2)}% ≥ ${this.settings.weeklyProfitTargetPct}% — booking ${fmtUsd(this.weekPnl)} · closing all opens, flat until next UTC week`
      );
      if (this.positions.length > 0) await this.closeAll("week-target");
      if (tgEnabledFor("target")) {
        tgNotify("target", "🏆 Weekly profit target booked", `week P&L ${weekPnlPct >= 0 ? "+" : ""}${weekPnlPct.toFixed(2)}% (${fmtUsd(this.weekPnl)}) ≥ weekly target ${this.settings.weeklyProfitTargetPct}%
all opens closed · flat until next UTC week
balance ${fmtUsd(this.settings.balance)}`);
      }
    }

    // weekly loss cap — breaker, flat until next UTC week (auto-clears on rollover)
    if (!this.weekHalted && this.settings.weeklyLossCapPct > 0 && weekPnlPct <= -this.settings.weeklyLossCapPct) {
      this.weekHalted = true;
      this.log(
        "RISK",
        `weekly loss cap HIT · week P&L ${weekPnlPct.toFixed(2)}% ≤ −${this.settings.weeklyLossCapPct}% — weekly breaker, closing all opens, flat until next UTC week`
      );
      if (this.positions.length > 0) await this.closeAll("week-circuit");
      if (tgEnabledFor("breaker")) {
        tgNotify("breaker", "🛑 Weekly loss cap — circuit breaker", `week P&L ${weekPnlPct.toFixed(2)}% ≤ −${this.settings.weeklyLossCapPct}%
all opens closed · flat until next UTC week
balance ${fmtUsd(this.settings.balance)}`);
      }
    }
  }

  /** close every open position at market (target lock-in / circuit breaker) */
  async closeAll(reason: string) {
    const n = this.positions.length;
    for (const pos of [...this.positions]) {
      await this.closePosition(pos, pos.price, reason);
    }
    if (n > 0) this.log("INFO", `${n} position(s) force-closed · reason ${reason}`);
  }

  async refreshUniverse() {
    const { rows: majors, live } = await fetchMajors();
    const { rows: memes } = await fetchMemecoins();
    this.universe = [...majors, ...memes];
    if (live) this.seen = Math.max(this.seen, majors.length + memes.length);
  }

  buildQueue() {
    const focus = this.settings.marketFocus;
    let pool = this.universe;
    if (focus === "majors") pool = pool.filter((p) => p.market === "majors");
    if (focus === "memecoins") pool = pool.filter((p) => p.market === "memecoin");
    // shuffle but keep deterministic-ish rotation
    const q = [...pool];
    for (let i = q.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [q[i], q[j]] = [q[j], q[i]];
    }
    this.queue = q;
    this.cycle += 1;
  }

  // ───────────── main loop ─────────────

  async tick() {
    if (this.ticking) return; // previous tick still in flight — skip
    this.ticking = true;
    try {
      await this.tickInner();
    } catch {
      // keep loop alive
    } finally {
      this.ticking = false;
    }
  }

  private async tickInner() {
    this.tickN += 1;
    if (!this.settings.running) {
      this.phase = "PAUSED";
      this.phaseDetail = "bot paused by operator";
      return;
    }
    try {
      // universe refresh every 15 ticks (~45s)
      if (Date.now() - this.universeAt > 45_000 || this.universe.length === 0) {
        await this.refreshUniverse();
        this.universeAt = Date.now();
      }
      // regime every 20 ticks
      if (this.tickN % 20 === 1) await this.refreshRegime();

      await this.managePositions();
      await this.checkTargets(); // target manager — book profit / loss by targets (daily + weekly)

      const entriesBlocked = this.halted || this.targetHit || this.weekTargetHit || this.weekHalted;
      if (!entriesBlocked && this.positions.length < this.settings.maxPositions) {
        await this.pipeline();
      } else if (this.halted) {
        this.phase = "HALTED";
        this.phaseDetail = "daily loss cap — resume manually after review";
      } else if (this.weekHalted) {
        this.phase = "HALTED";
        this.phaseDetail = `weekly loss cap hit — flat until ${this.weekKey} rolls over`;
      } else if (this.targetHit) {
        this.phase = "BOOKED";
        this.phaseDetail = `daily target booked ${fmtUsd(this.dayPnl)} — resumes next UTC day`;
      } else if (this.weekTargetHit) {
        this.phase = "BOOKED";
        this.phaseDetail = `weekly target booked ${fmtUsd(this.weekPnl)} — resumes next UTC week`;
      } else {
        this.phase = "MANAGING";
        this.phaseDetail = `${this.positions.length} position(s) open · risk agent on watch`;
      }
      await this.flushLogs();
      if (this.tickN % 10 === 0) await this.persistSettings();
    } catch {
      // keep loop alive
    }
  }

  async refreshRegime() {
    try {
      const k = await fetchKlines("BTCUSDT", "majors");
      if (k.h1.length > 55) {
        const closes = k.h1.map((c) => c.c);
        const e20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const e50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
        const chg = ((closes[closes.length - 1] - closes[closes.length - 12]) / closes[closes.length - 12]) * 100;
        this.regime = e20 > e50 * 1.001 && chg > 0.3 ? "trending_up" : e20 < e50 * 0.999 && chg < -0.3 ? "trending_down" : "ranging";
        const range = Math.abs(chg);
        this.volatility = range > 2.5 ? "volatile" : range > 1 ? "normal" : "calm";
        this.brain.regime = this.regime;
        this.brain.volatility = this.volatility;
      }
    } catch { /* keep last */ }
  }

  // ───────────── pipeline: scout → filter → analyst → executor ─────────────

  async pipeline() {
    if (this.queue.length === 0) {
      this.buildQueue();
      this.phase = "SCANNING";
      this.phaseDetail = `SCOUT rebuilt watchlist · ${this.queue.length} pairs in rotation`;
      this.log("INFO", `scout: fresh rotation #${this.cycle} · ${this.queue.length} pairs queued`);
      return;
    }

    // continue an in-flight filter check (reveal 2 rules per tick)
    if (this.filterProgress) {
      const fp = this.filterProgress;
      fp.revealed = Math.min(fp.rules.length, fp.revealed + 2);
      this.filterView = {
        coin: fp.pair.base,
        rules: fp.rules.slice(0, fp.revealed),
        checkLine: `checking ${fp.pair.base} · rule ${Math.min(fp.revealed, fp.rules.length)}/${fp.rules.length}`,
        killed: this.killed,
      };
      this.phase = "FILTERING";
      this.phaseDetail = `FILTER · ${fp.pair.base} rule ${Math.min(fp.revealed, fp.rules.length)}/${fp.rules.length}`;

      if (fp.revealed >= fp.rules.length) {
        const res = runFilter(fp.pair);
        this.filterProgress = null;
        if (!res.passed) {
          this.killed += 1;
          const bad = res.rules[res.failedRuleIndex];
          this.log("KILL", `${fp.pair.base} ${bad.label} — ${bad.value} · killed`);
          this.filterView = { ...this.filterView, checkLine: `${fp.pair.base} killed · rule ${res.failedRuleIndex + 1}/8` };
        } else {
          this.log("PASS", `${fp.pair.base} passed 8/8 rules → analyst`);
          this.pendingAnalyst = fp.pair;
          this.analystView = null;
        }
      }
      return;
    }

    // analyst scoring in progress?
    if (this.pendingAnalyst) {
      await this.scoreCandidate(this.pendingAnalyst);
      this.pendingAnalyst = null;
      return;
    }

    // pop next candidate
    const cand = this.queue.shift();
    if (!cand) return;
    this.seen += 1;
    this.filterProgress = { pair: cand, revealed: 0, rules: runFilter(cand).rules };
    this.phase = "FILTERING";
    this.phaseDetail = `FILTER picked up ${cand.base}`;
  }

  async scoreCandidate(pair: ScoutPair) {
    this.phase = "SCORING";
    this.phaseDetail = `ANALYST scoring ${pair.base}`;
    const k = await fetchKlines(pair.symbol, pair.market);
    const threshold = this.brain.scoreThreshold;
    // research engine: learned signal weights decide what the score means
    const res = runAnalyst(pair, k, threshold, this.brain.signalWeights);
    this.scored += 1;
    const handoff = res.passed
      ? `${res.final} ≥ ${threshold} → handoff to EXECUTOR`
      : `${res.final} < ${threshold} → dropped`;
    this.analystView = {
      coin: pair.base,
      scores: res.scores,
      final: res.final,
      deciding: res.passed,
      handoff,
    };
    this.log(res.passed ? "SCORE" : "PASS", `${res.passed ? "SCORE" : "PASS"} ${pair.base} ${res.final}/${threshold} · analyst`);

    if (!res.passed) return;

    // ─── STRATEGIST (inside executor handoff) ───
    this.phase = "DECIDING";
    const decision = pickStrategy(this.regime, this.brain.weights);
    const sig = checkEntrySignal(decision.strategy, k);
    if (!sig.ok) {
      this.log("INFO", `${pair.base} ${decision.strategy} signal not ready · ${sig.detail}`);
      this.analystView = { ...this.analystView, deciding: false, handoff: `${res.final} passed · no ${decision.strategy} trigger` };
      return;
    }
    await this.openPosition(pair, decision.strategy, res.final, k, decision.reason, res.scores.map((x) => x.value));
  }

  // ───────────── EXECUTOR ─────────────

  async openPosition(
    pair: ScoutPair,
    strategy: StrategyId,
    score: number,
    k: Awaited<ReturnType<typeof fetchKlines>>,
    decisionReason = "",
    entryScores: number[] = []
  ) {
    // target manager wins: never enter while booked out / circuit-broken (daily or weekly)
    if (this.halted || this.targetHit || this.weekTargetHit || this.weekHalted) return;
    const conf = clamp(0.6 + (0.8 * (score - this.brain.scoreThreshold)) / 30, 0.6, 1.4);
    const sizePct = clamp(this.settings.maxPositionPct * conf * this.brain.sizeMultiplier, 1, 15);
    const sizeUsd = (this.settings.balance * sizePct) / 100;
    if (sizeUsd < 5) {
      this.log("INFO", `${pair.base} size $${sizeUsd.toFixed(2)} below min — skipped`);
      return;
    }
    const slip = pair.market === "majors" ? 0.0004 : 0.004;
    const entry = pair.price * (1 + slip);
    // brain-tuned per-strategy params shape the targets
    const sp = stratParams(this.brain, strategy);
    const t = computeTargets(entry, pair.market, k, { stopMult: sp.stopMult, tpMult: sp.tpMult });
    const holdMin = Math.max(5, Math.round(this.settings.maxHoldMinutes * sp.holdMult));
    const qty = sizeUsd / entry;

    try {
      const row = await db.trade.create({
        data: {
          symbol: pair.symbol,
          name: pair.base,
          market: pair.market,
          strategy,
          entryPrice: entry,
          sizeUsd,
          qty,
          score,
          regime: this.regime,
          stopLoss: t.stopLoss,
          tp1: t.tp1,
          tp2: t.tp2,
          status: "open",
          featuresJson: JSON.stringify({
            vol: this.volatility,
            threshold: this.brain.scoreThreshold,
            sizePct,
            holdMin,
            decisionReason,
            scores: entryScores,
            signalWeights: this.brain.signalWeights,
          }),
        },
      });
      this.positions.push({
        id: row.id,
        symbol: pair.symbol,
        base: pair.base,
        name: pair.name,
        market: pair.market,
        strategy,
        entryPrice: entry,
        price: entry,
        qty,
        sizeUsd,
        score,
        regime: this.regime,
        stopLoss: t.stopLoss,
        tp1: t.tp1,
        tp2: t.tp2,
        trailActive: false,
        trailPeak: entry,
        openedAt: Date.now(),
        pnlPct: 0,
        pnlUsd: 0,
        series: [{ t: Date.now(), p: entry }],
        tp1Booked: false,
        entryScores,
        source: pair.source,
      });
      this.tradeCount += 1;
      this.log(
        "ENTER",
        `${pair.base} ${strategy} · ${sizePct.toFixed(1)}% size ${fmtUsd(sizeUsd)} · score ${score} · stop −${((1 - t.stopLoss / entry) * 100).toFixed(1)}% set before entry`
      );
      if (decisionReason) this.log("EXEC", `${pair.base} strategy pick · ${decisionReason}`);
      this.phaseDetail = `EXECUTOR filled ${pair.base} ${fmtUsd(sizeUsd)} · stop + targets armed`;
    } catch { /* db fail — skip */ }
  }

  // ───────────── RISK agent ─────────────

  async managePositions() {
    if (this.positions.length === 0) return;
    const priceMap = await this.getPrices(this.positions.map((p) => p));
    const stillOpen: Position[] = [];
    for (const pos of this.positions) {
      const px = priceMap.get(pos.symbol) ?? pos.price;
      pos.price = px;
      pos.pnlPct = ((px - pos.entryPrice) / pos.entryPrice) * 100;
      // unrealized on the open part + realized already banked at TP1
      const openQty = pos.qty * (pos.tp1Booked ? 0.5 : 1);
      const unrealized = (px - pos.entryPrice) * openQty;
      const banked = pos.tp1Booked ? ((pos.tp1 - pos.entryPrice) * pos.qty) / 2 : 0;
      pos.pnlUsd = unrealized + banked;
      pos.series.push({ t: Date.now(), p: px });
      if (pos.series.length > 240) pos.series.shift();
      if (px > pos.trailPeak) pos.trailPeak = px;

      const close = await this.riskCheck(pos, px);
      if (!close) stillOpen.push(pos);
    }
    this.positions = stillOpen;
  }

  async riskCheck(pos: Position, px: number): Promise<boolean> {
    const trailStop = pos.trailActive ? pos.trailPeak * (1 - this.settings.trailGapPct / 100) : 0;
    // brain-tuned hold time per strategy
    const holdMin = Math.max(5, this.settings.maxHoldMinutes * this.brain.strategies[pos.strategy].holdMult);
    const heldMin = (Date.now() - pos.openedAt) / 60_000;

    let reason: string | null = null;
    if (pos.trailActive && px <= trailStop) reason = "trail";
    else if (px <= pos.stopLoss) reason = "stop";
    else if (px >= pos.tp2) reason = "tp2";
    else if (heldMin > holdMin) reason = "timeout";

    if (reason) {
      await this.closePosition(pos, px, reason);
      return true;
    }

    if (!pos.tp1Booked && px >= pos.tp1) {
      // book half at TP1, arm trailing on the runner
      const booked = ((pos.tp1 - pos.entryPrice) * pos.qty) / 2;
      this.settings.balance += booked;
      pos.tp1Booked = true;
      pos.trailActive = true;
      pos.trailPeak = px;
      this.log("TRAIL", `${pos.base} +12% zone hit · booked ½ ${fmtUsd(booked)} · trailing ${this.settings.trailGapPct}% under peak`);
      try {
        await db.trade.update({
          where: { id: pos.id },
          data: { realizedPnl: { increment: booked }, trailActive: true, peakPrice: px },
        });
      } catch { /* ok */ }
      await this.persistSettings();
    }
    return false;
  }

  async closePosition(pos: Position, px: number, reason: string) {
    const remainingQty = pos.qty * (pos.tp1Booked ? 0.5 : 1);
    const realized = (px - pos.entryPrice) * remainingQty + (pos.tp1Booked ? ((pos.tp1 - pos.entryPrice) * pos.qty) / 2 : 0);
    const pnlPct = ((px - pos.entryPrice) / pos.entryPrice) * 100;
    const plannedRiskPct = Math.abs(((pos.stopLoss - pos.entryPrice) / pos.entryPrice) * 100) || 8;
    const reward = clamp((reason === "stop" ? -plannedRiskPct : pnlPct) / plannedRiskPct, -1, 1);
    const won = realized >= 0;

    this.settings.balance += realized;
    // target manager: book realized P&L into today + this week
    this.rolloverIfNeeded();
    this.dayPnl += realized;
    this.weekPnl += realized;
    if (won) this.wins += 1;
    else this.losses += 1;
    this.bestTrade = Math.max(this.bestTrade, realized);
    this.worstTrade = Math.min(this.worstTrade, realized);

    const exitLabel =
      reason === "stop" ? "stop hit"
      : reason === "trail" ? "trail paid"
      : reason === "tp2" ? "TP2 booked"
      : reason === "target" ? "target lock-in"
      : reason === "circuit" ? "loss-cap breaker"
      : reason === "week-target" ? "weekly target lock-in"
      : reason === "week-circuit" ? "weekly loss-cap breaker"
      : reason === "manual" ? "manual close"
      : "timeout";
    const events = learnFromTrade(
      this.brain,
      pos.strategy,
      pos.regime,
      reward,
      realized,
      won,
      reason,
      pos.entryScores
    );
    this.log(won ? "WIN" : "LOSS", `${pos.base} ${won ? "+" : "–"}$${Math.abs(realized).toFixed(2)} · ${exitLabel} · day ${this.dayPnl >= 0 ? "+" : "–"}$${Math.abs(this.dayPnl).toFixed(2)}`);

    for (const ev of events) {
      const [lvl, ...rest] = ev.split(" ");
      this.log(lvl, rest.join(" "));
    }
    if (this.brain.lessons[0]) this.log("BRAIN", this.brain.lessons[0]);

    // telegram: trade close alert
    if (tgEnabledFor("trades")) {
      const pnlStr = `${won ? "+" : "–"}$${Math.abs(realized).toFixed(2)}`;
      tgNotify("trades", `${won ? "✅" : "❌"} ${pos.base} closed ${pnlStr}`,
`${pos.base} · ${pos.strategy} · ${exitLabel}
P&L ${pnlStr} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)
day ${this.dayPnl >= 0 ? "+" : "–"}$${Math.abs(this.dayPnl).toFixed(2)} · week ${this.weekPnl >= 0 ? "+" : "–"}$${Math.abs(this.weekPnl).toFixed(2)} · balance ${fmtUsd(this.settings.balance)}`);
    }
    // telegram: brain autotune cycles
    if (tgEnabledFor("brain")) {
      for (const ev of events) {
        if (ev.startsWith("AUTOTUNE") || ev.startsWith("PARAMS")) {
          tgNotify("brain", "🧠 Brain auto-tune", ev);
        }
      }
    }

    this.closedPreview = { base: pos.base, pnlUsd: realized, pnlPct, reason };

    try {
      await db.trade.update({
        where: { id: pos.id },
        data: {
          status: "closed",
          exitPrice: px,
          exitReason: reason,
          realizedPnl: realized,
          pnlPct,
          closedAt: new Date(),
        },
      });
      await db.brainState.upsert({
        where: { id: "main" },
        update: {
          weightsJson: JSON.stringify(this.brain.weights),
          lessonsJson: JSON.stringify(this.brain.lessons),
          regime: this.brain.regime,
          volatility: this.brain.volatility,
          scoreThreshold: this.brain.scoreThreshold,
          sizeMultiplier: this.brain.sizeMultiplier,
          autotuneCount: this.brain.autotuneCount,
          signalWeightsJson: JSON.stringify(this.brain.signalWeights),
          stratParamsJson: JSON.stringify(
            Object.fromEntries(
              (["momentum", "meanrev", "breakout"] as StrategyId[]).map((s) => [s, stratParams(this.brain, s)])
            )
          ),
          closedSinceAutotune: this.brain.closedSinceAutotune,
        },
        create: { id: "main", weightsJson: JSON.stringify(this.brain.weights) },
      });
    } catch { /* ok */ }
    await this.persistSettings();
  }

  async getPrices(positions: Position[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    const majorSyms = positions.filter((p) => p.market === "majors").map((p) => p.symbol);
    const memeSyms = positions.filter((p) => p.market === "memecoin").map((p) => p.symbol);
    if (majorSyms.length) {
      const { rows } = await fetchMajors();
      for (const r of rows) if (majorSyms.includes(r.symbol)) map.set(r.symbol, r.price);
    }
    if (memeSyms.length) {
      const { rows } = await fetchMemecoins();
      for (const r of rows) if (memeSyms.includes(r.symbol)) map.set(r.symbol, r.price);
    }
    return map;
  }

  // ───────────── controls ─────────────

  setRunning(r: boolean) {
    this.settings.running = r;
    this.log("INFO", r ? "bot resumed by operator" : "bot paused by operator");
    void this.persistSettings();
  }

  setFocus(f: MarketFocus) {
    this.settings.marketFocus = f;
    this.queue = [];
    this.log("INFO", `market focus → ${f}`);
    void this.persistSettings();
  }

  forceScan() {
    this.queue = [];
    this.filterProgress = null;
    this.pendingAnalyst = null;
    this.phase = "SCANNING";
    this.phaseDetail = "manual force-scan requested";
    this.log("INFO", "manual scan forced — scout rebuilding queue");
  }

  /** rebuild per-strategy stats, brain recent-window and run counters from closed trades */
  async restoreHistoryFromDb() {
    try {
      const closed = await db.trade.findMany({
        where: { status: "closed" },
        orderBy: { closedAt: "asc" },
        select: {
          strategy: true, regime: true, realizedPnl: true, pnlPct: true,
          entryPrice: true, stopLoss: true, exitReason: true, closedAt: true,
        },
      });
      if (closed.length === 0) return;
      for (const t of closed) {
        const s = t.strategy as StrategyId;
        const d = this.brain.strategies[s];
        if (!d) continue;
        d.trades += 1;
        d.pnl += t.realizedPnl;
        if (t.realizedPnl >= 0) d.wins += 1;
        else d.losses += 1;
        const plannedRiskPct = Math.abs(((t.stopLoss - t.entryPrice) / t.entryPrice) * 100) || 8;
        const reward = clamp((t.exitReason === "stop" ? -plannedRiskPct : t.pnlPct) / plannedRiskPct, -1, 1);
        d.last10.push(reward);
        if (d.last10.length > 10) d.last10.shift();
        d.lastReasons.push(t.exitReason ?? "manual");
        if (d.lastReasons.length > 8) d.lastReasons.shift();
        this.brain.recent.push({ strategy: s, regime: t.regime as Regime, reward });
        if (this.brain.recent.length > 12) this.brain.recent.shift();
        this.tradeCount += 1;
        if (t.realizedPnl >= 0) this.wins += 1;
        else this.losses += 1;
        this.bestTrade = Math.max(this.bestTrade, t.realizedPnl);
        this.worstTrade = Math.min(this.worstTrade, t.realizedPnl);
      }
      // re-normalize displayed weights from the persisted weightsJson (already loaded)
      this.brain.lessons = generateLessons(this.brain);
      this.log("BOOT", `brain restored from ${closed.length} closed trades · gate ${this.brain.scoreThreshold}`);
    } catch { /* fresh start */ }
  }

  async reset() {
    for (const p of this.positions) {
      try {
        await db.trade.update({
          where: { id: p.id },
          data: { status: "closed", exitPrice: p.price, exitReason: "manual", realizedPnl: 0, pnlPct: 0, closedAt: new Date() },
        });
      } catch { /* ok */ }
    }
    this.positions = [];
    this.brain = freshBrain();
    this.brain.scoreThreshold = 70;
    this.settings.balance = this.settings.startBalance;
    this.seen = 0; this.killed = 0; this.scored = 0;
    this.tradeCount = 0; this.wins = 0; this.losses = 0;
    this.bestTrade = 0; this.worstTrade = 0; this.cycle = 0;
    this.halted = false;
    this.weekHalted = false;
    this.weekTargetHit = false;
    this.dayStartBalance = this.settings.startBalance;
    this.weekStartBalance = this.settings.startBalance;
    this.dayKey = this.timeKeys().day;
    this.weekKey = this.timeKeys().week;
    this.dayPnl = 0;
    this.weekPnl = 0;
    this.targetHit = false;
    this.queue = [];
    this.filterProgress = null;
    this.pendingAnalyst = null;
    this.filterView = null;
    this.analystView = null;
    this.closedPreview = null;
    this.logSeq = 0;
    this.logs = [];
    this.log("BOOT", "hard reset · balance restored · brain wiped · all agents idle");
    try {
      await db.trade.deleteMany({});
      await db.logEvent.deleteMany({});
      await db.brainState.deleteMany({});
      await db.brainState.create({ data: { id: "main", weightsJson: JSON.stringify(this.brain.weights) } });
    } catch { /* ok */ }
    await this.persistSettings();
  }

  updateSettings(patch: Partial<Settings>) {
    Object.assign(this.settings, patch);
    this.log("INFO", `settings updated · ${Object.keys(patch).join(", ")}`);
    void this.persistSettings();
  }

  /** telegram config from the settings dialog — never echoed back to any client */
  updateTelegram(cfg: { token?: string; chatId?: string; enabled?: boolean; events?: Partial<TgEventsConfig> }) {
    if (typeof cfg.token === "string") this.tgSavedToken = cfg.token.trim();
    if (typeof cfg.chatId === "string") this.tgSavedChatId = cfg.chatId.trim();
    if (cfg.events) this.tgEvents = { ...this.tgEvents, ...cfg.events };
    tgConfigure({ token: this.tgSavedToken, chatId: this.tgSavedChatId, enabled: cfg.enabled, events: this.tgEvents });
    this.persistTelegram();
    const status = tgConfig();
    this.log("INFO", `telegram alerts ${status.enabled ? "ON" : "OFF"} · ${status.configured ? "bot connected" : "not configured"}`);
  }

  tgSavedToken = "";
  tgSavedChatId = "";

  async persistTelegram() {
    try {
      await db.setting.upsert({
        where: { id: "main" },
        update: {
          tgToken: this.tgSavedToken,
          tgChatId: this.tgSavedChatId,
          tgEnabled: tgConfig().enabled,
          tgEventsJson: JSON.stringify(this.tgEvents),
        },
        create: { id: "main" },
      });
    } catch { /* non-fatal */ }
  }

  /** backtest mode → live bot: import a trained brain (weights, gate, size, signal weights, params) */
  async importBrain(v: BrainView, source: string) {
    this.brain.weights = { ...v.weights };
    for (const k of ["momentum", "meanrev", "breakout"] as StrategyId[]) {
      const p = v.stratParams[k];
      if (p) {
        this.brain.strategies[k].weight = v.weights[k] ?? this.brain.strategies[k].weight;
        this.brain.strategies[k].holdMult = Math.max(0.55, Math.min(1.7, p.holdMult));
        this.brain.strategies[k].stopMult = Math.max(0.85, Math.min(1.35, p.stopMult));
        this.brain.strategies[k].tpMult = Math.max(0.8, Math.min(1.5, p.tpMult));
      }
    }
    this.brain.scoreThreshold = Math.round(Math.max(66, Math.min(82, v.scoreThreshold)));
    this.brain.sizeMultiplier = Math.max(0.5, Math.min(1.25, v.sizeMultiplier));
    if (Array.isArray(v.signalWeights) && v.signalWeights.length === 6) this.brain.signalWeights = [...v.signalWeights];
    this.brain.lessons = [`brain imported from ${source} · gate ${this.brain.scoreThreshold} · size ×${this.brain.sizeMultiplier.toFixed(2)}`, ...this.brain.lessons].slice(0, 6);
    this.log("BRAIN", `brain imported from ${source} · gate ${this.brain.scoreThreshold} · size ×${this.brain.sizeMultiplier.toFixed(2)} · weights ${Object.entries(this.brain.weights).map(([k, w]) => `${k} ${(w * 100).toFixed(0)}%`).join(" / ")}`);
    try {
      await db.brainState.upsert({
        where: { id: "main" },
        update: {
          weightsJson: JSON.stringify(this.brain.weights),
          lessonsJson: JSON.stringify(this.brain.lessons),
          scoreThreshold: this.brain.scoreThreshold,
          sizeMultiplier: this.brain.sizeMultiplier,
          signalWeightsJson: JSON.stringify(this.brain.signalWeights),
          stratParamsJson: JSON.stringify(
            Object.fromEntries((["momentum", "meanrev", "breakout"] as StrategyId[]).map((s) => [s, stratParams(this.brain, s)]))
          ),
        },
        create: { id: "main", weightsJson: JSON.stringify(this.brain.weights) },
      });
    } catch { /* non-fatal */ }
  }

  // ───────────── snapshot for UI ─────────────

  snapshot(): BotSnapshot {
    const equity: number[] = [this.settings.startBalance];
    // reconstruct rough equity curve from brain trade history is complex; use balance + opens
    equity.push(this.settings.balance);

    const agents: AgentState[] = [
      {
        id: "scout",
        name: "SCOUT",
        badge: "SCAN",
        desc: this.settings.marketFocus === "memecoins" ? "finds fresh pairs — DexScreener solana · mcap $250k–$15M" : this.settings.marketFocus === "majors" ? "watches 10 majors — Binance spot · 24h vol ≥ $50M" : "watches majors + fresh solana pairs — two feeds, one desk",
        status: this.phase === "SCANNING" ? "SCAN" : "LIVE",
        statusTone: "green",
        activity: `seen ${this.seen.toLocaleString()} → ${this.queue.length} queued`,
      },
      {
        id: "filter",
        name: "FILTER",
        badge: "CHECK",
        desc: "kills what fails the rules — 8 hard rules · one fail = killed",
        status: this.phase === "FILTERING" ? "CHECK" : "IDLE",
        statusTone: "red",
        activity: this.filterView ? `${this.filterView.checkLine}` : `killed ${this.killed} · said no to ${this.killRate()}%`,
      },
      {
        id: "analyst",
        name: "ANALYST",
        badge: this.analystView?.deciding ? "PASS" : "IDLE",
        desc: `scores what's left, 0–100 — only ${this.brain.scoreThreshold}+ gets through`,
        status: this.phase === "SCORING" ? "SCORING" : this.analystView?.deciding ? "HANDOFF" : "IDLE",
        statusTone: "purple",
        activity: this.analystView ? `last ${this.analystView.coin} ${this.analystView.final} · ${this.analystView.handoff}` : `scored ${this.scored} · gate ${this.brain.scoreThreshold}`,
      },
      {
        id: "executor",
        name: "EXECUTOR",
        badge: this.positions.length ? "LIVE" : "FLAT",
        desc: `places the trades — max ${this.settings.maxPositionPct}% of balance · brain-sized`,
        status: this.positions.length ? "LIVE" : "FLAT",
        statusTone: "green",
        activity: this.positions.length
          ? this.positions.map((p) => `${p.base} ${p.pnlPct >= 0 ? "+" : ""}${p.pnlPct.toFixed(1)}%`).join(" · ")
          : "waiting for a 70+ trigger",
      },
      {
        id: "risk",
        name: "RISK",
        badge: this.positions.some((p) => p.trailActive) ? "TRAIL" : "GUARD",
        desc: `stop set before entry · trails after +${this.settings.trailActivationPct}%`,
        status: this.positions.length ? "WATCH" : "IDLE",
        statusTone: "amber",
        activity: this.positions.length
          ? `${this.positions.filter((p) => p.trailActive).length} trailing · stop −${this.settings.stopLossPct}% · caps ${this.settings.dailyLossCapPct}%/day · ${this.settings.weeklyLossCapPct}%/week`
          : `targets +${this.settings.dailyProfitTargetPct}%/day · +${this.settings.weeklyProfitTargetPct}%/week · books both horizons`,
      },
      {
        id: "brain",
        name: "BRAIN",
        badge: "AI",
        desc: "self-improving core — strategies · research signals · params, all auto",
        status: "THINK",
        statusTone: "purple",
        activity: `regime ${this.regime.replace("trending_", "trend ")} · gate ${this.brain.scoreThreshold} · autotune in ${AUTOTUNE_EVERY - this.brain.closedSinceAutotune}`,
      },
      {
        id: "logger",
        name: "LOGGER",
        badge: "WRITE",
        desc: "writes everything down — sqlite + live tail",
        status: "WRITE",
        statusTone: "blue",
        activity: `line #${String(this.logSeq).padStart(3, "0")} · ${this.phase.toLowerCase()}`,
      },
      {
        id: "you",
        name: "YOU",
        badge: this.settings.running ? "FREE" : "DRIVING",
        desc: this.settings.running ? "one toggle — the desk runs itself" : "you paused the desk",
        status: this.settings.running ? "CHILL" : "PAUSED",
        statusTone: "dim",
        activity: this.settings.running ? "no coin picked by hand · ever" : "press resume to hand back control",
      },
    ];

    const flow = [
      { id: "scout", label: "SCOUT", count: `${this.seen.toLocaleString()} seen`, tone: "green", active: this.phase === "SCANNING" },
      { id: "filter", label: "FILTER", count: `${this.killed.toLocaleString()} killed`, tone: "red", active: this.phase === "FILTERING" },
      { id: "analyst", label: "ANALYST", count: `${this.scored} scored`, tone: "purple", active: this.phase === "SCORING" },
      { id: "executor", label: "EXECUTOR", count: `${this.tradeCount} trades`, tone: "green", active: this.phase === "DECIDING" },
      { id: "risk", label: "RISK", count: `${this.wins + this.losses} closed`, tone: "amber", active: this.positions.length > 0 },
      { id: "logger", label: "LOGGER", count: `#${String(this.logSeq).padStart(3, "0")}`, tone: "blue", active: true },
    ];

    const ticker = this.universe.slice(0, 18).map((p) => ({
      base: p.base,
      sub:
        p.market === "majors"
          ? `${p.change24h >= 0 ? "+" : ""}${p.change24h.toFixed(1)}% · 24h`
          : `${p.ageHours < 1 ? `${Math.round(p.ageHours * 60)}m` : `${p.ageHours.toFixed(0)}h`} old · ${fmtUsd(p.mcap)}`,
      tone: p.change24h >= 0 ? "up" : "down",
    }));

    const openMain = this.positions[0] ?? null;

    return {
      booted: true,
      running: this.settings.running,
      mode: this.settings.mode,
      dataSource: dataSourceBadge(),
      marketFocus: this.settings.marketFocus,
      startedAt: this.startedAt,
      now: Date.now(),
      uptimeMs: Date.now() - this.startedAt,
      phase: this.halted ? "HALTED" : this.targetHit ? "BOOKED" : this.phase,
      phaseDetail: this.halted
        ? `daily loss cap — resume manually after review`
        : this.targetHit
          ? `daily target booked ${fmtUsd(this.dayPnl)} — auto-resumes next UTC day`
          : this.phaseDetail,
      currentStageLine: this.stageLine(),
      agents,
      ticker,
      flow,
      filterView: this.filterView,
      analystView: this.analystView,
      position: openMain,
      closedPreview: this.closedPreview,
      targets: {
        dailyProfitTargetPct: this.settings.dailyProfitTargetPct,
        dailyLossCapPct: this.settings.dailyLossCapPct,
        closeOnTarget: this.settings.closeOnTarget,
        dayPnl: this.dayPnl,
        dayPnlPct: this.dayStartBalance > 0 ? (this.dayPnl / this.dayStartBalance) * 100 : 0,
        dayStartBalance: this.dayStartBalance,
        weekPnl: this.weekPnl,
        dayKey: this.dayKey,
        weekKey: this.weekKey,
        targetHit: this.targetHit,
        lossCapped: this.halted,
        progressPct: this.targetProgress(),
        targetUsd: (this.dayStartBalance * this.settings.dailyProfitTargetPct) / 100,
        capUsd: (this.dayStartBalance * this.settings.dailyLossCapPct) / 100,
        weeklyProfitTargetPct: this.settings.weeklyProfitTargetPct,
        weeklyLossCapPct: this.settings.weeklyLossCapPct,
        weekPnlPct: this.weekStartBalance > 0 ? (this.weekPnl / this.weekStartBalance) * 100 : 0,
        weekStartBalance: this.weekStartBalance,
        weekTargetUsd: (this.weekStartBalance * this.settings.weeklyProfitTargetPct) / 100,
        weekCapUsd: (this.weekStartBalance * this.settings.weeklyLossCapPct) / 100,
        weekTargetHit: this.weekTargetHit,
        weekLossCapped: this.weekHalted,
        weekProgressPct: this.weekProgress(),
      },
      tg: (() => {
        const c = tgConfig();
        return { enabled: c.enabled, configured: c.configured, masked: c.masked, sentCount: c.sentCount, lastError: c.lastError };
      })(),
      stats: {
        seen: this.seen,
        killed: this.killed,
        scored: this.scored,
        trades: this.tradeCount,
        wins: this.wins,
        losses: this.losses,
        bestTrade: this.bestTrade,
        worstTrade: this.worstTrade,
        balance: this.settings.balance,
        startBalance: this.settings.startBalance,
        openPositions: this.positions.length,
        cycle: this.cycle,
      },
      brain: {
        weights: this.brain.weights,
        strategies: this.brain.strategies,
        lessons: this.brain.lessons,
        regime: this.brain.regime,
        volatility: this.brain.volatility,
        scoreThreshold: this.brain.scoreThreshold,
        sizeMultiplier: this.brain.sizeMultiplier,
        autotuneCount: this.brain.autotuneCount,
        equityCurve: this.equityCurve(),
        signalWeights: SIGNAL_LABELS.map((label, i) => ({
          label,
          base: SIGNAL_BASE_WEIGHTS[i],
          now: this.brain.signalWeights[i],
        })),
        nextAutotuneIn: Math.max(0, AUTOTUNE_EVERY - this.brain.closedSinceAutotune),
        autotuneEvery: AUTOTUNE_EVERY,
      },
      logs: this.logs.slice(-40).reverse(),
      settings: {
        balance: this.settings.balance,
        maxPositionPct: this.settings.maxPositionPct,
        stopLossPct: this.settings.stopLossPct,
        tp1Pct: this.settings.tp1Pct,
        tp2Pct: this.settings.tp2Pct,
        trailActivationPct: this.settings.trailActivationPct,
        trailGapPct: this.settings.trailGapPct,
        maxPositions: this.settings.maxPositions,
        maxHoldMinutes: this.settings.maxHoldMinutes,
        dailyLossCapPct: this.settings.dailyLossCapPct,
        dailyProfitTargetPct: this.settings.dailyProfitTargetPct,
        weeklyProfitTargetPct: this.settings.weeklyProfitTargetPct,
        weeklyLossCapPct: this.settings.weeklyLossCapPct,
        closeOnTarget: this.settings.closeOnTarget,
        startBalance: this.settings.startBalance,
      },
    };
  }

  /** -100 (at loss cap) .. +100 (at profit target) */
  targetProgress(): number {
    const target = this.dayStartBalance * (this.settings.dailyProfitTargetPct / 100);
    if (target <= 0) return 0;
    return Math.max(-100, Math.min(100, (this.dayPnl / target) * 100));
  }

  /** weekly progress on the same -100..+100 scale */
  weekProgress(): number {
    const target = this.weekStartBalance * (this.settings.weeklyProfitTargetPct / 100);
    if (target <= 0) return 0;
    return Math.max(-100, Math.min(100, (this.weekPnl / target) * 100));
  }

  equityCurve(): number[] {
    const curve: number[] = [];
    // balance now + open unrealized back-propagation is overkill; show realized path:
    curve.push(this.settings.startBalance);
    const realized = this.settings.balance;
    if (realized !== this.settings.startBalance) curve.push(realized);
    const unreal = this.positions.reduce((a, p) => a + p.pnlUsd, 0);
    curve.push(realized + unreal);
    return curve;
  }

  killRate(): string {
    const total = this.killed;
    const denom = this.scored + this.killed;
    if (denom === 0) return "~90";
    return String(Math.round((total / Math.max(1, denom)) * 100));
  }

  stageLine(): string {
    const open = this.positions[0];
    if (this.halted) return "RISK · daily cap hit";
    if (this.weekHalted) return "RISK · weekly cap hit";
    if (this.targetHit) return `TARGET · booked ${fmtUsd(this.dayPnl)} today`;
    if (this.weekTargetHit) return `TARGET · booked ${fmtUsd(this.weekPnl)} this week`;
    if (open) {
      if (open.trailActive) return `RISK · TRAIL ${open.base}`;
      return `EXECUTOR · LIVE ${open.base}`;
    }
    if (this.phase === "FILTERING" && this.filterView) return `FILTER · CHECK ${this.filterView.coin}`;
    if (this.phase === "SCORING" && this.analystView) return `ANALYST · SCORE ${this.analystView.coin}`;
    if (this.phase === "SCANNING") return "SCOUT · scanning pairs";
    return this.phaseDetail ? this.phase : "IDLE · standing by";
  }
}

const g = globalThis as unknown as { __neuroEngine?: Engine };

/** pull the 6 analyst sub-scores back out of a stored featuresJson */
function restoreEntryScores(featuresJson: string): number[] {
  try {
    const f = JSON.parse(featuresJson) as { scores?: number[] };
    if (Array.isArray(f.scores) && f.scores.length === 6 && f.scores.every((v) => isFinite(v))) return f.scores;
  } catch { /* fresh */ }
  return [];
}

export async function getEngine(): Promise<Engine> {
  if (!g.__neuroEngine || g.__neuroEngine.version !== ENGINE_VERSION) {
    if (g.__neuroEngine) g.__neuroEngine.stop(); // kill ghost timer from previous version
    const fresh = new Engine();
    g.__neuroEngine = fresh;
    await fresh.init();
  }
  return g.__neuroEngine;
}

export type { Engine };
