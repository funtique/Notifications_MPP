export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS guild_configs (
      guild_id TEXT PRIMARY KEY,
      guild_name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vehicle_feeds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      vehicle_id TEXT NOT NULL,
      vehicle_name TEXT,
      rss_url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(guild_id, vehicle_id),
      FOREIGN KEY(guild_id) REFERENCES guild_configs(guild_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS status_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      vehicle_id TEXT,
      status TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      role_ids_json TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(guild_id, status, vehicle_id),
      FOREIGN KEY(guild_id) REFERENCES guild_configs(guild_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS event_checkpoints (
      vehicle_feed_id INTEGER PRIMARY KEY,
      last_pub_date_iso TEXT,
      last_event_hash TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(vehicle_feed_id) REFERENCES vehicle_feeds(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      vehicle_feed_id INTEGER NOT NULL,
      event_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      pub_date_raw TEXT,
      pub_date_iso TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(guild_id, vehicle_feed_id, event_hash),
      FOREIGN KEY(vehicle_feed_id) REFERENCES vehicle_feeds(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_vehicle_feeds_active ON vehicle_feeds(enabled, guild_id);
    CREATE INDEX IF NOT EXISTS idx_status_rules_lookup ON status_rules(guild_id, status, vehicle_id, enabled);
    CREATE INDEX IF NOT EXISTS idx_events_vehicle_created ON events(vehicle_feed_id, created_at DESC, id DESC);
  `);

  try {
    db.exec("ALTER TABLE vehicle_feeds ADD COLUMN vehicle_name TEXT");
  } catch {
    // Column already exists on upgraded instances.
  }

  const statusRulesCols = db.prepare("PRAGMA table_info(status_rules)").all();
  const hasVehicleIdOnStatusRules = statusRulesCols.some((col) => col.name === "vehicle_id");

  if (!hasVehicleIdOnStatusRules) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS status_rules_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        vehicle_id TEXT,
        status TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        role_ids_json TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(guild_id, status, vehicle_id),
        FOREIGN KEY(guild_id) REFERENCES guild_configs(guild_id) ON DELETE CASCADE
      );

      INSERT INTO status_rules_v2 (id, guild_id, vehicle_id, status, channel_id, role_ids_json, enabled, created_at, updated_at)
      SELECT id, guild_id, NULL, status, channel_id, role_ids_json, enabled, created_at, updated_at
      FROM status_rules;

      DROP TABLE status_rules;
      ALTER TABLE status_rules_v2 RENAME TO status_rules;

      CREATE INDEX IF NOT EXISTS idx_status_rules_lookup ON status_rules(guild_id, status, vehicle_id, enabled);
    `);
  }
}
