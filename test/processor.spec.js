import assert from "node:assert/strict";
import { createDatabase } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createRepositories } from "../src/db/repositories.js";
import { handleParsedFeed } from "../src/worker/processor.js";

export async function runProcessorTests() {
  const db = createDatabase(":memory:");
  migrate(db);
  const repos = createRepositories(db);

  repos.upsertGuildConfig("g1", "Guild 1");
  repos.replaceVehicleFeeds("g1", [{ vehicle_id: "2386", rss_url: "https://example.com/rss", enabled: true }]);
  repos.replaceStatusRules("g1", [
    { status: "Alerté", channel_id: "ch1", role_ids: ["role1", "role2"], enabled: true }
  ]);

  const feedConfig = repos.listVehicleFeeds("g1")[0];

  const parsed = {
    telemetryByVehicleId: new Map([["2386", { fuel: "80", wear: "2 %" }]]),
    statusEvents: [
      {
        title: "Changement d'état",
        description: "le VSAV est : Alerté",
        status: "Alerté",
        pubDateRaw: "08/03/2026 21:54:19 GMT+1",
        pubDateIso: "2026-03-08T20:54:19.000Z"
      }
    ]
  };

  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    return { ok: true, text: async () => "{}" };
  };

  await handleParsedFeed({
    repos,
    feedConfig,
    parsedFeed: parsed,
    botToken: "token",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    fetchImpl
  });

  await handleParsedFeed({
    repos,
    feedConfig,
    parsedFeed: parsed,
    botToken: "token",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    fetchImpl
  });

  assert.equal(callCount, 1);

  for (let i = 0; i < 60; i += 1) {
    repos.insertEventAndCheckpoint({
      guildId: "g1",
      vehicleFeedId: feedConfig.id,
      eventHash: `hash-${i}`,
      status: "Alerté",
      pubDateRaw: String(i),
      pubDateIso: `2026-03-09T00:${String(i % 60).padStart(2, "0")}:00.000Z`
    });
  }

  assert.equal(repos.countEventsForVehicle(feedConfig.id), 50);
  db.close();
}