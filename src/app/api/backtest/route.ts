import { NextResponse } from "next/server";
import { getEngine } from "@/lib/engine/engine";
import { backtestBusy, lastReport, runBacktest } from "@/lib/engine/backtest";
import type { MarketFocus } from "@/lib/engine/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  return NextResponse.json({ running: backtestBusy(), report: lastReport() });
}

export async function POST(req: Request) {
  const engine = await getEngine();
  let body: {
    action?: "run" | "apply";
    scope?: MarketFocus;
    bars?: number;
    useLiveBrain?: boolean;
    startBalance?: number;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad body" }, { status: 400 });
  }

  if (body.action === "apply") {
    const rep = lastReport();
    if (!rep) {
      return NextResponse.json({ error: "no backtest result is stored on the server (it restarted since you ran it) — run the backtest again, then apply" }, { status: 400 });
    }
    // real money: never steer the live bot with a brain trained on made-up prices
    if (engine.settings.mode === "live" && (rep.simulated || rep.scope !== "majors")) {
      return NextResponse.json(
        {
          error: `refused in LIVE mode: this replay used ${rep.simulated ? "simulated" : "synthetic memecoin"} data. Run a MAJORS-only backtest on real Coinbase candles, or switch to paper first.`,
        },
        { status: 409 }
      );
    }
    await engine.importBrain(rep.brainAfter, `backtest ${rep.id} (${rep.trades} trades · ${rep.winRate.toFixed(0)}% win)`);
    return NextResponse.json({ ok: true, applied: true, snapshot: engine.snapshot() });
  }

  if (backtestBusy()) return NextResponse.json({ error: "backtest already running" }, { status: 409 });

  try {
    const report = await runBacktest(
      {
        scope: (["majors", "memecoins", "both"].includes(body.scope ?? "") ? body.scope : "majors") as MarketFocus,
        bars: typeof body.bars === "number" ? body.bars : 1000,
        useLiveBrain: body.useLiveBrain === true,
        startBalance: typeof body.startBalance === "number" ? body.startBalance : 1000,
      },
      engine.brain
    );
    engine.log(
      "INFO",
      `backtest ${report.id} done · ${report.trades} trades · ${report.winRate.toFixed(0)}% win · ${report.pnl >= 0 ? "+" : "–"}$${Math.abs(report.pnl).toFixed(2)} (${report.pnlPct.toFixed(1)}%) · ${report.bars} bars${report.simulated ? " · SIM DATA" : ""}`
    );
    return NextResponse.json({ ok: true, report });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "backtest failed" }, { status: 500 });
  }
}
