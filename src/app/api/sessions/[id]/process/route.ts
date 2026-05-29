import { NextResponse } from "next/server";
import { processTimelapse } from "@/lib/video/processTimelapse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const timelapsePath = await processTimelapse(id);
    return NextResponse.json({ timelapsePath });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
