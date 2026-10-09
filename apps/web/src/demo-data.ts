/** In-memory demo fixtures. Never touches SQLite or secrets.json.
 * Entity model: Viewer (Twitch) / Donor (DA name) / Person (link umbrella).
 */

const now = Date.now();
const minute = 60_000;
const hour = 60 * minute;

function id(prefix: string, n: number) {
  return `demo-${prefix}-${n}`;
}

const sessionLiveId = id("session", 1);
const sessionPastId = id("session", 2);

const people = [
  {
    id: id("person", 1),
    display_name: "Алиса",
    revision: 1,
    event_count: 42,
    sources: "twitch,donationalerts",
  },
  {
    id: id("person", 2),
    display_name: "Борис",
    revision: 1,
    event_count: 28,
    sources: "twitch",
  },
  {
    id: id("person", 3),
    display_name: "Вика",
    revision: 1,
    event_count: 19,
    sources: "donationalerts",
  },
  {
    id: id("person", 4),
    display_name: "Глеб",
    revision: 1,
    event_count: 11,
    sources: "twitch",
  },
  {
    id: id("person", 5),
    display_name: "Дина",
    revision: 1,
    event_count: 7,
    sources: "twitch,donationalerts",
  },
];

const sessions = [
  {
    id: sessionLiveId,
    kind: "platform",
    account_id: "demo-twitch",
    started_at_ms: now - 90 * minute,
    ended_at_ms: null as number | null,
    event_count: 86,
    end_quality: "exact",
  },
  {
    id: sessionPastId,
    kind: "manual",
    account_id: "local",
    started_at_ms: now - 2 * hour - 40 * minute,
    ended_at_ms: now - 2 * hour,
    event_count: 54,
    end_quality: "exact",
  },
];

const chatTexts = [
  "привет стрим!",
  "когда новая песня?",
  "лол",
  "ого донат",
  "можно трек?",
  "GG",
  "как дела?",
  "поддерживаю",
];

function buildEvents() {
  const rows: any[] = [];
  let n = 0;
  for (let i = 0; i < 24; i++) {
    const person = people[i % people.length]!;
    rows.push({
      id: id("evt", ++n),
      type: "chat.message",
      source: "twitch",
      display_name: person.display_name,
      person_id: person.id,
      occurred_at_ms: now - (80 - i) * minute,
      received_at_ms: now - (80 - i) * minute + 200,
      time_quality: "exact",
      payload: {
        text: chatTexts[i % chatTexts.length],
        actorName: person.display_name,
      },
    });
  }
  rows.push({
    id: id("evt", ++n),
    type: "donation",
    source: "donationalerts",
    display_name: "Алиса",
    person_id: people[0]!.id,
    occurred_at_ms: now - 45 * minute,
    received_at_ms: now - 45 * minute,
    time_quality: "exact",
    payload: {
      text: "На развитие панели",
      amountMinor: "50000",
      currency: "RUB",
      actorName: "Алиса",
      messageType: "text",
    },
  });
  rows.push({
    id: id("evt", ++n),
    type: "donation",
    source: "donationalerts",
    display_name: "Вика",
    person_id: people[2]!.id,
    occurred_at_ms: now - 30 * minute,
    received_at_ms: now - 30 * minute,
    time_quality: "exact",
    payload: {
      text: "",
      amountMinor: "10000",
      currency: "RUB",
      actorName: "Вика",
      messageType: "audio",
    },
  });
  rows.push({
    id: id("evt", ++n),
    type: "donation",
    source: "donationalerts",
    display_name: "Дина",
    person_id: people[4]!.id,
    occurred_at_ms: now - 12 * minute,
    received_at_ms: now - 12 * minute,
    time_quality: "exact",
    payload: {
      text: "Удачи на стриме!",
      amountMinor: "25000",
      currency: "RUB",
      actorName: "Дина",
      messageType: "text",
    },
  });
  rows.push({
    id: id("evt", ++n),
    type: "follow",
    source: "twitch",
    display_name: "Глеб",
    person_id: people[3]!.id,
    occurred_at_ms: now - 55 * minute,
    received_at_ms: now - 55 * minute,
    time_quality: "exact",
    payload: { actorName: "Глеб", text: "" },
  });
  return rows.sort(
    (a, b) => (b.occurred_at_ms ?? 0) - (a.occurred_at_ms ?? 0),
  );
}

let events = buildEvents();

const chattersOverTime = Array.from({ length: 18 }, (_, i) => ({
  atMs: now - (90 - i * 5) * minute,
  chatters: 8 + ((i * 3) % 11),
}));

