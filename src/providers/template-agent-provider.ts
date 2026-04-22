/**
 * +-----------------------------------------------------------------+
 * |  AGENT PROVIDER TEMPLATE -- Copy this file to add a new agent   |
 * |                                                                 |
 * |  Steps:                                                         |
 * |  1. Copy this file to src/providers/<name>-agent-provider.ts    |
 * |  2. Fill in the blanks below (API, auth, execution logic)       |
 * |  3. Add model entries to model-registry.ts with 'tools' cap     |
 * |  4. Add to factory in index.ts (1 line)                         |
 * |  5. Build + restart                                             |
 * |                                                                 |
 * |  NOTE: If your model only generates code as text (no tool       |
 * |  execution), use the ChatProvider template instead and add      |
 * |  'code-gen' to its capabilities. The router handles REST        |
 * |  code-gen models through the ChatProvider path automatically.   |
 * +-----------------------------------------------------------------+
 */

import type { AgentProvider, ProviderResult, ProviderCapability, ProviderHealth } from './types.js';
import type { AgentProgressEvent } from '../agent.js';
import { logger } from '../logger.js';

export class TemplateAgentProvider implements AgentProvider {
  // -- FILL IN --------------------------------------------------
  readonly name = 'template-agent';                         // unique provider name
  readonly capabilities: ReadonlySet<ProviderCapability> = new Set([
    'chat', 'tools', 'code-gen',                            // add: 'session', 'local', etc.
  ]);

  private apiKey: string;
  private _defaultModel = 'example-agent-model';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  defaultModel(): string {
    return this._defaultModel;
  }

  async healthCheck(): Promise<ProviderHealth> {
    // TODO: Implement a lightweight check for your provider's availability.
    // Example: HEAD request to the API endpoint, version check, etc.
    return {
      status: 'unknown',
      latencyMs: null,
      lastChecked: Date.now(),
      consecutiveFailures: 0,
    };
  }

  async execute(
    message: string,
    _resumeToken: string | undefined,
    onTyping: () => void,
    onProgress?: (event: AgentProgressEvent) => void,
    _timeoutMs?: number,
    model?: string,
    _cwd?: string,
  ): Promise<ProviderResult> {
    const useModel = model || this._defaultModel;

    // -- Execute the agent -----------------------------------------
    // Replace this with your agent's execution logic.
    // This could be:
    //   - Spawning a subprocess (like Aider, OpenHands)
    //   - Calling a REST API with tool definitions
    //   - Running a local agent framework
    //
    // Call onTyping() periodically to keep typing indicator alive.
    // Call onProgress?.() to report sub-task status.

    logger.info({ provider: this.name, model: useModel }, 'Agent execution started');
    onTyping();

    // PLACEHOLDER: replace with actual agent call
    throw new Error(`${this.name} agent provider is not implemented yet`);

    // -- Return ProviderResult -------------------------------------
    // return {
    //   text: 'agent response here',
    //   resumeToken: undefined,
    //   usage: {
    //     inputTokens: 0,
    //     outputTokens: 0,
    //     totalTokens: 0,
    //     costUsd: null,
    //     provider: this.name,
    //     model: useModel,
    //   },
    //   provider: this.name,
    //   model: useModel,
    // };
  }
}
