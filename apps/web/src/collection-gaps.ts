export interface CollectionGap {
  id?: string;
  source: string;
  reason: string;
  started_at_ms: number;
  ended_at_ms?: number | null;
}

export function groupCollectionGaps(gaps: readonly CollectionGap[]) {
  const groups = new Map<string, { source: string; reason: string; intervals: CollectionGap[] }>();
  for (const gap of gaps) {
    const key = JSON.stringify([gap.source, gap.reason]);
    let group = groups.get(key);
    if (!group) {
      group = { source: gap.source, reason: gap.reason, intervals: [] };
      groups.set(key, group);
    }
    group.intervals.push(gap);
  }
  for (const group of groups.values())
    group.intervals.sort((a, b) => b.started_at_ms - a.started_at_ms);
  return [...groups.values()].sort((a, b) => b.intervals[0]!.started_at_ms - a.intervals[0]!.started_at_ms);
}

export function gapReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    connection_lost_no_replay: "Разрыв соединения; события за это время недоступны",
    chatters_poll_incomplete: "Неполный опрос участников чата",
    chatters_poll_failed: "Не удалось опросить участников чата",
  };
  return labels[reason] ?? reason;
}
