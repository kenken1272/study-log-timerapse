import { NextResponse } from "next/server";
import { jsonError, requireAuthenticatedUser } from "@/lib/api/auth";
import { createSignedReadUrl } from "@/lib/gcp/storage";
import { getSessionForUser } from "@/lib/sessions/firestore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  try {
    const decodedToken = await requireAuthenticatedUser(request);
    const { id } = await context.params;
    const session = await getSessionForUser(id, decodedToken.uid);
    if (!session?.timelapsePath) {
      return NextResponse.json({ error: "Video is not ready." }, { status: 404 });
    }

    const url = await createSignedReadUrl(session.timelapsePath);
    return NextResponse.json({ url });
  } catch (error) {
    return jsonError(error);
  }
}
