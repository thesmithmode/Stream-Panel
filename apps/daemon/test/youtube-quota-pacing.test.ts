import test from 'node:test';
import assert from 'node:assert/strict';
import {
  YouTubeConnection,
  YOUTUBE_CHAT_PACE,
  YOUTUBE_DAILY_UNITS,
  YOUTUBE_LIVE_DISCOVERY_MS,
  youtubeUnitCost,
} from '../src/youtube.js';
import {
  youtubeSubscriberCountInterval,
  youtubeSubscriberListInterval,
  subscriberInterval,
} from '../src/subscriber-cadence.js';
import type { Configuration } from '../src/config.js';
import type { StoreClient } from '../src/db.js';

type Live = { id: string; chat?: string };
/** A YouTube channel fixture with an in-memory store, a manual clock and per-resource call logs. */
const fixture = (options: { chatOnly?: boolean; manyPages?: boolean } = {}) => {
  const base = Date.parse('2026-11-20T08:00:00Z');
  const state = {
    at: base,
    live: [{ id: 'live', chat: 'chat' }] as Live[],
    ended: new Set<string>(),
    notLive: new Set<string>(),
    messages: 1,
    floor: 60000,
    chatError: 0,
    offlineAt: '',
    backgroundError: false,
  };
  const calls: { path: string; params: URLSearchParams; at: number }[] = [],
    quota: [string, string, number, number][] = [],
    messages: [string, unknown[]][] = [];
  const channel = {
    id: 'owner',
    statistics: { subscriberCount: '10' },
    ...(options.manyPages ? { contentDetails: { relatedPlaylists: { uploads: 'uploads' } } } : {}),
  };
  const snapshots: Record<string, { data: unknown; updatedAt: number }> = {
    channel: { data: channel, updatedAt: base },
    report: { data: {}, updatedAt: base },
    'cursor:followers': { data: true, updatedAt: base },
  };
  const db = {
    call: async (method: string, ...args: any[]) => {
      if (method === 'youtubeQuota') {
        quota.push(args as [string, string, number, number]);
        return true;
      }
      if (method === 'youtubeData') return { snapshots, messages: [], subscriberCountAt: base };
      if (method === 'youtubeSnapshot') {
        snapshots[args[1]] = { data: args[2], updatedAt: args[3] };
        return null;
      }
      if (method === 'youtubeMessages') messages.push([args[1], args[2]]);
      return null;
    },
  } as unknown as StoreClient;
  const tokens = { access: 'a', refresh: 'r', userId: 'owner', expiresAt: base + 2 * 86400000, scopes: [] };
  const config = { value: { youtube: tokens }, save: async () => {} } as unknown as Configuration;
  let page = 0;
  const request: typeof fetch = async (input) => {
    const url = new URL(String(input)),
      path = url.pathname.split('/').at(-1)!;
    calls.push({ path, params: url.searchParams, at: state.at });
    if (path === 'liveBroadcasts')
      return Response.json({
        items: state.live.map((b) => ({
          id: b.id,
          snippet: { channelId: 'owner', ...(b.chat ? { liveChatId: b.chat } : {}) },
        })),
      });
    if (path === 'videos')
      return Response.json({
        items: url.searchParams
          .get('id')!
          .split(',')
          .map((id) =>
            id.startsWith('upload-')
              ? {
                  id,
                  snippet: { title: id, publishedAt: new Date(base).toISOString() },
                  status: { privacyStatus: 'public' },
                }
              : {
                  id,
                  snippet: { liveBroadcastContent: state.ended.has(id) || state.notLive.has(id) ? 'none' : 'live' },
                  liveStreamingDetails: {
                    actualStartTime: new Date(base).toISOString(),
                    concurrentViewers: '3',
                    ...(state.ended.has(id) ? { actualEndTime: new Date(state.at).toISOString() } : {}),
                  },
                },
          ),
      });
    if (path === 'messages') {
      if (state.chatError) {
        state.chatError--;
        return Response.json({ error: { errors: [{ reason: 'liveChatEnded' }] } }, { status: 403 });
      }
      page++;
      return Response.json({
        nextPageToken: `page-${page}`,
        pollingIntervalMillis: state.floor,
        ...(state.offlineAt ? { offlineAt: state.offlineAt } : {}),
        items: Array.from({ length: state.messages }, (_, i) => ({
          id: `m${page}-${i}`,
          snippet: { type: 'textMessageEvent', publishedAt: new Date(state.at).toISOString(), displayMessage: 'hi' },
          authorDetails: { channelId: 'viewer' },
        })),
      });
    }
    if (path === 'channels') return Response.json({ items: [channel] });
    if (path === 'subscriptions' || path === 'playlistItems') {
      if (!options.manyPages) return Response.json({ items: [] });
      const page = Number(url.searchParams.get('pageToken') ?? 1),
        maxPages = path === 'subscriptions' ? 25 : 20;
      if (state.backgroundError && page === maxPages) return Response.json({}, { status: 503 });
      return Response.json({
        items:
          path === 'subscriptions'
            ? [{ snippet: {}, subscriberSnippet: { channelId: `subscriber-${page}` } }]
            : Array.from({ length: 50 }, (_, i) => ({
                contentDetails: { videoId: `upload-${page}-${i}`, videoPublishedAt: new Date(base).toISOString() },
              })),
        ...(page < maxPages ? { nextPageToken: String(page + 1) } : {}),
      });
    }
    return Response.json({});
  };
  const yt = new YouTubeConnection(
    config,
    db,
    'https://panel.test/oauth/youtube/callback',
    'test-profile',
    request,
    () => state.at,
    options.chatOnly ? { chatOnly: true } : undefined,
  );
  const count = (path: string, predicate: (c: (typeof calls)[number]) => boolean = () => true) =>
    calls.filter((c) => c.path === path && predicate(c)).length;
  /** Runs the collector loop for the given duration, advancing the clock by each returned delay. */
  const run = async (duration: number) => {
    const delays: number[] = [];
    const end = state.at + duration;
    while (state.at < end) {
      const delay = await yt.collectOnce();
      delays.push(delay);
      state.at += delay;
    }
    return delays;
  };
  return { base, state, calls, quota, messages, snapshots, yt, count, run };
};

