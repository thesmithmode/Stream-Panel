export type Profile = "ruslan" | "gulnaz";
type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

// Read persisted preference once. Another tab may update storage, but cannot
// silently change this client's in-flight request scope.
export function createProfileSelection(storage: () => Storage) {
  let profile: Profile = "ruslan";
  try { if (storage().getItem("sp-profile") === "gulnaz") profile = "gulnaz"; } catch { /* private browser: in-memory selection */ }
  return {
    get: () => profile,
    set(value: Profile) {
      if (value !== "ruslan" && value !== "gulnaz") throw new Error("INVALID_PROFILE");
      profile = value;
      try { storage().setItem("sp-profile", value); } catch { /* private browser: in-memory selection */ }
    },
  };
}
