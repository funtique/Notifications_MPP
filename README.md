# RSS -> Discord Multi-Serveur

Application Node.js pour surveiller des flux RSS/XML de vehicules et envoyer des notifications Discord par statut, par serveur.

## Fonctionnalites

- Dashboard web avec connexion Discord OAuth2
- Permissions: uniquement administrateurs de serveur Discord
- Configuration multi-serveur:
  - plusieurs vehicules par serveur
  - regles par statut (`status -> channel_id + role_ids[]`)
- Ajout simplifie de vehicule:
  - `vehicle_id` seul possible
  - URL RSS auto-genee via `RSS_URL_TEMPLATE`
  - nom du vehicule auto-resolu depuis `channel > title`
- Worker polling global (`POLL_INTERVAL_SECONDS`, concurrence limitee)
- Deduplication robuste par hash d'evenement
- SQLite avec retention de 50 evenements par vehicule

## API v1

- `GET /api/guilds`
- `GET /api/guilds/:guildId/vehicles`
- `POST /api/guilds/:guildId/vehicles/resolve`
- `PUT /api/guilds/:guildId/vehicles`
- `GET /api/guilds/:guildId/status-rules`
- `PUT /api/guilds/:guildId/status-rules`
- `POST /api/guilds/:guildId/test-notification`

## Variables d'environnement

Copier `.env.example` vers `.env`.

- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `DISCORD_BOT_TOKEN`
- `APP_BASE_URL` (ex: `https://ton-domaine`)
- `SESSION_SECRET`
- `DATABASE_URL` (default local ou `/data/app.db` en Docker)
- `POLL_INTERVAL_SECONDS` (default `60`)
- `FETCH_CONCURRENCY` (default `5`)
- `APP_TIMEZONE` (default `Europe/Paris`)
- `RSS_URL_TEMPLATE` (default `https://monpompier.com/flux/vehicules/{vehicle_id}.xml`)
- `PORT` (default `3000`)

## Lancement local

```bash
npm install
npm run start:api
npm run start:worker
```

## Docker / Portainer

1. Creer `.env` ou renseigner les variables dans Portainer.
2. Deployer la stack `docker-compose.yml`.
3. Monter le volume `rss_data` (persistance SQLite).

Services:
- `api`: dashboard + endpoints
- `worker`: polling RSS + envoi Discord

## Exemples vehicules

JSON minimal (URL + nom auto):

```json
[
  { "vehicle_id": "2439", "enabled": true }
]
```

JSON explicite:

```json
[
  {
    "vehicle_id": "2439",
    "rss_url": "https://monpompier.com/flux/vehicules/2439.xml",
    "vehicle_name": "VSAV 1 Eyguières",
    "enabled": true
  }
]
```

## Tests

```bash
npm test
```