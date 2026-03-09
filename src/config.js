import dotenv from "dotenv";

dotenv.config();

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function required(name, value) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getSharedConfig() {
  return {
    nodeEnv: process.env.NODE_ENV ?? "development",
    databaseUrl: process.env.DATABASE_URL ?? "./data/app.db",
    pollIntervalSeconds: Math.max(10, toInt(process.env.POLL_INTERVAL_SECONDS, 60)),
    fetchConcurrency: Math.max(1, toInt(process.env.FETCH_CONCURRENCY, 5)),
    timezone: process.env.APP_TIMEZONE ?? "Europe/Paris"
  };
}

export function getApiConfig() {
  const shared = getSharedConfig();
  return {
    ...shared,
    port: Math.max(1, toInt(process.env.PORT, 3000)),
    appBaseUrl: required("APP_BASE_URL", process.env.APP_BASE_URL),
    sessionSecret: required("SESSION_SECRET", process.env.SESSION_SECRET),
    discordClientId: required("DISCORD_CLIENT_ID", process.env.DISCORD_CLIENT_ID),
    discordClientSecret: required("DISCORD_CLIENT_SECRET", process.env.DISCORD_CLIENT_SECRET),
    discordBotToken: required("DISCORD_BOT_TOKEN", process.env.DISCORD_BOT_TOKEN)
  };
}

export function getWorkerConfig() {
  const shared = getSharedConfig();
  return {
    ...shared,
    discordBotToken: required("DISCORD_BOT_TOKEN", process.env.DISCORD_BOT_TOKEN)
  };
}