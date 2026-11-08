import { NextResponse } from "next/server";
import { getEngine } from "@/lib/engine/engine";
import { tgSendTest, type TgEventsConfig } from "@/lib/engine/telegram";

export const dynamic = "force-dynamic";

const NUMERIC_KEYS = [
  "maxPositionPct",
  "stopLossPct",
  "tp1Pct",
  "tp2Pct",
  "trailActivationPct",
  "trailGapPct",
  "maxPositions",
  "maxHoldMinutes",
  "dailyLossCapPct",
  "dailyProfitTargetPct",
  "weeklyProfitTargetPct",
  "weeklyLossCapPct",
  "startBalance",
] as const;

export async function GET() {
  const engine = await getEngine();
  const s = engine.settings;
  return NextResponse.json({
    mode: s.mode,
    marketFocus: s.marketFocus,
    running: s.running,
    startBalance: s.startBalance,
    balance: s.balance,
    maxPositionPct: s.maxPositionPct,
    stopLossPct: s.stopLossPct,
    tp1Pct: s.tp1Pct,
    tp2Pct: s.tp2Pct,
    trailActivationPct: s.trailActivationPct,
    trailGapPct: s.trailGapPct,
    maxPositions: s.maxPositions,
    maxHoldMinutes: s.maxHoldMinutes,
    dailyLossCapPct: s.dailyLossCapPct,
    dailyProfitTargetPct: s.dailyProfitTargetPct,
    weeklyProfitTargetPct: s.weeklyProfitTargetPct,
    weeklyLossCapPct: s.weeklyLossCapPct,
    closeOnTarget: s.closeOnTarget,
    scoreThreshold: engine.brain.scoreThreshold,
    tg: engine.snapshot().tg, // enabled / configured / masked / sentCount — token never echoed
  });
}

export async function POST(req: Request) {
  const engine = await getEngine();
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad body" }, { status: 400 });
  }

  const patch: Record<string, number> = {};
  for (const k of NUMERIC_KEYS) {
    const v = body[k];
    if (typeof v === "number" && isFinite(v)) {
      if (k === "maxPositions") patch[k] = Math.max(1, Math.min(10, Math.round(v)));
      else if (k === "maxHoldMinutes") patch[k] = Math.max(5, Math.min(1440, Math.round(v)));
      else if (k === "startBalance") patch[k] = Math.max(50, Math.min(1_000_000, v));
      else patch[k] = Math.max(0.1, Math.min(95, v));
    }
  }
  if (Object.keys(patch).length > 0) {
    engine.updateSettings(patch);
  }
  if (typeof body.closeOnTarget === "boolean") {
    engine.updateSettings({ closeOnTarget: body.closeOnTarget });
  }

  // ── telegram alerts config ──
  const tgPatch: { token?: string; chatId?: string; enabled?: boolean; events?: Partial<TgEventsConfig> } = {};
  if (typeof body.tgToken === "string" && body.tgToken.trim().length > 0) tgPatch.token = body.tgToken;
  if (typeof body.tgChatId === "string" && body.tgChatId.trim().length > 0) tgPatch.chatId = body.tgChatId;
  if (typeof body.tgEnabled === "boolean") tgPatch.enabled = body.tgEnabled;
  if (body.tgEvents && typeof body.tgEvents === "object") {
    const ev = body.tgEvents as Record<string, unknown>;
    tgPatch.events = {
      target: ev.target === true,
      breaker: ev.breaker === true,
      trades: ev.trades === true,
      brain: ev.brain === true,
    };
  }
  if (Object.keys(tgPatch).length > 0) {
    engine.updateTelegram(tgPatch);
  }

  // one-off test message (uses posted credentials, falls back to stored ones)
  if (body.tgTest === true) {
    const token = typeof body.tgToken === "string" && body.tgToken.trim() ? body.tgToken.trim() : "";
    const chatId = typeof body.tgChatId === "string" && body.tgChatId.trim() ? body.tgChatId.trim() : "";
    const res = await tgSendTest(token, chatId);
    return NextResponse.json({ ok: res.ok, tgTest: res, snapshot: engine.snapshot() });
  }

  return NextResponse.json({ ok: true, snapshot: engine.snapshot() });
}
