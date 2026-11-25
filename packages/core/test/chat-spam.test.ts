import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatSpam } from '../src/chat-spam.js';
import type { EventInput } from '../src/domain.js';
import { StreamStore } from '../src/store.js';

test('chat flood limits use publication time and isolate senders and chats', () => {
  const filter = new ChatSpam();
  const at = 100_000;
  const chat = ['owner', 'chat'];
  for (let i = 0; i < 20; i++) assert.equal(filter.allow(chat, 'viewer', String(i), at, `Message ${i}`), true);
  assert.equal(filter.allow(chat, 'viewer', '0', at, 'Message 0'), true, 'retry does not consume capacity');
  assert.equal(filter.allow(chat, 'viewer', 'late', at - 40_000, 'Old history'), true);
  assert.equal(filter.allow(chat, 'viewer', 'blocked', at + 9999, 'Still flooding'), false);
  assert.equal(filter.allow(chat, 'viewer', 'recovered', at + 10_000, 'New message'), true);
  assert.equal(filter.allow(chat, 'another', 'blocked', at, 'New sender'), true);
  assert.equal(filter.allow(['owner', 'other-chat'], 'viewer', 'blocked', at, 'Other chat'), true);
  for (let i = 0; i < 1024; i++) assert.equal(filter.allow(chat, `user-${i}`, '1', at, 'Hi'), true);
  assert.equal(filter.allow(chat, 'viewer', 'after-eviction', at, 'New message'), true);
});

test('Twitch chat spam creates neither a permanent event nor a person or recent entry', (t) => {
  const store = new StreamStore(':memory:');
  t.after(() => store.close());
  const at = Date.now() - 60_000;
  store.startSession('owner', 'stream', at - 1000, 'platform', at - 1000);
  const message = (id: string, text: string, actor = 'viewer', time = at): EventInput => ({
    source: 'twitch',
    accountId: 'owner',
    externalId: id,
    type: 'chat.message',
    actor: { externalId: actor, displayName: actor },
    occurredAtMs: time,
    receivedAtMs: at,
    sourceTime: null,
    timeQuality: 'provider',
    transport: 'eventsub',
    payload: { text },
  });
  const promotion = message('promotion', 'Want to become famous? Buy followers at https://example.com', 'spammer');
  assert.deepEqual(store.ingest(promotion), { inserted: false, identityId: null, personId: null });
  assert.equal(
    store.persons().some((person) => person.display_name === 'spammer'),
    false,
  );

  for (const [index, text] of [
    'Repeated chat message',
    ' REPEATED CHAT MESSAGE ',
    'Repeated   chat message',
  ].entries()) {
    assert.equal(store.ingest(message(`normal-${index}`, text)).inserted, true);
  }
  assert.equal(store.ingest(message('repeat', 'repeated chat message')).inserted, false);
  assert.equal(store.ingest(message('regular-link', 'Here is the clip https://example.com')).inserted, true);
  assert.equal(store.ingest(message('later', 'Repeated chat message', 'viewer', at + 30_000)).inserted, true);
  assert.equal(store.summary().messages, 5);
  assert.equal(store.recentEvents().length, 5);
});

test('YouTube applies the filter across polls and keeps Super Chats and moderation', (t) => {
  const store = new StreamStore(':memory:');
  t.after(() => store.close());
  const publishedAt = new Date(Date.now() - 1000).toISOString();
  const message = (id: string, text: string, channelId = 'viewer') => ({
    id,
    snippet: { publishedAt, type: 'textMessageEvent', textMessageDetails: { messageText: text } },
    authorDetails: { channelId },
  });
  const regular = message('first', 'Any good recommendations?');
  const ad = message('spam', 'Накрутка зрителей — example.ru', 'spammer');
  store.youtubeMessages('owner', 'chat', [regular, ad]);
  assert.equal(
    store.persons().some((person) => person.display_name === 'spammer'),
    false,
  );
  store.youtubeMessages('owner', 'chat', [regular, { ...regular, id: 'second' }, { ...regular, id: 'third' }]);
  const repeat = { ...regular, id: 'repeat' };
  store.youtubeMessages('owner', 'chat', [
    repeat,
    { ...ad, id: 'paid', snippet: { ...ad.snippet, type: 'superChatEvent' } },
    { id: 'moderated', snippet: { publishedAt, type: 'messageDeletedEvent' } },
    { id: 'anonymous', snippet: regular.snippet },
  ]);
  store.youtubeMessages('owner', 'other-chat', [{ ...repeat, id: 'other-chat' }]);
  const expected = ['anonymous', 'first', 'moderated', 'other-chat', 'paid', 'second', 'third'];
  assert.deepEqual(
    store
      .youtubeData('owner')
      .messages.map((row) => row.id)
      .sort(),
    expected,
  );
  assert.deepEqual(
    store
      .recentEvents()
      .map((row) => row.external_id)
      .sort(),
    expected,
  );
});
