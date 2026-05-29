import { NextResponse } from "next/server";
import {
  getWeeklyGoalMinutes,
  setWeeklyGoalMinutes,
} from "@/lib/sessions/firestore";
import { nonNegativeNumber, readJsonRecord } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const targetWeeklyStudyMinutes = await getWeeklyGoalMinutes();
  return NextResponse.json({ targetWeeklyStudyMinutes });
}

export async function PUT(request: Request) {
  try {
    const body = await readJsonRecord(request);
    const targetWeeklyStudyMinutes = nonNegativeNumber(
      body.targetWeeklyStudyMinutes,
      "targetWeeklyStudyMinutes",
    );
    await setWeeklyGoalMinutes(targetWeeklyStudyMinutes);

    return NextResponse.json({ targetWeeklyStudyMinutes });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
