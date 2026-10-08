import { clampChattersPollSeconds } from "../../../packages/core/src/presence.js";
import { mkdir, readFile, writeFile, rename, chmod } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
export interface Tokens {
  access: string;
  refresh: string;
  expiresAt: number;
  userId: string;
  scopes: string[];
}
export interface Config {
  version: 1;
  youtubeClientId?: string;
  youtubeAccountId?: string;
  youtubeClientSecret?: string;
  youtube?: Tokens;
  twitchClientId: string;
  twitch?: Tokens;
  daClientId: string;
  daClientSecret: string;
  daAccessToken: string;
  daRefreshToken: string;
  daUtcOffsetMinutes: number | null;
  chattersPollSeconds: number;
  /** Extra bot logins excluded from analytics aggregates (well-known list always applied). */
  excludedBotLogins: string[];
}
const defaults: Config = {
  version: 1,
  twitchClientId: "",
  daClientId: "",
  daClientSecret: "",
  daAccessToken: "",
  daRefreshToken: "",
  daUtcOffsetMinutes: null,
  chattersPollSeconds: 60,
  excludedBotLogins: ["fullrandomname_twitch", "jeetbot", "streemelements", "streamelements"],
};
export function defaultDataDir(): string {
  return (
    process.env.STREAM_PANEL_DATA_DIR ??
    join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "stream-panel")
  );
}
export class Configuration {
  value: Config = { ...defaults, excludedBotLogins: [...defaults.excludedBotLogins] };
  private saving: Promise<void> = Promise.resolve();
  constructor(readonly dir: string) {}
  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(
        await readFile(join(this.dir, "secrets.json"), "utf8"),
      ) as Config;
      if (saved.version !== 1) throw new Error("UNSUPPORTED_CONFIG");
      this.value = { ...defaults, ...saved };
      this.value.youtubeAccountId = this.value.youtube?.userId ?? this.value.youtubeAccountId ?? "";
      this.value.chattersPollSeconds = clampChattersPollSeconds(
        this.value.chattersPollSeconds,
      );
      this.value.excludedBotLogins = Array.isArray(this.value.excludedBotLogins)
        ? this.value.excludedBotLogins
            .filter((v): v is string => typeof v === "string")
            .map((v) => v.trim())
            .filter(Boolean)
            .slice(0, 200)
        : [];
      this.value.excludedBotLogins = [...new Set([...defaults.excludedBotLogins,...this.value.excludedBotLogins])];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  async save(): Promise<void> {
    const data = JSON.stringify(this.value);
    const path = join(this.dir, "secrets.json");
    const operation = this.saving.then(async () => {
      await writeFile(path + ".tmp", data, { mode: 0o600 });
      await chmod(path + ".tmp", 0o600);
      await rename(path + ".tmp", path);
    });
    this.saving = operation.catch(() => {});
    await operation;
  }
  publicView() {
    return {
      youtubeClientId: this.value.youtubeClientId ?? "",
      hasYoutubeSecret: !!this.value.youtubeClientSecret,
      twitchClientId: this.value.twitchClientId,
      daClientId: this.value.daClientId,
      hasDaSecret: !!this.value.daClientSecret,
      hasDaToken: !!this.value.daAccessToken,
      daUtcOffsetMinutes: this.value.daUtcOffsetMinutes,
      chattersPollSeconds: this.value.chattersPollSeconds,
      excludedBotLogins: this.value.excludedBotLogins,
    };
  }
}
