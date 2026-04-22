import { randomBytes } from 'crypto';

import { getDatabase } from '../db.js';
import type { WebhookRow, WorkflowRunRow, WorkflowStepRow } from './types.js';

// ── Workflow Runs ───────────────────────────────────────────────────

export function createWorkflowRun(run: {
  id: string;
  workflowId: string;
  triggerType: string;
  triggerData?: string;
}): void {
  const now = Math.floor(Date.now() / 1000);
  getDatabase()
    .prepare(
      `INSERT INTO workflow_runs (id, workflow_id, trigger_type, trigger_data, status, started_at, created_at)
       VALUES (?, ?, ?, ?, 'running', ?, ?)`,
    )
    .run(run.id, run.workflowId, run.triggerType, run.triggerData ?? null, now, now);
}

export function updateWorkflowRun(
  runId: string,
  status: string,
  error?: string,
): void {
  const now = Math.floor(Date.now() / 1000);
  getDatabase()
    .prepare(
      `UPDATE workflow_runs SET status = ?, completed_at = ?, error = ? WHERE id = ?`,
    )
    .run(status, now, error ?? null, runId);
}

export function getRecentRuns(
  workflowId?: string,
  limit = 20,
): WorkflowRunRow[] {
  const db = getDatabase();
  if (workflowId) {
    return db
      .prepare(
        `SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(workflowId, limit) as WorkflowRunRow[];
  }
  return db
    .prepare(`SELECT * FROM workflow_runs ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as WorkflowRunRow[];
}

export function getRunDetails(
  runId: string,
): { run: WorkflowRunRow | null; steps: WorkflowStepRow[] } {
  const db = getDatabase();
  const run = db
    .prepare(`SELECT * FROM workflow_runs WHERE id = ?`)
    .get(runId) as WorkflowRunRow | null;
  const steps = db
    .prepare(`SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY id`)
    .all(runId) as WorkflowStepRow[];
  return { run, steps };
}

// ── Workflow Steps ──────────────────────────────────────────────────

export function createStepRecord(step: {
  runId: string;
  stepId: string;
  action: string;
  input?: string;
}): void {
  getDatabase()
    .prepare(
      `INSERT INTO workflow_steps (run_id, step_id, action, status, input)
       VALUES (?, ?, ?, 'pending', ?)`,
    )
    .run(step.runId, step.stepId, step.action, step.input ?? null);
}

export function updateStepRecord(
  runId: string,
  stepId: string,
  update: {
    status: string;
    output?: string;
    error?: string;
    retryCount?: number;
  },
): void {
  const now = Math.floor(Date.now() / 1000);
  const db = getDatabase();

  if (update.status === 'running') {
    db.prepare(
      `UPDATE workflow_steps SET status = ?, started_at = ? WHERE run_id = ? AND step_id = ?`,
    ).run('running', now, runId, stepId);
  } else {
    db.prepare(
      `UPDATE workflow_steps
       SET status = ?, output = ?, error = ?, completed_at = ?, retry_count = COALESCE(?, retry_count)
       WHERE run_id = ? AND step_id = ?`,
    ).run(
      update.status,
      update.output ?? null,
      update.error ?? null,
      now,
      update.retryCount ?? null,
      runId,
      stepId,
    );
  }
}

// ── Webhooks ────────────────────────────────────────────────────────

export function createWebhook(webhook: {
  name: string;
  secret: string;
  workflowId: string;
  eventName?: string;
}): string {
  if (!webhook.secret) {
    throw new Error('Webhook secret is required');
  }
  const id = randomBytes(8).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  getDatabase()
    .prepare(
      `INSERT INTO webhooks (id, name, secret, workflow_id, event_name, active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(
      id,
      webhook.name,
      webhook.secret,
      webhook.workflowId,
      webhook.eventName ?? 'webhook_received',
      now,
    );
  return id;
}

export function getWebhook(id: string): WebhookRow | null {
  return getDatabase()
    .prepare(`SELECT * FROM webhooks WHERE id = ?`)
    .get(id) as WebhookRow | null;
}

export function getAllWebhooks(): WebhookRow[] {
  return getDatabase()
    .prepare(`SELECT * FROM webhooks ORDER BY created_at DESC`)
    .all() as WebhookRow[];
}

export function deleteWebhook(id: string): boolean {
  const result = getDatabase()
    .prepare(`DELETE FROM webhooks WHERE id = ?`)
    .run(id);
  return result.changes > 0;
}

// ── Utilities ───────────────────────────────────────────────────────

export function generateRunId(): string {
  return randomBytes(8).toString('hex');
}

export function pruneOldRuns(maxAgeDays = 30): number {
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeDays * 86400;
  const db = getDatabase();
  // Delete steps first (foreign key-like cleanup)
  const oldRuns = db
    .prepare(`SELECT id FROM workflow_runs WHERE created_at < ?`)
    .all(cutoff) as Array<{ id: string }>;
  if (oldRuns.length === 0) return 0;
  const ids = oldRuns.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM workflow_steps WHERE run_id IN (${placeholders})`).run(
    ...ids,
  );
  const result = db
    .prepare(`DELETE FROM workflow_runs WHERE created_at < ?`)
    .run(cutoff);
  return result.changes;
}
