/**
 * Telegram MessageSender adapter.
 *
 * Wraps Grammy Bot API calls behind the unified MessageSender interface.
 * This is the reference adapter -- Matrix and Signal follow this pattern.
 */

import fs from 'fs';
import { Api, InputFile, RawApi } from 'grammy';
import type { MessageSender, MessageSource } from './message-interface.js';
import { formatForTelegram, splitMessage } from './bot.js';

export class TelegramSender implements MessageSender {
  readonly platform: MessageSource = 'telegram';
  private api: Api<RawApi>;

  constructor(api: Api<RawApi>) {
    this.api = api;
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const parts = this.splitText(this.formatText(text));
    for (const part of parts) {
      await this.api.sendMessage(Number(chatId), part, { parse_mode: 'HTML' });
    }
  }

  async sendVoice(chatId: string, audioBuffer: Buffer, ext = 'mp3'): Promise<void> {
    await this.api.sendVoice(Number(chatId), new InputFile(audioBuffer, `response.${ext}`));
  }

  async sendFile(chatId: string, filePath: string, caption?: string): Promise<void> {
    if (!fs.existsSync(filePath)) {
      await this.api.sendMessage(Number(chatId), `Could not send file: ${filePath} (not found)`);
      return;
    }
    await this.api.sendDocument(Number(chatId), new InputFile(filePath), caption ? { caption } : undefined);
  }

  async sendPhoto(chatId: string, filePath: string, caption?: string): Promise<void> {
    if (!fs.existsSync(filePath)) {
      await this.api.sendMessage(Number(chatId), `Could not send photo: ${filePath} (not found)`);
      return;
    }
    await this.api.sendPhoto(Number(chatId), new InputFile(filePath), caption ? { caption } : undefined);
  }

  async sendTyping(chatId: string): Promise<void> {
    try {
      await this.api.sendChatAction(Number(chatId), 'typing');
    } catch {
      // typing indicator is best-effort
    }
  }

  formatText(text: string): string {
    return formatForTelegram(text);
  }

  splitText(text: string): string[] {
    return splitMessage(text);
  }
}
