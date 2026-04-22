import pino from 'pino';

const logger = pino({ name: 'message-queue' });

/**
 * Per-chat FIFO message queue.
 *
 * Ensures messages from the same chat are processed sequentially
 * (no interleaving), while different chats can run in parallel.
 *
 * Uses Promise chaining -- no DB, no locks, no overhead.
 * Grammy still gets immediate ack (fire-and-forget from the bot's perspective).
 * If the process crashes, Grammy re-delivers unacknowledged messages on restart.
 */
class ChatMessageQueue {
  private chains = new Map<string, Promise<void>>();

  /**
   * Enqueue a message handler for sequential processing within a chat.
   * The handler runs after all previously queued handlers for this chat complete.
   */
  enqueue(chatId: string, fn: () => Promise<void>): void {
    const prev = this.chains.get(chatId) ?? Promise.resolve();

    const next = prev.then(
      () => fn(),
      () => fn(), // run fn even if previous handler errored
    ).catch((err) => {
      logger.error({ chatId, err }, 'Queued message handler failed');
    });

    this.chains.set(chatId, next);

    // Cleanup: remove chain reference once it's the last in queue
    next.finally(() => {
      if (this.chains.get(chatId) === next) {
        this.chains.delete(chatId);
      }
    });
  }

  /** Get the current queue depth for a chat (0 = idle). */
  depth(chatId: string): number {
    return this.chains.has(chatId) ? 1 : 0;
  }

  /** Check if any chat has a pending queue. */
  get active(): boolean {
    return this.chains.size > 0;
  }

  /** Number of chats with active queues. */
  get size(): number {
    return this.chains.size;
  }
}

/** Singleton message queue instance. */
export const chatQueue = new ChatMessageQueue();
