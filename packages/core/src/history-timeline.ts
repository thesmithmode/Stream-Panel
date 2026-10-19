import {dateTimeFormatter} from './date-time-formatter.js';
import type { audienceAnalytics } from './analytics.js';
import { localDateWindow } from './time-audience.js';
type Report = ReturnType<typeof audienceAnalytics>;
type DayRow = Report['timeline'][number] & {
    n: number;
    known: number;
    tw: number;
    twN: number;
    yt: number;
    ytN: number;
};
type SignalField = 'observed' | 'estimated' | 'participants' | 'regularObserved' | 'regularEstimated' | 'regularParticipants' | 'followerObserved' | 'followerEstimated' | 'followerParticipants';
type MessageField = 'regularMessages' | 'regularTwitchMessages' | 'regularYoutubeMessages' | 'followerMessages' | 'followerTwitchMessages' | 'followerYoutubeMessages';
/** Daily means preserve duration weighting; message counts remain sums. */
export class HistoryTimeline {
    private rows = new Map<number, DayRow>();
    private dates = new Map<string, number>();
    private formatter: Intl.DateTimeFormat;
    constructor(private timezone: string, private people: Pick<ReadonlyMap<string, {
        core: boolean;
        follower: boolean | null;
    }>,'get'>) { this.formatter = dateTimeFormatter('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }); }
    private day(at: number) { const label = this.formatter.format(at); let start = this.dates.get(label); if (start === undefined) {
        start = localDateWindow(label, this.timezone).from;
        this.dates.set(label, start);
    } return start; }
    add(report: Report) {
        const weights = new Map<number, number>(), byMinute = new Map(report.timeline.map(p => [p.at, p]));
        for (const point of report.timeline) {
            const weight = report.activityWindows.reduce((n, w) => n + Math.max(0, Math.min(point.at + 60000, w.to) - Math.max(point.at, w.from)) / 60000, 0);
            if (!weight)
                continue;
            weights.set(point.at, weight);
            const at = this.day(point.at);
            let row = this.rows.get(at);
            if (!row) {
                row = { presenceKnown: false, viewers: null, twitchViewers: null, youtubeViewers: null, unknownMessages: 0, unknownTwitchMessages: 0, unknownYoutubeMessages: 0, at, n: 0, known: 0, tw: 0, twN: 0, yt: 0, ytN: 0, messages: 0, twitchMessages: 0, youtubeMessages: 0, observed: 0, estimated: 0, participants: 0, regularObserved: 0, regularEstimated: 0, regularParticipants: 0, followerObserved: 0, followerEstimated: 0, followerParticipants: 0, regularMessages: 0, regularTwitchMessages: 0, regularYoutubeMessages: 0, followerMessages: 0, followerTwitchMessages: 0, followerYoutubeMessages: 0, viewersPartial: false };
                this.rows.set(at, row);
            }
            row.n += weight;
            if (point.presenceKnown) {
                row.known += weight;
                row.observed += point.observed * weight;
            }
            row.estimated += point.estimated * weight;
            row.participants += point.participants * weight;
            for (const field of ['messages', 'twitchMessages', 'youtubeMessages'] as const)
                row[field] += point[field];
            if (point.twitchViewers !== null) {
                row.tw += point.twitchViewers * weight;
                row.twN += weight;
            }
            if (point.youtubeViewers !== null) {
                row.yt += point.youtubeViewers * weight;
                row.ytN += weight;
            }
            row.viewersPartial ||= point.viewersPartial ?? false;
        }
        for (const person of report.audience) {
            const global = this.people.get(person.id), role = global?.core ? 'regular' : global?.follower ? 'follower' : null;
            if (!role)
                continue;
            const seen = new Set<string>();
            for (const span of person.intervals)
                for (let at = Math.floor(span.from / 60000) * 60000; at < span.to; at += 60000) {
                    const weight = weights.get(at) ?? 0;
                    if (!weight)
                        continue;
                    const row = this.rows.get(this.day(at))!;
                    const kind = span.kind === 'observed' ? 'Observed' : 'Estimated', key = kind + ':' + at;
                    if (!seen.has(key)) {
                        seen.add(key);
                        if (kind === 'Estimated' || byMinute.get(at)?.presenceKnown)
                            row[(role + kind) as SignalField] += weight;
                    }
                    if (!seen.has('all:' + at)) {
                        seen.add('all:' + at);
                        row[(role + 'Participants') as SignalField] += weight;
                    }
                }
            for (const signal of person.messageCounts) {
                const row = this.rows.get(this.day(signal.at));
                if (!row)
                    continue;
                row[(role + 'Messages') as MessageField] += signal.count;
                row[(role + (signal.source === 'twitch' ? 'TwitchMessages' : 'YoutubeMessages')) as MessageField] += signal.count;
            }
        }
    }
    values(): Report['timeline'] {
        return [...this.rows.values()].sort((a, b) => a.at - b.at).map(row => {
            const { n, known, tw, twN, yt, ytN, ...base } = row;
            const twitchViewers = twN ? tw / twN : null, youtubeViewers = ytN ? yt / ytN : null;
            const point = { ...base, presenceKnown: row.known > 0, twitchViewers, youtubeViewers, viewers: twitchViewers === null && youtubeViewers === null ? null : (twitchViewers ?? 0) + (youtubeViewers ?? 0) };
            for (const role of ['', 'regular', 'follower'])
                for (const kind of ['Observed', 'Estimated', 'Participants']) {
                    const field = (role ? role + kind : kind[0]!.toLowerCase() + kind.slice(1)) as SignalField;
                    point[field] = row[field] / (kind === 'Observed' ? known || 1 : n || 1);
                }
            point.unknownMessages = Math.max(0, row.messages - row.regularMessages - row.followerMessages);
            point.unknownTwitchMessages = Math.max(0, row.twitchMessages - row.regularTwitchMessages - row.followerTwitchMessages);
            point.unknownYoutubeMessages = Math.max(0, row.youtubeMessages - row.regularYoutubeMessages - row.followerYoutubeMessages);
            return point;
        });
    }
}
