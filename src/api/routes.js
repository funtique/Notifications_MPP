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

function isLikelyUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

function extractVehicleIdFromUrl(url) {
  const match = url.match(/\/vehicules\/(\d+)\.xml(?:$|[?#])/i) || url.match(/\/vehicules\/(\d+)\.xml$/i);
  return match ? match[1] : null;
}

function normalizeVehicleInputEntry(entry) {
  if (typeof entry === "string") {
    const value = entry.trim();
    if (!value) return null;
    if (isLikelyUrl(value)) {
      return {
        vehicle_id: extractVehicleIdFromUrl(value),
        rss_url: value,
        vehicle_name: null,
        enabled: true
      };
    }
    return {
      vehicle_id: value,
      rss_url: null,
      vehicle_name: null,
      enabled: true
    };
  }

  if (!entry || typeof entry !== "object") {
    return null;
  }

  const rawInput = typeof entry.input === "string" ? entry.input.trim() : "";
  const vehicleId = typeof entry.vehicle_id === "string" && entry.vehicle_id.trim().length > 0 ? entry.vehicle_id.trim() : null;
  const rssUrl = typeof entry.rss_url === "string" && entry.rss_url.trim().length > 0 ? entry.rss_url.trim() : null;

  if (vehicleId || rssUrl || rawInput) {
    if (rawInput) {
      if (isLikelyUrl(rawInput)) {
        return {
          vehicle_id: vehicleId ?? extractVehicleIdFromUrl(rawInput),
          rss_url: rssUrl ?? rawInput,
          vehicle_name: typeof entry.vehicle_name === "string" ? entry.vehicle_name.trim() || null : null,
          enabled: toBoolean(entry.enabled, true)
        };
      }
      return {
        vehicle_id: vehicleId ?? rawInput,
        rss_url: rssUrl,
        vehicle_name: typeof entry.vehicle_name === "string" ? entry.vehicle_name.trim() || null : null,
        enabled: toBoolean(entry.enabled, true)
      };
    }

    return {
      vehicle_id: vehicleId ?? (rssUrl ? extractVehicleIdFromUrl(rssUrl) : null),
      rss_url: rssUrl,
      vehicle_name: typeof entry.vehicle_name === "string" ? entry.vehicle_name.trim() || null : null,
      enabled: toBoolean(entry.enabled, true)
    };
  }

  return null;
}

function resolveRssUrl(config, vehicleId, rssUrlInput) {
  if (typeof rssUrlInput === "string" && rssUrlInput.trim().length > 0) {
    return rssUrlInput.trim();
  }
  return config.rssUrlTemplate.replace("{vehicle_id}", encodeURIComponent(vehicleId));
}

async function fetchFeedDetails(rssUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(rssUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const xml = await response.text();
    const parsed = parseFeed(xml);
    const inferredVehicleId = parsed.telemetryByVehicleId.size > 0 ? Array.from(parsed.telemetryByVehicleId.keys())[0] : null;
    return {
      vehicleName: parsed.channelTitle || null,
      inferredVehicleId
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveVehicleConfigInput(config, rawEntry) {
  const normalized = normalizeVehicleInputEntry(rawEntry);
  if (!normalized) {
    throw new Error("Invalid vehicle entry. Use an ID, URL, or { input } object.");
  }

  let vehicleId = normalized.vehicle_id;
  let rssUrl = normalized.rss_url;
  let vehicleName = normalized.vehicle_name;

  if (!vehicleId && !rssUrl) {
    throw new Error("Vehicle entry must include an ID or URL");
  }

  if (!rssUrl && vehicleId) {
    rssUrl = resolveRssUrl(config, vehicleId, null);
  }

  if (rssUrl && (!vehicleId || !vehicleName)) {
    try {
      const details = await fetchFeedDetails(rssUrl);
      if (!vehicleName) {
        vehicleName = details.vehicleName;
      }
      if (!vehicleId) {
        vehicleId = details.inferredVehicleId;
      }
    } catch {
      // Ignore fetch errors here; fallback validation below handles missing vehicle id.
    }
  }

  if (!vehicleId) {
    throw new Error("Unable to infer vehicle_id from URL. Use format .../vehicules/{id}.xml or provide vehicle_id.");
  }

  if (!rssUrl) {
    rssUrl = resolveRssUrl(config, vehicleId, null);
  }

  return {
    vehicle_id: vehicleId,
    vehicle_name: vehicleName ?? null,
    rss_url: rssUrl,
    enabled: normalized.enabled
  };
}

async function discordBotRequest(path, { botToken }) {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    headers: {
      Authorization: `Bot ${botToken}`
    }
  });

  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`Discord bot request failed (${response.status}): ${body}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

function buildBotInviteUrl(config, guildId) {
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", config.discordClientId);
  url.searchParams.set("scope", "bot applications.commands");
  url.searchParams.set("permissions", "8");
  if (guildId) {
    url.searchParams.set("guild_id", String(guildId));
    url.searchParams.set("disable_guild_select", "true");
  }
  return url.toString();
}

export function createApiRouter({ repos, authHandlers, config, logger }) {
  const router = express.Router();
  let botIdentityPromise = null;

  function getBotIdentity() {
    if (!botIdentityPromise) {
      botIdentityPromise = discordBotRequest("/users/@me", { botToken: config.discordBotToken });
    }
    return botIdentityPromise;
  }

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
    const input = req.body?.input ?? req.body?.vehicle_id ?? req.body?.rss_url;

    try {
      const resolved = await resolveVehicleConfigInput(config, input);
      if (!resolved.vehicle_name) {
        try {
          const details = await fetchFeedDetails(resolved.rss_url);
          resolved.vehicle_name = details.vehicleName;
        } catch (error) {
          logger.warn("Vehicle name lookup failed", { input, error: String(error) });
        }
      }
      return res.json(resolved);
    } catch (error) {
      return res.status(400).json({ error: String(error.message ?? error) });
    }
  });

  router.put("/guilds/:guildId/vehicles", requireAuth, requireGuildAdmin, async (req, res) => {
    if (!Array.isArray(req.body)) {
      return res.status(400).json({ error: "Expected array of entries (ID, URL, or object with input)." });
    }

    const sanitized = [];
    for (const entry of req.body) {
      try {
        const resolved = await resolveVehicleConfigInput(config, entry);
        if (!resolved.vehicle_name) {
          try {
            const details = await fetchFeedDetails(resolved.rss_url);
            resolved.vehicle_name = details.vehicleName;
          } catch (error) {
            logger.warn("Could not fetch vehicle name during save", {
              guildId: req.params.guildId,
              vehicleId: resolved.vehicle_id,
              rssUrl: resolved.rss_url,
              error: String(error)
            });
          }
        }
        sanitized.push(resolved);
      } catch (error) {
        return res.status(400).json({ error: `Invalid vehicle entry: ${String(error.message ?? error)}` });
      }
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

  router.get("/guilds/:guildId/bot-status", requireAuth, requireGuildAdmin, async (req, res) => {
    const guildId = String(req.params.guildId);
    const inviteUrl = buildBotInviteUrl(config, guildId);

    try {
      const botIdentity = await getBotIdentity();
      await discordBotRequest(`/guilds/${guildId}/members/${botIdentity.id}`, { botToken: config.discordBotToken });
      return res.json({
        present: true,
        bot_user_id: botIdentity.id,
        bot_username: botIdentity.username,
        invite_url: inviteUrl
      });
    } catch (error) {
      if (error?.status === 404) {
        return res.json({
          present: false,
          invite_url: inviteUrl
        });
      }

      logger.error("Bot status lookup failed", { guildId, error: String(error) });
      return res.status(502).json({ error: "Unable to verify bot presence on this guild right now." });
    }
  });

  return router;
}
