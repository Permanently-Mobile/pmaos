#!/usr/bin/env node
/**
 * Discord CLI -- test Discord integration outside of the Telegram bot.
 *
 * Usage:
 *   node dist/discord-cli.js servers                -- list servers + channels
 *   node dist/discord-cli.js channels [--limit N]   -- list recent channels (all servers)
 *   node dist/discord-cli.js read <channelId> [--limit N]  -- read channel messages
 *   node dist/discord-cli.js send <channelId> "text"       -- send a message
 */

import { initDiscord, getDiscordServers, getDiscordChannels, getDiscordMessages, sendDiscordMessage, closeDiscord } from './discord.js';

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0]?.toLowerCase();
  const rest = args.slice(1);

  if (!cmd || cmd === 'help') {
    console.log(`Discord CLI
  servers                     -- list servers + channels
  channels [--limit N]        -- list recent channels
  read <channelId> [--limit N] -- read messages
  send <channelId> "text"     -- send a message`);
    process.exit(0);
  }

  // Init Discord (required for all commands)
  await initDiscord();

  try {
    switch (cmd) {
      case 'servers': {
        const servers = await getDiscordServers();
        for (const s of servers) {
          console.log(`\n${s.name} (${s.memberCount} members)`);
          for (const ch of s.channels.slice(0, 10)) {
            const preview = ch.lastMessage ? ch.lastMessage.slice(0, 50) : '';
            console.log(`  #${ch.name} (${ch.id}) -- ${preview}`);
          }
        }
        break;
      }

      case 'channels': {
        const limit = parseInt(parseFlag(rest, '--limit') || '15', 10);
        const channels = await getDiscordChannels(limit);
        console.log(JSON.stringify(channels, null, 2));
        break;
      }

      case 'read': {
        const channelId = rest[0];
        if (!channelId) { console.error('Usage: read <channelId>'); process.exit(1); }
        const limit = parseInt(parseFlag(rest, '--limit') || '15', 10);
        const messages = await getDiscordMessages(channelId, limit);
        for (const m of messages) {
          const prefix = m.fromMe ? 'YOU' : m.userName;
          console.log(`[${prefix}] ${m.text}`);
          if (m.attachments.length) console.log(`  Attachments: ${m.attachments.join(', ')}`);
        }
        break;
      }

      case 'send': {
        const channelId = rest[0];
        const message = rest[1];
        if (!channelId || !message) { console.error('Usage: send <channelId> "text"'); process.exit(1); }
        await sendDiscordMessage(channelId, message);
        console.log(JSON.stringify({ ok: true, channel: channelId }));
        break;
      }

      default:
        console.error(`Unknown command: ${cmd}`);
        process.exit(1);
    }
  } finally {
    await closeDiscord();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
