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
export type TimelineState = {rows: DayRow[]; people: [string, [number, number[]][]][]};
type MessageField = 'regularMessages' | 'regularTwitchMessages' | 'regularYoutubeMessages' | 'followerMessages' | 'followerTwitchMessages' | 'followerYoutubeMessages';
/** Daily means preserve duration weighting; message counts remain sums. */
export class HistoryTimeline {
    private rows = new Map<number, DayRow>();
    private personDays = new Map<string, Map<number, number[]>>();
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
            const cells=this.personDays.get(person.id)??new Map<number,number[]>();
            this.personDays.set(person.id,cells);
            const cell=(at:number)=>{const day=this.day(at);let row=cells.get(day);if(!row){row=[0,0,0,0,0,0];cells.set(day,row);}return row;};
            const seen = new Set<string>();
            for (const span of person.intervals)
                for (let at = Math.floor(span.from / 60000) * 60000; at < span.to; at += 60000) {
                    const weight = weights.get(at) ?? 0;
                    if (!weight)
                        continue;
                    const row = cell(at);
                    const kind = span.kind === 'observed' ? 'Observed' : 'Estimated', key = kind + ':' + at;
                    if (!seen.has(key)) {
                        seen.add(key);
                        if (kind === 'Estimated' || byMinute.get(at)?.presenceKnown)
                            row[kind==='Observed'?0:1]! += weight;
                    }
                    if (!seen.has('all:' + at)) {
                        seen.add('all:' + at);
                        row[2]! += weight;
                    }
                }
            for (const signal of person.messageCounts) {
                const row = this.rows.get(this.day(signal.at));
                if (!row)
                    continue;
                const counts=cell(signal.at);counts[3]!+=signal.count;counts[signal.source==='twitch'?4:5]!+=signal.count;
            }
        }
    }
    snapshot():TimelineState {return {rows:[...this.rows.values()],people:[...this.personDays].map(([id,rows])=>[id,[...rows]])};}
    append(state:TimelineState){
        for(const input of state.rows){const prior=this.rows.get(input.at);if(!prior){this.rows.set(input.at,{...input});continue;}
            for(const key of ['n','known','tw','twN','yt','ytN','messages','twitchMessages','youtubeMessages','observed','estimated','participants'] as const)prior[key]+=input[key];
            prior.viewersPartial=!!(prior.viewersPartial||input.viewersPartial);
        }
        for(const [id,rows] of state.people){const cells=this.personDays.get(id)??new Map<number,number[]>();this.personDays.set(id,cells);
            for(const [at,values] of rows){const prior=cells.get(at);if(prior)values.forEach((n,i)=>prior[i]!+=n);else cells.set(at,[...values]);}
        }
    }
    values(): Report['timeline'] {
        const roles=new Map<number,number[]>();
        for(const [id,cells] of this.personDays){const person=this.people.get(id),offset=person?.core?0:person?.follower?6:-1;if(offset<0)continue;
            for(const [at,values] of cells){const row=roles.get(at)??Array<number>(12).fill(0);roles.set(at,row);values.forEach((n,i)=>row[offset+i]!+=n);}
        }
        return [...this.rows.values()].sort((a, b) => a.at - b.at).map(row => {
            const { n, known, tw, twN, yt, ytN, ...neutral } = row;
            const base={...neutral},counts=roles.get(row.at)??Array<number>(12).fill(0);
            for(const [offset,role] of [[0,'regular'],[6,'follower']] as const){
                for(const [i,kind] of ['Observed','Estimated','Participants','Messages','TwitchMessages','YoutubeMessages'].entries())base[(role+kind) as SignalField|MessageField]=counts[offset+i]!;
            }
            const twitchViewers = twN ? tw / twN : null, youtubeViewers = ytN ? yt / ytN : null;
            const point = { ...base, presenceKnown: row.known > 0, twitchViewers, youtubeViewers, viewers: twitchViewers === null && youtubeViewers === null ? null : (twitchViewers ?? 0) + (youtubeViewers ?? 0) };
            for (const role of ['', 'regular', 'follower'])
                for (const kind of ['Observed', 'Estimated', 'Participants']) {
                    const field = (role ? role + kind : kind[0]!.toLowerCase() + kind.slice(1)) as SignalField;
                    point[field] = base[field] / (kind === 'Observed' ? known || 1 : n || 1);
                }
            point.unknownMessages = Math.max(0, base.messages - base.regularMessages - base.followerMessages);
            point.unknownTwitchMessages = Math.max(0, base.twitchMessages - base.regularTwitchMessages - base.followerTwitchMessages);
            point.unknownYoutubeMessages = Math.max(0, base.youtubeMessages - base.regularYoutubeMessages - base.followerYoutubeMessages);
            return point;
        });
    }
}
