'use strict';

require('dotenv').config();

function parseBoolean(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseList(value, separator = ',') {
  if (!value) return [];
  return value
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
}

function optional(value) {
  return value && value.trim() !== '' ? value.trim() : undefined;
}

const auth = optional(process.env.MC_AUTH) || 'offline';
const securityAuthPassword = optional(process.env.SECURITY_AUTH_PASSWORD);
const configuredSecurityCommands = parseList(process.env.SECURITY_AUTH_COMMANDS, ';');
const securityAuthCommands = configuredSecurityCommands.length > 0
  ? configuredSecurityCommands
  : ['/register {password}', '/login {password}'];
const healthPort = parseNumber(process.env.PORT || process.env.HEALTH_PORT, 3000);

const config = {
  minecraft: {
    host: optional(process.env.MC_HOST),
    port: parseNumber(process.env.MC_PORT, 25565),
    username: optional(process.env.MC_USERNAME) || 'AternosBot',
    password: optional(process.env.MC_PASSWORD),
    auth,
    version: optional(process.env.MC_VERSION) || false
  },
  commandPrefix: optional(process.env.COMMAND_PREFIX) || '!bot',
  authorizedUsers: parseList(process.env.AUTHORIZED_USERS).map((name) => name.toLowerCase()),
  replyMode: optional(process.env.REPLY_MODE) || 'chat',
  autoReconnect: parseBoolean(process.env.AUTO_RECONNECT, true),
  reconnectDelayMs: parseNumber(process.env.RECONNECT_DELAY_MS, 10000),
  pathfinderCanDig: parseBoolean(process.env.PATHFINDER_CAN_DIG, true),
  onSpawnCommands: parseList(process.env.ON_SPAWN_COMMANDS, ';'),
  autoAcceptResourcePack: parseBoolean(process.env.AUTO_ACCEPT_RESOURCE_PACK, true),
  securityAuth: {
    enabled: parseBoolean(process.env.SECURITY_AUTH_ENABLED, false),
    password: securityAuthPassword,
    commands: securityAuthCommands,
    delayMs: parseNumber(process.env.SECURITY_AUTH_DELAY_MS, 3000),
    commandDelayMs: parseNumber(process.env.SECURITY_AUTH_COMMAND_DELAY_MS, 1000)
  },
  antiAfk: {
    enabled: parseBoolean(process.env.ANTI_AFK_ENABLED, true),
    intervalMs: parseNumber(process.env.ANTI_AFK_INTERVAL_MS, 30000)
  },
  healthServer: {
    enabled: parseBoolean(process.env.HEALTH_SERVER_ENABLED, Boolean(process.env.PORT)),
    port: healthPort
  }
};

function validateConfig() {
  if (!config.minecraft.host) {
    throw new Error('MC_HOST is missing. Copy .env.example to .env and set your Aternos server address.');
  }

  if (!['offline', 'microsoft'].includes(config.minecraft.auth)) {
    throw new Error('MC_AUTH must be either "offline" or "microsoft".');
  }

  if (!['chat', 'whisper'].includes(config.replyMode)) {
    throw new Error('REPLY_MODE must be either "chat" or "whisper".');
  }

  if (config.securityAuth.enabled && !config.securityAuth.password) {
    throw new Error('SECURITY_AUTH_PASSWORD is required when SECURITY_AUTH_ENABLED=true.');
  }

  if (config.healthServer.enabled && (config.healthServer.port < 1 || config.healthServer.port > 65535)) {
    throw new Error('HEALTH_PORT/PORT must be a valid TCP port.');
  }
}

module.exports = {
  config,
  validateConfig
};
