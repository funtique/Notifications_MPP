import fs from "node:fs";
import path from "node:path";

const logDir = process.env.LOG_DIR ? path.resolve(process.env.LOG_DIR) : path.resolve(process.cwd(), "logs");

function ensureLogDir() {
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    // ignore directory creation failures; stdout logging still works
  }
}

function appendToLocalLogFile(payload) {
  ensureLogDir();
  const targetFile = path.join(logDir, `${process.env.LOG_FILE_BASENAME || "app"}.ndjson`);
  try {
    fs.appendFileSync(targetFile, `${JSON.stringify(payload)}\n`, "utf8");
  } catch {
    // ignore file persistence failures; stdout logging still works
  }
}

function write(level, message, meta = {}) {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta
  };
  // Keep log output JSON for easy ingestion in Docker/Portainer
  console.log(JSON.stringify(payload));
  appendToLocalLogFile(payload);
}

export function readRecentLogEntries({ basename = process.env.LOG_FILE_BASENAME || "app", limit = 200 } = {}) {
  const normalizedLimit = Math.max(1, Math.min(1000, Number(limit) || 200));
  const targetFile = path.join(logDir, `${basename}.ndjson`);
  if (!fs.existsSync(targetFile)) {
    return [];
  }

  const content = fs.readFileSync(targetFile, "utf8");
  const lines = content.split(/\r?\n/).filter(Boolean);
  return lines.slice(-normalizedLimit).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { timestamp: new Date().toISOString(), level: "warn", message: "Unparseable log line", raw: line };
    }
  });
}

export const logger = {
  info(message, meta) {
    write("info", message, meta);
  },
  warn(message, meta) {
    write("warn", message, meta);
  },
  error(message, meta) {
    write("error", message, meta);
  },
  debug(message, meta) {
    write("debug", message, meta);
  }
};
