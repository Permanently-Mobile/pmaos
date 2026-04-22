import pino from 'pino';

import { getAction } from './actions.js';
import {
  createStepRecord,
  createWorkflowRun,
  generateRunId,
  updateStepRecord,
  updateWorkflowRun,
} from './db.js';
import type {
  ActionContext,
  StepResult,
  WorkflowDefinition,
  WorkflowRunState,
  WorkflowStep,
} from './types.js';

const logger = pino({ name: 'workflow-engine' });

type SendFn = (text: string) => Promise<void>;

/** Active run IDs -- prevents double-fire from cron triggers. */
const activeRuns = new Set<string>();

export class WorkflowEngine {
  private send: SendFn;

  constructor(send: SendFn) {
    this.send = send;
  }

  /**
   * Execute a workflow definition from start to finish.
   * Steps are organized into layers by dependency (topological sort).
   * Steps within a layer execute in parallel.
   */
  async execute(
    def: WorkflowDefinition,
    triggerType: string,
    triggerData?: unknown,
  ): Promise<WorkflowRunState> {
    const runId = generateRunId();
    const state: WorkflowRunState = {
      runId,
      workflowId: def.workflow,
      triggerType,
      triggerData,
      status: 'running',
      outputs: new Map(),
      stepResults: [],
      startedAt: Date.now(),
    };

    // Prevent concurrent runs of the same workflow (cron dedup)
    const runKey = `${def.workflow}`;
    if (activeRuns.has(runKey)) {
      logger.warn({ workflow: def.workflow }, 'Workflow already running, skipping');
      state.status = 'cancelled';
      state.error = 'Already running';
      return state;
    }
    activeRuns.add(runKey);

    try {
      // Persist run record
      createWorkflowRun({
        id: runId,
        workflowId: def.workflow,
        triggerType,
        triggerData: triggerData ? JSON.stringify(triggerData) : undefined,
      });

      // Pre-create all step records
      for (const step of def.steps) {
        createStepRecord({
          runId,
          stepId: step.id,
          action: step.action,
          input: step.params ? JSON.stringify(step.params) : undefined,
        });
      }

      logger.info(
        { runId, workflow: def.workflow, triggerType, steps: def.steps.length },
        'Starting workflow execution',
      );

      // Build execution layers (topological sort)
      const layers = this.buildLayers(def.steps);

      // Execute layer by layer
      for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
        const layer = layers[layerIdx];
        logger.info(
          { runId, layer: layerIdx, steps: layer.map((s) => s.id) },
          'Executing layer',
        );

        // Execute all steps in this layer in parallel
        const results = await Promise.allSettled(
          layer.map((step) => this.executeStep(step, state)),
        );

        // Process results
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const step = layer[i];

          if (result.status === 'rejected') {
            // Step threw an unhandled error (shouldn't happen -- executeStep catches)
            const err = result.reason instanceof Error ? result.reason.message : String(result.reason);
            state.stepResults.push({
              stepId: step.id,
              status: 'failed',
              output: null,
              error: err,
              durationMs: 0,
            });

            if (step.on_fail === 'stop' || !step.on_fail) {
              state.status = 'failed';
              state.error = `Step "${step.id}" failed: ${err}`;
              updateWorkflowRun(runId, 'failed', state.error);
              logger.error({ runId, stepId: step.id, err }, 'Workflow failed');
              return state;
            }
          }
          // fulfilled results are already handled inside executeStep
        }

        // Check if any step with on_fail='stop' caused a workflow abort
        if (state.status === 'failed') {
          return state;
        }
      }

      // All layers done
      state.status = 'completed';
      state.completedAt = Date.now();
      updateWorkflowRun(runId, 'completed');
      logger.info(
        { runId, workflow: def.workflow, durationMs: state.completedAt - state.startedAt },
        'Workflow completed',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      state.status = 'failed';
      state.error = msg;
      updateWorkflowRun(runId, 'failed', msg);
      logger.error({ runId, err }, 'Workflow execution error');
    } finally {
      activeRuns.delete(runKey);
    }

