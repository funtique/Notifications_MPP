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
app.set("trust proxy", 1);

app.use(morgan("combined"));
app.use(express.json({ limit: "1mb" }));
app.use(
  session({
    secret: config.sessionSecret,
    proxy: true,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: secureCookie ? "auto" : false
    }
  })
);

app.use("/api", createApiRouter({ repos, authHandlers, config, logger }));
app.use(express.static(publicDir));
app.use((error, req, res, _next) => {
  logger.error("Unhandled API error", {
    path: req.originalUrl,
    method: req.method,
    error: String(error?.stack ?? error)
  });

  if (res.headersSent) {
    return;
  }

  if (req.originalUrl?.startsWith("/api/")) {
    res.status(500).json({ error: "Internal server error" });
    return;
  }

  res.status(500).send("Internal server error");
});

const server = app.listen(config.port, () => {
  logger.info("API server started", {
    port: config.port,
    appBaseUrl: config.appBaseUrl,
    databaseUrl: config.databaseUrl
  });
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    logger.error("API startup failed: port already in use", {
      port: config.port,
      hint: "Stop the existing process/container on this port before restarting."
    });
    process.exit(1);
    return;
  }

  logger.error("API startup failed", { error: String(error?.stack ?? error) });
  process.exit(1);
});

function shutdown(signal) {
  logger.info("API shutdown requested", { signal });
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