test('local quota accounting charges Google units: chat reads cost 5, list reads cost 1, within 9000/3000 daily budgets', async () => {
  assert.equal(youtubeUnitCost('liveChat/messages'), 5);
  for (const resource of ['channels', 'videos', 'liveBroadcasts', 'playlistItems', 'subscriptions'])
    assert.equal(youtubeUnitCost(resource), 1);
  assert.deepEqual(YOUTUBE_DAILY_UNITS, { primary: 9000, secondary: 3000 });
  const main = fixture();
  try {
    await main.yt.collectOnce();
    const chat = main.quota.filter(([, , cost]) => cost === 5);
    assert.equal(chat.length, main.count('messages'));
    assert.ok(chat.length > 0);
    assert.equal(main.quota.length, main.calls.length);
    assert.ok(
      main.quota.every(
        ([day, profile, cost, budget]) =>
          day === '11/20/2026' && profile === 'test-profile' && budget === 9000 && (cost === 1 || cost === 5),
      ),
    );
  } finally {
    await main.yt.stop();
  }
  const secondary = fixture({ chatOnly: true });
  try {
    await secondary.yt.collectOnce();
    assert.deepEqual(
      secondary.quota.map(([, profile, cost, budget]) => [profile, cost, budget]),
      [
        ['test-profile:secondary', 1, 3000],
        ['test-profile:secondary', 5, 3000],
      ],
    );
  } finally {
    await secondary.yt.stop();
  }
});

test('while live, viewers stay per minute, broadcasts and totals every five minutes, and the subscriber list hourly', async () => {
  assert.equal(youtubeSubscriberCountInterval(true), 300000);
  assert.equal(youtubeSubscriberListInterval, 3600000);
  assert.equal(subscriberInterval(true), 60000, 'Twitch keeps its own cadence');
  const f = fixture();
  try {
    const delays = await f.run(3600000);
    assert.ok(delays.every((delay) => delay === 60000));
    assert.equal(delays.length, 60);
    assert.equal(f.count('videos'), 60, 'viewer counts are still sampled every minute');
    assert.equal(f.count('liveBroadcasts'), 3600000 / YOUTUBE_LIVE_DISCOVERY_MS);
    // The starting snapshots defer the first reads to +5 minutes and +1 hour respectively.
    assert.equal(
      f.count('channels', (c) => c.params.get('part') === 'statistics'),
      11,
    );
    assert.equal(f.count('subscriptions'), 0);
    await f.yt.collectOnce();
    assert.equal(f.count('subscriptions'), 1);
    const discovered = f.calls.filter((c) => c.path === 'liveBroadcasts').map((c) => c.at - f.base);
    assert.deepEqual(discovered.slice(0, 3), [0, 300000, 600000]);
  } finally {
    await f.yt.stop();
  }
});

