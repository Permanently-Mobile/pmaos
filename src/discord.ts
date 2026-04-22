/**
 * Discord Integration -- pull-based client for reading/sending Discord messages.
 *
 * Pattern: follows slack.ts (stateless, lazy client init, DB-backed history).
 * Uses discord.js v14 with Gateway intents for real-time message monitoring
 * and REST for on-demand pulls.
 */

import {
  Client,
  GatewayIntentBits,
  TextChannel,
  DMChannel,
  NewsChannel,
  ChannelType,
  Message as DiscordMessage,
  Partials,
} from 'discord.js';

import { DISCORD_TOKEN, DISCORD_ENABLED } from './config.js';
import { saveDiscordMessage } from './db.js';
import { logger } from './logger.js';

let client: Client | null = null;
let readyPromise: Promise<void> | null = null;
let onIncomingCallback: OnIncomingDiscordMessage | null = null;

// ── Types ───────────────────────────────────────────────────────────

export type OnIncomingDiscordMessage = (
  authorName: string,
  channelName: string,
  serverName: string | null,
  content: string,
) => void;

export interface DiscordServer {
  id: string;
  name: string;
  icon: string | null;
  memberCount: number;
  channels: DiscordChannelInfo[];
}

export interface DiscordChannelInfo {
  id: string;
  name: string;
  type: 'text' | 'dm' | 'voice' | 'thread' | 'other';
  unreadCount: number;
  lastMessage: string;
  lastMessageTs: number;
}

export interface DiscordChatMessage {
  text: string;
  userName: string;
  fromMe: boolean;
  ts: string;
  attachments: string[];
}

// ── Client lifecycle ─────────────────────────────────────────────────

function getClient(): Client {
  if (client?.isReady()) return client;

  if (!DISCORD_TOKEN) {
    throw new Error('DISCORD_TOKEN not set in .env');
  }

  if (!client) {
    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    readyPromise = new Promise<void>((resolve, reject) => {
      client!.once('clientReady', () => {
        logger.info({ user: client!.user?.tag }, 'Discord bot connected');
        resolve();
      });
      client!.once('error', (err) => {
        logger.error({ err }, 'Discord connection error');
        reject(err);
      });

      // Incoming message handler -- forwards to Telegram callback
      client!.on('messageCreate', (msg: DiscordMessage) => {
        if (msg.author.bot) return;
        if (msg.author.id === client!.user?.id) return;

        const channelName = getChannelName(msg.channel);
        const serverName = msg.guild?.name ?? null;

        // Save to DB (try-catch for standalone/CLI usage without DB init)
        try {
          saveDiscordMessage(
            msg.channel.id,
            channelName,
            serverName ?? '',
            msg.author.username,
            msg.content || '[attachment]',
            msg.id,
            false,
          );
        } catch {
          logger.debug('Discord DB save skipped (DB not initialized)');
        }

        if (onIncomingCallback) {
          onIncomingCallback(msg.author.username, channelName, serverName, msg.content);
        }
      });
    });

    client.login(DISCORD_TOKEN).catch((err) => {
      logger.error({ err }, 'Discord login failed');
      client = null;
      readyPromise = null;
    });
  }

  return client;
}

async function ensureReady(): Promise<Client> {
  const c = getClient();
  if (readyPromise) await readyPromise;
  return c;
}

