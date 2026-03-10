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
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord request failed (${response.status}): ${body}`);
  }

  return response.json();
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

    res.redirect(authUrl);
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
      return res.redirect("/");
    });
  }

  function logout(req, res) {
    req.session.destroy(() => {
      res.redirect("/");
    });
  }

  async function me(req, res) {
    if (!req.session.user) {
      return res.status(401).json({ authenticated: false });
    }

    return res.json({ authenticated: true, user: req.session.user });
  }

  async function fetchAdminGuilds(req) {
    const guilds = await discordRequest("/users/@me/guilds", { accessToken: req.session.accessToken });
    return guilds.filter((guild) => hasAdminPermission(guild.permissions));
  }

  return {
    login,
    callback,
    logout,
    me,
    fetchAdminGuilds
  };
}
