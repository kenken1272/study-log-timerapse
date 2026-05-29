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
    if (!session?.thumbnailPath) {
      return NextResponse.json({ error: "Thumbnail is not ready." }, { status: 404 });
    }

    const url = await createSignedReadUrl(session.thumbnailPath);
    return NextResponse.json({ url });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