    return state;
  }

  /**
   * Topological sort using Kahn's algorithm.
   * Returns steps grouped into layers -- steps in the same layer can run in parallel.
   * Throws if a cycle is detected.
   */
  private buildLayers(steps: WorkflowStep[]): WorkflowStep[][] {
    const stepMap = new Map<string, WorkflowStep>();
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>(); // step -> steps that depend on it

    for (const step of steps) {
      stepMap.set(step.id, step);
      inDegree.set(step.id, 0);
      dependents.set(step.id, []);
    }

    // Build in-degree counts and dependency graph
    for (const step of steps) {
      if (step.depends && step.depends.length > 0) {
        inDegree.set(step.id, step.depends.length);
        for (const dep of step.depends) {
          dependents.get(dep)?.push(step.id);
        }
      }
    }

    const layers: WorkflowStep[][] = [];
    const processed = new Set<string>();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Find all steps with in-degree 0 that haven't been processed
      const ready: WorkflowStep[] = [];
      for (const [id, degree] of inDegree) {
        if (degree === 0 && !processed.has(id)) {
          ready.push(stepMap.get(id)!);
        }
      }

      if (ready.length === 0) break;

      layers.push(ready);

      // Remove these steps and reduce in-degree of dependents
      for (const step of ready) {
        processed.add(step.id);
        for (const depId of dependents.get(step.id) ?? []) {
          inDegree.set(depId, (inDegree.get(depId) ?? 1) - 1);
        }
      }
    }

    // Cycle detection: if not all steps were processed, there's a cycle
    if (processed.size !== steps.length) {
      const unprocessed = steps
        .filter((s) => !processed.has(s.id))
        .map((s) => s.id);
      throw new Error(`Workflow has circular dependencies: ${unprocessed.join(', ')}`);
    }

    return layers;
  }

  /**
   * Execute a single step with timeout, retry, condition check, and on_fail policy.
   */
  private async executeStep(
    step: WorkflowStep,
    state: WorkflowRunState,
  ): Promise<StepResult> {
    const startMs = Date.now();

    // Condition check -- skip if condition evaluates to falsy
    if (step.condition) {
      try {
        const conditionResult = this.evaluateCondition(step.condition, state.outputs);
        if (!conditionResult) {
          const result: StepResult = {
            stepId: step.id,
            status: 'skipped',
            output: null,
            error: 'Condition not met',
            durationMs: Date.now() - startMs,
          };
          state.stepResults.push(result);
          updateStepRecord(state.runId, step.id, { status: 'skipped', error: 'Condition not met' });
          logger.info({ runId: state.runId, stepId: step.id }, 'Step skipped (condition)');
          return result;
        }
      } catch (err) {
        logger.warn({ runId: state.runId, stepId: step.id, err }, 'Condition eval failed, running step anyway');
      }
    }

    // Look up action handler
    const handler = getAction(step.action);
    if (!handler) {
      const result: StepResult = {
        stepId: step.id,
        status: 'failed',
        output: null,
        error: `Unknown action: ${step.action}`,
        durationMs: Date.now() - startMs,
      };
      state.stepResults.push(result);
      updateStepRecord(state.runId, step.id, {
        status: 'failed',
        error: result.error,
      });
      return this.handleStepFailure(step, result, state);
    }

    // Resolve template variables in params
    const resolvedParams = this.resolveTemplates(
      step.params ?? {},
      state.outputs,
    );

    // Build action context
    const depOutputs: Record<string, unknown> = {};
    for (const dep of step.depends ?? []) {
      depOutputs[dep] = state.outputs.get(dep);
    }

    const context: ActionContext = {
      runId: state.runId,
      stepId: step.id,
      outputs: depOutputs,
      workflowId: state.workflowId,
      send: this.send,
    };

    // Execute with retries
    const maxRetries = step.on_fail === 'retry' ? (step.retry_max ?? 2) : 0;
    const timeoutMs = (step.timeout_s ?? 120) * 1000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        updateStepRecord(state.runId, step.id, { status: 'running' });

        // Run with timeout
        const output = await Promise.race([
          handler(resolvedParams, context),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Step timeout (${step.timeout_s ?? 120}s)`)), timeoutMs),
          ),
        ]);

        // Success
        const result: StepResult = {
          stepId: step.id,
          status: 'success',
          output,
          durationMs: Date.now() - startMs,
        };
        state.stepResults.push(result);
        state.outputs.set(step.id, output);

        const outputStr =
          typeof output === 'string'
            ? output.slice(0, 500)
            : JSON.stringify(output)?.slice(0, 500) ?? '';

        updateStepRecord(state.runId, step.id, {
          status: 'completed',
          output: outputStr,
          retryCount: attempt,
        });

        logger.info(
          { runId: state.runId, stepId: step.id, attempt, durationMs: result.durationMs },
          'Step completed',
        );
        return result;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.warn(
          { runId: state.runId, stepId: step.id, attempt, maxRetries, err: errMsg },
          'Step execution failed',
        );

        if (attempt < maxRetries) {
          // Wait before retry (exponential backoff: 2s, 4s, 8s...)
          const backoffMs = Math.min(2000 * Math.pow(2, attempt), 30000);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }

        // Final attempt failed
        const result: StepResult = {
          stepId: step.id,
          status: 'failed',
          output: null,
          error: errMsg,
          durationMs: Date.now() - startMs,
        };
        state.stepResults.push(result);
        updateStepRecord(state.runId, step.id, {
          status: 'failed',
          error: errMsg,
          retryCount: attempt,
        });

        return this.handleStepFailure(step, result, state);
      }
    }

    // Unreachable, but TypeScript needs it
    throw new Error(`Step "${step.id}" execution logic error`);
  }

  /**
   * Handle step failure based on on_fail policy.
   * Returns the step result (possibly modified).
   */
  private handleStepFailure(
    step: WorkflowStep,
    result: StepResult,
    state: WorkflowRunState,
  ): StepResult {
    switch (step.on_fail) {
      case 'skip':
        result.status = 'skipped';
        logger.info({ stepId: step.id }, 'Step failure policy: skip');
        break;

      case 'notify':
        // Send failure notification to Telegram, continue workflow
        this.send(`Workflow "${state.workflowId}" step "${step.id}" failed: ${result.error}`).catch(
          () => {},
        );
        result.status = 'skipped';
        logger.info({ stepId: step.id }, 'Step failure policy: notify + continue');
        break;

      case 'stop':
      default:
        // Abort the workflow
        state.status = 'failed';
        state.error = `Step "${step.id}" failed: ${result.error}`;
        updateWorkflowRun(state.runId, 'failed', state.error);
        logger.error({ stepId: step.id }, 'Step failure policy: stop workflow');
        break;
    }
    return result;
  }

  /**
   * Replace template variables in params.
   * {outputs.step_id} -> JSON output from that step
   * {outputs} -> all dependency outputs concatenated
   */
  private resolveTemplates(
    params: Record<string, unknown>,
    outputs: Map<string, unknown>,
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string') {
        resolved[key] = this.resolveString(value, outputs);
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        resolved[key] = this.resolveTemplates(
          value as Record<string, unknown>,
          outputs,
        );
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }

  /** Replace template variables in a single string. */
  private resolveString(
    str: string,
    outputs: Map<string, unknown>,
  ): string {
    // {outputs.step_id} -> specific step output
    let result = str.replace(/\{outputs\.(\w+)\}/g, (_match, stepId: string) => {
      const val = outputs.get(stepId);
      if (val === undefined) return `[no output from ${stepId}]`;
      return typeof val === 'string' ? val : JSON.stringify(val);
    });

    // {outputs} -> all outputs concatenated
    result = result.replace(/\{outputs\}/g, () => {
      const parts: string[] = [];
      for (const [id, val] of outputs) {
        const str = typeof val === 'string' ? val : JSON.stringify(val);
        parts.push(`[${id}]: ${str}`);
      }
      return parts.join('\n\n');
    });

    return result;
  }

  /**
   * Evaluate a simple condition string against outputs.
   * Supports: "step_id exists", "step_id contains keyword"
   */
  private evaluateCondition(
    condition: string,
    outputs: Map<string, unknown>,
  ): boolean {
    const parts = condition.trim().split(/\s+/);
    if (parts.length >= 3 && parts[1] === 'contains') {
      const val = String(outputs.get(parts[0]) ?? '');
      const keyword = parts.slice(2).join(' ');
      return val.toLowerCase().includes(keyword.toLowerCase());
    }
    if (parts.length === 2 && parts[1] === 'exists') {
      return outputs.has(parts[0]) && outputs.get(parts[0]) != null;
    }
    // Default: check if referenced step has truthy output
    return !!outputs.get(parts[0]);
  }

  /** Check if a workflow is currently running. */
  isRunning(workflowId: string): boolean {
    return activeRuns.has(workflowId);
  }
}
