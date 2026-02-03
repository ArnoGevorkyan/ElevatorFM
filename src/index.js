require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  Client,
  GatewayIntentBits,
  Events,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
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
const prism = require('prism-media');

// --- Config & constants ---
const TRACKS_DIR = path.join(__dirname, '..', 'tracks');
const NOTIFICATION_SOUND = path.join(TRACKS_DIR, 'notification.mp3');
const STATE_FILE = path.join(__dirname, '..', 'state.json');
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is missing in .env');
  process.exit(1);
}

// --- State persistence ---
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load state:', e.message);
  }
  return {};
}

function saveState(state) {
  try {
    const current = loadState();
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...current, ...state }, null, 2));
  } catch (e) {
    console.error('Failed to save state:', e.message);
  }
}

// --- Helpers ---
function loadTracks() {
  if (!fs.existsSync(TRACKS_DIR)) return [];
  return fs
    .readdirSync(TRACKS_DIR)
    .filter((file) => /\.(mp3|wav|ogg)$/i.test(file))
    .filter((file) => file.toLowerCase() !== 'notification.mp3')
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
const FADE_DURATION_SEC = 5; // 5 seconds fade out

const player = createAudioPlayer({
  behaviors: { noSubscriber: NoSubscriberBehavior.Play }
});

function stopFfmpeg() {
  if (currentFfmpeg) {
    try { currentFfmpeg.kill('SIGKILL'); } catch (_) {}
    currentFfmpeg = null;
  }
}

let volumeTransformer = null;

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

  // Create volume transformer for fade control
  volumeTransformer = new prism.VolumeTransformer({ type: 's16le', volume: 1 });
  console.log('[createLoopingResource] Created volumeTransformer');
  const audioStream = ffmpeg.stdout.pipe(volumeTransformer);

  const resource = createAudioResource(audioStream, {
    inputType: StreamType.Raw,
    metadata: { track: path.parse(filePath).name }
  });
  return resource;
}

function fadeOut() {
  return new Promise((resolve) => {
    console.log('[fadeOut] Starting fade, volumeTransformer:', !!volumeTransformer);
    if (!volumeTransformer) {
      console.log('[fadeOut] No volumeTransformer, skipping');
      resolve();
      return;
    }

    const steps = 30;
    const stepTime = (FADE_DURATION_SEC * 1000) / steps;
    let currentVolume = volumeTransformer.volume || 1;
    console.log('[fadeOut] Initial volume:', currentVolume, 'stepTime:', stepTime);

    const fadeInterval = setInterval(() => {
      currentVolume -= (1 / steps);
      if (currentVolume <= 0) {
        clearInterval(fadeInterval);
        try {
          volumeTransformer.setVolume(0);
        } catch (e) {
          console.error('[fadeOut] setVolume error:', e.message);
        }
        console.log('[fadeOut] Fade complete');
        resolve();
      } else {
        try {
          volumeTransformer.setVolume(currentVolume);
        } catch (e) {
          console.error('[fadeOut] setVolume error:', e.message);
          clearInterval(fadeInterval);
          resolve();
        }
      }
    }, stepTime);
  });
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

  voiceConnection.on('stateChange', async (oldState, newState) => {
    if (newState.status === VoiceConnectionStatus.Disconnected) {
      // Try to reconnect
      try {
        await entersState(voiceConnection, VoiceConnectionStatus.Connecting, 5000);
      } catch {
        // Could not reconnect in 5 sec, try to rejoin the channel
        console.log('Disconnected, attempting to rejoin...');
        try {
          voiceConnection.destroy();
        } catch (_) {}

        // Attempt to rejoin with exponential backoff
        const state = loadState();
        if (state.lastChannelId) {
          let delay = 1000;
          for (let attempt = 1; attempt <= 5; attempt++) {
            try {
              console.log(`Rejoin attempt ${attempt}/5...`);
              const ch = await client.channels.fetch(state.lastChannelId);
              if (ch?.isVoiceBased()) {
                await connectToChannel(ch);
                if (currentTrack) playTrack(currentTrack);
                console.log('Rejoined successfully');
                return;
              }
            } catch (e) {
              console.error(`Rejoin attempt ${attempt} failed:`, e.message);
            }
            await new Promise(r => setTimeout(r, delay));
            delay *= 2; // 1s, 2s, 4s, 8s, 16s
          }
          console.error('All rejoin attempts failed');
        }
      }
    }
  });

  voiceConnection.subscribe(player);
  await entersState(voiceConnection, VoiceConnectionStatus.Ready, 20_000);

  // Save last channel for auto-rejoin on restart
  saveState({ lastChannelId: channel.id, lastGuildId: channel.guild.id });

  return voiceConnection;
}

