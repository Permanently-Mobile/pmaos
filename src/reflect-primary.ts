/**
 * Reflect Primary -- Primary Bot Self-Improvement Module
 *
 * This is a stub module included as an extension point. The full module
 * analyzes conversation patterns, implicit feedback signals, and memory
 * usage to generate improvement proposals for the primary bot's behavior.
 *
 * Implement observe/measure/reflect to power the self-improvement loop.
 */

import type {
  ReflectLoopInstance,
  Observation,
  MeasuredOutcome,
  ReflectProposal,
} from './reflect-loop.js';

/**
 * Classify implicit feedback from a user's follow-up message.
 * Used by memory.ts to detect satisfaction/frustration signals
 * without explicit feedback commands.
 *
 * Stub: no-op. Implement to enable implicit feedback learning.
 */
export function classifyImplicitFeedback(
  _userMessage: string,
  _claudeResponse: string,
  _chatId: string,
): void {
  // Stub -- implement feedback classification logic
}

/**
 * Create a ReflectLoopInstance for the primary bot.
 * Called by reflect-orchestrator.ts at session boundaries.
 *
 * Stub: returns a no-op instance. Implement to enable self-improvement.
 */
export function createPrimaryReflectInstance(): ReflectLoopInstance {
  return {
    async observe(): Promise<Observation[]> {
      return [];
    },
    async measure(_observations: Observation[]): Promise<MeasuredOutcome[]> {
      return [];
    },
    async reflect(_outcomes: MeasuredOutcome[]): Promise<ReflectProposal[]> {
      return [];
    },
  };
}
