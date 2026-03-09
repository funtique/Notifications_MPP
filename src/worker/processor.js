import pLimit from "p-limit";
import { hashStable } from "../lib/hash.js";
import { parseFeed } from "../lib/rss.js";
import { buildDiscordPayload, sendDiscordMessageWithRetry } from "../lib/discord.js";

function isOlderThanCheckpoint(checkpoint, event) {
  if (!checkpoint?.last_pub_date_iso || !event.pubDateIso) return false;
  return event.pubDateIso < checkpoint.last_pub_date_iso;
}

export async function handleParsedFeed({ repos, feedConfig, parsedFeed, botToken, logger, fetchImpl }) {
  const telemetry = parsedFeed.telemetryByVehicleId.get(String(feedConfig.vehicle_id)) ?? null;
  const checkpoint = repos.getCheckpoint(feedConfig.id);
  let sentCount = 0;

  for (const event of parsedFeed.statusEvents) {
    if (isOlderThanCheckpoint(checkpoint, event)) {
      continue;
    }

    const rule = repos.getStatusRule(feedConfig.guild_id, event.status);
    if (!rule || !rule.enabled) {
      logger.debug("Status ignored because no active rule", {
        guildId: feedConfig.guild_id,
        vehicleId: feedConfig.vehicle_id,
        status: event.status
      });
      continue;
    }

    const eventHash = hashStable(
      `${event.title}|${event.description}|${event.pubDateIso ?? event.pubDateRaw ?? ""}|${feedConfig.vehicle_id}|${feedConfig.guild_id}`
    );

    if (repos.hasEvent(feedConfig.guild_id, feedConfig.id, eventHash)) {
      continue;
    }

    const payload = buildDiscordPayload({
      vehicleId: feedConfig.vehicle_id,
      status: event.status,
      eventPubDate: event.pubDateRaw ?? event.pubDateIso,
      telemetry,
      roleIds: rule.role_ids
    });

    await sendDiscordMessageWithRetry({
      botToken,
      channelId: rule.channel_id,
      payload,
      fetchImpl
    });

    repos.insertEventAndCheckpoint({
      guildId: feedConfig.guild_id,
      vehicleFeedId: feedConfig.id,
      eventHash,
      status: event.status,
      pubDateRaw: event.pubDateRaw,
      pubDateIso: event.pubDateIso
    });

    sentCount += 1;
  }

  return sentCount;
}

async function fetchFeedXml(url, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Feed request failed (${response.status})`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

export async function runPollingCycle({ repos, botToken, fetchConcurrency, logger, fetchImpl = fetch }) {
  const feeds = repos.listActiveVehicleFeeds();
  const limit = pLimit(fetchConcurrency);

  const results = await Promise.allSettled(
    feeds.map((feed) =>
      limit(async () => {
        const xml = await fetchFeedXml(feed.rss_url, fetchImpl);
        const parsed = parseFeed(xml);
        const sent = await handleParsedFeed({ repos, feedConfig: feed, parsedFeed: parsed, botToken, logger, fetchImpl });
        logger.info("Feed processed", { guildId: feed.guild_id, vehicleId: feed.vehicle_id, sent });
      })
    )
  );

  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    for (const failure of failures) {
      logger.error("Feed processing failed", { error: String(failure.reason) });
    }
  }

  return { processed: feeds.length, failures: failures.length };
}