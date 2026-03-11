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
  repos.replaceVehicleFeeds("g1", [
    { vehicle_id: "2386", rss_url: "https://example.com/rss-2386", enabled: true },
    { vehicle_id: "2569", rss_url: "https://example.com/rss-2569", enabled: true }
  ]);
  repos.replaceStatusRules("g1", [
    { status: "Alerté", channel_id: "ch1", role_ids: ["role1", "role2"], enabled: true },
    { vehicle_id: "2569", status: "Désinfection", channel_id: "ch2", role_ids: ["role3"], enabled: true }
  ]);

  const allFeeds = repos.listVehicleFeeds("g1");
  const feedConfig = allFeeds.find((feed) => feed.vehicle_id === "2386");
  const feedConfig2569 = allFeeds.find((feed) => feed.vehicle_id === "2569");
  assert.ok(feedConfig);
  assert.ok(feedConfig2569);

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

  const parsedDisinfection = {
    telemetryByVehicleId: new Map([
      ["2386", { fuel: "75", wear: "3 %" }],
      ["2569", { fuel: "55", wear: "9 %" }]
    ]),
    statusEvents: [
      {
        title: "Maintenance",
        description: "desinfection",
        status: "Désinfection",
        pubDateRaw: "09/03/2026 10:00:00 GMT+1",
        pubDateIso: "2026-03-09T09:00:00.000Z"
      }
    ]
  };

  // 2386 should not send for Désinfection because the rule is scoped to 2569.
  await handleParsedFeed({
    repos,
    feedConfig,
    parsedFeed: parsedDisinfection,
    botToken: "token",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    fetchImpl
  });

  // 2569 should send for Désinfection because the rule matches this vehicle.
  await handleParsedFeed({
    repos,
    feedConfig: feedConfig2569,
    parsedFeed: parsedDisinfection,
    botToken: "token",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    fetchImpl
  });

  assert.equal(callCount, 2);

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
