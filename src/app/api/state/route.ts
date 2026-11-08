import { NextResponse } from "next/server";
import { getEngine } from "@/lib/engine/engine";

export const dynamic = "force-dynamic";

export async function GET() {
  const engine = await getEngine();
  return NextResponse.json(engine.snapshot(), {
    headers: { "Cache-Control": "no-store" },
  });
}
