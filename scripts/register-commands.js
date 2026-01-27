require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { REST, Routes, ChannelType } = require('discord.js');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const DEV_GUILD_ID = process.env.DEV_GUILD_ID;

if (!BOT_TOKEN || !CLIENT_ID) {
  console.error('BOT_TOKEN and CLIENT_ID are required in .env');
  process.exit(1);
}

const TRACKS_DIR = path.join(__dirname, '..', 'tracks');
function loadTracks() {
  if (!fs.existsSync(TRACKS_DIR)) return [];
  return fs
    .readdirSync(TRACKS_DIR)
    .filter((f) => /\.(mp3|wav|ogg)$/i.test(f))
    .map((file) => ({ name: path.parse(file).name }));
}

const tracks = loadTracks();
const floorChoices = tracks.slice(0, 25).map((t) => ({ name: t.name, value: t.name }));

const commands = [
  {
    name: 'join',
    description: 'Join a voice channel',
    options: [
      {
        name: 'channel',
        description: 'Voice channel to join',
        type: 7, // CHANNEL
        channel_types: [ChannelType.GuildVoice, ChannelType.GuildStageVoice],
        required: false
      }
    ]
  },
  {
    name: 'floor',
    description: 'Choose a floor (track) to play'
  },
  {
    name: 'floors',
    description: 'List available floors'
  },
  {
    name: 'leave',
    description: 'Leave the voice channel'
  }
];

async function register() {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  try {
    console.log('Registering slash commands...');
    if (DEV_GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, DEV_GUILD_ID), { body: commands });
      console.log('Guild commands registered to DEV_GUILD_ID');
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('Global commands registered');
    }
  } catch (err) {
    console.error('Failed to register commands:', err);
    process.exit(1);
  }
}

register();
