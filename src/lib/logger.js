function write(level, message, meta = {}) {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta
  };
  // Keep log output JSON for easy ingestion in Docker/Portainer
  console.log(JSON.stringify(payload));
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