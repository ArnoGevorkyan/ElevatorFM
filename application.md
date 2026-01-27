# Elevator FM — Discord Application Setup
Use this checklist to create/verify the bot in the Discord Developer Portal so your agent can fill values automatically.

## Core App Info
- **App Name:** Elevator FM
- **Description (suggested):** 24/7 elevator music bot with /floor to switch tracks and /join to choose a voice channel.
- **App Icon:** 1024x1024 PNG/JPG/WebP (upload any elevator/lofi style image).
- **Public Application:** Enabled (so others can invite it).

## Bot User
1) In **Bot** tab → "Add Bot" (if not already added).
2) Toggle **Public Bot:** On.
3) **Privileged Intents:** leave all off (not needed: no message content or member intent required).
4) **Presence Status:** Online.
5) **Token:** Copy and place into `.env` as `BOT_TOKEN=` (do NOT commit).

## OAuth2 (Invite URL)
- **Scopes:** `bot`, `applications.commands`
- **Bot Permissions:**
  - Connect
  - Speak
- **Permission Integer:** 3145728
- **Example Invite URL pattern:**
  `https://discord.com/api/oauth2/authorize?client_id=CLIENT_ID&permissions=3145728&scope=bot+applications.commands`
  Replace `CLIENT_ID` with `1465789832088256513`.

## IDs to collect
- **Client ID:** 1465789832088256513 (already set in `.env`).
- **DEV_GUILD_ID:** Right-click your test server → Copy ID (optional for faster command registration).
- **START_VOICE_CHANNEL_ID:** Right-click target voice channel → Copy ID (optional auto-join at startup).

## Slash Commands to register
- `/join [channel]` — join specified or caller voice channel.
- `/floor name` — switch to track (floor).
- `/floors` — list available floors.
- `/leave` — disconnect.

## Agent actions (apply after filling IDs/token)
1) `cp .env.example .env` (if not yet).
2) Fill `.env` with BOT_TOKEN, DEV_GUILD_ID (optional), START_VOICE_CHANNEL_ID (optional).
3) `npm run register:commands` (guild-scoped if DEV_GUILD_ID set; else global).
4) `pm2 start ecosystem.config.js --env production && pm2 save`.
5) Upload tracks to `tracks/` before starting playback.
