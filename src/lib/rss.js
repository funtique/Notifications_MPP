import { XMLParser } from "fast-xml-parser";
import { normalizePubDate } from "./date.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
  parseTagValue: false
});

function ensureArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeDescription(descriptionValue) {
  if (typeof descriptionValue === "string") {
    return descriptionValue.trim();
  }

  if (descriptionValue && typeof descriptionValue === "object") {
    return JSON.stringify(descriptionValue);
  }

  return "";
}

function extractTag(source, tagName) {
  if (!source || typeof source !== "string") return null;
  const regex = new RegExp(`<${tagName}>(.*?)</${tagName}>`, "i");
  const match = source.match(regex);
  return match ? match[1].trim() : null;
}

function extractTelemetry(descriptionValue) {
  if (descriptionValue && typeof descriptionValue === "object") {
    const idVehicule = descriptionValue.idVehicule ? String(descriptionValue.idVehicule).trim() : null;
    if (!idVehicule) return null;

    return {
      vehicleId: idVehicule,
      fuel: descriptionValue.niveauCarburant ? String(descriptionValue.niveauCarburant).trim() : null,
      wear: descriptionValue.usure ? String(descriptionValue.usure).trim() : null
    };
  }

  if (typeof descriptionValue === "string") {
    const vehicleId = extractTag(descriptionValue, "idVehicule");
    if (!vehicleId) return null;

    return {
      vehicleId,
      fuel: extractTag(descriptionValue, "niveauCarburant"),
      wear: extractTag(descriptionValue, "usure")
    };
  }

  return null;
}

export function extractStatus(description) {
  if (!description || typeof description !== "string") return null;
  const match = description.match(/est\s*:\s*([^\r\n<]+)/i);
  return match ? match[1].trim() : null;
}

export function parseFeed(xmlText) {
  const doc = parser.parse(xmlText);
  const channel = doc?.rss?.channel ?? {};
  const items = ensureArray(channel.item);

  const statusEvents = [];
  const telemetryByVehicleId = new Map();

  for (const item of items) {
    const title = String(item?.title ?? "").trim();
    const descriptionValue = item?.description;
    const description = normalizeDescription(descriptionValue);
    const pubDateRaw = item?.pubDate ? String(item.pubDate).trim() : null;
    const pubDateIso = normalizePubDate(pubDateRaw);

    const telemetry = extractTelemetry(descriptionValue);
    if (telemetry?.vehicleId) {
      telemetryByVehicleId.set(String(telemetry.vehicleId), {
        fuel: telemetry.fuel,
        wear: telemetry.wear
      });
    }

    if (title !== "Changement d'état") {
      continue;
    }

    const status = extractStatus(description);
    if (!status) {
      continue;
    }

    statusEvents.push({
      title,
      description,
      status,
      pubDateRaw,
      pubDateIso,
      guid: item?.guid ? String(item.guid) : null,
      link: item?.link ? String(item.link) : null
    });
  }

  statusEvents.sort((a, b) => {
    if (a.pubDateIso && b.pubDateIso) {
      return a.pubDateIso.localeCompare(b.pubDateIso);
    }
    if (a.pubDateIso && !b.pubDateIso) return 1;
    if (!a.pubDateIso && b.pubDateIso) return -1;
    return 0;
  });

  return {
    channelTitle: String(channel.title ?? "").trim(),
    statusEvents,
    telemetryByVehicleId
  };
}