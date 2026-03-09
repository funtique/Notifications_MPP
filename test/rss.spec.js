import assert from "node:assert/strict";
import { extractStatus, parseFeed } from "../src/lib/rss.js";

const fixture = `<?xml version="1.0" encoding="utf8"?><rss version="2.0"><channel><title>VSAV 1 Eyguières</title><item><title>VSAV 1 Eyguières</title><description><idVehicule>2386</idVehicule><usure>5 %</usure><niveauCarburant>81</niveauCarburant></description></item><item><title>Changement d'état</title><pubDate>08/03/2026 21:54:19 GMT+1</pubDate><description>le VSAV 1 Eyguières est : Alerté</description></item><item><title>Changement d'état</title><pubDate>08/03/2026 21:55:19 GMT+1</pubDate><description>le VSAV 1 Eyguières est : Disponible</description></item></channel></rss>`;

export async function runRssTests() {
  assert.equal(extractStatus("le VSAV est : Alerté"), "Alerté");

  const parsed = parseFeed(fixture);
  assert.equal(parsed.statusEvents.length, 2);
  assert.equal(parsed.statusEvents[0].status, "Alerté");
  assert.deepEqual(parsed.telemetryByVehicleId.get("2386"), { fuel: "81", wear: "5 %" });
}