test('24 hours of active chat with full subscriber and upload pagination leave at least 1500 Google units', async (t) => {
  const f = fixture({ manyPages: true });
  try {
    delete f.snapshots['cursor:followers'];
    await f.run(86400000);
    assert.equal(
      f.count('videos', (c) => c.params.get('id') === 'live'),
      1440,
    );
    assert.equal(f.count('liveBroadcasts'), 288);
    assert.equal(f.count('subscriptions'), 24 * 25);
    assert.equal(f.count('playlistItems'), 24 * 20);
    assert.equal(
      f.count('videos', (c) => c.params.get('id')?.startsWith('upload-') === true),
      24 * 20,
    );
    const units = f.quota.reduce((sum, [, , cost]) => sum + cost, 0);
    assert.ok(units <= 8500, `24-hour collection cost ${units} units`);
    t.diagnostic(`24-hour collection cost ${units} units`);
  } finally {
    await f.yt.stop();
  }
});

test('failed paginated background reads wait for the next hour while live checks continue', async () => {
  const f = fixture({ manyPages: true });
  try {
    delete f.snapshots['cursor:followers'];
    f.state.backgroundError = true;
    await f.run(3600000);
    assert.equal(f.count('subscriptions'), 25);
    assert.equal(f.count('playlistItems'), 20);
    assert.equal(
      f.count('videos', (c) => c.params.get('id') === 'live'),
      60,
    );
    assert.equal(f.snapshots['cursor:followers'], undefined);
    assert.equal(f.snapshots['cursor:publications'], undefined);
    f.state.backgroundError = false;
    await f.yt.collectOnce();
    assert.ok(f.snapshots['cursor:followers']);
    assert.ok(f.snapshots['cursor:publications']);
  } finally {
    await f.yt.stop();
  }
});

test('offline subscriber reads are hourly, while broadcast discovery still runs every five minutes', async () => {
  const f = fixture();
  try {
    f.state.live = [];
    await f.run(3600000);
    assert.equal(f.count('liveBroadcasts'), 12);
    assert.equal(f.count('channels'), 0);
    assert.equal(f.count('subscriptions'), 0);
    await f.yt.collectOnce();
    assert.equal(f.count('channels'), 1);
    assert.equal(f.count('subscriptions'), 1);
  } finally {
    await f.yt.stop();
  }
});

test('an ended or changed broadcast is rediscovered at once from the per-minute video read; same IDs reuse the read', async () => {
  const f = fixture();
  try {
    await f.yt.collectOnce();
    assert.equal(f.count('liveBroadcasts'), 1);
    assert.equal(f.count('videos'), 1);
    f.state.at += 60000;
    await f.yt.collectOnce();
    assert.equal(f.count('liveBroadcasts'), 1, 'confirmed broadcast list is reused');
    assert.equal(f.count('videos'), 2);
    // The video read says the stream ended: rediscover in the same cycle and record it as gone.
    const reads = (id: string) => f.count('videos', (c) => c.params.get('id') === id);
    f.state.ended.add('live');
    f.state.live = [];
    f.state.at += 60000;
    assert.equal(await f.yt.collectOnce(), 300000);
    assert.equal(f.count('liveBroadcasts'), 2);
    assert.equal(reads('live'), 4, 'three live reads plus the existing archive read of the ended stream');
    assert.deepEqual(f.snapshots.broadcasts!.data, []);
    assert.equal(f.snapshots.broadcasts!.updatedAt, f.state.at);
    // Offline, every cycle discovers again: an empty list is never reused.
    f.state.at += 300000;
    await f.yt.collectOnce();
    assert.equal(f.count('liveBroadcasts'), 3);
    f.state.live = [{ id: 'next', chat: 'chat2' }];
    f.state.at += 300000;
    await f.yt.collectOnce();
    assert.equal(f.count('liveBroadcasts'), 4);
    assert.equal(reads('next'), 1);
    // The listing still names the stream while its video says ended: one rediscovery, and the same IDs reuse that video read.
    f.state.ended.add('next');
    f.state.at += 60000;
    await f.yt.collectOnce();
    assert.equal(f.count('liveBroadcasts'), 5);
    assert.equal(reads('next'), 2);
    // A different list after a failed confirmation reads its own videos.
    f.state.live = [{ id: 'third', chat: 'chat3' }];
    f.state.at += 60000;
    await f.yt.collectOnce();
    assert.equal(f.count('liveBroadcasts'), 6);
    assert.equal(reads('third'), 1);
    // Restarting forgets the reused list.
    await f.yt.stop();
    f.state.at += 60000;
    await f.yt.collectOnce();
    assert.equal(f.count('liveBroadcasts'), 7);
  } finally {
    await f.yt.stop();
  }
});

