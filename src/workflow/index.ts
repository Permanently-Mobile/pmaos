import pino from 'pino';

import { getRecentRuns } from './db.js';
import { WorkflowEngine } from './engine.js';
import { loadWorkflow, loadWorkflows, listWorkflowNames } from './loader.js';
import {
  checkCronTriggers,
  disableWorkflow,
  enableWorkflow,
  getCronTriggerInfo,
  getEventListenerInfo,
  initTriggers,
  isWorkflowEnabled,
} from './triggers.js';
import type { WorkflowDefinition, WorkflowRunState } from './types.js';

const logger = pino({ name: 'workflow' });

// Re-export public API
export { registerAction, getAction, listActions } from './actions.js';
export { getRecentRuns, getRunDetails, getAllWebhooks } from './db.js';
export { WorkflowEngine } from './engine.js';
export { loadWorkflows, loadWorkflow, saveWorkflow, deleteWorkflow, listWorkflowNames } from './loader.js';
export { emitEvent, checkCronTriggers, enableWorkflow, disableWorkflow, isWorkflowEnabled } from './triggers.js';
export { createWebhookApp } from './webhooks.js';
export type {
  WorkflowDefinition,
  WorkflowStep,
  WorkflowTrigger,
  WorkflowRunState,
  StepResult,
  ActionHandler,
  ActionContext,
  WorkflowRunRow,
  WorkflowStepRow,
  WebhookRow,
} from './types.js';

type SendFn = (text: string) => Promise<void>;

let engine: WorkflowEngine | null = null;
let definitions: WorkflowDefinition[] = [];

/**
 * Initialize the workflow system.
 * Loads definitions, registers triggers, starts the engine.
 * Call once at startup (primary bot only).
 */
export function initWorkflowSystem(send: SendFn): WorkflowEngine {
  // Load all workflow definitions
  definitions = loadWorkflows();

  // Create engine
  engine = new WorkflowEngine(send);

  // Register triggers
  initTriggers(definitions, engine);

  logger.info(
    { workflows: definitions.length },
    'Workflow system initialized',
  );

  return engine;
}

/** Get the singleton engine instance. Throws if not initialized. */
export function getWorkflowEngine(): WorkflowEngine {
  if (!engine) throw new Error('Workflow system not initialized');
  return engine;
}

/**
 * Manually trigger a workflow by name.
 * Used by /workflow run <name> and API endpoints.
 */
export async function runWorkflow(
  name: string,
  triggerData?: unknown,
): Promise<WorkflowRunState | null> {
  if (!engine) {
    logger.warn('Workflow engine not initialized');
    return null;
  }

  // Try cached definitions first, fall back to disk
  let def = definitions.find((d) => d.workflow === name);
  if (!def) {
    def = loadWorkflow(name) ?? undefined;
  }

  if (!def) {
    logger.warn({ name }, 'Workflow not found');
    return null;
  }

  return engine.execute(def, 'manual', triggerData);
}

/**
 * Get status summary of all workflows for display.
 */
export function getWorkflowStatus(): Array<{
  workflow: string;
  description?: string;
  enabled: boolean;
  triggers: string[];
  lastRun?: { id: string; status: string; at: number };
}> {
  const names = listWorkflowNames();
  const result: ReturnType<typeof getWorkflowStatus> = [];

  for (const name of names) {
    const def = definitions.find((d) => d.workflow === name) ?? loadWorkflow(name);
    if (!def) continue;

    // Get last run
    const runs = getRecentRuns(name, 1);
    const lastRun = runs[0]
      ? {
          id: runs[0].id,
          status: runs[0].status,
          at: runs[0].completed_at ?? runs[0].started_at ?? runs[0].created_at,
        }
      : undefined;

    // Summarize triggers
    const triggers: string[] = [];
    for (const t of def.triggers) {
      if (t.cron) triggers.push(`cron: ${t.cron}`);
      if (t.event) triggers.push(`event: ${t.event}`);
      if (t.webhook) triggers.push(`webhook: ${t.webhook}`);
      if (t.manual) triggers.push('manual');
    }

    result.push({
      workflow: def.workflow,
      description: def.description,
      enabled: isWorkflowEnabled(def.workflow),
      triggers,
      lastRun,
    });
  }

  return result;
}

/**
 * Get diagnostic info about the trigger system for debugging.
 */
export function getTriggerDiagnostics(): {
  crons: ReturnType<typeof getCronTriggerInfo>;
  events: ReturnType<typeof getEventListenerInfo>;
} {
  return {
    crons: getCronTriggerInfo(),
    events: getEventListenerInfo(),
  };
}

/**
 * Reload workflow definitions from disk.
 * Call after adding/modifying workflow files.
 */
export function reloadWorkflows(): void {
  if (!engine) return;
  definitions = loadWorkflows();
  initTriggers(definitions, engine);
  logger.info({ count: definitions.length }, 'Workflows reloaded');
}
