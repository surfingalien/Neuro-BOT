import { NextResponse } from "next/server";
import { getEngine } from "@/lib/engine/engine";
import { deskBusy, deskSnapshot, forwardCycle, loadDesk, researchCycle } from "@/lib/engine/desk";

export const dynamic = "force-dynamic";

// The desk is research + forward-testing only. Nothing here can place an order.

export async function GET() {
  await getEngine(); // makes sure the background desk loop is started
  await loadDesk();
  return NextResponse.json({ ...deskSnapshot(), busy: deskBusy() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  await getEngine();
  await loadDesk();
  let body: { action?: "research" | "forward" };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad body" }, { status: 400 });
  }
  if (deskBusy()) return NextResponse.json({ error: "the desk is already working — check back in a minute" }, { status: 409 });
  if (body.action === "research") {
    void researchCycle("manual");
    return NextResponse.json({ ok: true, started: "research" }, { status: 202 });
  }
  if (body.action === "forward") {
    void forwardCycle();
    return NextResponse.json({ ok: true, started: "forward" }, { status: 202 });
  }
  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
