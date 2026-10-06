let csrf = "";
export const setCsrf = (value: string) => (csrf = value);
export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined
        ? {}
        : { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP_${response.status}`);
  return data as T;
}
export function money(minor: string, currency: string) {
  const value = BigInt(minor);
  return `${(value / 100n).toLocaleString("ru-RU")},${(value % 100n).toString().padStart(2, "0")} ${currency}`;
}
export function date(at: number | null) {
  return at === null
    ? "Время неизвестно"
    : new Date(at).toLocaleString("ru-RU");
}
export interface Event {
  id: string;
  type: string;
  source: string;
  display_name: string | null;
  person_id: string | null;
  occurred_at_ms: number | null;
  received_at_ms: number;
  time_quality: string;
  payload: {
    text?: string;
    amountMinor?: string;
    currency?: string;
    actorName?: string;
    originChannelId?: string;
  };
}
export interface Person {
  id: string;
  display_name: string;
  revision: number;
  event_count: number;
  sources: string;
}
export interface Session {
  id: string;
  kind: string;
  account_id: string;
  started_at_ms: number;
  ended_at_ms: number | null;
  event_count: number;
  end_quality: string;
}
export interface Summary {
  messages: number;
  donations: number;
  totals: Record<string, string>;
  chatters: number | null;
  lastPollAtMs: number | null;
  events: number;
}
