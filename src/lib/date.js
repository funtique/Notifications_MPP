function parseFrenchLikeDate(raw) {
  const match = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+GMT([+-]\d{1,2})$/i);
  if (!match) {
    return null;
  }

  const [, dd, mm, yyyy, hh, mi, ss, tzHoursRaw] = match;
  const tzHours = Number.parseInt(tzHoursRaw, 10);
  const utcMillis = Date.UTC(
    Number.parseInt(yyyy, 10),
    Number.parseInt(mm, 10) - 1,
    Number.parseInt(dd, 10),
    Number.parseInt(hh, 10) - tzHours,
    Number.parseInt(mi, 10),
    Number.parseInt(ss, 10)
  );

  if (!Number.isFinite(utcMillis)) {
    return null;
  }
  return new Date(utcMillis).toISOString();
}

export function normalizePubDate(rawPubDate) {
  if (!rawPubDate || typeof rawPubDate !== "string") {
    return null;
  }

  const direct = Date.parse(rawPubDate);
  if (!Number.isNaN(direct)) {
    return new Date(direct).toISOString();
  }

  return parseFrenchLikeDate(rawPubDate.trim());
}