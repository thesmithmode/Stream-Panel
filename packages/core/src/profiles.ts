/** The installation's profiles: one list shared by the daemon (accounts, backups) and the web UI. */
export const PROFILES = ["ruslan", "gulnaz"] as const;
export type ProfileName = typeof PROFILES[number];
export const isProfileName = (value: unknown): value is ProfileName => (PROFILES as readonly unknown[]).includes(value);
