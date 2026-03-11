import express from "express";
import { requireAuth } from "./middleware.js";
import { buildDiscordPayload, sendDiscordMessageWithRetry } from "../lib/discord.js";
import { parseFeed } from "../lib/rss.js";
import { readRecentLogEntries } from "../lib/logger.js";

function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function isDiscordUnauthorizedError(error) {
  return /Discord request failed \(401\)/i.test(String(error?.message ?? ""));
}

function toBoolean(value, fallback = true) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function validateStatusRule(rule) {
  const vehicleId =
    rule && typeof rule.vehicle_id === "string" && rule.vehicle_id.trim().length > 0 ? rule.vehicle_id.trim() : null;

  return (
    rule &&
    typeof rule === "object" &&
    (vehicleId === null || /^[0-9A-Za-z_-]+$/.test(vehicleId)) &&
    typeof rule.status === "string" &&
    rule.status.length > 0 &&
    typeof rule.channel_id === "string" &&
    rule.channel_id.length > 0
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    error.path = path;
    error.body = body;
    throw error;
  }

  return response.json();
}

async function discordBotRequestRaw(path, { botToken }) {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    headers: {
      Authorization: `Bot ${botToken}`
    }
  });

  const body = await response.text();
  return { ok: response.ok, status: response.status, body };
}

