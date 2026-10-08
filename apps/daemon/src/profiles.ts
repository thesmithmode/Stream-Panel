export const profiles = ["ruslan", "gulnaz"] as const;
export type Profile = typeof profiles[number];
export const profileNames: Record<Profile, string> = { ruslan: "Руслан", gulnaz: "Гульназ" };
