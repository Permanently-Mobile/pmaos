import fs from 'fs';
import path from 'path';
import pino from 'pino';

import { STORE_DIR } from '../config.js';
import type { WorkflowDefinition } from './types.js';

const logger = pino({ name: 'workflow-loader' });

function getWorkflowDir(): string {
  return path.join(STORE_DIR, 'workflows');
}

/** Validate a parsed object looks like a WorkflowDefinition. */
function validate(obj: unknown, file: string): obj is WorkflowDefinition {
  if (!obj || typeof obj !== 'object') {
    logger.warn({ file }, 'Workflow file is not a valid object');
    return false;
  }
  const def = obj as Record<string, unknown>;
  if (typeof def.workflow !== 'string' || !def.workflow) {
    logger.warn({ file }, 'Workflow missing "workflow" name field');
    return false;
  }
  if (!Array.isArray(def.triggers)) {
    logger.warn({ file, workflow: def.workflow }, 'Workflow missing "triggers" array');
    return false;
  }
  if (!Array.isArray(def.steps) || def.steps.length === 0) {
    logger.warn({ file, workflow: def.workflow }, 'Workflow missing or empty "steps" array');
    return false;
  }
  // Validate step IDs are unique
  const ids = new Set<string>();
  for (const step of def.steps as Array<Record<string, unknown>>) {
    if (typeof step.id !== 'string' || !step.id) {
      logger.warn({ file, workflow: def.workflow }, 'Step missing "id" field');
      return false;
    }
    if (ids.has(step.id)) {
      logger.warn({ file, workflow: def.workflow, stepId: step.id }, 'Duplicate step ID');
      return false;
    }
    ids.add(step.id);
    if (typeof step.action !== 'string' || !step.action) {
      logger.warn({ file, workflow: def.workflow, stepId: step.id }, 'Step missing "action"');
      return false;
    }
  }
  // Validate depends references exist
  for (const step of def.steps as Array<Record<string, unknown>>) {
    if (Array.isArray(step.depends)) {
      for (const dep of step.depends) {
        if (!ids.has(dep as string)) {
          logger.warn(
            { file, workflow: def.workflow, stepId: step.id, dep },
            'Step depends on non-existent step',
          );
          return false;
        }
      }
    }
  }
  return true;
}

/** Load all workflow definitions from store/workflows/*.json. */
export function loadWorkflows(): WorkflowDefinition[] {
  const dir = getWorkflowDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    return [];
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const workflows: WorkflowDefinition[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
      const parsed = JSON.parse(raw);
      if (validate(parsed, file)) {
        workflows.push(parsed);
      }
    } catch (err) {
      logger.warn({ file, err }, 'Failed to parse workflow file');
    }
  }
  logger.info({ count: workflows.length }, 'Loaded workflow definitions');
  return workflows;
}

/** Load a single workflow by name. */
export function loadWorkflow(name: string): WorkflowDefinition | null {
  const filePath = path.join(getWorkflowDir(), `${name}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return validate(parsed, `${name}.json`) ? parsed : null;
  } catch {
    return null;
  }
}

/** Save a workflow definition to disk. */
export function saveWorkflow(def: WorkflowDefinition): void {
  const dir = getWorkflowDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${def.workflow}.json`);
  fs.writeFileSync(filePath, JSON.stringify(def, null, 2), 'utf-8');
  logger.info({ workflow: def.workflow }, 'Saved workflow definition');
}

/** Delete a workflow definition from disk. */
export function deleteWorkflow(name: string): boolean {
  const filePath = path.join(getWorkflowDir(), `${name}.json`);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  logger.info({ workflow: name }, 'Deleted workflow definition');
  return true;
}

/** List all workflow definition file names (without .json). */
export function listWorkflowNames(): string[] {
  const dir = getWorkflowDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}
