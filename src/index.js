'use strict';

const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const collectBlock = require('mineflayer-collectblock').plugin;
const tool = require('mineflayer-tool').plugin;
const { config, validateConfig } = require('./config');
const { createCommandRunner, parseArgs } = require('./commands');
const { startHealthServer } = require('./health');

let reconnectTimer = null;
let shuttingDown = false;
let currentBot = null;
let antiAfkTimer = null;

const runtimeStatus = {
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  state: 'booting',
  server: `${config.minecraft.host}:${config.minecraft.port}`,
  username: config.minecraft.username,
  version: null,
  serverBrand: null,
  lastError: null,
  lastKick: null,
  lastDisconnect: null,
  lastResourcePack: null
};

startHealthServer(config.healthServer, () => runtimeStatus);

function updateStatus(patch) {
  Object.assign(runtimeStatus, patch, {
    updatedAt: new Date().toISOString()
  });
}

try {
  validateConfig();
} catch (error) {
  console.error('CONFIGURATION ERROR:', error.message);
  updateStatus({ state: 'error', lastError: error.message });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createBotOptions() {
  const options = {
    host: config.minecraft.host,
    port: config.minecraft.port,
    username: config.minecraft.username,
    auth: config.minecraft.auth
  };

  if (config.minecraft.password) options.password = config.minecraft.password;
  if (config.minecraft.version) options.version = config.minecraft.version;

  return options;
}

function scheduleReconnect(reason) {
  if (shuttingDown || !config.autoReconnect || reconnectTimer) return;

  console.log(`Reconnecting in ${config.reconnectDelayMs}ms (${reason})...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startBot();
  }, config.reconnectDelayMs);
}

function makeReply(bot) {
  return async function reply(username, message) {
    const text = String(message).slice(0, 240);

    if (config.replyMode === 'whisper') {
      bot.whisper(username, text);
      return;
    }

    bot.chat(text);
  };
}

function renderTemplate(template, values) {
  return template.replace(/\{([a-z_]+)\}/gi, (match, key) => {
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match;
  });
}

function redactSecrets(text) {
  if (!config.securityAuth.password) return text;
  return text.split(config.securityAuth.password).join('********');
}

async function runSecurityAuth(bot) {
  if (!config.securityAuth.enabled) return;

  await sleep(config.securityAuth.delayMs);

  for (const template of config.securityAuth.commands) {
    const command = renderTemplate(template, {
      password: config.securityAuth.password,
      username: config.minecraft.username
    });

    if (!command.trim()) continue;

    console.log(`Sending server auth command: ${redactSecrets(command)}`);
    bot.chat(command);
    await sleep(config.securityAuth.commandDelayMs);
  }
}

async function runSpawnAutomation(bot) {
  await runSecurityAuth(bot);

  for (const command of config.onSpawnCommands) {
    bot.chat(command);
    await sleep(500);
  }

  bot.chat(`Ready. Use ${config.commandPrefix} help`);
}

function isAuthorized(username) {
  if (config.authorizedUsers.length === 0) return true;
  return config.authorizedUsers.includes(username.toLowerCase());
}

function startBot() {
  console.log(`Connecting to ${config.minecraft.host}:${config.minecraft.port} as ${config.minecraft.username}...`);
  updateStatus({ state: 'connecting', lastError: null, lastDisconnect: null });

  const bot = mineflayer.createBot(createBotOptions());
  currentBot = bot;
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(tool);
  bot.loadPlugin(collectBlock);

  const commandRunner = createCommandRunner(bot, {
    pathfinderCanDig: config.pathfinderCanDig
  });

  bot.on('resourcePack', (url, hash) => {
    updateStatus({
      lastResourcePack: {
        receivedAt: new Date().toISOString(),
        url,
        hash
      }
    });

    if (config.autoAcceptResourcePack) {
      console.log(`Server sent resource pack: ${url}. Accepting it.`);
      try {
        bot.acceptResourcePack();
      } catch (error) {
        console.error('Could not accept resource pack:', error.message);
      }
      return;
    }

    console.log('Server sent a resource pack. Denying it.');
    bot.denyResourcePack();
  });

  bot.once('spawn', () => {
    console.log(`Spawned on ${bot.game.serverBrand || 'Minecraft'} ${bot.version}.`);
    updateStatus({
      state: 'spawned',
      version: bot.version,
      serverBrand: bot.game.serverBrand || null
    });

    if (config.authorizedUsers.length === 0) {
      console.warn('AUTHORIZED_USERS is empty. Anyone in chat can command the bot.');
    }

    commandRunner.onSpawn();
    runSpawnAutomation(bot).catch((error) => {
      updateStatus({ lastError: error.message });
      console.error('Spawn automation failed:', error.message);
    });
  });

  bot.on('chat', async (username, message) => {
    if (username === bot.username) return;
    if (!message.startsWith(config.commandPrefix)) return;

    const reply = makeReply(bot);

    if (!isAuthorized(username)) {
      await reply(username, 'You are not allowed to command me.');
      return;
    }

    const raw = message.slice(config.commandPrefix.length).trim();
    const args = parseArgs(raw);
    const commandName = (args.shift() || 'help').toLowerCase();

    try {
      await commandRunner.handle(username, commandName, args, reply);
    } catch (error) {
      console.error(error);
      await reply(username, `Command failed: ${error.message}`);
    }
  });

  bot.on('kicked', (reason) => {
    console.log('Kicked:', reason);
    updateStatus({ state: 'kicked', lastKick: String(reason) });
  });

  bot.on('error', (error) => {
    console.error('Bot error:', error.message);
    updateStatus({ lastError: error.message });
  });

  bot.on('end', (reason) => {
    console.log('Disconnected:', reason || 'connection ended');
    if (currentBot === bot) currentBot = null;
    updateStatus({
      state: 'disconnected',
      lastDisconnect: String(reason || 'connection ended')
    });
    scheduleReconnect(reason || 'disconnected');
  });

  if (config.antiAfk.enabled) {
    if (antiAfkTimer) clearInterval(antiAfkTimer);
    antiAfkTimer = setInterval(() => {
      if (!bot.entity || !bot.pathfinder) return;
      if (bot.pathfinder.isMoving()) return;

      // Small random movement
      const yaw = bot.entity.yaw + (Math.random() - 0.5) * 0.2;
      bot.look(yaw, bot.entity.pitch, false);
      bot.setControlState('jump', true);
      setTimeout(() => {
        if (currentBot === bot) bot.setControlState('jump', false);
      }, 500);
    }, config.antiAfk.intervalMs);
  }
}

function shutdown(signal) {
  console.log(`Received ${signal}. Shutting down.`);
  shuttingDown = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (antiAfkTimer) clearInterval(antiAfkTimer);

  if (currentBot) {
    currentBot.quit('Bot shutting down');
    setTimeout(() => process.exit(0), 500).unref();
    return;
  }

  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (runtimeStatus.state !== 'error') {
  startBot();
} else {
  console.warn('Bot will not start due to configuration errors. Please check your environment variables in Railway.');
}
