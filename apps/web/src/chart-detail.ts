export interface SignalParticipant {
  id: string; name: string; core?: boolean;
  intervals: {from: number; to: number; kind: string}[];
}
export function participantsAt(audience: SignalParticipant[], from: number, to: number) {
  return audience.flatMap(person => {
    const spans = person.intervals.filter(span => span.from < to && span.to > from);
    const observed = spans.some(span => span.kind === 'observed');
    const estimated = spans.some(span => span.kind === 'chat_proxy');
    return observed || estimated ? [{id: person.id, name: person.name, core: person.core, observed, estimated}] : [];
  }).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}
export function timelineTicks(start: number, end: number) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const quarter = 15 * 60000;
  const step = Math.max(1, Math.ceil((end - start) / quarter / 96)) * quarter;
  const ticks: number[] = [];
  for (let at = Math.ceil(start / step) * step; at < end; at += step) ticks.push(at);
  return ticks;
}
