import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const trades = await db.trade.findMany({
      orderBy: { openedAt: "desc" },
      take: 100,
    });
    const closed = trades.filter((t) => t.status === "closed");
    const totalPnl = closed.reduce((a, t) => a + t.realizedPnl, 0);
    const wins = closed.filter((t) => t.realizedPnl > 0).length;
    return NextResponse.json({
      trades: trades.map((t) => ({
        id: t.id,
        symbol: t.symbol,
        base: t.name,
        market: t.market,
        strategy: t.strategy,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        sizeUsd: t.sizeUsd,
        score: t.score,
        status: t.status,
        exitReason: t.exitReason,
        realizedPnl: t.realizedPnl,
        pnlPct: t.pnlPct,
        openedAt: t.openedAt,
        closedAt: t.closedAt,
      })),
      summary: {
        total: trades.length,
        closed: closed.length,
        wins,
        losses: closed.length - wins,
        totalPnl,
        winRate: closed.length ? Math.round((wins / closed.length) * 100) : 0,
      },
    });
  } catch {
    return NextResponse.json({ trades: [], summary: { total: 0, closed: 0, wins: 0, losses: 0, totalPnl: 0, winRate: 0 } });
  }
}
