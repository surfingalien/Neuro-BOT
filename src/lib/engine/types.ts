// ─── Core types for the Neuro Bot trading engine ───

export type MarketKind = "majors" | "memecoin";
export type MarketFocus = "majors" | "memecoins" | "both";
export type StrategyId = "momentum" | "meanrev" | "breakout";
export type Regime = "trending_up" | "trending_down" | "ranging";
export type VolState = "calm" | "normal" | "volatile";

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Klines {
  m1: Candle[]; // 1m candles for TA / scalping
  h1: Candle[]; // 1h candles for regime / context
  simulated: boolean;
}

export interface ScoutPair {
  symbol: string; // e.g. BTCUSDT or pair address short
  base: string; // e.g. BTC or $PIPPA
  name: string;
  market: MarketKind;
  price: number;
  change24h: number; // pct
  volume24h: number;
  volume1h: number;
  liquidity: number;
  mcap: number;
  ageHours: number;
  txns1h: number;
  buys1h: number;
  sells1h: number;
  source: string; // binance | dexscreener | sim
}

export interface FilterRuleResult {
  label: string;
  pass: boolean;
  value: string;
  na?: boolean; // rule not applicable → auto-pass
}

export interface FilterResult {
  symbol: string;
  base: string;
  passed: boolean;
  rules: FilterRuleResult[];
  failedRuleIndex: number; // -1 if passed
}

export interface AnalystResult {
  symbol: string;
  base: string;
  scores: { label: string; value: number }[]; // 6 sub-scores 0-100
  final: number;
  passed: boolean; // >= threshold
}

export interface StrategyDecision {
  strategy: StrategyId;
  reason: string;
  fitBonus: number;
}

export interface Position {
  id: string;
  symbol: string;
  base: string;
  name: string;
  market: MarketKind;
  strategy: StrategyId;
  entryPrice: number;
  price: number; // last known
  qty: number;
  sizeUsd: number;
  score: number;
  regime: Regime;
  stopLoss: number;
  tp1: number;
  tp2: number;
  trailActive: boolean;
  trailPeak: number;
  openedAt: number;
  pnlPct: number;
  pnlUsd: number;
  series: { t: number; p: number }[]; // price ticks since open
  tp1Booked: boolean;
  entryScores: number[]; // 6 analyst sub-scores at entry (0-100) — feeds research learning
  source: string;
}

export type AgentId =
  | "scout"
  | "filter"
  | "analyst"
  | "executor"
  | "risk"
  | "logger"
  | "brain"
  | "you";

export interface AgentState {
  id: AgentId;
  name: string;
  badge: string;
  desc: string;
  status: string; // SCAN | CHECK | SCORING | LIVE | TRAIL | WRITE | THINK | IDLE ...
  statusTone: "green" | "red" | "purple" | "amber" | "blue" | "dim";
  activity: string; // one-liner footer
}

export interface LogLine {
  n: number;
  level: string;
  text: string;
  ts: number;
}

export interface StrategyBrain {
  weight: number;
  trades: number;
  wins: number;
  losses: number;
  pnl: number;
  last10: number[]; // rewards -1..1
  lastReasons: string[]; // exit reasons, brain tunes params from these
  holdMult: number; // × maxHoldMinutes — learned 0.55..1.7
  stopMult: number; // × stop distance — learned 0.85..1.35
  tpMult: number; // × TP1/TP2 distance — learned 0.8..1.5
}

export interface SignalWeightView {
  label: string;
  base: number; // factory weight
  now: number; // learned weight
}

export interface BrainSnapshot {
  weights: Record<StrategyId, number>;
  strategies: Record<StrategyId, StrategyBrain>;
  lessons: string[];
  regime: Regime | "unknown";
  volatility: VolState;
  scoreThreshold: number;
  sizeMultiplier: number;
  autotuneCount: number;
  equityCurve: number[]; // balance after each closed trade
  signalWeights: SignalWeightView[]; // research engine learned signal importance
  nextAutotuneIn: number; // closes until next full auto-tune cycle
  autotuneEvery: number;
}

export interface TargetsSnapshot {
  dailyProfitTargetPct: number;
  dailyLossCapPct: number;
  closeOnTarget: boolean;
  dayPnl: number; // realized today usd
  dayPnlPct: number;
  dayStartBalance: number;
  weekPnl: number;
  dayKey: string;
  weekKey: string;
  targetHit: boolean;
  lossCapped: boolean;
  progressPct: number; // -100..100 relative to target span
  targetUsd: number;
  capUsd: number;
  // ── weekly targets (same semantics, bigger horizon) ──
  weeklyProfitTargetPct: number;
  weeklyLossCapPct: number;
  weekPnlPct: number;
  weekStartBalance: number;
  weekTargetUsd: number;
  weekCapUsd: number;
  weekTargetHit: boolean;
  weekLossCapped: boolean;
  weekProgressPct: number;
}

export interface StatsSnapshot {
  seen: number;
  killed: number;
  scored: number;
  trades: number;
  wins: number;
  losses: number;
  bestTrade: number; // usd
  worstTrade: number;
  balance: number;
  startBalance: number;
  openPositions: number;
  cycle: number;
}

export interface BotSnapshot {
  booted: boolean;
  running: boolean;
  mode: "paper" | "live";
  dataSource: "live" | "sim";
  marketFocus: MarketFocus;
  startedAt: number;
  now: number;
  uptimeMs: number;
  phase: string; // SCANNING | FILTERING | SCORING | DECIDING | MANAGING | IDLE
  phaseDetail: string;
  currentStageLine: string;
  agents: AgentState[];
  ticker: { base: string; sub: string; tone: string }[];
  flow: { id: string; label: string; count: string; tone: string; active: boolean }[];
  filterView: {
    coin: string;
    rules: FilterRuleResult[];
    checkLine: string;
    killed: number;
  } | null;
  analystView: {
    coin: string;
    scores: { label: string; value: number }[];
    final: number;
    deciding: boolean;
    handoff: string;
  } | null;
  position: Position | null;
  closedPreview: { base: string; pnlUsd: number; pnlPct: number; reason: string } | null;
  targets: TargetsSnapshot;
  tg: { enabled: boolean; configured: boolean; masked: string; sentCount: number; lastError: string };
  stats: StatsSnapshot;
  brain: BrainSnapshot;
  logs: LogLine[];
  settings: Record<string, number | string | boolean>;
}
