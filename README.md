# Elevator FM Discord Bot
A 24/7 elevator-music Discord bot. It sits in a voice channel and loops tracks. Use `/join` to pick a channel and `/floor` to choose a track (floor).

## Setup
1) Copy env template and fill values:
```
cp .env.example .env
# set BOT_TOKEN, CLIENT_ID, optional DEV_GUILD_ID, START_VOICE_CHANNEL_ID
```
2) Add tracks: place `.mp3/.wav/.ogg` files in `tracks/`. The floor name is the file name (without extension).
3) Install deps (already done on this VPS):
```
npm install
```

## Register slash commands
- Fast dev (per guild): set `DEV_GUILD_ID` in `.env`, then:
```
npm run register:commands
```
- Global: omit `DEV_GUILD_ID` and run the same command (may take up to an hour to propagate).

## Run the bot
```
npm run start          # foreground
pm2 start ecosystem.config.js --env production
pm2 save               # persist across reboots
pm2 logs elevator-fm   # view logs
```

## Commands
- `/join [channel]` — join the specified voice channel (or the caller's current channel).
- `/floor name` — switch to a floor (track) by name.
- `/floors` — list available floors.
- `/leave` — disconnect the bot.

## Notes
- If `START_VOICE_CHANNEL_ID` is set, the bot will auto-join that channel on startup and begin playing the first track found.
- Tracks can be added without restart; `/floors` and `/floor` re-scan the `tracks/` directory on each call.
