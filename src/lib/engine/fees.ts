// ─── Fee model: the account's REAL Coinbase fee tier (refreshed hourly), with a conservative fallback ───
import { cbConfigured, cbFeeTier } from "./coinbase";

export interface FeeModel {
  maker: number; // per side, fraction
  taker: number;
  tier: string;
  volume30d: number;
  fetchedAt: number;
  source: "coinbase" | "fallback";
}

const FALLBACK: FeeModel = { maker: 0.004, taker: 0.006, tier: "assumed lowest tier", volume30d: 0, fetchedAt: 0, source: "fallback" };
const g = globalThis as unknown as { __nbFees?: FeeModel };
let model: FeeModel = (g.__nbFees ??= { ...FALLBACK });

export async function refreshFees(force = false): Promise<FeeModel> {
  if (!force && Date.now() - model.fetchedAt < 3_600_000) return model;
  if (!cbConfigured()) return model;
  try {
    const t = await cbFeeTier();
    if (t) model = g.__nbFees = { ...t, fetchedAt: Date.now(), source: "coinbase" };
  } catch { /* keep the last known model */ }
  return model;
}

export const feeModel = (): FeeModel => model;

/** taker fee per side used for market orders (what the bot actually pays) */
export const takerFee = (): number => model.taker;

/** paper-mode fee per side: PAPER_FEE_PCT overrides; majors use the real taker rate when known */
export function paperFee(market: "majors" | "memecoin"): number {
  const v = parseFloat(process.env.PAPER_FEE_PCT ?? "");
  if (isFinite(v) && v >= 0) return Math.min(2, v) / 100;
  return market === "majors" ? model.taker : 0.003;
}

/** round-trip cost of a market-in / market-out trade, as a fraction of notional */
export const roundTripCost = (slip = 0.0004): number => 2 * model.taker + 2 * slip;
