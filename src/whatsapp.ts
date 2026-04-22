import path from 'path';

import qrcode from 'qrcode-terminal';
import wwebjs from 'whatsapp-web.js';
const { Client, LocalAuth } = wwebjs;
type Message = wwebjs.Message;

import { STORE_DIR } from './config.js';
import { getPendingWaMessages, markWaMessageSent, saveWaMessage } from './db.js';
import { logger } from './logger.js';

export type OnIncomingMessage = (contactName: string, isGroup: boolean, groupName?: string) => void;

export interface WaChat {
  id: string;
  name: string;
  unreadCount: number;
  lastMessage: string;
  lastMessageTime: number;
  isGroup: boolean;
}

export interface WaMessage {
  body: string;
  fromMe: boolean;
  senderName: string;
  timestamp: number;
}

let client: InstanceType<typeof Client> | null = null;

export async function initWhatsApp(onIncoming: OnIncomingMessage): Promise<void> {
  const sessionPath = path.join(STORE_DIR, 'waweb');

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: sessionPath }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  client.on('qr', (qr: string) => {
    console.log('\n  Scan this QR code with WhatsApp > Linked Devices:\n');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => {
    logger.info('WhatsApp authenticated');
  });

  client.on('ready', () => {
    logger.info('WhatsApp ready');
    console.log('\n  WhatsApp connected ✓\n');
    startOutboxPoller();
  });

  client.on('disconnected', (reason: string) => {
    logger.warn({ reason }, 'WhatsApp disconnected');
  });

  client.on('message', async (msg: Message) => {
    if (msg.fromMe || msg.from === 'status@broadcast' || !msg.body) return;

    try {
      const contact = await msg.getContact();
      const contactName = contact.pushname || contact.name || msg.from.replace(/@[cg]\.us$/, '');
      const isGroup = msg.from.endsWith('@g.us');
      const groupName = isGroup ? (await msg.getChat()).name : undefined;

      // Store message in DB (for skill access)
      saveWaMessage(msg.from, contactName, msg.body, msg.timestamp, false);

      // Notify Telegram with a brief ping — no full content
      onIncoming(contactName, isGroup, groupName);
    } catch (err) {
      logger.error({ err }, 'WhatsApp message handler error');
    }
  });

  await client.initialize();
}

export async function getWaChats(limit = 5): Promise<WaChat[]> {
  if (!client) throw new Error('WhatsApp not connected');
  const chats = await client.getChats();
  return chats
    .filter((c) => c.lastMessage)
    .slice(0, limit)
    .map((chat) => ({
      id: chat.id._serialized,
      name: chat.name,
      unreadCount: chat.unreadCount,
      lastMessage: chat.lastMessage?.body ?? '',
      lastMessageTime: chat.lastMessage?.timestamp ?? 0,
      isGroup: chat.isGroup,
    }));
}

export async function getWaChatMessages(chatId: string, limit = 10): Promise<WaMessage[]> {
  if (!client) throw new Error('WhatsApp not connected');
  const chat = await client.getChatById(chatId);
  const messages = await chat.fetchMessages({ limit });
  return messages.map((msg) => ({
    body: msg.body,
    fromMe: msg.fromMe,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    senderName: msg.fromMe ? 'You' : ((msg as any)._data?.notifyName ?? chat.name),
    timestamp: msg.timestamp,
  }));
}

export async function sendWhatsAppMessage(chatId: string, text: string): Promise<void> {
  if (!client) throw new Error('WhatsApp client not initialized');
  await client.sendMessage(chatId, text);
  saveWaMessage(chatId, 'You', text, Math.floor(Date.now() / 1000), true);
}

export function isWhatsAppReady(): boolean {
  return client !== null;
}

function startOutboxPoller(): void {
  setInterval(async () => {
    if (!client) return;
    const pending = getPendingWaMessages();
    for (const item of pending) {
      try {
        await client.sendMessage(item.to_chat_id, item.body);
        markWaMessageSent(item.id);
        logger.info({ to: item.to_chat_id, id: item.id }, 'Outbox message sent');
      } catch (err) {
        logger.error({ err, id: item.id }, 'Failed to send outbox message');
      }
    }
  }, 3000);
}
