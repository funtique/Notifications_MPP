function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUrl(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function discordRequest(path, { accessToken }) {
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(`https://discord.com/api/v10${path}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    if (response.ok) {
      return response.json();
    }

    const body = await response.text();
    if (response.status === 429 && attempt < maxAttempts) {
      let retryMs = Number(response.headers.get("retry-after")) * 1000;
      if (!Number.isFinite(retryMs)) {
        try {
          const parsed = JSON.parse(body);
          retryMs = Number(parsed?.retry_after) * 1000;
        } catch {
          retryMs = 1000;
        }
      }
      const boundedRetryMs = Math.max(250, Math.min(5000, Number.isFinite(retryMs) ? retryMs : 1000));
      await wait(boundedRetryMs);
      continue;
    }

    const error = new Error(`Discord request failed (${response.status}): ${body}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
}

function hasAdminPermission(permissionString) {
  try {
    return (BigInt(permissionString ?? "0") & 0x8n) === 0x8n;
  } catch {
    return false;
  }
}

export function createAuthHandlers(config) {
  const redirectUri = `${config.appBaseUrl}/api/auth/callback`;

  function login(req, res) {
    const state = Math.random().toString(36).slice(2);
    req.session.oauthState = state;

    const authUrl = buildUrl("https://discord.com/oauth2/authorize", {
      client_id: config.discordClientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: "identify guilds",
      state,
      prompt: "none"
    });

    return req.session.save((error) => {
      if (error) {
        return res.status(500).send("Unable to start login session");
      }
      return res.redirect(authUrl);
    });
  }

  async function callback(req, res) {
    const { code, state } = req.query;
    if (!code || !state || state !== req.session.oauthState) {
      return res.status(400).send("Invalid OAuth callback state");
    }

    const params = new URLSearchParams({
      client_id: config.discordClientId,
      client_secret: config.discordClientSecret,
      grant_type: "authorization_code",
      code: String(code),
      redirect_uri: redirectUri
    });

    const tokenResponse = await fetch("https://discord.com/api/v10/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString()
    });

    if (!tokenResponse.ok) {
      const body = await tokenResponse.text();
      return res.status(500).send(`OAuth token exchange failed: ${body}`);
    }

    const tokenData = await tokenResponse.json();
    const user = await discordRequest("/users/@me", { accessToken: tokenData.access_token });

    req.session.user = {
      id: user.id,
      username: user.username,
      avatar: user.avatar
    };
    req.session.accessToken = tokenData.access_token;
    delete req.session.oauthState;

    return req.session.save((error) => {
      if (error) {
        return res.status(500).send("Unable to persist login session");
      }
      return res.redirect("/dashboard.html");
    });
  }

  function logout(req, res) {
    req.session.destroy(() => {
      res.redirect("/");
    });
  }

  async function me(req, res) {
    if (!req.session.user || !req.session.accessToken) {
      return res.status(401).json({ authenticated: false });
    }

    return res.json({ authenticated: true, user: req.session.user });
  }

  async function fetchAdminGuilds(req) {
    const ttlMs = 30_000;
    const cachedAt = Number(req.session.guildsCacheAt ?? 0);
    const cachedGuilds = Array.isArray(req.session.adminGuildsCache) ? req.session.adminGuildsCache : null;

    if (cachedGuilds && Date.now() - cachedAt < ttlMs) {
      return cachedGuilds;
    }

    const guilds = await discordRequest("/users/@me/guilds", { accessToken: req.session.accessToken });
    const adminGuilds = guilds.filter((guild) => hasAdminPermission(guild.permissions));
    req.session.adminGuildsCache = adminGuilds;
    req.session.guildsCacheAt = Date.now();
    return adminGuilds;
  }

  return {
    login,
    callback,
    logout,
    me,
    fetchAdminGuilds
  };
}
