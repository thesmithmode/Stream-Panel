import type Database from 'better-sqlite3';
import { EVENT_CLEANUP_BATCH, EVENT_RETENTION_MS } from './recent-events.js';

type Clip = { id: string; streamId: string; accountId: string; positionSeconds: number; createdAt: number };
const clipFields =
  'c.id,c.stream_id AS streamId,c.account_id AS accountId,c.position_seconds AS positionSeconds,c.created_at_ms AS createdAt';
const streamScope = `p.platform='twitch' AND p.session_id=? AND
  NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.session_id=p.session_id)`;

export class StreamClips {
  constructor(private readonly db: Database.Database) {}

  list(session: string, account: string, now = Date.now()) {
    const activeStreamId =
      (
        this.db
          .prepare(
            `
      SELECT p.external_id AS id FROM logical_platform_streams p
      WHERE ${streamScope} AND p.account_id=? AND p.ended_at_ms IS NULL
      ORDER BY p.started_at_ms DESC LIMIT 1`,
          )
          .get(session, account) as { id: string } | undefined
      )?.id ?? null;
    const clips = this.db
      .prepare(
        `
      SELECT ${clipFields} FROM stream_clips c
      JOIN logical_platform_streams p ON p.external_id=c.stream_id AND p.account_id=c.account_id
      WHERE ${streamScope} AND c.created_at_ms>? ORDER BY c.created_at_ms DESC,c.id`,
      )
      .all(session, now - EVENT_RETENTION_MS) as Clip[];
    return { activeStreamId, clips };
  }

  save(session: string, account: string, stream: string, id: string, at: number, position: number) {
    return this.db
      .transaction(() => {
        const { activeStreamId, clips } = this.list(session, account, at);
        const existing = clips.find((clip) => clip.id === id);
        if (existing) return existing;
        if (activeStreamId !== stream) throw new Error('TWITCH_STREAM_OFFLINE');
        this.db.prepare('INSERT INTO stream_clips VALUES (?,?,?,?,?)').run(id, account, stream, at, position);
        return { id, accountId: account, streamId: stream, createdAt: at, positionSeconds: position };
      })
      .immediate();
  }

  purge(now: number) {
    this.db
      .prepare(
        `DELETE FROM stream_clips WHERE id IN (
      SELECT id FROM stream_clips WHERE created_at_ms<=? ORDER BY created_at_ms LIMIT ?)`,
      )
      .run(now - EVENT_RETENTION_MS, EVENT_CLEANUP_BATCH);
  }
}
