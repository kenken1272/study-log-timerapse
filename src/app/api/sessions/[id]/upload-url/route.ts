import { NextResponse } from "next/server";
import { createSignedUploadUrl } from "@/lib/gcp/storage";
import { integerValue, readJsonRecord, requiredString } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = await readJsonRecord(request);
    const index = integerValue(body.index, "index");
    const contentType = requiredString(body.contentType, "contentType", 120);
    const objectPath = `users/local/sessions/${id}/chunks/${index}.webm`;
    const uploadUrl = await createSignedUploadUrl(objectPath, contentType);

    return NextResponse.json({ uploadUrl, objectPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
