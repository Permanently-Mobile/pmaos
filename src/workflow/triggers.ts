import { CronExpressionParser } from 'cron-parser';
import pino from 'pino';

import type { WorkflowEngine } from './engine.js';
import type { WorkflowDefinition, WorkflowTrigger } from './types.js';

const logger = pino({ name: 'workflow-triggers' });

// ── Trigger Registry ────────────────────────────────────────────────

interface CronEntry {
  workflowId: string;
  cron: string;
  lastFired: number;
  def: WorkflowDefinition;
}

interface EventEntry {
  workflowId: string;
  def: WorkflowDefinition;
}

const cronTriggers = new Map<string, CronEntry>(); // key: workflowId
const eventListeners = new Map<string, EventEntry[]>(); // key: event name
const disabledWorkflows = new Set<string>();

let engineRef: WorkflowEngine | null = null;

// ── Public API ──────────────────────────────────────────────────────

/**
 * Initialize all triggers from loaded workflow definitions.
 * Call once at startup after the engine is ready.
 */
export function initTriggers(
  workflows: WorkflowDefinition[],
  engine: WorkflowEngine,
): void {
  // Internal automation -- disabled by default in release builds
  if (process.env.ENABLE_WORKFLOWS !== 'true') {
    logger.info('Workflow triggers disabled (set ENABLE_WORKFLOWS=true to enable)');
    return;
  }

  engineRef = engine;
  cronTriggers.clear();
  eventListeners.clear();
  disabledWorkflows.clear();

  for (const def of workflows) {
    if (def.enabled === false) {
      disabledWorkflows.add(def.workflow);
      continue;
    }
    registerWorkflowTriggers(def);
  }

  logger.info(
    { crons: cronTriggers.size, events: eventListeners.size },
    'Workflow triggers initialized',
  );
}

/** Register all triggers for a single workflow definition. */
export function registerWorkflowTriggers(def: WorkflowDefinition): void {
  for (const trigger of def.triggers) {
    registerTrigger(trigger, def);
  }
}

/** Register a single trigger for a workflow. */
export function registerTrigger(
  trigger: WorkflowTrigger,
  def: WorkflowDefinition,
): void {
  if (trigger.cron) {
    // Validate cron expression
    try {
      CronExpressionParser.parse(trigger.cron);
    } catch (err) {
      logger.warn(
        { workflow: def.workflow, cron: trigger.cron, err },
        'Invalid cron expression, skipping',
      );
      return;
    }
    cronTriggers.set(def.workflow, {
      workflowId: def.workflow,
      cron: trigger.cron,
      lastFired: 0,
      def,
    });
    logger.info(
      { workflow: def.workflow, cron: trigger.cron },
      'Registered cron trigger',
    );
  }

  if (trigger.event) {
    const entries = eventListeners.get(trigger.event) ?? [];
    entries.push({ workflowId: def.workflow, def });
    eventListeners.set(trigger.event, entries);
    logger.info(
      { workflow: def.workflow, event: trigger.event },
      'Registered event trigger',
    );
  }
}

/**
 * Check which cron-triggered workflows are due for execution.
 * Called from the scheduler's 60-second tick.
 * Executes due workflows in the background (fire-and-forget).
 */
export function checkCronTriggers(): void {
  // Internal automation -- disabled by default in release builds
  if (process.env.ENABLE_WORKFLOWS !== 'true') return;
  if (!engineRef) return;

  const now = Date.now();

  for (const entry of cronTriggers.values()) {
    if (disabledWorkflows.has(entry.workflowId)) continue;

    try {
      const cron = CronExpressionParser.parse(entry.cron);
      const prev = cron.prev();
      const prevMs = prev.getTime();

      // Fire if the previous occurrence is after our last fire time
      // and within the last 90 seconds (covers the 60s poll interval + jitter)
      if (prevMs > entry.lastFired && now - prevMs < 90_000) {
        entry.lastFired = now;
        logger.info(
          { workflow: entry.workflowId, cron: entry.cron },
          'Cron trigger firing',
        );

        // Fire-and-forget -- don't block the scheduler
        engineRef
          .execute(entry.def, 'cron', { expression: entry.cron })
          .catch((err) => {
            logger.error(
              { workflow: entry.workflowId, err },
              'Cron-triggered workflow failed',
            );
          });
      }
    } catch (err) {
      logger.warn(
        { workflow: entry.workflowId, err },
        'Error checking cron trigger',
      );
    }
  }
}

/**
 * Emit an internal event. Any workflows registered for this event
 * will be executed in the background.
 */
export function emitEvent(name: string, payload?: unknown): void {
  if (!engineRef) return;

  const entries = eventListeners.get(name);
  if (!entries || entries.length === 0) return;

  logger.info({ event: name, workflows: entries.length }, 'Event emitted');

  for (const entry of entries) {
    if (disabledWorkflows.has(entry.workflowId)) continue;

    engineRef
      .execute(entry.def, 'event', { event: name, payload })
      .catch((err) => {
        logger.error(
          { workflow: entry.workflowId, event: name, err },
          'Event-triggered workflow failed',
        );
      });
  }
}

/** Enable a workflow (allow its triggers to fire). */
export function enableWorkflow(workflowId: string): void {
  disabledWorkflows.delete(workflowId);
}

/** Disable a workflow (suppress its triggers). */
export function disableWorkflow(workflowId: string): void {
  disabledWorkflows.add(workflowId);
}

/** Check if a workflow is enabled. */
export function isWorkflowEnabled(workflowId: string): boolean {
  return !disabledWorkflows.has(workflowId);
}

/** Get all registered cron triggers for status display. */
export function getCronTriggerInfo(): Array<{
  workflowId: string;
  cron: string;
  lastFired: number;
}> {
  return [...cronTriggers.values()].map((e) => ({
    workflowId: e.workflowId,
    cron: e.cron,
    lastFired: e.lastFired,
  }));
}

/** Get all registered event listeners for status display. */
export function getEventListenerInfo(): Record<string, string[]> {
  const info: Record<string, string[]> = {};
  for (const [event, entries] of eventListeners) {
    info[event] = entries.map((e) => e.workflowId);
  }
  return info;
}