function getChannelName(channel: TextChannel | DMChannel | NewsChannel | { id: string; type: number }): string {
  if ('name' in channel && channel.name) return channel.name as string;
  if ('recipient' in channel && channel.recipient) return `DM: ${(channel.recipient as { username: string }).username}`;
  return channel.id;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Initialize Discord with an optional incoming message callback.
 * Call once at startup. Subsequent calls are no-ops.
 */
export async function initDiscord(onIncoming?: OnIncomingDiscordMessage): Promise<void> {
  if (!DISCORD_ENABLED || !DISCORD_TOKEN) {
    logger.info('Discord disabled or token not set -- skipping init');
    return;
  }
  if (onIncoming) onIncomingCallback = onIncoming;
  await ensureReady();
}

/**
 * Check if Discord client is connected and ready.
 */
export function isDiscordReady(): boolean {
  return client?.isReady() ?? false;
}

/**
 * List servers (guilds) the bot is in, with their text channels.
 */
export async function getDiscordServers(): Promise<DiscordServer[]> {
  const c = await ensureReady();
  const guilds = c.guilds.cache;

  const servers: DiscordServer[] = [];

  for (const [, guild] of guilds) {
    const channels: DiscordChannelInfo[] = [];

    const guildChannels = guild.channels.cache.filter(
      (ch) => ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement,
    );

    for (const [, ch] of guildChannels) {
      const textCh = ch as TextChannel;
      let lastMessage = '';
      let lastMessageTs = 0;
      try {
        const msgs = await textCh.messages.fetch({ limit: 1 });
        const latest = msgs.first();
        if (latest) {
          lastMessage = latest.content || '[attachment]';
          lastMessageTs = latest.createdTimestamp;
        }
      } catch {
        // Can't read this channel, skip
        continue;
      }

      channels.push({
        id: ch.id,
        name: ch.name,
        type: 'text',
        unreadCount: 0, // Discord bots don't track unread
        lastMessage,
        lastMessageTs,
      });
    }

    // Sort channels by most recent activity
    channels.sort((a, b) => b.lastMessageTs - a.lastMessageTs);

    servers.push({
      id: guild.id,
      name: guild.name,
      icon: guild.iconURL(),
      memberCount: guild.memberCount,
      channels,
    });
  }

  return servers;
}

/**
 * List channels across all servers, sorted by recent activity.
 * Flattened view for the /discord command.
 */
export async function getDiscordChannels(limit = 15): Promise<(DiscordChannelInfo & { serverName: string })[]> {
  const c = await ensureReady();
  const results: (DiscordChannelInfo & { serverName: string })[] = [];

  // DMs
  try {
    const dmChannels = c.channels.cache.filter((ch) => ch.type === ChannelType.DM);
    for (const [, ch] of dmChannels) {
      const dm = ch as DMChannel;
      let lastMessage = '';
      let lastMessageTs = 0;
      try {
        const msgs = await dm.messages.fetch({ limit: 1 });
        const latest = msgs.first();
        if (latest) {
          lastMessage = latest.content || '[attachment]';
          lastMessageTs = latest.createdTimestamp;
        }
      } catch {
        continue;
      }

      if (!lastMessageTs) continue;

      results.push({
        id: dm.id,
        name: dm.recipient?.username ?? 'DM',
        type: 'dm',
        unreadCount: 0,
        lastMessage,
        lastMessageTs,
        serverName: 'Direct Messages',
      });
    }
  } catch {
    // DM fetch may fail
  }

  // Guild text channels
  for (const [, guild] of c.guilds.cache) {
    const textChannels = guild.channels.cache.filter(
      (ch) => ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement,
    );

    for (const [, ch] of textChannels) {
      const textCh = ch as TextChannel;
      let lastMessage = '';
      let lastMessageTs = 0;
      try {
        const msgs = await textCh.messages.fetch({ limit: 1 });
        const latest = msgs.first();
        if (latest) {
          lastMessage = latest.content || '[attachment]';
          lastMessageTs = latest.createdTimestamp;
        }
      } catch {
        continue;
      }

      if (!lastMessageTs) continue;

      results.push({
        id: ch.id,
        name: `#${ch.name}`,
        type: 'text',
        unreadCount: 0,
        lastMessage,
        lastMessageTs,
        serverName: guild.name,
      });
    }
  }

  results.sort((a, b) => b.lastMessageTs - a.lastMessageTs);
  return results.slice(0, limit);
}

/**
 * Get messages from a specific channel.
 */
export async function getDiscordMessages(channelId: string, limit = 15): Promise<DiscordChatMessage[]> {
  const c = await ensureReady();
  const channel = await c.channels.fetch(channelId);

  if (!channel || !('messages' in channel)) {
    throw new Error(`Channel ${channelId} not found or not a text channel`);
  }

  const textChannel = channel as TextChannel | DMChannel;
  const fetched = await textChannel.messages.fetch({ limit });
  const myId = c.user?.id;

  const messages: DiscordChatMessage[] = [];

  // Reverse to get chronological order (oldest first)
  const sorted = [...fetched.values()].reverse();

  for (const msg of sorted) {
    messages.push({
      text: msg.content || '',
      userName: msg.author.bot ? `${msg.author.username} [BOT]` : msg.author.username,
      fromMe: msg.author.id === myId,
      ts: msg.id,
      attachments: msg.attachments.map((a) => a.url),
    });
  }

  return messages;
}

/**
 * Send a message to a Discord channel.
 */
export async function sendDiscordMessage(channelId: string, text: string, channelName?: string): Promise<void> {
  const c = await ensureReady();
  const channel = await c.channels.fetch(channelId);

  if (!channel || !('send' in channel)) {
    throw new Error(`Channel ${channelId} not found or not a text channel`);
  }

  const textChannel = channel as TextChannel | DMChannel;
  const sent = await textChannel.send(text);

  try {
    saveDiscordMessage(
      channelId,
      channelName || getChannelName(textChannel),
      ('guild' in textChannel && textChannel.guild) ? textChannel.guild.name : '',
      c.user?.username || 'Bot',
      text,
      sent.id,
      true,
    );
  } catch {
    logger.debug('Discord DB save skipped (DB not initialized)');
  }

  logger.info({ channel: channelId }, 'Discord message sent');
}

/**
 * Graceful shutdown.
 */
export async function closeDiscord(): Promise<void> {
  if (client) {
    client.destroy();
    client = null;
    readyPromise = null;
    logger.info('Discord client destroyed');
  }
}
