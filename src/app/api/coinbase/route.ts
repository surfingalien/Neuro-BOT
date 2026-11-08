import { NextResponse } from "next/server";
import { getEngine } from "@/lib/engine/engine";
import { cbAccounts, cbConfigured, cbProducts, liveGate, liveLimits } from "@/lib/engine/coinbase";

export const dynamic = "force-dynamic";

// Real Coinbase balance + holdings. Read-only; credentials never leave the server.
let cache: { at: number; body: unknown } | null = null;

export async function GET() {
  const engine = await getEngine();
  const gate = liveGate();
  const base = {
    configured: cbConfigured(),
    liveAllowed: gate.ok,
    liveProblems: gate.problems,
    limits: liveLimits(),
    live: engine.liveStatus(),
  };
  if (!base.configured) return NextResponse.json({ ...base, holdings: [], totalUsd: 0, usd: 0 });

  if (!cache || Date.now() - cache.at > 8_000) {
    try {
      const accounts = await cbAccounts();
      const coins = accounts.filter((a) => a.currency !== "USD");
      const prices = new Map<string, number>();
      if (coins.length) {
        try {
          for (const p of await cbProducts(coins.map((c) => `${c.currency}-USD`), 5_000)) prices.set(p.id, p.price);
        } catch { /* holdings shown without USD value */ }
      }
      const usd = accounts.find((a) => a.currency === "USD");
      const holdings = [
        ...(usd ? [{ currency: "USD", qty: usd.available + usd.hold, hold: usd.hold, price: 1, usdValue: usd.available + usd.hold }] : []),
        ...coins.map((c) => {
          const price = prices.get(`${c.currency}-USD`) ?? 0;
          const qty = c.available + c.hold;
          return { currency: c.currency, qty, hold: c.hold, price, usdValue: qty * price };
        }),
      ].sort((a, b) => b.usdValue - a.usdValue);
      cache = { at: Date.now(), body: { holdings, usd: usd ? usd.available : 0, totalUsd: holdings.reduce((t, h) => t + h.usdValue, 0), fetchedAt: Date.now() } };
    } catch (e) {
      return NextResponse.json({ ...base, holdings: [], totalUsd: 0, usd: 0, error: e instanceof Error ? e.message : "coinbase error" });
    }
  }
  return NextResponse.json({ ...base, ...(cache.body as object) }, { headers: { "Cache-Control": "no-store" } });
}