test('an active chat is read every 60 s up to a 90 s long-run average; a quiet one every 120 s; cursors chain so nothing is skipped', async () => {
  assert.deepEqual(YOUTUBE_CHAT_PACE, {
    activeMs: 60000,
    quietMs: 120000,
    averageMs: 90000,
    burst: 4,
    toleranceMs: 5000,
  });
  const f = fixture();
  try {
    const hours = 6,
      delays = await f.run(hours * 3600000);
    assert.ok(
      delays.every((delay) => delay === 60000),
      'viewers and the loop stay per minute',
    );
    const polls = f.calls.filter((c) => c.path === 'messages');
    assert.ok(
      polls.length <= (hours * 3600000) / 90000 + YOUTUBE_CHAT_PACE.burst,
      `${polls.length} reads stay within the 90 s average`,
    );
    assert.ok(polls.length >= (hours * 3600000) / 90000 - 1, `${polls.length} reads keep the 90 s average`);
    for (let i = 1; i < polls.length; i++) {
      assert.ok(
        polls[i]!.at - polls[i - 1]!.at >= 60000 && polls[i]!.at - polls[i - 1]!.at <= 120000,
        'active reads are 60 to 120 s apart',
      );
      assert.equal(polls[i]!.params.get('pageToken'), `page-${i}`, 'every read continues from the previous cursor');
    }
    assert.equal(polls[0]!.params.get('pageToken'), null);
    assert.equal(f.messages.length, polls.length);
    // A quiet chat backs off to 120 s; a message brings it back to 60 s.
    f.state.messages = 0;
    const quietStart = f.calls.length;
    await f.run(3600000);
    const quiet = f.calls.slice(quietStart).filter((c) => c.path === 'messages');
    assert.ok(quiet.length >= 29 && quiet.length <= 31, `${quiet.length} quiet reads per hour`);
    for (let i = 1; i < quiet.length; i++) assert.equal(quiet[i]!.at - quiet[i - 1]!.at, 120000);
    f.state.messages = 2;
    const activeStart = f.calls.length;
    await f.run(600000);
    const active = f.calls.slice(activeStart).filter((c) => c.path === 'messages');
    assert.ok(active.length >= 8, `${active.length} reads in ten active minutes after a quiet hour`);
    // YouTube's pollingIntervalMillis remains a floor for both the chat and the loop.
    f.state.floor = 150000;
    await f.run(60000);
    const floorStart = f.calls.length;
    const slow = await f.run(1500000);
    assert.ok(slow.every((delay) => delay === 150000));
    const floored = f.calls.slice(floorStart).filter((c) => c.path === 'messages');
    assert.equal(floored.length, 10);
  } finally {
    await f.yt.stop();
  }
});

test('a chat read failing on a reused broadcast list confirms the broadcast before reporting an error', async () => {
  const gone = fixture();
  try {
    await gone.yt.collectOnce();
    gone.state.at += 60000;
    gone.state.chatError = 1;
    gone.state.live = [];
    assert.equal(await gone.yt.collectOnce(), 300000, 'an ended chat is not an error');
    assert.equal(gone.count('liveBroadcasts'), 2);
  } finally {
    await gone.yt.stop();
  }
  const listed = fixture();
  try {
    await listed.yt.collectOnce();
    listed.state.at += 60000;
    listed.state.chatError = 1;
    await assert.rejects(listed.yt.collectOnce(), /YOUTUBE_ACCESS_OR_QUOTA/);
    assert.equal(listed.count('liveBroadcasts'), 2);
  } finally {
    await listed.yt.stop();
  }
  const other = fixture();
  try {
    await other.yt.collectOnce();
    other.state.at += 60000;
    other.state.chatError = 1;
    other.state.live = [{ id: 'other', chat: 'other-chat' }];
    assert.equal(await other.yt.collectOnce(), 60000, 'another live broadcast keeps the live cadence');
  } finally {
    await other.yt.stop();
  }
  const fresh = fixture();
  try {
    fresh.state.chatError = 1;
    await assert.rejects(fresh.yt.collectOnce(), /YOUTUBE_ACCESS_OR_QUOTA/);
    assert.equal(fresh.count('liveBroadcasts'), 1, 'a fresh list is not rediscovered');
  } finally {
    await fresh.yt.stop();
  }
});

