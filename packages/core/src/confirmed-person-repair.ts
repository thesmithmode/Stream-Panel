import type { StreamStore } from './store.js';
type Identity = { id: string; source: string; display_name: string; match_key: string };
type Detail = {
  id: string;
  revision: number;
  display_name: string;
  identities: Identity[];
  aliases: { identity_id: string; name: string; candidate_key: string }[];
};
const key = (value: string) => value.normalize('NFKC').trim().toLowerCase();
/** The owner-confirmed pair: a Twitch login and the DA signatures of the same viewer. */
export type ConfirmedPerson = { viewer: string; donors: string[] };
/**
 * The confirmed names are deployment data, never repository content: they are read from
 * STREAM_PANEL_CONFIRMED_PERSON as JSON {"viewer":"<twitch login>","donors":["<DA name>",...]}.
 * An absent value means there is nothing to repair on this installation.
 */
export function confirmedPerson(raw: string | undefined): ConfirmedPerson | null {
  if (raw === undefined || !raw.trim()) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('INVALID_CONFIRMED_PERSON');
  }
  const spec = value as Partial<ConfirmedPerson> | null;
  const name = (item: unknown): item is string => typeof item === 'string' && !!key(item) && item.length <= 128;
  if (
    !spec ||
    typeof spec !== 'object' ||
    !name(spec.viewer) ||
    !Array.isArray(spec.donors) ||
    !spec.donors.length ||
    spec.donors.length > 8 ||
    !spec.donors.every(name)
  )
    throw new Error('INVALID_CONFIRMED_PERSON');
  return { viewer: spec.viewer, donors: [...spec.donors] };
}
/** Owner-confirmed repair (2026-10-25), deliberately not a fuzzy auto-link rule.
 * Only a sole DA-only duplicate and the known Twitch account may be joined.
 * The existing reversible merge journal retains all original facts. */
export function repairConfirmedPerson(store: Pick<StreamStore, 'persons' | 'person' | 'merge'>, spec: ConfirmedPerson) {
  const viewer = key(spec.viewer),
    donorNames = new Set(spec.donors.map(key));
  const rows = [
    ...new Map(
      [spec.viewer, ...spec.donors].flatMap((name) => store.persons(name)).map((row) => [String(row.id), row]),
    ).values(),
  ];
  const people = rows.map((row) => store.person(String(row.id), false) as unknown as Detail);
  const targets = people.filter((person) => {
    const twitch = new Set(person.identities.filter((i) => i.source === 'twitch').map((i) => i.id));
    return (
      person.identities.some(
        (i) => i.source === 'twitch' && [i.display_name, i.match_key].some((n) => key(n) === viewer),
      ) ||
      person.aliases.some((a) => twitch.has(a.identity_id) && [a.name, a.candidate_key].some((n) => key(n) === viewer))
    );
  });
  if (targets.length !== 1) return { state: targets.length ? 'ambiguous' : 'not-found' } as const;
  const target = targets[0]!;
  const donors = people.filter(
    (person) =>
      person.id !== target.id &&
      donorNames.has(key(person.display_name)) &&
      person.identities.length > 0 &&
      person.identities.every((i) => i.source === 'donationalerts' && donorNames.has(key(i.display_name))),
  );
  if (donors.length !== 1) return { state: donors.length ? 'ambiguous' : 'already-linked-or-absent' } as const;
  const source = donors[0]!;
  const mergeId = store.merge(source.id, target.id, source.revision, target.revision, Date.now());
  return { state: 'merged', mergeId } as const;
}
