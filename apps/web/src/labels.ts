/** Russian labels for connection state / capability values shown in UI. */
const stateRu: Record<string, string> = {
  connected: "подключено",
  disconnected: "отключено",
  connecting: "подключение…",
  authorizing: "авторизация…",
  error: "ошибка",
  degraded: "ограничено",
  enabled: "включено",
  complete: "полный опрос",
  partial: "частичный опрос",
  failed: "сбой опроса",
  silent: "тихо",
};

export function statusLabel(value: unknown): string {
  if (value == null || value === "") return "";
  const raw = String(value);
  return stateRu[raw] ?? stateRu[raw.toLowerCase()] ?? raw;
}

/** True when donation payload is an audio alert (DA message_type or media URL). */
export function isAudioDonation(payload: {
  messageType?: unknown;
  text?: unknown;
}): boolean {
  const type = String(payload.messageType ?? "").toLowerCase();
  if (type === "audio") return true;
  const text = String(payload.text ?? "").trim();
  if (!text) return false;
  if (/^https?:\/\/\S+\.(wav|mp3|ogg|m4a)(\?\S*)?$/i.test(text)) return true;
  if (/\.wav(\?|$)/i.test(text) && /^https?:\/\//i.test(text)) return true;
  return false;
}

export function audioUrl(payload: { text?: unknown }): string | null {
  const text = String(payload.text ?? "").trim();
  if (!text) return null;
  if (/^https?:\/\/\S+/i.test(text)) return text;
  return null;
}

export function donationCountLabel(count:number):string {
 const form=count%100>=11&&count%100<=14?'донатов':count%10===1?'донат':count%10>=2&&count%10<=4?'доната':'донатов';
 return `${count} ${form}`;
}
