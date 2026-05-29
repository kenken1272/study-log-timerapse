import { NextResponse } from "next/server";
import { createSignedReadUrl } from "@/lib/gcp/storage";
import { getSession } from "@/lib/sessions/firestore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const session = await getSession(id);
    if (!session?.timelapsePath) {
      return NextResponse.json({ error: "Video is not ready." }, { status: 404 });
    }

    const url = await createSignedReadUrl(session.timelapsePath);
    return NextResponse.json({ url });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