function summaryFor(session?: string) {
  const scoped = session
    ? events.filter(() => true) // demo: same pool is enough for UI walkthrough
    : events;
  const donations = scoped.filter((e) => e.type === "donation");
  const messages = scoped.filter((e) => e.type === "chat.message");
  const totals: Record<string, string> = {};
  for (const d of donations) {
    const c = String(d.payload.currency || "RUB");
    const a = BigInt(d.payload.amountMinor || "0");
    totals[c] = String(BigInt(totals[c] || "0") + a);
  }
  return {
    messages: messages.length,
    donations: donations.length,
    totals,
    chatters: 14,
    lastPollAtMs: now - 2 * minute,
    events: scoped.length,
    uniquePersons: people.length,
    uniqueIdentities: people.length + 2,
    uniquePersonsObserved: 4,
    uniqueIdentitiesObserved: 4,
    messagesPerMinuteOfSession: 0.42,
    sessionDurationMs: 90 * minute,
    coverage: { knownMinutes: 72, totalMinutes: 90, ratio: 0.8 },
    chattersOverTime,
    gapCount: 1,
  };
}

function personDetail(personId: string) {
  const person = people.find((p) => p.id === personId);
  if (!person) throw new Error("PERSON_NOT_FOUND");
  const identities = [
    {
      id: `${personId}-ident-0`,
      display_name: person.display_name,
      source: person.sources.includes("twitch") ? "twitch" : "donationalerts",
      external_id: `ext-${personId}`,
    },
  ];
  if (person.sources.includes("donationalerts") && person.sources.includes("twitch")) {
    identities.push({
      id: id("ident-da", 9),
      display_name: person.display_name,
      source: "donationalerts",
      external_id: `da-${personId}`,
    });
  }
  return {
    ...person,
    identities: identities.map((x, i) => ({
      ...x,
      id: `${personId}-ident-${i}`,
    })),
    events: events.filter((e) => e.person_id === personId).slice(0, 50),
  };
}

function personStats(personId: string) {
  const person = people.find((p) => p.id === personId);
  if (!person) throw new Error("PERSON_NOT_FOUND");
  const pe = events.filter((e) => e.person_id === personId);
  const donations = pe.filter((e) => e.type === "donation");
  const totals: Record<string, string> = {};
  for (const d of donations) {
    const c = String(d.payload.currency || "RUB");
    totals[c] = String(
      BigInt(totals[c] || "0") + BigInt(d.payload.amountMinor || "0"),
    );
  }
  return {
    personId,
    displayName: person.display_name,
    sessionId: sessionLiveId,
    messageCount: pe.filter((e) => e.type === "chat.message").length,
    donationCount: donations.length,
    donationTotals: totals,
    firstEventMs: pe.at(-1)?.occurred_at_ms ?? null,
    lastEventMs: pe[0]?.occurred_at_ms ?? null,
    firstObservedMs: now - 80 * minute,
    lastObservedMs: now - 3 * minute,
    observedMinutesThisSession: 48,
    avgObservedMinutes: 36,
    avgFirstObservedOffsetMs: 4 * minute,
    sessionsWithObservation: 2,
    totalObservedMinutes: 72,
    recordedStreams: 3,
    attendanceRatio: 2 / 3,
    followedAtMs: null,
    watchingSinceMs: now - 80 * minute,
    observedBeforeFollowMinutes: null,
  };
}

function presenceGrid(from: number, to: number) {
  const cells: { minuteStartMs: number; state: string }[] = [];
  for (let t = from; t < to && cells.length < 120; t += minute) {
    const slot = Math.floor((t - from) / minute);
    const state =
      slot % 7 === 0 ? "unknown" : slot % 3 === 0 ? "not_observed" : "observed";
    cells.push({ minuteStartMs: t, state });
  }
  return cells;
}

function parseQuery(path: string) {
  const q = path.includes("?") ? path.slice(path.indexOf("?") + 1) : "";
  return new URLSearchParams(q);
}

function basePath(path: string) {
  return (path.split("?")[0] ?? path).replace(/^\/+/, "");
}

export type DataMode = "real" | "demo";

let mode: DataMode = "real";

export function getDataMode(): DataMode {
  return mode;
}

export function setDataMode(next: DataMode) {
  mode = next;
}

