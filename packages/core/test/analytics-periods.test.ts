import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamStore } from '../src/store.js';

const day = 86400000;

test('analytics accepts 180 and 365 days, rejects 366, and all-time includes old streams without empty-range expansion', () => {
    const store = new StreamStore(':memory:');
    const oldStart = Date.UTC(2000, 0, 1);
    try {
        for (const days of [180, 365]) {
            const result = store.analytics({ fromMs: oldStart, toMs: oldStart + days * day });
            assert.equal(result.summary.streams, 0);
        }
        assert.throws(() => store.analytics({ fromMs: oldStart, toMs: oldStart + 366 * day }), /INVALID_ANALYTICS_FILTER/);

        const sessionId = store.startSession('channel', 'old-platform-stream', oldStart, 'platform', oldStart);
        store.streamSample(sessionId, oldStart, 'game', 'Game', 'Old stream', 12);
        store.endSession(sessionId, oldStart + 2 * 60000, 'observed');
        const history = store.analytics({ fromMs: 0, toMs: Date.UTC(2026, 9, 9) });
        assert.equal(history.summary.streams, 1);
        assert.equal(history.sessions.some(session => session.id === sessionId), true);

        const empty = new StreamStore(':memory:');
        try {
            const result = empty.analytics({ fromMs: 0, toMs: Date.UTC(2026, 9, 9) });
            assert.equal(result.summary.streams, 0);
            assert.deepEqual(result.timeline, []);
        }
        finally {
            empty.close();
        }
    }
    finally {
        store.close();
    }
});
