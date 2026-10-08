import { matchKey } from "./domain.js";

/** Well-known Twitch chat bots (logins). Events stay stored; analytics can exclude them. */
export const WELL_KNOWN_TWITCH_BOTS: readonly string[] = [
  "jeetbot",
  "streemelements",
  "nightbot",
  "streamelements",
  "streamlabs",
  "moobot",
  "fossabot",
  "wizebot",
  "coebot",
  "stay_hydrated_bot",
  "sery_bot",
  "soundalerts",
  "pretzelrocks",
  "commanderroot",
  "anotherttvviewer",
  "kofistreambot",
  "frankie_showman",
];

export function normalizeBotLogin(login: string): string {
  return matchKey(login);
}

export function botExclusionSet(
  extra: readonly string[] = [],
): ReadonlySet<string> {
  const set = new Set<string>();
  for (const login of WELL_KNOWN_TWITCH_BOTS)
    set.add(normalizeBotLogin(login));
  for (const login of extra) {
    const key = normalizeBotLogin(login);
    if (key) set.add(key);
  }
  return set;
}

export function isExcludedBot(
  loginOrName: string,
  excluded: ReadonlySet<string>,
): boolean {
  const key = normalizeBotLogin(loginOrName);
  return key !== "" && excluded.has(key);
}