test('a chat cannot be read before YouTube’s deadline, even after the collector restarts', async () => {
  const f = fixture();
  try {
    f.state.floor = 65000;
    await f.yt.collectOnce();
    f.state.at += 60000;
    await f.yt.collectOnce();
    assert.equal(f.count('messages'), 1);
    await f.yt.stop();
    f.state.at += 4999;
    await f.yt.collectOnce();
    assert.equal(f.count('messages'), 1);
    f.state.at += 1;
    await f.yt.collectOnce();
    assert.equal(f.count('messages'), 2);
    assert.equal(f.calls.filter((call) => call.path === 'messages')[1]?.params.get('pageToken'), 'page-1');
  } finally {
    await f.yt.stop();
  }
});

test('the supplementary chat reuses its broadcast list for 5 minutes and rediscovers when the chat reports offline', async () => {
  const f = fixture({ chatOnly: true });
  try {
    const delays = await f.run(1800000);
    assert.ok(delays.every((delay) => delay === 60000));
    assert.equal(f.count('liveBroadcasts'), 6);
    assert.equal(f.count('videos'), 0);
    assert.ok(f.count('messages') <= 1800000 / 90000 + YOUTUBE_CHAT_PACE.burst);
    f.state.offlineAt = new Date(f.state.at).toISOString();
    f.state.at += 60000;
    const read = f.count('messages');
    while (f.count('messages') === read) {
      await f.yt.collectOnce();
      f.state.at += 60000;
    }
    // The offline chat dropped the reused list, so the very next cycle rediscovers instead of waiting out the 5 minutes.
    f.state.live = [];
    const before = f.count('liveBroadcasts');
    assert.equal(await f.yt.collectOnce(), 300000);
    assert.equal(f.count('liveBroadcasts'), before + 1);
  } finally {
    await f.yt.stop();
  }
});

test('a video that stops being live in snippet.liveBroadcastContent is rediscovered at once, before actualEndTime appears', async () => {
  const f = fixture();
  try {
    await f.yt.collectOnce();
    f.state.at += 60000;
    await f.yt.collectOnce();
    assert.equal(f.count('liveBroadcasts'), 1, 'live video keeps the reused list');
    // YouTube already moved the stream out of live but has not published actualEndTime yet.
    f.state.notLive.add('live');
    f.state.live = [];
    f.state.at += 60000;
    const videos = f.count('videos');
    assert.equal(await f.yt.collectOnce(), 300000);
    assert.equal(f.count('liveBroadcasts'), 2, 'rediscovered in the same cycle');
    assert.deepEqual(f.snapshots.broadcasts!.data, []);
    assert.ok(f.count('videos') >= videos + 1);
    // Same signal while the listing still names the stream: one rediscovery, nothing else changes.
    const g = fixture();
    try {
      await g.yt.collectOnce();
      g.state.at += 60000;
      g.state.notLive.add('live');
      await g.yt.collectOnce();
      assert.equal(g.count('liveBroadcasts'), 2, 'listing still names it: one rediscovery');
    } finally {
      await g.yt.stop();
    }
  } finally {
    await f.yt.stop();
  }
});

test('the last page of an ended broadcast is read once without waiting for the quiet cadence', async () => {
  const f = fixture();
  try {
    f.state.messages = 0;
    await f.yt.collectOnce();
    f.state.at += 60000;
    f.state.live = [];
    f.state.ended.add('live');
    f.state.messages = 1;
    assert.equal(await f.yt.collectOnce(), 300000);
    assert.equal(f.count('messages'), 2);
    const polls = f.calls.filter((call) => call.path === 'messages');
    assert.equal(polls.at(-1)?.params.get('pageToken'), 'page-1');
    assert.equal(f.messages.at(-1)?.[1].length, 1);
    f.state.at += 300000;
    await f.yt.collectOnce();
    assert.equal(f.count('messages'), 2);
  } finally {
    await f.yt.stop();
  }
});

test('a closed supplementary chat is not retried after the final read is rejected', async () => {
  const f = fixture({ chatOnly: true });
  try {
    await f.yt.collectOnce();
    f.state.at += YOUTUBE_LIVE_DISCOVERY_MS;
    f.state.live = [];
    f.state.chatError = 1;
    assert.equal(await f.yt.collectOnce(), 300000);
    f.state.at += 300000;
    await f.yt.collectOnce();
    assert.equal(f.count('messages'), 2);
    assert.equal(f.yt.status.state, 'connected');
  } finally {
    await f.yt.stop();
  }
});
