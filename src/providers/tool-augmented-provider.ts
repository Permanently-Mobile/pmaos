/**
 * ToolAugmentedProvider -- Wraps any ChatProvider with local tool execution.
 *
 * Implements AgentProvider by running a simple agent loop:
 *   1. Send message + tool descriptions to a REST ChatProvider
 *   2. Parse <tool_use> blocks from the model's response
 *   3. Execute tools locally via ToolExecutor
 *   4. Feed results back to the model
 *   5. Repeat until the model gives a final answer or max iterations hit
 *
 * This bridges the gap between Tier 1 (chat-only) and Tier 2 (tool-executing)
 * providers, giving fallback models limited tool access when Claude is down.
 */

import type {
  AgentProvider,
  ChatProvider,
  ChatMessage,
  ProviderResult,
  ProviderCapability,
  ProviderHealth,
  NormalizedUsage,
} from './types.js';
import type { AgentProgressEvent } from '../agent.js';
import { ToolExecutor } from './tool-executor.js';
import type { ToolDefinition } from './tool-executor.js';
import { logger } from '../logger.js';

// ── Constants ───────────────────────────────────────────────────────

/** Maximum agent loop iterations to prevent runaway. */
const MAX_ITERATIONS = 5;

/** Regex to extract <tool_use> blocks from model output. */
const TOOL_USE_REGEX = /<tool_use>\s*([\s\S]*?)\s*<\/tool_use>/g;

// ── Tool-augmented system prompt builder ────────────────────────────

function buildToolSystemPrompt(tools: ToolDefinition[]): string {
  const toolDocs = tools.map(t => {
    const argsDoc = Object.entries(t.args)
      .map(([name, spec]) => `    - ${name} (${spec.type}${spec.required ? ', required' : ''}): ${spec.description}`)
      .join('\n');
    return `### ${t.name}\n${t.description}\n  Arguments:\n${argsDoc || '    (none)'}`;
  }).join('\n\n');

  return `You have access to LOCAL tools that you can execute. When you need to use a tool, respond with a JSON block wrapped in <tool_use> tags. You may include text before or after the tool call.

To use a tool, include this in your response:
<tool_use>
{"tool": "toolName", "args": {"argName": "value"}}
</tool_use>

You can make multiple tool calls in one response by including multiple <tool_use> blocks.

After each tool call, you will receive the result and can decide whether to make more calls or give your final answer. When you have enough information, respond with your final answer WITHOUT any <tool_use> blocks.

IMPORTANT:
- Only use tools when needed. If you can answer from your knowledge, do so directly.
- You have a maximum of ${MAX_ITERATIONS} tool call rounds. Use them wisely.
- Tool results will be provided in <tool_result> tags.

Available tools:

${toolDocs}`;
}

// ── ToolAugmentedProvider ───────────────────────────────────────────

export class ToolAugmentedProvider implements AgentProvider {
  readonly name: string;
  readonly capabilities: ReadonlySet<ProviderCapability>;

  private chatProvider: ChatProvider;
  private toolExecutor: ToolExecutor;

  constructor(chatProvider: ChatProvider, toolExecutor: ToolExecutor) {
    this.chatProvider = chatProvider;
    this.toolExecutor = toolExecutor;
    this.name = `${chatProvider.name}-augmented`;

    // Inherit chat provider capabilities + add 'tools'
    const caps = new Set(chatProvider.capabilities);
    caps.add('tools');
    this.capabilities = caps;
  }

  isConfigured(): boolean {
    return this.chatProvider.isConfigured();
  }

  defaultModel(): string {
    return this.chatProvider.defaultModel();
  }

  async healthCheck(): Promise<ProviderHealth> {
    // Delegate to the underlying chat provider's health check
    return this.chatProvider.healthCheck();
  }

