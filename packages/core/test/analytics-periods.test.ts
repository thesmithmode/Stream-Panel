import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamStore } from '../src/store.js';

const day = 86400000;

test('analytics accepts arbitrary multi-year dates and all-time without expanding empty days', () => {
    const store = new StreamStore(':memory:');
    const oldStart = Date.UTC(2000, 0, 1);
    try {
        for (const days of [180, 365, 366, 730, 3650]) {
            const result = store.analytics({ fromMs: oldStart, toMs: oldStart + days * day });
            assert.equal(result.summary.streams, 0);
        }
        assert.throws(() => store.analytics({ fromMs: oldStart, toMs: 8640000000000001 }), /INVALID_ANALYTICS_FILTER/);

        const sessionId = store.startSession('channel', 'old-platform-stream', oldStart, 'platform', oldStart);
        store.streamSample(sessionId, oldStart, 'game', 'Game', 'Old stream', 12);
        store.endSession(sessionId, oldStart + 2 * 60000, 'observed');
        const history = store.analytics({ fromMs: 0, toMs: Date.UTC(2026, 9, 9) });
        assert.equal(history.summary.streams, 1);
        assert.equal(history.sessions.some(session => session.id === sessionId), true);
        const recentStart=Date.UTC(2026,0,1), recent=store.startSession('channel','recent-stream',recentStart,'platform',recentStart);
        store.streamSample(recent,recentStart,'other','Other game','Recent stream',5);
        store.endSession(recent,recentStart+2*60000,'observed');
        const custom=store.analytics({fromMs:oldStart,toMs:recentStart+day});
        assert.equal(custom.summary.streams,2);
        assert.deepEqual(new Set(custom.sessions.map(row=>row.id)),new Set([sessionId,recent]));
        assert.ok(custom.timeline.length<=6,'decades between real streams do not become empty minute rows');
        const clipped=store.analytics({fromMs:oldStart+day,toMs:recentStart+day});
        assert.deepEqual(clipped.sessions.map(row=>row.id),[recent]);

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
