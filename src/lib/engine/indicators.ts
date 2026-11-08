// ─── Technical indicator math (pure functions, no deps) ───
import type { Candle } from "./types";

export function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

export function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

export function macd(closes: number[]): { macd: number; signal: number; hist: number } {
  if (closes.length < 26) return { macd: 0, signal: 0, hist: 0 };
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const line: number[] = [];
  for (let i = 0; i < closes.length; i++) line.push(e12[i] - e26[i]);
  const sig = ema(line, 9);
  const m = line[line.length - 1];
  const s = sig[sig.length - 1];
  return { macd: m, signal: s, hist: m - s };
}

export function bollinger(closes: number[], period = 20, mult = 2) {
  if (closes.length < period) {
    const last = closes[closes.length - 1] ?? 0;
    return { upper: last, mid: last, lower: last, widthPct: 0 };
  }
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return {
    upper: mid + mult * sd,
    mid,
    lower: mid - mult * sd,
    widthPct: mid !== 0 ? ((2 * mult * sd) / mid) * 100 : 0,
  };
}

export function atr(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) {
    const last = candles[candles.length - 1];
    return last ? last.c * 0.005 : 0;
  }
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c)
    );
    sum += tr;
  }
  return sum / period;
}

/** Normalized slope of last n EMA values, in % per bar */
export function emaSlope(closes: number[], period: number, bars = 10): number {
  const e = ema(closes, period);
  if (e.length < bars + 1) return 0;
  const a = e[e.length - 1 - bars];
  const b = e[e.length - 1];
  return a !== 0 ? ((b - a) / a) * 100 : 0;
}

/** Coefficient of variation of volumes — volume consistency (smart money proxy) */
export function volumeConsistency(volumes: number[]): number {
  if (volumes.length < 10) return 0.5;
  const slice = volumes.slice(-30);
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  if (mean === 0) return 0.5;
  const sd = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length);
  return Math.max(0, Math.min(1, 1 - sd / mean / 1.5)); // 1 = very steady
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(abs < 10 ? 2 : 0)}`;
}

export function fmtPrice(n: number): string {
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.01) return n.toFixed(4);
  return n.toFixed(6);
}
