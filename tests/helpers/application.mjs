import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { createApplication } from "../../dist/apps/daemon/src/server.js";
export async function application(transports = {}) {
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
  const dir = await mkdtemp(join(tmpdir(), "sp-e2e-"));
  const a = await createApplication(dir, port, false, transports);
  await a.app.listen({ host: "127.0.0.1", port });
  return {
    ...a,
    dir,
    origin: `http://127.0.0.1:${port}`,
    close: async () => {
      await a.app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
export async function seed(a) {
  const now = Date.now();
  const s = (await a.db.call("sessions")).find(
    (x) => x.ended_at_ms === null,
  ) || {
    id: await a.db.call(
      "startSession",
      "test-channel",
      "test-stream",
      now - 600000,
      "platform",
      now - 600000,
    ),
  };
  for (let i = 0; i < 8; i++)
    await a.db.call("ingest", {
      source: "twitch",
      accountId: "test-channel",
      externalId: "m" + i,
      type: "chat.message",
      actor: {
        externalId: i % 2 ? "42" : "43",
        displayName: i % 2 ? "Тестовый зритель" : "Другой зритель",
      },
      occurredAtMs: now - i * 60000,
      receivedAtMs: now,
      sourceTime: new Date(now - i * 60000).toISOString(),
      timeQuality: "provider",
      transport: "eventsub",
      payload: {
        text:
          i % 2
            ? "Привет! Проверяем запись в базу."
            : "Тестовое сообщение чата.",
        originChannelId: "test-channel",
      },
    });
  await a.db.call("ingest", {
    source: "donationalerts",
    accountId: "test-recipient",
    externalId: "123",
    type: "donation",
    actor: { externalId: "123", displayName: "Тестовый зритель" },
    occurredAtMs: null,
    receivedAtMs: now,
    sourceTime: "2026-10-06 20:00:00",
    timeQuality: "unknown",
    transport: "rest",
    payload: { text: "Тестовая сумма", amountMinor: "25000", currency: "RUB" },
  });
  for (let i = 0; i < 5; i++)
    await a.db.call("recordPoll", s.id, "test-channel", {
      startedAtMs: now - i * 60000,
      completedAtMs: now - i * 60000,
      status: "complete",
      userIds: ["42", "43"],
    });
  return s.id;
}
