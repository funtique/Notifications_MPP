import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import session from "express-session";
import morgan from "morgan";
import { getApiConfig } from "../config.js";
import { createDatabase } from "../db/client.js";
import { migrate } from "../db/migrate.js";
import { createRepositories } from "../db/repositories.js";
import { logger } from "../lib/logger.js";
import { createAuthHandlers } from "./auth.js";
import { createApiRouter } from "./routes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, "../../public");

const config = getApiConfig();
const db = createDatabase(config.databaseUrl);
migrate(db);
const repos = createRepositories(db);
const authHandlers = createAuthHandlers(config);
const secureCookie = (() => {
  try {
    return new URL(config.appBaseUrl).protocol === "https:";
  } catch {
    return config.nodeEnv === "production";
  }
})();

const app = express();

app.use(morgan("combined"));
app.use(express.json({ limit: "1mb" }));
app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: secureCookie
    }
  })
);

app.use("/api", createApiRouter({ repos, authHandlers, config, logger }));
app.use(express.static(publicDir));

app.listen(config.port, () => {
  logger.info("API server started", {
    port: config.port,
    appBaseUrl: config.appBaseUrl,
    databaseUrl: config.databaseUrl
  });
});

function shutdown(signal) {
  logger.info("API shutdown requested", { signal });
  db.close();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
