import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StoreClient } from '../src/db.js';
import { YouTubeConnection } from '../src/youtube.js';
import type { Configuration } from '../src/config.js';

const startA = 'video_AAAAAA';
const startB = 'video_BBBBBB';
const scopes = ['https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/yt-analytics.readonly'];

test('YouTube discovery coalesces concurrent streams and closes only the absent stream across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sp-youtube-logical-'));
  const path = join(dir, 'data.sqlite');
  const base = Date.parse('2026-10-07T12:00:00Z');
  let now = base + 60000;
  let broadcasts = [startA, startB];
  const config = { value: { youtube: { access: 'access', refresh: 'refresh', userId: 'channel', scopes, expiresAt: now + 3600000 } }, save: async () => {} } as unknown as Configuration;
  const request: typeof fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/liveBroadcasts')) return Response.json({ items: broadcasts.map((id, index) => ({ id, snippet: { channelId: 'channel', title: `Stream ${index}`, liveChatId: '' } })) });
    if (url.pathname.endsWith('/videos')) return Response.json({ items: url.searchParams.get('id')!.split(',').map(id => ({ id, liveStreamingDetails: { actualStartTime: new Date(base).toISOString(), concurrentViewers: id === startA ? '12' : '7' } })) });
    return Response.json({});
  };
  let db = new StoreClient(path, 'ruslan');
  let yt = new YouTubeConnection(config, db, 'https://panel.test/oauth/youtube/callback', 'ruslan', request, () => now);
  try {
    await db.ready;
    await db.call('youtubeSnapshot', 'channel', 'channel', { id: 'channel' }, now);
    await db.call('youtubeSnapshot', 'channel', 'report', {}, now);
    await yt.collectOnce();
    const initial = await db.call<any[]>('sessions');
    assert.equal(initial.length, 1);
    const sessionId = initial[0]!.id;
    let links = await db.call<any[]>('platformStreams', sessionId);
    assert.deepEqual(links.map(link => link.external_id), [startA, startB]);
    assert.ok(links.every(link => link.url === `https://www.youtube.com/watch?v=${link.external_id}`));
    assert.ok(links.every(link => link.started_at_ms === base));

    await yt.stop();
    await db.stop();
    db = new StoreClient(path, 'ruslan');
    await db.ready;
    yt = new YouTubeConnection(config, db, 'https://panel.test/oauth/youtube/callback', 'ruslan', request, () => now);
    broadcasts = [startB];
    now += 60000;
    await yt.collectOnce();
    now += 60000;
    await yt.collectOnce();

    links = await db.call<any[]>('platformStreams', sessionId);
    const absent = links.find(link => link.external_id === startA)!;
    const present = links.find(link => link.external_id === startB)!;
    assert.equal(absent.ended_at_ms, base + 120000);
    assert.equal(present.ended_at_ms, null);
    assert.equal((await db.call<any[]>('sessions')).find(session => session.id === sessionId)?.ended_at_ms, null);
  } finally {
    await yt.stop();
    await db.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('unknown provider start times retain viewer/chat collection without inventing a stream session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sp-youtube-unknown-start-'));
  const db = new StoreClient(join(dir, 'data.sqlite'), 'ruslan');
  const now = Date.parse('2026-10-07T12:00:00Z');
  const config = { value: { youtube: { access: 'access', refresh: 'refresh', userId: 'channel', scopes, expiresAt: now + 3600000 } }, save: async () => {} } as unknown as Configuration;
  const writes: Array<[string, ...unknown[]]> = [];
  const request: typeof fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/liveBroadcasts')) return Response.json({ items: [{ id: startA, snippet: { channelId: 'channel', liveChatId: 'chat', title: 'Live title' } }] });
    if (url.pathname.endsWith('/videos')) return Response.json({ items: [{ id: startA, liveStreamingDetails: { concurrentViewers: '9' } }] });
    if (url.pathname.endsWith('/messages')) return Response.json({ items: [{ id: 'message', snippet: { type: 'textMessageEvent', publishedAt: new Date(now).toISOString(), displayMessage: 'hello' }, authorDetails: { channelId: 'viewer', displayName: 'Viewer' } }], pollingIntervalMillis: 60000 });
    return Response.json({});
  };
  const originalCall = db.call.bind(db);
  const trackedDb = { call: async (method: string, ...args: unknown[]) => { writes.push([method, ...args]); return originalCall(method, ...args); } } as unknown as StoreClient;
  const yt = new YouTubeConnection(config, trackedDb, 'https://panel.test/oauth/youtube/callback', 'ruslan', request, () => now);
  try {
    await db.ready;
    await db.call('youtubeSnapshot', 'channel', 'channel', { id: 'channel' }, now);
    await db.call('youtubeSnapshot', 'channel', 'report', {}, now);
    await yt.collectOnce();
    assert.equal((await db.call<any[]>('sessions')).length, 0);
    assert.ok(writes.some(([method, at, viewers]) => method === 'youtubeViewers' && at === now && viewers === 9));
    assert.ok(writes.some(([method, , chat]) => method === 'youtubeMessages' && chat === 'chat'));
    assert.ok(writes.some(([method, platform, account, ids]) => method === 'platformMissing' && platform === 'youtube' && account === 'channel' && Array.isArray(ids) && ids.includes(startA)));
  } finally {
    await yt.stop();
    await db.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('malformed or capped broadcast discovery fails before snapshots or missing checks can mutate stream history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sp-youtube-invalid-discovery-'));
  const db = new StoreClient(join(dir, 'data.sqlite'), 'ruslan');
  const now = Date.parse('2026-10-07T12:00:00Z');
  const config = { value: { youtube: { access: 'access', refresh: 'refresh', userId: 'channel', scopes, expiresAt: now + 3600000 } }, save: async () => {} } as unknown as Configuration;
  let mode: 'valid' | 'missing' | 'malformed' | 'pagination-cap' = 'valid';
  let page = 0;
  const request: typeof fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/liveBroadcasts')) {
      if (mode === 'missing') return Response.json({});
      if (mode === 'malformed') return Response.json({ items: [{ id: startA }] });
      if (mode === 'pagination-cap') { page++; return Response.json({ items: [], nextPageToken: `page-${page}` }); }
      return Response.json({ items: [{ id: startA, snippet: { channelId: 'channel', title: 'Valid stream' } }] });
    }
    if (url.pathname.endsWith('/videos')) return Response.json({ items: [{ id: startA, liveStreamingDetails: { actualStartTime: new Date(now - 60000).toISOString() } }] });
    return Response.json({});
  };
  const yt = new YouTubeConnection(config, db, 'https://panel.test/oauth/youtube/callback', 'ruslan', request, () => now);
  try {
    await db.ready;
    await db.call('youtubeSnapshot', 'channel', 'channel', { id: 'channel' }, now);
    await db.call('youtubeSnapshot', 'channel', 'report', {}, now);
    await yt.collectOnce();
    const sessionId = (await db.call<any[]>('sessions'))[0]!.id;
    const snapshotBefore = await db.call<any>('youtubeData', 'channel');
    const linkBefore = (await db.call<any[]>('platformStreams', sessionId))[0]!;

    mode = 'missing';
    await assert.rejects(yt.collectOnce(), /YOUTUBE_INVALID_BROADCASTS/);
    mode = 'malformed';
    await assert.rejects(yt.collectOnce(), /YOUTUBE_INVALID_BROADCASTS/);
    mode = 'pagination-cap'; page = 0;
    await assert.rejects(yt.collectOnce(), /YOUTUBE_BROADCAST_PAGINATION_LIMIT/);
    const snapshotAfter = await db.call<any>('youtubeData', 'channel');
    const linkAfter = (await db.call<any[]>('platformStreams', sessionId))[0]!;
    assert.deepEqual(snapshotAfter.snapshots.broadcasts, snapshotBefore.snapshots.broadcasts);
    assert.equal(linkAfter.offline_checks, linkBefore.offline_checks);
    assert.equal(linkAfter.ended_at_ms, null);
  } finally {
    await yt.stop();
    await db.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