async function playNotificationThenTrack(trackName) {
  const track = getTrack(trackName);
  if (!track) throw new Error(`Track '${trackName}' not found`);

  console.log('[playNotificationThenTrack] Player status:', player.state.status);

  // Fade out current track if playing
  if (player.state.status === AudioPlayerStatus.Playing) {
    console.log('[playNotificationThenTrack] Starting fade out...');
    await fadeOut();
    console.log('[playNotificationThenTrack] Fade out done');
  } else {
    console.log('[playNotificationThenTrack] Not playing, skipping fade');
  }

  currentTrack = track.name;
  stopFfmpeg();

  // Check if notification sound exists
  if (fs.existsSync(NOTIFICATION_SOUND)) {
    // Play notification sound first (one-shot, no loop)
    const notificationResource = createAudioResource(NOTIFICATION_SOUND);
    player.play(notificationResource);

    // When notification finishes, start the floor music
    const onIdle = (oldState, newState) => {
      if (newState.status === AudioPlayerStatus.Idle) {
        player.off('stateChange', onIdle);
        const resource = createLoopingResource(track.fullPath);
        player.play(resource);
      }
    };
    player.on('stateChange', onIdle);
  } else {
    // No notification sound, play track directly
    const resource = createLoopingResource(track.fullPath);
    player.play(resource);
  }
}

function playTrack(trackName) {
  const track = getTrack(trackName);
  if (!track) throw new Error(`Track '${trackName}' not found`);
  currentTrack = track.name;
  saveState({ lastTrack: track.name });

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

  // Try to rejoin last channel from saved state
  const state = loadState();
  if (state.lastChannelId) {
    try {
      const channel = await c.channels.fetch(state.lastChannelId);
      if (channel?.isVoiceBased()) {
        await connectToChannel(channel);
        refreshTracks();
        // Resume last track or play first available
        const trackToPlay = state.lastTrack && getTrack(state.lastTrack) ? state.lastTrack : (tracks.length ? tracks[0].name : null);
        if (trackToPlay) playTrack(trackToPlay);
        console.log(`Auto-rejoined channel: ${channel.name}`);
      }
    } catch (err) {
      console.error('Auto-rejoin failed:', err.message);
    }
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  // Handle button interactions
  if (interaction.isButton() && interaction.customId.startsWith('floor:')) {
    const trackName = interaction.customId.slice(6);
    try {
      // Defer immediately to avoid timeout (we have 5 sec fade)
      await interaction.deferUpdate();

      await ensureConnected(interaction);
      await playNotificationThenTrack(trackName);
      refreshTracks();
      const buttons = tracks.slice(0, 25).map((t) =>
        new ButtonBuilder()
          .setCustomId(`floor:${t.name}`)
          .setLabel(t.name)
          .setStyle(currentTrack === t.name ? ButtonStyle.Success : ButtonStyle.Primary)
      );
      const rows = [];
      for (let i = 0; i < buttons.length; i += 5) {
        rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
      }
      return interaction.editReply({ content: `Now playing floor **${trackName}**.`, components: rows });
    } catch (err) {
      console.error('Button error:', err);
      if (!interaction.replied && !interaction.deferred) {
        return interaction.reply({ content: err.message, ephemeral: true });
      }
      return interaction.editReply({ content: err.message });
    }
  }

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
      const buttons = tracks.slice(0, 25).map((t) =>
        new ButtonBuilder()
          .setCustomId(`floor:${t.name}`)
          .setLabel(t.name)
          .setStyle(currentTrack === t.name ? ButtonStyle.Success : ButtonStyle.Primary)
      );
      const rows = [];
      for (let i = 0; i < buttons.length; i += 5) {
        rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
      }
      return interaction.reply({ content: 'Choose a floor:', components: rows, ephemeral: true });
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

// Handle unhandled errors to prevent crashes
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message || err);
  // Don't exit - let the bot try to recover
});

client.login(BOT_TOKEN);
