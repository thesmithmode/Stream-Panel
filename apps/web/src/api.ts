import { createProfileSelection } from "./profile";

import {requestJson} from "./request";
let csrf = "";
const revisions=new Map<string,number>();
export const getDataRevision=(profile:string)=>revisions.get(profile)??0;
const serverVersions=new Map<string,Record<string,string>>();
export const getServerRevision=(profile:string,scope='report')=>serverVersions.get(profile)?.[scope]??'';
export const bumpReadRevision=(profile:string)=>revisions.set(profile,getDataRevision(profile)+1);
export function setServerVersions(profile:string,change:{versions:Record<string,number>;stream:{id:string;revision:number;endedAt:number|null}|null;configRevision?:string;dataEpoch?:string;checkedAt?:number;activeStream?:string|null;requestedSession?:string|null}){
 const config=[change.configRevision,change.dataEpoch];
 const v=change.versions,values=serverVersions.get(profile)??{};
 values.report=JSON.stringify([v.activity,v.people,v.donations,v.follows,config]);
 values.overview=JSON.stringify([v.activity,v.people,v.donations,config]);
 values.subscribers=JSON.stringify([v.activity,v.subscribers,v.follows,config]);
 if(change.stream){const value=JSON.stringify([change.stream,v.follows,config]);values['stream:'+change.stream.id]=value;if(change.requestedSession)values['stream:'+change.requestedSession]=value;}
 else if(change.requestedSession)values['stream:'+change.requestedSession]=JSON.stringify([null,config]);
 serverVersions.set(profile,values);
}

export type { Profile } from "./profile";
const selection = createProfileSelection(() => localStorage);
export const getProfile = selection.get;
export const setProfile = selection.set;
export const setCsrf = (value: string) => (csrf = value);
export async function importBackup(file:File,key:string){
  if(file.size>64*1024*1024*1024)throw new Error('BACKUP_SIZE_LIMIT');
  return requestJson('/api/v1/backups/restore',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-CSRF-Token':csrf,'X-Stream-Panel-Profile':getProfile(),...(key?{'X-Backup-Key':key}:{})},body:file,signal:new AbortController().signal,timeoutMs:30*60*1000});
}
const validators=new Map<string,{etag:string;value:unknown;bytes:number}>();
let validatorBytes=0;
export async function api<T = any>(path: string, body?: unknown, signal?: AbortSignal, profile: string = getProfile()): Promise<T> {
  const conditionalKey=JSON.stringify([profile,path]),retained=body===undefined?validators.get(conditionalKey):undefined;
  const result=await requestJson<T>(`/api/v1/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined
        ? { "X-Stream-Panel-Profile": profile,...(retained?{"If-None-Match":retained.etag}:{}) }
        : { "Content-Type": "application/json", "X-CSRF-Token": csrf, "X-Stream-Panel-Profile": profile },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(retained?{conditional:{etag:retained.etag,value:retained.value as T}}:{}),
    onResponse:(response,value)=>{const etag=response.headers.get('etag');if(!etag||body!==undefined)return;
      const bytes=JSON.stringify(value).length*2;if(bytes>4*1024*1024)return;
      validatorBytes-=validators.get(conditionalKey)?.bytes??0;validators.delete(conditionalKey);
      while(validators.size>=16||validatorBytes+bytes>8*1024*1024){const oldest=validators.keys().next().value!;validatorBytes-=validators.get(oldest)!.bytes;validators.delete(oldest);}
      validators.set(conditionalKey,{etag,value,bytes});validatorBytes+=bytes;
    },
    ...(signal ? {signal} : {}),
  });

  if(body!==undefined){revisions.set(profile,getDataRevision(profile)+1);for(const [key,value] of validators)if(JSON.parse(key)[0]===profile){validators.delete(key);validatorBytes-=value.bytes;}}
  return result;
}
export function money(minor: string, currency: string) {
  const value = BigInt(minor);
  return `${(value / 100n).toLocaleString("ru-RU")},${(value % 100n).toString().padStart(2, "0")} ${currency}`;
}
export function date(at: number | null) {
  return at === null
    ? "Время неизвестно"
    : new Date(at).toLocaleString("ru-RU",{timeZone:'Europe/Moscow'});
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
    redacted?: number | boolean;
    amountMinor?: string;
    currency?: string;
    actorName?: string;
    messageType?: string;
    originChannelId?: string;
  };
}
export interface Person {
  is_bot?: number;
  id: string;
  display_name: string;
  revision: number;
  event_count: number;
  sources: string;
}
export interface Session {
  memberIds?:string[];
  id: string;
  kind: string;
  account_id: string;
  started_at_ms: number;
  ended_at_ms: number | null;
  event_count: number;
  messageCount?:number;
  end_quality: string;
  durationMs?:number;viewerMean?:number|null;viewerPeak?:number|null;viewerKnownMean?:number|null;viewerKnownPeak?:number|null;viewerPartial?:boolean;donationTotals?:Record<string,string>;donationCount?:number;
  platforms?: Array<"twitch" | "youtube">;
  primaryTitle?: string | null;
  breaks?:Array<{from:number;to:number}>;
  confirmedUrls?: Array<{ platform: "twitch" | "youtube"; url: string }>;
}
export interface Summary {
  messages: number;
  donations: number;
  totals: Record<string, string>;
  chatters: number | null;
  lastPollAtMs: number | null;
  events: number;
  uniquePersons?: number;
  uniqueIdentities?: number;
  uniquePersonsObserved?: number | null;
  uniqueIdentitiesObserved?: number | null;
  messagesPerMinuteOfSession?: number | null;
  sessionDurationMs?: number | null;
  coverage?: {
    knownMinutes: number;
    totalMinutes: number;
    ratio: number | null;
  } | null;
  participants?: {personId:string;name:string;messages:number}[];
  chattersOverTime?: { atMs: number; chatters: number }[];
  gapCount?: number;
}
export interface PersonStats {
  personId: string;
  displayName: string;
  sessionId: string | null;
  messageCount: number;
  donationCount: number;
  donationTotals: Record<string, string>;
  firstEventMs: number | null;
  lastEventMs: number | null;
  firstObservedMs: number | null;
  lastObservedMs: number | null;
  observedMinutesThisSession: number | null;
  avgObservedMinutes: number | null;
  avgFirstObservedOffsetMs: number | null;
  sessionsWithObservation: number;
  sessionsWithAttendance?: number;
  estimatedChatMinutes?: number;
  totalObservedMinutes: number;
  recordedStreams: number;
  attendanceRatio: number | null;
  followedAtMs: number | null;
  watchingSinceMs: number | null;
  observedBeforeFollowMinutes: number | null;
}
export interface PersonTop {
  id: string;
  display_name: string;
  revision: number;
  sources: string;
  messageCount: number;
  donationCount: number;
  donationTotals: Record<string, string>;
  observedMinutes: number;
}
export type {InsightCard} from '../../../packages/core/src/insights';
