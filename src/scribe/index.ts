/**
 * Scribe -- pipeline orchestrator.
 *
 * Wires together: conversation_log -> threader -> classifier -> router.
 * This is the main entry point called by the worker or on-demand.
 */

import { logger } from '../logger.js';
import {
  getLastProcessedId,
  setLastProcessedId,
  getUnprocessedMessages,
  getMessagesSince,
  startScribeRun,
  completeScribeRun,
  logScribeItem,
} from './db.js';
import { buildThreads } from './threader.js';
import { classifyBatch, setKnownProjects, setVaultContext } from './classifier.js';
import { routeAllToVault, routeToVault } from './router.js';
import { writeMemoriesFromClassified } from './memory-writer.js';
import { hasMainWriteDb } from './db.js';
import {
  loadKnownProjects,
  loadCompletedTasks,
  isTaskAlreadyCompleted,
  buildVaultIndex,
  clearVaultIndex,
  buildVaultContextForClassifier,
  extractSignatureWords,
} from './vault-scanner.js';
import type { ScribeRunResult, ScribeOptions, ClassifiedItem } from './types.js';

// ── Main pipeline ───────────────────────────────────────────────────

/**
 * Run the full Scribe extraction pipeline.
 *
 * @param options.lookbackDays  Override: process last N days (ignores watermark)
 * @param options.afterMessageId  Override: process after specific conversation_log ID
 * @param options.dryRun  Classify but don't write to vault
 */
export async function runScribePipeline(
  options?: ScribeOptions,
  triggerType = 'on_demand',
  triggerDetail?: string,
): Promise<ScribeRunResult> {
  const startTime = Date.now();
  const runId = startScribeRun(triggerType, triggerDetail);

  const result: ScribeRunResult = {
    threadsProcessed: 0,
    itemsClassified: 0,
    itemsWritten: 0,
    itemsSkipped: 0,
    itemsDeduplicated: 0,
    memoriesCreated: 0,
    memoriesUpdated: 0,
    errors: [],
    durationMs: 0,
  };

  try {
    // 1. Build vault index (read-before-write: one scan per pipeline run)
    const vaultIndex = buildVaultIndex();
    setKnownProjects(vaultIndex.projects);
    setVaultContext(buildVaultContextForClassifier(vaultIndex));

    // 2. Get unprocessed messages
    let messages;
    if (options?.lookbackDays) {
      const since = Math.floor(Date.now() / 1000) - (options.lookbackDays * 86400);
      messages = getMessagesSince(since);
      logger.info({ lookbackDays: options.lookbackDays, messageCount: messages.length }, 'Fetched messages by lookback');
    } else {
      const afterId = options?.afterMessageId ?? getLastProcessedId();
      messages = getUnprocessedMessages(afterId);
      logger.info({ afterId, messageCount: messages.length }, 'Fetched unprocessed messages');
    }

    if (messages.length === 0) {
      logger.info('No new messages to process');
      result.durationMs = Date.now() - startTime;
      completeScribeRun(runId, result);
      return result;
    }

    // 3. Build conversation threads
    const threads = buildThreads(messages);
    result.threadsProcessed = threads.length;

    if (threads.length === 0) {
      logger.info('No meaningful threads found');
      // Still advance the watermark
      const maxId = Math.max(...messages.map(m => m.id));
      if (!options?.lookbackDays) setLastProcessedId(maxId);
      result.durationMs = Date.now() - startTime;
      completeScribeRun(runId, result);
      return result;
    }

    logger.info({ threadCount: threads.length }, 'Starting classification');

    // 4. Classify all threads via Venice
    const classifiedItems = await classifyBatch(threads);
    result.itemsClassified = classifiedItems.length;

    if (classifiedItems.length === 0) {
      logger.info('No items extracted from classification');
      const maxId = Math.max(...messages.map(m => m.id));
      if (!options?.lookbackDays) setLastProcessedId(maxId);
      result.durationMs = Date.now() - startTime;
      completeScribeRun(runId, result);
      return result;
    }

    // 4b. Cross-reference tasks against vault -- reclassify completed ones as progress
    const completedTasks = vaultIndex.completedTasks;
    let reclassified = 0;

    for (const item of classifiedItems) {
      if (item.category === 'task' && isTaskAlreadyCompleted(item.content, completedTasks)) {
        item.category = 'progress';
        reclassified++;
        logger.debug({ content: item.content.slice(0, 60) }, 'Reclassified completed task as progress');
      }
    }

    if (reclassified > 0) {
      logger.info({ reclassified }, 'Cross-referenced tasks against vault completed items');
    }

    // 4c. Substance gate -- reject trivial notes/research that would become orphan stubs
    // Note: thin notes that pass this gate but are still short get redirected to daily log
    // by the router's thin note gate (routeNote). This gate catches truly empty items.
    let gated = 0;
    for (const item of classifiedItems) {
      if (item.category === 'note' || item.category === 'research') {
        const sigWords = extractSignatureWords(item.content);
        if (sigWords.size < 3 || item.content.length < 20) {
          item.category = 'skip';
          gated++;
          logger.debug({ content: item.content.slice(0, 60), sigWords: sigWords.size }, 'Substance gate: too trivial');
        }
      }
    }

    if (gated > 0) {
      logger.info({ gated }, 'Substance gate rejected trivial items');
    }

    // 5. Route to vault (async -- semantic dedup may call Venice embeddings)
    const routeResults = await routeAllToVault(classifiedItems, options?.dryRun);

    for (let i = 0; i < classifiedItems.length; i++) {
      const item = classifiedItems[i];
      const route = routeResults[i];

      // Log each item to audit trail
      logScribeItem(runId, item, route.path || null, route.deduplicated);

      if (route.deduplicated) {
        result.itemsDeduplicated++;
      } else if (route.written) {
        result.itemsWritten++;
      } else if (route.error) {
        result.errors.push(`${item.category}: ${route.error}`);
        result.itemsSkipped++;
      } else {
        result.itemsSkipped++;
      }
    }

    // 6. Write to memories DB (Librarian -- Phase 1+2+3)
    if (!options?.dryRun && !options?.skipMemoryWrite && hasMainWriteDb()) {
      const chatId = messages[0]?.chat_id;
      if (chatId) {
        try {
          const memResult = await writeMemoriesFromClassified(chatId, classifiedItems, routeResults);
          result.memoriesCreated = memResult.created;
          result.memoriesUpdated = memResult.updated;
          if (memResult.errors.length > 0) {
            result.errors.push(...memResult.errors.map(e => `memory: ${e}`));
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          result.errors.push(`memory-writer: ${errMsg}`);
          logger.error({ err: errMsg }, 'Memory writer failed (non-fatal)');
        }
      }
    }

    // 7. Advance watermark
    const maxId = Math.max(...messages.map(m => m.id));
    if (!options?.lookbackDays && !options?.dryRun) {
      setLastProcessedId(maxId);
    }

    logger.info(
      {
        threads: result.threadsProcessed,
        classified: result.itemsClassified,
        written: result.itemsWritten,
        deduped: result.itemsDeduplicated,
        skipped: result.itemsSkipped,
        memCreated: result.memoriesCreated,
        memUpdated: result.memoriesUpdated,
        errors: result.errors.length,
      },
      'Scribe pipeline complete',
    );

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    result.errors.push(errMsg);
    logger.error({ err: errMsg }, 'Scribe pipeline error');
  } finally {
    // Clear cached vault index to free memory between runs
    clearVaultIndex();
  }

  result.durationMs = Date.now() - startTime;
  completeScribeRun(runId, result);
  return result;
}
