const UNKNOWN_DURATION = "—";

export function formatDuration(minutes: number | null | undefined): string {
  if (
    minutes === null ||
    minutes === undefined ||
    !Number.isFinite(minutes) ||
    minutes < 0
  )
    return UNKNOWN_DURATION;

  if (minutes === 0) return "0 мин";
  if (minutes < 1) return "<1 мин";

  const totalMinutes = Math.floor(minutes);
  if (!Number.isSafeInteger(totalMinutes)) return UNKNOWN_DURATION;

  if (totalMinutes < 60) return `${totalMinutes} мин`;

  if (totalMinutes < 1_440) {
    const hours = Math.floor(totalMinutes / 60);
    const remainder = totalMinutes % 60;
    return remainder === 0 ? `${hours} ч` : `${hours} ч ${remainder} мин`;
  }

  const days = Math.floor(totalMinutes / 1_440);
  const remainder = totalMinutes % 1_440;
  const hours = Math.floor(remainder / 60);
  const remainingMinutes = remainder % 60;
  const parts = [`${days} д`];
  if (hours > 0) parts.push(`${hours} ч`);
  if (remainingMinutes > 0) parts.push(`${remainingMinutes} мин`);
  return parts.join(" ");
}
