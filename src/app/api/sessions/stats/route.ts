import { NextResponse } from "next/server";
import { jsonError, requireAuthenticatedUser } from "@/lib/api/auth";
import { ensureUserProfile } from "@/lib/gcp/userData";
import { getDashboardStats } from "@/lib/sessions/stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const decodedToken = await requireAuthenticatedUser(request);
    const profile = await ensureUserProfile(decodedToken);
    const stats = await getDashboardStats({
      ownerUid: decodedToken.uid,
      targetWeeklyStudyMinutes: Math.round(profile.weeklyGoalHours * 60),
    });
    return NextResponse.json({ stats });
  } catch (error) {
    return jsonError(error);
  }
}