  /**
   * Execute a message with tool-augmented agent loop.
   *
   * Runs the ChatProvider in a loop, parsing tool calls from its output,
   * executing them locally, and feeding results back until the model
   * produces a final answer (no tool calls) or we hit MAX_ITERATIONS.
   */
  async execute(
    message: string,
    _resumeToken: string | undefined,
    onTyping: () => void,
    onProgress?: (event: AgentProgressEvent) => void,
    _timeoutMs?: number,
    model?: string,
    _cwd?: string,
  ): Promise<ProviderResult> {
    const toolDefs = this.toolExecutor.getToolDefinitions();
    const toolSystemPrompt = buildToolSystemPrompt(toolDefs);

    // Build conversation history for the agent loop
    const messages: ChatMessage[] = [
      { role: 'system', content: toolSystemPrompt },
      { role: 'user', content: message },
    ];

    // Accumulate usage across iterations
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCostUsd: number | null = null;
    let lastModel = model || this.chatProvider.defaultModel();

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      onTyping();

      if (onProgress && iteration > 0) {
        onProgress({
          type: 'task_started',
          description: `Tool-augmented loop iteration ${iteration + 1}/${MAX_ITERATIONS}`,
        });
      }

      logger.info(
        { provider: this.name, iteration, messageCount: messages.length },
        'ToolAugmented: sending to chat provider',
      );

      // Call the underlying chat provider
      let result;
      try {
        result = await this.chatProvider.chat(messages, model);
      } catch (err) {
        logger.error({ err, provider: this.name, iteration }, 'ToolAugmented: chat provider call failed');
        throw err;
      }

      // Accumulate usage
      totalInputTokens += result.usage.inputTokens;
      totalOutputTokens += result.usage.outputTokens;
      if (result.usage.costUsd !== null) {
        totalCostUsd = (totalCostUsd ?? 0) + result.usage.costUsd;
      }
      lastModel = result.usage.model;

      const responseText = result.text;

      // Parse tool calls from response
      const toolCalls = this.parseToolCalls(responseText);

      if (toolCalls.length === 0) {
        // No tool calls -- this is the final answer
        logger.info(
          { provider: this.name, iterations: iteration + 1 },
          'ToolAugmented: final answer (no tool calls)',
        );

        if (onProgress) {
          onProgress({
            type: 'task_completed',
            description: 'Tool-augmented processing complete',
          });
        }

        const usage: NormalizedUsage = {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          totalTokens: totalInputTokens + totalOutputTokens,
          costUsd: totalCostUsd,
          provider: this.name,
          model: lastModel,
        };

        // Strip any leftover tool_use tags from the final response (shouldn't be any)
        const cleanText = this.stripToolBlocks(responseText);

        return {
          text: `[Fallback+Tools: ${this.chatProvider.name}]\n\n${cleanText}`,
          resumeToken: undefined,
          usage,
          provider: this.name,
          model: lastModel,
        };
      }

      // Execute tool calls and build results
      logger.info(
        { provider: this.name, toolCount: toolCalls.length, iteration },
        'ToolAugmented: executing tool calls',
      );

      // Add assistant response to conversation
      messages.push({ role: 'assistant', content: responseText });

      // Execute all tool calls and collect results
      const toolResults: string[] = [];
      for (const call of toolCalls) {
        onTyping();

        if (onProgress) {
          onProgress({
            type: 'task_started',
            description: `Executing tool: ${call.tool}`,
          });
        }

        const toolResult = await this.toolExecutor.execute(call.tool, call.args);

        const resultText = toolResult.success
          ? toolResult.output
          : `ERROR: ${toolResult.error || 'Unknown error'}`;

        toolResults.push(
          `<tool_result name="${call.tool}">\n${resultText}\n</tool_result>`,
        );

        if (onProgress) {
          onProgress({
            type: 'task_completed',
            description: `Tool ${call.tool}: ${toolResult.success ? 'success' : 'failed'}`,
          });
        }
      }

      // Feed tool results back as a user message
      messages.push({
        role: 'user',
        content: toolResults.join('\n\n'),
      });
    }

    // Hit max iterations -- return whatever we have
    logger.warn(
      { provider: this.name, maxIterations: MAX_ITERATIONS },
      'ToolAugmented: hit max iterations, returning last response',
    );

    const lastAssistantMsg = messages
      .filter(m => m.role === 'assistant')
      .pop();

    const usage: NormalizedUsage = {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      costUsd: totalCostUsd,
      provider: this.name,
      model: lastModel,
    };

    const finalText = lastAssistantMsg
      ? this.stripToolBlocks(lastAssistantMsg.content)
      : 'Tool-augmented processing reached max iterations without a final answer.';

    return {
      text: `[Fallback+Tools: ${this.chatProvider.name}]\n\n${finalText}`,
      resumeToken: undefined,
      usage,
      provider: this.name,
      model: lastModel,
    };
  }

  // ── Tool call parsing ─────────────────────────────────────────

  private parseToolCalls(text: string): Array<{ tool: string; args: Record<string, unknown> }> {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];

    let match: RegExpExecArray | null;
    // Reset regex state
    TOOL_USE_REGEX.lastIndex = 0;

    while ((match = TOOL_USE_REGEX.exec(text)) !== null) {
      const jsonStr = match[1].trim();
      try {
        const parsed = JSON.parse(jsonStr) as { tool?: string; args?: Record<string, unknown> };
        if (parsed.tool && typeof parsed.tool === 'string') {
          calls.push({
            tool: parsed.tool,
            args: parsed.args || {},
          });
        } else {
          logger.warn({ json: jsonStr }, 'ToolAugmented: parsed JSON missing "tool" field');
        }
      } catch (err) {
        logger.warn({ json: jsonStr, err }, 'ToolAugmented: failed to parse tool_use JSON');
      }
    }

    return calls;
  }

  private stripToolBlocks(text: string): string {
    return text.replace(TOOL_USE_REGEX, '').trim();
  }
}
