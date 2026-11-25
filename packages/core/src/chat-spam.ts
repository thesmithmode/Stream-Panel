import { createHash } from 'node:crypto';

const floodWindowMs = 10_000;
const repeatWindowMs = 30_000;
const floodLimit = 20;
const repeatLimit = 3;
const maxSenders = 1024;
const maxMessagesPerSender = 60;
const promotion =
  /\b(?:buy|cheap)\s+(?:(?:twitch|youtube|live)\s+)?(?:followers|viewers)\b|(?:купить|накрутка)\s+(?:зрителей|подписчиков|фолловеров)/u;
const link = /(?:https?:\/\/|www\.)[^\s]+|\b[\w-]+\.(?:com|net|org|ru|gg|tv|io|live|shop)(?:\b|\/)/u;

type Message = { id: string; at: number; fingerprint: string };
type Sender = { latestAt: number; messages: Message[] };

/** Bounded per-profile state for text chat. Use publication time so an entire poll is not treated as a flood. */
export class ChatSpam {
  private readonly senders = new Map<string, Sender>();

  allow(scope: string[], sender: string, id: string, at: number, text: unknown): boolean {
    const normalized =
      typeof text === 'string' ? text.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ') : '';
    if (promotion.test(normalized) && link.test(normalized)) return false;
    if (!sender) return true;

    const key = JSON.stringify([...scope, sender]);
    const prior = this.senders.get(key);
    const latestAt = Math.max(at, prior?.latestAt ?? at);
    const cutoff = latestAt - repeatWindowMs;
    if (at <= cutoff) return true;

    const nearby = prior?.messages.filter((message) => message.at > cutoff) ?? [];
    if (nearby.some((message) => message.id === id)) return true;
    const fingerprint = normalized.length >= 12 ? createHash('sha256').update(normalized).digest('base64') : '';
    if (nearby.filter((message) => Math.abs(at - message.at) < floodWindowMs).length >= floodLimit) return false;
    if (fingerprint && nearby.filter((message) => message.fingerprint === fingerprint).length >= repeatLimit)
      return false;

    this.senders.delete(key);
    this.senders.set(key, { latestAt, messages: [...nearby, { id, at, fingerprint }].slice(-maxMessagesPerSender) });
    if (this.senders.size > maxSenders) this.senders.delete(this.senders.keys().next().value!);
    return true;
  }
}
