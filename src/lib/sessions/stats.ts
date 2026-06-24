import type { DashboardStats, StudySession } from "@/lib/sessions/types";
import { listAllSessions } from "@/lib/sessions/firestore";

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function startOfWeekMonday(): Date {
  const today = startOfToday();
  const day = today.getDay();
  const distanceFromMonday = day === 0 ? 6 : day - 1;
  today.setDate(today.getDate() - distanceFromMonday);
  return today;
}

function isAfterOrSame(session: StudySession, boundary: Date): boolean {
  return session.startedAt.toDate().getTime() >= boundary.getTime();
}

export async function getDashboardStats(input: {
  ownerUid: string;
  targetWeeklyStudyMinutes: number;
}): Promise<DashboardStats> {
  const sessions = await listAllSessions(input.ownerUid);
  const targetWeeklyStudyMinutes = input.targetWeeklyStudyMinutes;
  const today = startOfToday();
  const week = startOfWeekMonday();
  const todayStudySec = sessions
    .filter((session) => isAfterOrSame(session, today))
    .reduce((sum, session) => sum + session.actualStudySec, 0);
  const weekStudySec = sessions
    .filter((session) => isAfterOrSame(session, week))
    .reduce((sum, session) => sum + session.actualStudySec, 0);
  const totalStudySec = sessions.reduce((sum, session) => sum + session.actualStudySec, 0);
  const totalBreakSec = sessions.reduce((sum, session) => sum + session.totalBreakSec, 0);
  const qualitySessions = sessions.filter((session) => session.quality !== null);
  const averageQuality =
    qualitySessions.length > 0
      ? qualitySessions.reduce((sum, session) => sum + (session.quality ?? 0), 0) /
        qualitySessions.length
      : null;
  const weeklyAchievementRate =
    targetWeeklyStudyMinutes > 0 ? (weekStudySec / (targetWeeklyStudyMinutes * 60)) * 100 : 0;

  return {
    todayStudySec,
    weekStudySec,
    targetWeeklyStudyMinutes,
    weeklyAchievementRate,
    totalStudySec,
    totalBreakSec,
    totalSessions: sessions.length,
    averageQuality,
  };
}
