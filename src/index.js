require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  Client,
  GatewayIntentBits,
  Events,
  ChannelType
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType
} = require('@discordjs/voice');

// --- Config & constants ---
const TRACKS_DIR = path.join(__dirname, '..', 'tracks');
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is missing in .env');
  process.exit(1);
}

// --- Helpers ---
function loadTracks() {
  if (!fs.existsSync(TRACKS_DIR)) return [];
  return fs
    .readdirSync(TRACKS_DIR)
    .filter((file) => /\.(mp3|wav|ogg)$/i.test(file))
    .map((file) => ({
      name: path.parse(file).name,
      file,
      fullPath: path.join(TRACKS_DIR, file)
    }));
}

let tracks = loadTracks();
function refreshTracks() {
  tracks = loadTracks();
  return tracks;
}

function getTrack(name) {
  if (!name) return null;
  return tracks.find((t) => t.name.toLowerCase() === name.toLowerCase()) || null;
}

// --- Discord client setup ---
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

let voiceConnection = null;
let currentTrack = null;
let currentFfmpeg = null;
const player = createAudioPlayer({
  behaviors: { noSubscriber: NoSubscriberBehavior.Play }
});

function stopFfmpeg() {
  if (currentFfmpeg) {
    try { currentFfmpeg.kill('SIGKILL'); } catch (_) {}
    currentFfmpeg = null;
  }
}

function createLoopingResource(filePath) {
  // Uses ffmpeg -stream_loop -1 for gapless looping
  const ffmpeg = spawn('ffmpeg', [
    '-loglevel', 'quiet',
    '-stream_loop', '-1',
    '-i', filePath,
    '-ar', '48000', // discord sample rate
    '-ac', '2',     // stereo
    '-f', 's16le',
    'pipe:1'
  ], { stdio: ['ignore', 'pipe', 'inherit'] });

  currentFfmpeg = ffmpeg;
  ffmpeg.on('exit', (code, signal) => {
    if (signal !== 'SIGKILL') {
      console.error(`ffmpeg exited (code ${code}, signal ${signal})`);
    }
  });

  const resource = createAudioResource(ffmpeg.stdout, {
    inputType: StreamType.Raw,
    metadata: { track: path.parse(filePath).name }
  });
  return resource;
}

player.on('error', (err) => {
  console.error('Audio player error:', err.message);
  // try to restart current track
  if (currentTrack) {
    setTimeout(() => {
      try {
        playTrack(currentTrack);
      } catch (e) {
        console.error('Recovery play failed:', e.message);
      }
    }, 1000);
  }
});

async function connectToChannel(channel) {
  if (!channel || !channel.isVoiceBased()) {
    throw new Error('Channel is not voice-capable');
  }

  voiceConnection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true
  });

  voiceConnection.on('stateChange', (oldState, newState) => {
    if (newState.status === VoiceConnectionStatus.Disconnected) {
      entersState(voiceConnection, VoiceConnectionStatus.Connecting, 5000).catch(() => {
        try { voiceConnection.destroy(); } catch (_) {}
      });
    }
  });

  voiceConnection.subscribe(player);
  await entersState(voiceConnection, VoiceConnectionStatus.Ready, 20_000);
  return voiceConnection;
}

function playTrack(trackName) {
  const track = getTrack(trackName);
  if (!track) throw new Error(`Track '${trackName}' not found`);
  currentTrack = track.name;

  stopFfmpeg();
  const resource = createLoopingResource(track.fullPath);
  player.play(resource);
}

async function ensureConnected(interaction) {
  if (voiceConnection && voiceConnection.state.status === VoiceConnectionStatus.Ready) return voiceConnection;
  const memberChannel = interaction.member?.voice?.channel;
  if (memberChannel && memberChannel.isVoiceBased()) {
    return connectToChannel(memberChannel);
  }
  throw new Error('Bot is not in a voice channel. Use /join first.');
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Elevator FM ready as ${c.user.tag}`);
  if (process.env.START_VOICE_CHANNEL_ID) {
    try {
      const channel = await c.channels.fetch(process.env.START_VOICE_CHANNEL_ID);
      if (channel?.isVoiceBased()) {
        await connectToChannel(channel);
        refreshTracks();
        if (tracks.length) playTrack(tracks[0].name);
      }
    } catch (err) {
      console.error('Auto-join failed:', err.message);
    }
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === 'join') {
      const channel = interaction.options.getChannel('channel') ?? interaction.member?.voice?.channel;
      if (!channel || (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice)) {
        return interaction.reply({
          content: 'Please specify a voice channel or join one first.',
          ephemeral: true
        });
      }
      await connectToChannel(channel);
      refreshTracks();
      if (!currentTrack && tracks.length) playTrack(tracks[0].name);
      return interaction.reply({ content: `Joined **${channel.name}**.`, ephemeral: false });
    }

    if (interaction.commandName === 'floor') {
      refreshTracks();
      if (!tracks.length) {
        return interaction.reply({ content: 'No tracks found. Upload .mp3/.wav/.ogg files to the tracks/ folder.', ephemeral: true });
      }
      const name = interaction.options.getString('name', true);
      const track = getTrack(name);
      if (!track) {
        const available = tracks.map((t) => t.name).join(', ');
        return interaction.reply({ content: `Unknown floor '${name}'. Available floors: ${available}`, ephemeral: true });
      }
      await ensureConnected(interaction);
      playTrack(track.name);
      return interaction.reply({ content: `Now playing floor **${track.name}**.`, ephemeral: false });
    }

    if (interaction.commandName === 'floors') {
      refreshTracks();
      const list = tracks.length ? tracks.map((t) => `• ${t.name}`).join('\n') : 'No tracks available yet.';
      return interaction.reply({ content: list, ephemeral: true });
    }

    if (interaction.commandName === 'leave') {
      currentTrack = null;
      player.stop(true);
      stopFfmpeg();
      if (voiceConnection) {
        voiceConnection.destroy();
        voiceConnection = null;
      }
      return interaction.reply({ content: 'Left the voice channel.', ephemeral: true });
    }
  } catch (err) {
    console.error('Command error:', err);
    if (interaction.replied || interaction.deferred) {
      interaction.followUp({ content: 'Something went wrong.', ephemeral: true }).catch(() => {});
    } else {
      interaction.reply({ content: 'Something went wrong.', ephemeral: true }).catch(() => {});
    }
  }
});

process.on('SIGINT', () => { stopFfmpeg(); process.exit(0); });
process.on('SIGTERM', () => { stopFfmpeg(); process.exit(0); });

client.login(BOT_TOKEN);
