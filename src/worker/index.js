import { getWorkerConfig } from "../config.js";
import { createDatabase } from "../db/client.js";
import { migrate } from "../db/migrate.js";
import { createRepositories } from "../db/repositories.js";
import { logger } from "../lib/logger.js";
import { runPollingCycle } from "./processor.js";

process.env.LOG_FILE_BASENAME = process.env.LOG_FILE_BASENAME || "worker";

const config = getWorkerConfig();
const db = createDatabase(config.databaseUrl);
migrate(db);
const repos = createRepositories(db);

let isRunning = false;

async function runOnce() {
  if (isRunning) {
    logger.warn("Previous polling cycle still running, skipping this tick");
    return;
  }

  isRunning = true;
  try {
    const result = await runPollingCycle({
      repos,
      botToken: config.discordBotToken,
      fetchConcurrency: config.fetchConcurrency,
      logger
    });
    logger.info("Polling cycle completed", result);
  } catch (error) {
    logger.error("Polling cycle crashed", { error: String(error) });
  } finally {
    isRunning = false;
  }
}

const intervalMs = config.pollIntervalSeconds * 1000;
logger.info("Worker started", {
  pollIntervalSeconds: config.pollIntervalSeconds,
  fetchConcurrency: config.fetchConcurrency,
  databaseUrl: config.databaseUrl
});

await runOnce();
const interval = setInterval(runOnce, intervalMs);

function shutdown(signal) {
  logger.info("Worker shutdown requested", { signal });
  clearInterval(interval);
  db.close();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
