import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export function createDatabase(databaseUrl) {
  if (databaseUrl !== ":memory:") {
    const resolved = path.resolve(databaseUrl);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
  }

  const db = new Database(databaseUrl);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}