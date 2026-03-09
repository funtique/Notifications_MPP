import crypto from "node:crypto";

export function hashStable(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}