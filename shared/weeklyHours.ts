import type { ReceiptAttendanceDay } from "./schema";

export function weeklyEffectiveHours(days: ReceiptAttendanceDay[] | null) {
  if (days === null) return null;
  const regular = days.reduce((sum, day) => sum + (day.absent ? 0 : day.hours), 0);
  const overtime = days.reduce((sum, day) => sum + (day.absent ? 0 : day.overtime), 0);
  return { regular, overtime, total: regular + overtime };
}