function normalizeStatusRuleScope(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
  let botIdentityCache = null;
  let botIdentityFetchedAtMs = 0;
  let botIdentityInFlightPromise = null;
  const BOT_IDENTITY_CACHE_TTL_MS = 5 * 60 * 1000;

  function parseDiscordErrorBody(error) {
    const raw = String(error?.body ?? "").trim();
    if (!raw) {
      return { raw: "" };
    }

    try {
      const parsed = JSON.parse(raw);
      return {
        raw,
        code: parsed?.code ?? null,
        message: parsed?.message ?? null
      };
    } catch {
      return { raw };
    }
  }

  async function getBotIdentity() {
    const now = Date.now();
    if (botIdentityCache && now - botIdentityFetchedAtMs < BOT_IDENTITY_CACHE_TTL_MS) {
      return botIdentityCache;
    }

    if (!botIdentityInFlightPromise) {
      botIdentityInFlightPromise = discordBotRequest("/users/@me", { botToken: config.discordBotToken })
        .then((identity) => {
          botIdentityCache = identity;
          botIdentityFetchedAtMs = Date.now();
          return identity;
        })
        .finally(() => {
          botIdentityInFlightPromise = null;
        });
    }

    return botIdentityInFlightPromise;
  }

  async function checkBotPresenceWithRetry({ guildId, botUserId, maxAttempts = 3, delayMs = 1200 }) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await discordBotRequest(`/guilds/${guildId}/members/${botUserId}`, { botToken: config.discordBotToken });
        return true;
      } catch (error) {
        if (error?.status !== 404) {
          throw error;
        }
        if (attempt < maxAttempts) {
          await wait(delayMs);
        }
      }
    }
    return false;
  }

  router.get("/health", (_req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
  });

  router.get(
    "/diagnostics/logs",
    requireAuth,
    asyncHandler(async (req, res) => {
      const limit = Number(req.query?.limit ?? 200);
      const logs = readRecentLogEntries({ basename: "api", limit });
      return res.json({
        ok: true,
        count: logs.length,
        logs
      });
    })
  );

  router.get("/auth/login", authHandlers.login);
  router.get("/auth/callback", authHandlers.callback);
  router.post("/auth/logout", authHandlers.logout);
  router.get("/auth/me", authHandlers.me);

  const requireGuildAdmin = asyncHandler(async (req, res, next) => {
    const targetGuildId = String(req.params.guildId);

    try {
      const guilds = await authHandlers.fetchAdminGuilds(req);
      const guild = guilds.find((entry) => String(entry.id) === targetGuildId);
      if (!guild) {
        return res.status(403).json({ error: "Admin permission required for this guild" });
      }

      repos.upsertGuildConfig(guild.id, guild.name);
      req.guildContext = guild;
      return next();
    } catch (error) {
      if (isDiscordUnauthorizedError(error)) {
        return res.status(401).json({ error: "Authentication required" });
      }
      throw error;
    }
  });

  router.get(
    "/guilds",
    requireAuth,
    asyncHandler(async (req, res) => {
      try {
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
      } catch (error) {
        if (isDiscordUnauthorizedError(error)) {
          return res.status(401).json({ error: "Authentication required" });
        }
        throw error;
      }
    })
  );

  router.get("/guilds/:guildId/vehicles", requireAuth, requireGuildAdmin, (req, res) => {
    try {
      const data = repos.listVehicleFeeds(req.params.guildId);
      res.json(data);
    } catch (error) {
      logger.error("Vehicles read failed", {
        requestId: req.requestId,
        guildId: req.params.guildId,
        error: String(error?.stack ?? error)
      });
      res.status(500).json({ error: "Unable to load vehicle configuration", request_id: req.requestId });
    }
  });

  router.post(
    "/guilds/:guildId/vehicles/resolve",
    requireAuth,
    requireGuildAdmin,
    asyncHandler(async (req, res) => {
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
    })
  );

  router.put(
    "/guilds/:guildId/vehicles",
    requireAuth,
    requireGuildAdmin,
    asyncHandler(async (req, res) => {
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
    })
  );

  router.get("/guilds/:guildId/status-rules", requireAuth, requireGuildAdmin, (req, res) => {
    try {
      const data = repos.listStatusRules(req.params.guildId);
      res.json(data);
    } catch (error) {
      logger.error("Status rules read failed", {
        requestId: req.requestId,
        guildId: req.params.guildId,
        error: String(error?.stack ?? error)
      });
      res.status(500).json({ error: "Unable to load status rules", request_id: req.requestId });
    }
  });

  router.put("/guilds/:guildId/status-rules", requireAuth, requireGuildAdmin, (req, res) => {
    if (!Array.isArray(req.body) || req.body.some((rule) => !validateStatusRule(rule))) {
      return res.status(400).json({ error: "Expected an array of { vehicle_id, status, channel_id, role_ids, enabled }" });
    }

    const sanitized = req.body.map((rule) => ({
      vehicle_id: normalizeStatusRuleScope(rule.vehicle_id),
      status: rule.status.trim(),
      channel_id: rule.channel_id.trim(),
      role_ids: Array.isArray(rule.role_ids) ? rule.role_ids.map(String) : [],
      enabled: toBoolean(rule.enabled, true)
    }));

    const seen = new Set();
    for (const rule of sanitized) {
      const key = `${rule.vehicle_id ?? "*"}::${rule.status.toLowerCase()}`;
      if (seen.has(key)) {
        return res.status(400).json({
          error: `Duplicate status rule for vehicle ${rule.vehicle_id ?? "ALL"} and status "${rule.status}".`
        });
      }
      seen.add(key);
    }

    repos.replaceStatusRules(req.params.guildId, sanitized);
    return res.json({ ok: true, count: sanitized.length });
  });

  router.get(
    "/guilds/:guildId/discord-resources",
    requireAuth,
    requireGuildAdmin,
    asyncHandler(async (req, res) => {
      const guildId = String(req.params.guildId);

      try {
        const [channels, roles] = await Promise.all([
          discordBotRequest(`/guilds/${guildId}/channels`, { botToken: config.discordBotToken }),
          discordBotRequest(`/guilds/${guildId}/roles`, { botToken: config.discordBotToken })
        ]);

        const channelOptions = (Array.isArray(channels) ? channels : [])
          .filter((channel) => channel && typeof channel.id === "string" && (channel.type === 0 || channel.type === 5))
          .map((channel) => ({
            id: channel.id,
            name: channel.name ?? channel.id,
            type: channel.type
          }))
          .sort((a, b) => a.name.localeCompare(b.name, "fr", { sensitivity: "base" }));

        const roleOptions = (Array.isArray(roles) ? roles : [])
          .filter((role) => role && typeof role.id === "string" && role.id !== guildId)
          .map((role) => ({
            id: role.id,
            name: role.name ?? role.id,
            position: Number(role.position ?? 0)
          }))
          .sort((a, b) => b.position - a.position || a.name.localeCompare(b.name, "fr", { sensitivity: "base" }));

        return res.json({
          channels: channelOptions,
          roles: roleOptions
        });
      } catch (error) {
        const details = parseDiscordErrorBody(error);
        logger.warn("Discord resources lookup failed", {
          guildId,
          path: error?.path,
          status: error?.status ?? null,
          discordCode: details.code,
          discordMessage: details.message
        });

        return res.status(502).json({
          error: "Impossible de recuperer salons/roles via le bot. Verifie sa presence et ses permissions sur ce serveur."
        });
      }
    })
  );

  router.post(
    "/guilds/:guildId/test-notification",
    requireAuth,
    requireGuildAdmin,
    asyncHandler(async (req, res) => {
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
    })
  );

  router.get(
    "/guilds/:guildId/bot-status",
    requireAuth,
    requireGuildAdmin,
    asyncHandler(async (req, res) => {
      const guildId = String(req.params.guildId);
      const inviteUrl = buildBotInviteUrl(config, guildId);

      try {
        const botIdentity = await getBotIdentity();
        const isPresent = await checkBotPresenceWithRetry({ guildId, botUserId: botIdentity.id });
        if (!isPresent) {
          // Fallback probe: GET /guilds/{guildId} can succeed even when member lookup is delayed.
          const guildProbe = await discordBotRequestRaw(`/guilds/${guildId}`, { botToken: config.discordBotToken });
          if (guildProbe.ok) {
            return res.json({
              present: true,
              bot_user_id: botIdentity.id,
              bot_username: botIdentity.username,
              invite_url: inviteUrl,
              note: "Bot presence confirmed via guild probe."
            });
          }

          return res.json({
            present: false,
            invite_url: inviteUrl
          });
        }

        return res.json({
          present: true,
          bot_user_id: botIdentity.id,
          bot_username: botIdentity.username,
          invite_url: inviteUrl
        });
      } catch (error) {
        const details = parseDiscordErrorBody(error);

        if (error?.status === 404) {
          return res.json({
            present: false,
            invite_url: inviteUrl
          });
        }

        if (error?.status === 401) {
          logger.error("Bot status lookup unauthorized", {
            guildId,
            path: error?.path,
            discordCode: details.code,
            discordMessage: details.message,
            discordRaw: details.raw
          });
          return res.status(500).json({
            error: "DISCORD_BOT_TOKEN invalide ou expire. Regenerer le token bot puis redemarrer l'API/worker.",
            code: "BOT_TOKEN_INVALID"
          });
        }

        if (error?.status === 403) {
          logger.warn("Bot status lookup forbidden", {
            guildId,
            path: error?.path,
            discordCode: details.code,
            discordMessage: details.message,
            discordRaw: details.raw
          });
          return res.json({
            present: false,
            invite_url: inviteUrl,
            warning: "Le bot n'a pas encore acces a ce serveur (ou droits insuffisants)."
          });
        }

        logger.error("Bot status lookup failed", {
          guildId,
          path: error?.path,
          status: error?.status ?? null,
          discordCode: details.code,
          discordMessage: details.message,
          discordRaw: details.raw,
          error: String(error)
        });
        return res.status(502).json({ error: "Unable to verify bot presence on this guild right now." });
      }
    })
  );

  return router;
}
