#!/usr/bin/env node
/**
 * Announce a Printventory beta release in Discord #latest-builds via the Printventory-Build bot
 * (announcement + @beta-testers).
 *
 * Discord bot credentials: scripts/.discord (ApplicationID / PublicKey / BotToken)
 *   or DISCORD_BOT_TOKEN env override.
 *
 * Usage:
 *   node scripts/publish-beta-release.js --changelog "- Fix foo\n- Fix bar"
 *   node scripts/publish-beta-release.js --dry-run --changelog "- Fix foo"
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'publish-beta-release.config.json');
const LOCAL_CONFIG_PATH = path.join(__dirname, 'publish-beta-release.local.json');
const LEGACY_DISCORD_CONFIG_PATH = path.join(__dirname, 'discord-latest-builds.config.json');
const DISCORD_CREDENTIALS_PATH = path.join(__dirname, '.discord');
const PACKAGE_PATH = path.join(__dirname, '..', 'package.json');
const DISCORD_API = 'https://discord.com/api/v10';

function deepMerge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = deepMerge(base?.[key] || {}, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function loadConfig() {
  let config = null;

  if (fs.existsSync(CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } else if (fs.existsSync(LEGACY_DISCORD_CONFIG_PATH)) {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_DISCORD_CONFIG_PATH, 'utf8'));
    config = {
      discord: legacy,
    };
  }

  if (!config) {
    console.error(`Missing config: ${CONFIG_PATH}`);
    process.exit(1);
  }

  if (fs.existsSync(LOCAL_CONFIG_PATH)) {
    config = deepMerge(config, JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8')));
  }

  return config;
}

function parseKeyValueFile(filePath) {
  const data = {};
  if (!fs.existsSync(filePath)) return data;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key) data[key] = value;
  }
  return data;
}

function loadDiscordBotCredentials(discordConfig) {
  const fileName = discordConfig.botCredentialsFile || '.discord';
  const filePath = path.isAbsolute(fileName) ? fileName : path.join(__dirname, fileName);
  const fromFile = parseKeyValueFile(filePath);
  return {
    applicationId: fromFile.ApplicationID || fromFile.applicationId || null,
    publicKey: fromFile.PublicKey || fromFile.publicKey || null,
    botToken: fromFile.BotToken || fromFile.botToken || null,
    credentialsPath: filePath,
  };
}

function loadVersion(explicitVersion) {
  if (explicitVersion) return explicitVersion.replace(/^v/, '');
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  return pkg.version;
}

function parseArgs(argv) {
  const args = {
    version: null,
    changelog: null,
    dryRun: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    // Kept so older npm scripts and workflows keep working; Discord is the only target now.
    else if (arg === '--discord-only') continue;
    else if (arg === '--version') args.version = argv[++i];
    else if (arg === '--changelog') args.changelog = argv[++i];
    else if (arg === '--discord-init' || arg === '--init') {
      console.error('--discord-init is no longer used. Discord posts a fresh announcement each release.');
      process.exit(1);
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/publish-beta-release.js [options]

Options:
  --version <semver>     Version to publish (default: package.json)
  --changelog <text>     Changelog lines (markdown bullets or plain lines)
  --dry-run              Print the announcement without posting it
  --help                 Show this help

Discord auth:
  scripts/.discord  (BotToken)  or  DISCORD_BOT_TOKEN
`);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }

  return args;
}

function normalizeChangelogInput(raw) {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (line.startsWith('- ') ? line : `- ${line.replace(/^[-*]\s*/, '')}`));
}

function parseReleaseBody(body) {
  if (!body) return [];
  const lines = body.split(/\r?\n/).map((line) => line.trim());
  const bullets = [];
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    if (/^[-*]\s+/.test(line)) {
      bullets.push(line.startsWith('- ') ? line : `- ${line.replace(/^[-*]\s+/, '')}`);
    }
  }
  return bullets.length > 0 ? bullets : normalizeChangelogInput(body);
}

function buildDownloadLinks(version, baseUrl) {
  const root = baseUrl.replace(/\/$/, '');
  return [
    `${root}/Printventory-Setup-${version}.exe`,
    `${root}/printventory-${version}-universal.dmg`,
    `${root}/printventory-${version}.AppImage`,
  ];
}

function buildDiscordAnnouncement(version, baseUrl, bullets, roleId) {
  const links = buildDownloadLinks(version, baseUrl);
  const changeLines =
    bullets.length > 0
      ? bullets.map((line) => (line.startsWith('- ') ? line : `- ${line}`))
      : [`- Release ${version}`];

  return [
    `<@&${roleId}>`,
    `**Printventory ${version} beta is ready for testing!**`,
    '',
    'Downloads:',
    ...links,
    '',
    'Changes:',
    ...changeLines,
  ].join('\n');
}

function resolveDiscordBotToken(discordConfig) {
  const fromEnv = process.env.DISCORD_BOT_TOKEN || null;
  if (fromEnv) return fromEnv;

  const creds = loadDiscordBotCredentials(discordConfig);
  if (creds.botToken) return creds.botToken;

  if (discordConfig.botToken) return discordConfig.botToken;

  console.error('Discord bot token not found.');
  console.error(`Add BotToken to ${creds.credentialsPath} (Printventory-Build) or set DISCORD_BOT_TOKEN.`);
  process.exit(1);
}

function applyDiscordEnv(discordConfig) {
  return {
    ...discordConfig,
    guildId: process.env.DISCORD_GUILD_ID || discordConfig.guildId,
    channelId: process.env.DISCORD_CHANNEL_ID || discordConfig.channelId,
    betaTestersRoleId: process.env.DISCORD_BETA_TESTERS_ROLE_ID || discordConfig.betaTestersRoleId,
    betaTestersRoleName: process.env.DISCORD_BETA_TESTERS_ROLE_NAME || discordConfig.betaTestersRoleName || 'beta-testers',
  };
}

function discordHeaders(token) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bot ${token}`,
  };
}

