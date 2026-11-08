import { NextResponse } from "next/server";
import { getEngine } from "@/lib/engine/engine";
import type { MarketFocus } from "@/lib/engine/types";

export const dynamic = "force-dynamic";

interface ControlBody {
  action: "start" | "pause" | "reset" | "forceScan" | "focus" | "closePosition" | "liveOn" | "liveOff";
  confirm?: string;
  focus?: MarketFocus;
  positionId?: string;
}

export async function POST(req: Request) {
  const engine = await getEngine();
  let body: ControlBody;
  try {
    body = (await req.json()) as ControlBody;
  } catch {
    return NextResponse.json({ error: "bad body" }, { status: 400 });
  }

  switch (body.action) {
    case "start":
      engine.halted = false;
      engine.weekHalted = false; // manual resume also clears the weekly breaker
      engine.setRunning(true);
      break;
    case "pause":
      engine.setRunning(false);
      break;
    case "reset":
      await engine.reset();
      break;
    case "forceScan":
      engine.forceScan();
      break;
    case "focus":
      if (body.focus) engine.setFocus(body.focus);
      break;
    case "closePosition": {
      const pos = engine.positions.find((p) => p.id === body.positionId);
      if (pos) await engine.closePosition(pos, pos.price, "manual");
      break;
    }
    case "liveOn": {
      const r = await engine.enableLive(typeof body.confirm === "string" ? body.confirm : "");
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
      break;
    }
    case "liveOff": {
      const r = await engine.disableLive();
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409 });
      break;
    }
    default:
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, snapshot: engine.snapshot() });
}
