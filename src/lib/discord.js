function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildDiscordPayload({ vehicleId, status, eventPubDate, telemetry, roleIds }) {
  const mentions = Array.isArray(roleIds) ? roleIds.filter(Boolean).map((id) => `<@&${id}>`) : [];

  const fields = [];
  if (telemetry?.fuel) {
    fields.push({ name: "Carburant", value: `${telemetry.fuel}%`, inline: true });
  }
  if (telemetry?.wear) {
    fields.push({ name: "Usure", value: String(telemetry.wear), inline: true });
  }
  if (eventPubDate) {
    fields.push({ name: "Date source", value: eventPubDate, inline: false });
  }

  return {
    content: mentions.join(" "),
    allowed_mentions: { parse: [], roles: roleIds ?? [] },
    embeds: [
      {
        title: `Vehicule ${vehicleId} - ${status}`,
        color: 15158332,
        fields,
        timestamp: new Date().toISOString()
      }
    ]
  };
}

export async function sendDiscordMessageWithRetry({
  botToken,
  channelId,
  payload,
  fetchImpl = fetch,
  maxAttempts = 3,
  baseDelayMs = 300
}) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bot ${botToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Discord API error ${response.status}: ${body}`);
      }

      return;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await wait(baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  throw lastError;
}