async function discordRequest(method, url, token, body) {
  const response = await fetch(url, {
    method,
    headers: discordHeaders(token),
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const detail = typeof data === 'object' ? JSON.stringify(data) : data;
    throw new Error(`Discord API ${method} ${url} failed (${response.status}): ${detail}`);
  }

  return data;
}

async function resolveBetaTestersRoleId(discordConfig, token) {
  if (discordConfig.betaTestersRoleId) return discordConfig.betaTestersRoleId;

  const guildId = discordConfig.guildId;
  if (!guildId) {
    throw new Error('discord.guildId is required to look up @beta-testers');
  }

  const roles = await discordRequest('GET', `${DISCORD_API}/guilds/${guildId}/roles`, token);
  const wanted = (discordConfig.betaTestersRoleName || 'beta-testers').toLowerCase();
  const match = roles.find((role) => {
    const name = String(role.name || '').toLowerCase();
    return name === wanted || name.replace(/\s+/g, '-') === wanted || /beta.?testers?/.test(name);
  });

  if (!match) {
    throw new Error(
      `Could not find Discord role matching "${discordConfig.betaTestersRoleName || 'beta-testers'}". ` +
        'Set discord.betaTestersRoleId in publish-beta-release.config.json or publish-beta-release.local.json.'
    );
  }

  return match.id;
}

async function postDiscordAnnouncement(discordConfig, token, content, roleId) {
  if (!discordConfig.channelId) {
    throw new Error('discord.channelId is required');
  }

  return discordRequest(
    'POST',
    `${DISCORD_API}/channels/${discordConfig.channelId}/messages`,
    token,
    {
      content,
      allowed_mentions: { roles: [roleId] },
    }
  );
}

function persistBetaTestersRoleId(roleId) {
  let local = {};
  if (fs.existsSync(LOCAL_CONFIG_PATH)) {
    local = JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8'));
  }
  if (!local.discord) local.discord = {};
  if (local.discord.betaTestersRoleId === roleId) return;
  local.discord.betaTestersRoleId = roleId;
  fs.writeFileSync(LOCAL_CONFIG_PATH, `${JSON.stringify(local, null, 2)}\n`, 'utf8');
  console.log('Saved betaTestersRoleId to publish-beta-release.local.json');
}

async function updateDiscordLatestBuilds(discordConfig, token, version, bullets, dryRun) {
  if (!token && !dryRun) {
    throw new Error('Discord bot token is required');
  }

  let roleId = discordConfig.betaTestersRoleId || null;
  if (!dryRun) {
    roleId = await resolveBetaTestersRoleId(discordConfig, token);
  } else if (!roleId) {
    roleId = 'ROLE_ID';
  }

  const content = buildDiscordAnnouncement(
    version,
    discordConfig.downloadBaseUrl,
    bullets,
    roleId
  );

  if (dryRun) {
    console.log('--- Discord #latest-builds announcement ---');
    console.log(content);
    return;
  }

  console.log(`Posting Discord #latest-builds announcement for v${version} (Printventory-Build bot)...`);
  const message = await postDiscordAnnouncement(discordConfig, token, content, roleId);
  persistBetaTestersRoleId(roleId);
  console.log(`Discord announcement posted (${message.id}), tagged @beta-testers.`);
}

async function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig();
  const version = loadVersion(args.version);
  const discordConfig = applyDiscordEnv(config.discord || {});

  const changelogSource =
    args.changelog ||
    process.env.CHANGELOG ||
    process.env.RELEASE_BODY ||
    process.env.GITHUB_EVENT_RELEASE_BODY;

  const bullets = normalizeChangelogInput(changelogSource);
  if (bullets.length === 0 && changelogSource) {
    bullets.push(...parseReleaseBody(changelogSource));
  }

  if (bullets.length === 0) {
    console.error('No changelog provided. Use --changelog, CHANGELOG, or RELEASE_BODY.');
    process.exit(1);
  }

  const discordToken = args.dryRun
    ? process.env.DISCORD_BOT_TOKEN || loadDiscordBotCredentials(discordConfig).botToken || null
    : resolveDiscordBotToken(discordConfig);

  await updateDiscordLatestBuilds(discordConfig, discordToken, version, bullets, args.dryRun);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
