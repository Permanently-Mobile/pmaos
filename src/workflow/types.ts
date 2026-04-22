// ── Workflow DAG Types ───────────────────────────────────────────────

/** A single step in a workflow DAG. */
export interface WorkflowStep {
  /** Unique step ID within the workflow (e.g. "scan_inbox") */
  id: string;
  /** Action handler name (e.g. "llm-query", "telegram-send", "vault-read") */
  action: string;
  /** Params passed to the action handler. Supports template vars: {outputs.step_id} */
  params?: Record<string, unknown>;
  /** Step IDs that must complete before this step runs */
  depends?: string[];
  /** Failure policy: stop (default), skip, notify (telegram + continue), retry */
  on_fail?: 'stop' | 'skip' | 'notify' | 'retry';
  /** Max retries when on_fail='retry' (default 2) */
  retry_max?: number;
  /** Step timeout in seconds (default 120) */
  timeout_s?: number;
  /** Optional JS expression evaluated at runtime. Step skips if falsy. */
  condition?: string;
}

/** Trigger definition for when a workflow should fire. */
export interface WorkflowTrigger {
  /** Cron expression (e.g. "0 9 * * *") */
  cron?: string;
  /** Internal event name (e.g. "agent_complete", "session_start") */
  event?: string;
  /** Webhook ID that triggers this workflow */
  webhook?: string;
  /** Allow manual trigger via /workflow run */
  manual?: boolean;
}

/** Full workflow definition (stored as JSON in store/workflows/). */
export interface WorkflowDefinition {
  /** Unique workflow name/ID (e.g. "gmail-cleanup") */
  workflow: string;
  /** Human-readable description */
  description?: string;
  /** What triggers this workflow */
  triggers: WorkflowTrigger[];
  /** Ordered list of steps (DAG resolved from depends fields) */
  steps: WorkflowStep[];
  /** Whether this workflow is active (default true) */
  enabled?: boolean;
}

/** Result from executing a single step. */
export interface StepResult {
  stepId: string;
  status: 'success' | 'failed' | 'skipped';
  output: unknown;
  error?: string;
  durationMs: number;
}

/** Full state of a workflow run. */
export interface WorkflowRunState {
  runId: string;
  workflowId: string;
  triggerType: string;
  triggerData?: unknown;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  outputs: Map<string, unknown>;
  stepResults: StepResult[];
  startedAt: number;
  completedAt?: number;
  error?: string;
}

/** Async function that executes a workflow step action. */
export type ActionHandler = (
  params: Record<string, unknown>,
  context: ActionContext,
) => Promise<unknown>;

/** Context passed to every action handler. */
export interface ActionContext {
  /** Current workflow run ID */
  runId: string;
  /** Current step ID */
  stepId: string;
  /** Completed outputs from dependency steps */
  outputs: Record<string, unknown>;
  /** Name of the workflow being executed */
  workflowId: string;
  /** Send a message to Telegram */
  send: (text: string) => Promise<void>;
}

// ── DB Row Types ────────────────────────────────────────────────────

export interface WorkflowRunRow {
  id: string;
  workflow_id: string;
  trigger_type: string;
  trigger_data: string | null;
  status: string;
  started_at: number | null;
  completed_at: number | null;
  error: string | null;
  created_at: number;
}

export interface WorkflowStepRow {
  id: number;
  run_id: string;
  step_id: string;
  action: string;
  status: string;
  input: string | null;
  output: string | null;
  error: string | null;
  started_at: number | null;
  completed_at: number | null;
  retry_count: number;
}

export interface WebhookRow {
  id: string;
  name: string;
  secret: string | null;
  workflow_id: string;
  event_name: string;
  active: number;
  created_at: number;
}
