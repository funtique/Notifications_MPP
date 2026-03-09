import express from "express";
import { requireAuth } from "./middleware.js";
import { buildDiscordPayload, sendDiscordMessageWithRetry } from "../lib/discord.js";

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
    feed.vehicle_id.length > 0 &&
    typeof feed.rss_url === "string" &&
    feed.rss_url.length > 0
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

  router.put("/guilds/:guildId/vehicles", requireAuth, requireGuildAdmin, (req, res) => {
    if (!Array.isArray(req.body) || req.body.some((feed) => !validateVehicleFeed(feed))) {
      return res.status(400).json({ error: "Expected an array of { vehicle_id, rss_url, enabled }" });
    }

    const sanitized = req.body.map((feed) => ({
      vehicle_id: feed.vehicle_id.trim(),
      rss_url: feed.rss_url.trim(),
      enabled: toBoolean(feed.enabled, true)
    }));

    repos.replaceVehicleFeeds(req.params.guildId, sanitized);
    return res.json({ ok: true, count: sanitized.length });
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