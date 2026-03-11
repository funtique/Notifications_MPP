function nowIso() {
  return new Date().toISOString();
}

function parseRoleIds(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function createRepositories(db) {
  const statusRulesCols = db.prepare("PRAGMA table_info(status_rules)").all();
  const hasStatusRuleVehicleScope = statusRulesCols.some((col) => col.name === "vehicle_id");

  const upsertGuildStmt = db.prepare(`
    INSERT INTO guild_configs (guild_id, guild_name, created_at, updated_at)
    VALUES (@guild_id, @guild_name, @created_at, @updated_at)
    ON CONFLICT(guild_id)
    DO UPDATE SET guild_name = excluded.guild_name, updated_at = excluded.updated_at
  `);

  const deleteVehicleFeedsStmt = db.prepare("DELETE FROM vehicle_feeds WHERE guild_id = ?");
  const insertVehicleFeedStmt = db.prepare(`
    INSERT INTO vehicle_feeds (guild_id, vehicle_id, vehicle_name, rss_url, enabled, created_at, updated_at)
    VALUES (@guild_id, @vehicle_id, @vehicle_name, @rss_url, @enabled, @created_at, @updated_at)
  `);

  const deleteStatusRulesStmt = db.prepare("DELETE FROM status_rules WHERE guild_id = ?");
  const insertStatusRuleStmt = hasStatusRuleVehicleScope
    ? db.prepare(`
        INSERT INTO status_rules (guild_id, vehicle_id, status, channel_id, role_ids_json, enabled, created_at, updated_at)
        VALUES (@guild_id, @vehicle_id, @status, @channel_id, @role_ids_json, @enabled, @created_at, @updated_at)
      `)
    : db.prepare(`
        INSERT INTO status_rules (guild_id, status, channel_id, role_ids_json, enabled, created_at, updated_at)
        VALUES (@guild_id, @status, @channel_id, @role_ids_json, @enabled, @created_at, @updated_at)
      `);

  const listGuildVehicleFeedsStmt = db.prepare(`
    SELECT id, guild_id, vehicle_id, vehicle_name, rss_url, enabled, created_at, updated_at
    FROM vehicle_feeds
    WHERE guild_id = ?
    ORDER BY vehicle_id ASC
  `);

  const listAllActiveVehicleFeedsStmt = db.prepare(`
    SELECT vf.id, vf.guild_id, vf.vehicle_id, vf.vehicle_name, vf.rss_url, vf.enabled
    FROM vehicle_feeds vf
    JOIN guild_configs gc ON gc.guild_id = vf.guild_id
    WHERE vf.enabled = 1
    ORDER BY vf.guild_id ASC, vf.vehicle_id ASC
  `);

  const listStatusRulesStmt = hasStatusRuleVehicleScope
    ? db.prepare(`
        SELECT id, guild_id, vehicle_id, status, channel_id, role_ids_json, enabled, created_at, updated_at
        FROM status_rules
        WHERE guild_id = ?
        ORDER BY status ASC, vehicle_id ASC
      `)
    : db.prepare(`
        SELECT id, guild_id, NULL AS vehicle_id, status, channel_id, role_ids_json, enabled, created_at, updated_at
        FROM status_rules
        WHERE guild_id = ?
        ORDER BY status ASC
      `);

  const getStatusRuleByVehicleStmt = hasStatusRuleVehicleScope
    ? db.prepare(`
        SELECT id, guild_id, vehicle_id, status, channel_id, role_ids_json, enabled
        FROM status_rules
        WHERE guild_id = ? AND vehicle_id = ? AND status = ? AND enabled = 1
        LIMIT 1
      `)
    : null;

  const getGlobalStatusRuleStmt = hasStatusRuleVehicleScope
    ? db.prepare(`
        SELECT id, guild_id, vehicle_id, status, channel_id, role_ids_json, enabled
        FROM status_rules
        WHERE guild_id = ? AND status = ? AND enabled = 1 AND (vehicle_id IS NULL OR vehicle_id = '')
        LIMIT 1
      `)
    : db.prepare(`
        SELECT id, guild_id, NULL AS vehicle_id, status, channel_id, role_ids_json, enabled
        FROM status_rules
        WHERE guild_id = ? AND status = ? AND enabled = 1
        LIMIT 1
      `);

  const hasEventStmt = db.prepare(`
    SELECT 1 AS found
    FROM events
    WHERE guild_id = ? AND vehicle_feed_id = ? AND event_hash = ?
    LIMIT 1
  `);

  const insertEventStmt = db.prepare(`
    INSERT INTO events (guild_id, vehicle_feed_id, event_hash, status, pub_date_raw, pub_date_iso, created_at)
    VALUES (@guild_id, @vehicle_feed_id, @event_hash, @status, @pub_date_raw, @pub_date_iso, @created_at)
  `);

  const upsertCheckpointStmt = db.prepare(`
    INSERT INTO event_checkpoints (vehicle_feed_id, last_pub_date_iso, last_event_hash, updated_at)
    VALUES (@vehicle_feed_id, @last_pub_date_iso, @last_event_hash, @updated_at)
    ON CONFLICT(vehicle_feed_id)
    DO UPDATE SET
      last_pub_date_iso = excluded.last_pub_date_iso,
      last_event_hash = excluded.last_event_hash,
      updated_at = excluded.updated_at
  `);

  const getCheckpointStmt = db.prepare(`
    SELECT vehicle_feed_id, last_pub_date_iso, last_event_hash, updated_at
    FROM event_checkpoints
    WHERE vehicle_feed_id = ?
  `);

  const retentionStmt = db.prepare(`
    DELETE FROM events
    WHERE vehicle_feed_id = ?
      AND id NOT IN (
        SELECT id
        FROM events
        WHERE vehicle_feed_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 50
      )
  `);

  const countEventsStmt = db.prepare("SELECT COUNT(*) AS count FROM events WHERE vehicle_feed_id = ?");

  const replaceVehicleFeedsTx = db.transaction((guildId, feeds) => {
    const now = nowIso();
    deleteVehicleFeedsStmt.run(guildId);
    for (const feed of feeds) {
      insertVehicleFeedStmt.run({
        guild_id: guildId,
        vehicle_id: String(feed.vehicle_id),
        vehicle_name: feed.vehicle_name ? String(feed.vehicle_name) : null,
        rss_url: String(feed.rss_url),
        enabled: feed.enabled ? 1 : 0,
        created_at: now,
        updated_at: now
      });
    }
  });

  const replaceStatusRulesTx = db.transaction((guildId, rules) => {
    const now = nowIso();
    deleteStatusRulesStmt.run(guildId);
    for (const rule of rules) {
      if (hasStatusRuleVehicleScope) {
        insertStatusRuleStmt.run({
          guild_id: guildId,
          vehicle_id: rule.vehicle_id ? String(rule.vehicle_id) : null,
          status: String(rule.status),
          channel_id: String(rule.channel_id),
          role_ids_json: JSON.stringify(Array.isArray(rule.role_ids) ? rule.role_ids.map(String) : []),
          enabled: rule.enabled ? 1 : 0,
          created_at: now,
          updated_at: now
        });
      } else {
        insertStatusRuleStmt.run({
          guild_id: guildId,
          status: String(rule.status),
          channel_id: String(rule.channel_id),
          role_ids_json: JSON.stringify(Array.isArray(rule.role_ids) ? rule.role_ids.map(String) : []),
          enabled: rule.enabled ? 1 : 0,
          created_at: now,
          updated_at: now
        });
      }
    }
  });

  const insertEventAndCheckpointTx = db.transaction((payload) => {
    insertEventStmt.run({
      guild_id: payload.guildId,
      vehicle_feed_id: payload.vehicleFeedId,
      event_hash: payload.eventHash,
      status: payload.status,
      pub_date_raw: payload.pubDateRaw,
      pub_date_iso: payload.pubDateIso,
      created_at: nowIso()
    });

    upsertCheckpointStmt.run({
      vehicle_feed_id: payload.vehicleFeedId,
      last_pub_date_iso: payload.pubDateIso,
      last_event_hash: payload.eventHash,
      updated_at: nowIso()
    });

    retentionStmt.run(payload.vehicleFeedId, payload.vehicleFeedId);
  });

  return {
    upsertGuildConfig(guildId, guildName) {
      const now = nowIso();
      upsertGuildStmt.run({ guild_id: String(guildId), guild_name: guildName ?? null, created_at: now, updated_at: now });
    },

    replaceVehicleFeeds(guildId, feeds) {
      replaceVehicleFeedsTx(String(guildId), feeds);
    },

    replaceStatusRules(guildId, rules) {
      replaceStatusRulesTx(String(guildId), rules);
    },

    listVehicleFeeds(guildId) {
      return listGuildVehicleFeedsStmt.all(String(guildId)).map((row) => ({
        ...row,
        enabled: Boolean(row.enabled)
      }));
    },

    listActiveVehicleFeeds() {
      return listAllActiveVehicleFeedsStmt.all().map((row) => ({ ...row, enabled: Boolean(row.enabled) }));
    },

    listStatusRules(guildId) {
      return listStatusRulesStmt.all(String(guildId)).map((row) => ({
        ...row,
        vehicle_id: row.vehicle_id ? String(row.vehicle_id) : null,
        enabled: Boolean(row.enabled),
        role_ids: parseRoleIds(row.role_ids_json)
      }));
    },

    getStatusRule(guildId, status, vehicleId = null) {
      const targetGuildId = String(guildId);
      const targetStatus = String(status);
      const scopedVehicleId = vehicleId ? String(vehicleId) : null;

      const row =
        (scopedVehicleId && getStatusRuleByVehicleStmt
          ? getStatusRuleByVehicleStmt.get(targetGuildId, scopedVehicleId, targetStatus)
          : null) ?? getGlobalStatusRuleStmt.get(targetGuildId, targetStatus);

      if (!row) return null;
      return {
        ...row,
        vehicle_id: row.vehicle_id ? String(row.vehicle_id) : null,
        enabled: Boolean(row.enabled),
        role_ids: parseRoleIds(row.role_ids_json)
      };
    },

    hasEvent(guildId, vehicleFeedId, eventHash) {
      return Boolean(hasEventStmt.get(String(guildId), Number(vehicleFeedId), String(eventHash)));
    },

    insertEventAndCheckpoint(payload) {
      insertEventAndCheckpointTx(payload);
    },

    getCheckpoint(vehicleFeedId) {
      return getCheckpointStmt.get(Number(vehicleFeedId)) ?? null;
    },

    countEventsForVehicle(vehicleFeedId) {
      return Number(countEventsStmt.get(Number(vehicleFeedId)).count);
    }
  };
}
