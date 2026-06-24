import { NextResponse } from "next/server";
import { jsonError, requireAuthenticatedUser } from "@/lib/api/auth";
import { ensureUserProfile, updateUserWeeklyGoalHours } from "@/lib/gcp/userData";
import { nonNegativeNumber, readJsonRecord } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const decodedToken = await requireAuthenticatedUser(request);
    const profile = await ensureUserProfile(decodedToken);
    return NextResponse.json({ profile });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const decodedToken = await requireAuthenticatedUser(request);
    const body = await readJsonRecord(request);
    const weeklyGoalHours = nonNegativeNumber(body.weeklyGoalHours, "weeklyGoalHours");
    const profile = await updateUserWeeklyGoalHours(decodedToken, weeklyGoalHours);

    return NextResponse.json({ profile });
  } catch (error) {
    return jsonError(error);
  }
}