/** Handle /api/v1/* paths when demo mode is active. Returns null to fall through (should not happen). */
export async function demoApi(path: string, body?: unknown): Promise<unknown> {
  const p = basePath(path);
  const q = parseQuery(path);
  const isPost = body !== undefined;
  if (/^persons\/[^/]+\/metadata$/.test(p)) {
    if(isPost)throw new Error("Метки доступны после подключения к серверу");
    return {revision:0,tags:[],manualCore:null};
  }
  if (/^persons\/[^/]+\/notes(?:\/[^/]+\/(?:update|delete))?$/.test(p)) {
    if (isPost) throw new Error("Заметки доступны после подключения к серверу");
    return [];
  }

  if (p === "analytics") {
    const from=Number(q.get("from")),to=Number(q.get("to")),start=Math.max(from,to-2*hour),source=q.get("source")||"all";
    const regularThresholdPercent=Number(q.get("regularThresholdPercent")??50);
    const rows=people.slice(0,3).map((p,i)=>{const attendanceSessionIds=i===0?[sessionLiveId,sessionPastId]:[sessionLiveId],attendanceRatio=attendanceSessionIds.length/2;return {id:p.id,name:p.display_name,source:"twitch",messages:20-i*5,observedMinutes:60-i*10,estimatedChatMinutes:0,sessionIds:attendanceSessionIds,attendanceSessionIds,attendanceRatio,regular:attendanceRatio*100>regularThresholdPercent,intervals:[{from:start,to:start+(60-i*10)*minute,session:sessionLiveId,kind:"observed"}],donations:{},core:attendanceSessionIds.length>=Number(q.get("minSessions")||3)};}).filter(()=>source!=="youtube");
    const timeline=Array.from({length:90},(_,i)=>{const observed=Math.min(rows.length,1+i%3),regularObserved=rows.slice(0,observed).filter(r=>r.regular).length,messages=rows.length?i%4:0;return {at:Math.floor(start/minute)*minute+i*minute,messages,regularMessages:rows[0]?.regular?messages:0,observed,regularObserved,estimated:0,regularEstimated:0,viewers:8+i%5,presenceKnown:i%13!==0};});
    const regulars=rows.filter(r=>r.regular).length;
    return {filters:{regularThresholdPercent},summary:{entities:rows.length,attendees:rows.length,regulars,regularShare:rows.length?regulars/rows.length:null,core:rows.filter(r=>r.core).length,streams:2,messages:rows.reduce((a,r)=>a+r.messages,0)},audience:rows,timeline,hours:[{day:"пн",hour:20,observed:120,observedKnownMinutes:60,estimated:0,messages:40,sampleMinutes:60}],categories:[{id:"demo-game",name:"Демо-игра",minutes:120,sessions:2,audience:rows.length,core:rows.filter(r=>r.core).length,messagesPerHour:30,observedMinutes:150,estimatedChatMinutes:0}]};
  }

  if (p === "status") {
    return {
      twitch: {
        state: "connected",
        detail: "Демо: чат и присутствие",
        account: "demo_streamer",
        capabilities: { presence: "полный опрос", "channel.chat.message": "включено" },
      },
      donationalerts: {
        state: "connected",
        detail: "Демо: REST и realtime",
        account: "demo_da",
        capabilities: {
          realtime: "подключено",
          history: "Импорт доступных страниц завершён",
        },
      },
      device: null,
      config: {
        twitchClientId: "demo-twitch-client",
        daClientId: "demo-da-client",
        hasDaSecret: true,
        daUtcOffsetMinutes: 180,
        daRedirectUri: "http://127.0.0.1:47831/oauth/donationalerts/callback",
      },
      csrf: "demo-csrf",
      gaps: [
        {
          source: "twitch",
          reason: "DEMO_GAP",
          started_at_ms: now - hour,
        },
      ],
      dataMode: "demo",
    };
  }

  if (p === "sessions" && !isPost) return sessions;

  if (p === "sessions/start" && isPost) {
    if (sessions.some((s) => s.ended_at_ms === null))
      throw new Error("SESSION_ALREADY_OPEN");
    const row = {
      id: id("session", sessions.length + 1),
      kind: "manual",
      account_id: "local",
      started_at_ms: Date.now(),
      ended_at_ms: null as number | null,
      event_count: 0,
      end_quality: "exact",
    };
    sessions.unshift(row);
    return { id: row.id };
  }

  const stop = /^sessions\/([^/]+)\/stop$/.exec(p);
  if (stop?.[1] && isPost) {
    const s = sessions.find((x) => x.id === stop[1]);
    if (!s) throw new Error("SESSION_NOT_FOUND");
    if (s.kind !== "manual")
      throw new Error("PLATFORM_SESSION_MANAGED_AUTOMATICALLY");
    s.ended_at_ms = Date.now();
    return { ok: true };
  }

  if (p === "summary") return summaryFor(q.get("session") || undefined);

  if (p === "events") {
    let rows = events;
    const person = q.get("person");
    const from = q.get("from");
    const to = q.get("to");
    if (person) rows = rows.filter((e) => e.person_id === person);
    if (from) rows = rows.filter((e) => (e.occurred_at_ms ?? 0) >= Number(from));
    if (to) rows = rows.filter((e) => (e.occurred_at_ms ?? 0) < Number(to));
    return rows.slice(0, 200);
  }

  if (p === "persons") {
    const search = (q.get("search") || "").trim().toLowerCase();
    if (!search) return people;
    return people.filter((x) => x.display_name.toLowerCase().includes(search));
  }

  if (p === "persons/tops") {
    const by = q.get("by") || "messages";
    return people.map((person, i) => {
      const pe = events.filter((e) => e.person_id === person.id);
      const donations = pe.filter((e) => e.type === "donation");
      const totals: Record<string, string> = {};
      for (const d of donations) {
        const c = String(d.payload.currency || "RUB");
        totals[c] = String(
          BigInt(totals[c] || "0") + BigInt(d.payload.amountMinor || "0"),
        );
      }
      return {
        id: person.id,
        display_name: person.display_name,
        revision: person.revision,
        sources: person.sources,
        messageCount: pe.filter((e) => e.type === "chat.message").length + (5 - i),
        donationCount: donations.length,
        donationTotals: totals,
        observedMinutes: 20 + i * 7,
      };
    }).sort((a, b) => {
      if (by === "donations") return b.donationCount - a.donationCount;
      if (by === "observed_minutes") return b.observedMinutes - a.observedMinutes;
      return b.messageCount - a.messageCount;
    });
  }

  if (p === "insights") {
    return [
      {
        kind: "top_chatter",
        title: "Алиса чаще всех пишет в чат",
        detail: "Демо-паттерн: высокая доля сообщений за текущую сессию.",
        personId: people[0]!.id,
        sessionId: sessionLiveId,
        metrics: { messages: 12 },
      },
      {
        kind: "donor",
        title: "Вика отправила аудио-донат",
        detail: "Демо: проверьте отображение «Аудио» в ленте.",
        personId: people[2]!.id,
        sessionId: sessionLiveId,
        metrics: { amountMinor: "10000" },
      },
      {
        kind: "presence",
        title: "Покрытие опросов 80%",
        detail: "Демо: есть один искусственный пробел сбора.",
        personId: null,
        sessionId: sessionLiveId,
        metrics: { ratio: 0.8 },
      },
    ];
  }

  if (p === "donations") {
    if(isPost)throw new Error("Изменения донатов доступны после подключения к серверу");
    return {items:[],total:0,offset:0,limit:10};
  }
  if(p.startsWith("donations/"))throw new Error("Изменения донатов доступны после подключения к серверу");
  if (p === "merges" || p === "splits") return [];

  if (p === "presence") {
    const from = Number(q.get("from") || now - 90 * minute);
    const to = Number(q.get("to") || now);
    return presenceGrid(from, to);
  }

  if (p === "backup" && isPost) {
    return { filename: "demo-backup-not-written.sqlite" };
  }

  // Block real credential / connection mutations in demo.
  if (
    isPost &&
    /^(twitch\/|donationalerts\/|persons\/|merges\/|splits\/)/.test(p)
  ) {
    if (/\/rename$/.test(p)) {
      const m = /^persons\/([^/]+)\/rename$/.exec(p);
      if (m) {
        const person = people.find((x) => x.id === m[1]);
        const name = String((body as any)?.name || "").trim();
        if (!person || !name) throw new Error("INVALID_NAME");
        person.display_name = name;
        return { ok: true };
      }
    }
    throw new Error("DEMO_READONLY");
  }

  const personMatch = /^persons\/([^/]+)$/.exec(p);
  if (personMatch?.[1]) return personDetail(personMatch[1]);

  const statsMatch = /^persons\/([^/]+)\/stats$/.exec(p);
  if (statsMatch?.[1]) return personStats(statsMatch[1]);

  const candMatch = /^persons\/([^/]+)\/candidates$/.exec(p);
  if (candMatch?.[1]) {
    return people.filter((x) => x.id !== candMatch[1]).slice(0, 2).map((x) => x.id);
  }

  throw new Error(`DEMO_UNHANDLED:${p}`);
}
