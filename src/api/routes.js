import express from "express";
import { requireAuth } from "./middleware.js";
import { buildDiscordPayload, sendDiscordMessageWithRetry } from "../lib/discord.js";
import { parseFeed } from "../lib/rss.js";

function toBoolean(value, fallback = true) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function validateVehicleFeed(feed) {
  return (
    feed &&
    typeof feed === "object" &&
    typeof feed.vehicle_id === "string" &&
    feed.vehicle_id.trim().length > 0 &&
    (feed.rss_url === undefined || (typeof feed.rss_url === "string" && feed.rss_url.trim().length > 0))
  );
}

function validateStatusRule(rule) {
  return (
    rule &&
    typeof rule === "object" &&
    typeof rule.status === "string" &&
    rule.status.length > 0 &&
    typeof rule.channel_id === "string" &&
    rule.channel_id.length > 0
  );
}

function resolveRssUrl(config, vehicleId, rssUrlInput) {
  if (typeof rssUrlInput === "string" && rssUrlInput.trim().length > 0) {
    return rssUrlInput.trim();
  }
  return config.rssUrlTemplate.replace("{vehicle_id}", encodeURIComponent(vehicleId));
}

async function fetchVehicleName(rssUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(rssUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const xml = await response.text();
    const parsed = parseFeed(xml);
    return parsed.channelTitle || null;
  } finally {
    clearTimeout(timeout);
  }
}

export function createApiRouter({ repos, authHandlers, config, logger }) {
  const router = express.Router();

  router.get("/health", (_req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
  });

  router.get("/auth/login", authHandlers.login);
  router.get("/auth/callback", authHandlers.callback);
  router.post("/auth/logout", authHandlers.logout);
  router.get("/auth/me", authHandlers.me);

  async function requireGuildAdmin(req, res, next) {
    const targetGuildId = String(req.params.guildId);
    const guilds = await authHandlers.fetchAdminGuilds(req);
    const guild = guilds.find((entry) => String(entry.id) === targetGuildId);
    if (!guild) {
      return res.status(403).json({ error: "Admin permission required for this guild" });
    }

    repos.upsertGuildConfig(guild.id, guild.name);
    req.guildContext = guild;
    return next();
  }

  router.get("/guilds", requireAuth, async (req, res) => {
    const guilds = await authHandlers.fetchAdminGuilds(req);
    for (const guild of guilds) {
      repos.upsertGuildConfig(guild.id, guild.name);
    }
    res.json(
      guilds.map((guild) => ({
        id: guild.id,
        name: guild.name,
        icon: guild.icon
      }))
    );
  });

  router.get("/guilds/:guildId/vehicles", requireAuth, requireGuildAdmin, (req, res) => {
    const data = repos.listVehicleFeeds(req.params.guildId);
    res.json(data);
  });

  router.post("/guilds/:guildId/vehicles/resolve", requireAuth, requireGuildAdmin, async (req, res) => {
    const vehicleId = String(req.body?.vehicle_id ?? "").trim();
    if (!vehicleId) {
      return res.status(400).json({ error: "vehicle_id is required" });
    }

    const rssUrl = resolveRssUrl(config, vehicleId, req.body?.rss_url);
    let vehicleName = null;

    try {
      vehicleName = await fetchVehicleName(rssUrl);
    } catch (error) {
      logger.warn("Vehicle feed resolution failed", { vehicleId, rssUrl, error: String(error) });
    }

    return res.json({ vehicle_id: vehicleId, rss_url: rssUrl, vehicle_name: vehicleName });
  });

  router.put("/guilds/:guildId/vehicles", requireAuth, requireGuildAdmin, async (req, res) => {
    if (!Array.isArray(req.body) || req.body.some((feed) => !validateVehicleFeed(feed))) {
      return res.status(400).json({ error: "Expected array of { vehicle_id, rss_url?, vehicle_name?, enabled }" });
    }

    const sanitized = [];
    for (const feed of req.body) {
      const vehicleId = feed.vehicle_id.trim();
      const rssUrl = resolveRssUrl(config, vehicleId, feed.rss_url);
      let vehicleName = typeof feed.vehicle_name === "string" && feed.vehicle_name.trim().length > 0 ? feed.vehicle_name.trim() : null;

      if (!vehicleName) {
        try {
          vehicleName = await fetchVehicleName(rssUrl);
        } catch (error) {
          logger.warn("Could not fetch vehicle name during save", {
            guildId: req.params.guildId,
            vehicleId,
            rssUrl,
            error: String(error)
          });
        }
      }

      sanitized.push({
        vehicle_id: vehicleId,
        vehicle_name: vehicleName,
        rss_url: rssUrl,
        enabled: toBoolean(feed.enabled, true)
      });
    }

    repos.replaceVehicleFeeds(req.params.guildId, sanitized);
    return res.json({ ok: true, count: sanitized.length, items: sanitized });
  });

  router.get("/guilds/:guildId/status-rules", requireAuth, requireGuildAdmin, (req, res) => {
    const data = repos.listStatusRules(req.params.guildId);
    res.json(data);
  });

  router.put("/guilds/:guildId/status-rules", requireAuth, requireGuildAdmin, (req, res) => {
    if (!Array.isArray(req.body) || req.body.some((rule) => !validateStatusRule(rule))) {
      return res.status(400).json({ error: "Expected an array of { status, channel_id, role_ids, enabled }" });
    }

    const sanitized = req.body.map((rule) => ({
      status: rule.status.trim(),
      channel_id: rule.channel_id.trim(),
      role_ids: Array.isArray(rule.role_ids) ? rule.role_ids.map(String) : [],
      enabled: toBoolean(rule.enabled, true)
    }));

    repos.replaceStatusRules(req.params.guildId, sanitized);
    return res.json({ ok: true, count: sanitized.length });
  });

  router.post("/guilds/:guildId/test-notification", requireAuth, requireGuildAdmin, async (req, res) => {
    const status = String(req.body?.status ?? "").trim();
    const vehicleId = String(req.body?.vehicle_id ?? "").trim();

    if (!status) {
      return res.status(400).json({ error: "status is required" });
    }

    const rule = repos.getStatusRule(req.params.guildId, status);
    if (!rule) {
      return res.status(404).json({ error: "No active rule for this status" });
    }

    const payload = buildDiscordPayload({
      vehicleId: vehicleId || "TEST",
      status,
      eventPubDate: new Date().toISOString(),
      telemetry: null,
      roleIds: rule.role_ids
    });

    await sendDiscordMessageWithRetry({
      botToken: config.discordBotToken,
      channelId: rule.channel_id,
      payload
    });

    logger.info("Test notification sent", {
      guildId: req.params.guildId,
      status,
      channelId: rule.channel_id
    });

    return res.json({ ok: true });
  });

  return router;
}