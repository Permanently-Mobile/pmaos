/**
 * Scribe -- Venice classification pipeline.
 *
 * Sends conversation threads to Venice for privacy-first
 * classification into vault routing categories.
 */

import { veniceChat, type VeniceChatMessage } from '../venice.js';
import { logger } from '../logger.js';
import type { ConversationThread, ClassifiedItem, ScribeCategory } from './types.js';
import { formatThreadForClassification } from './threader.js';

// ── Configuration ───────────────────────────────────────────────────

const VALID_CATEGORIES = new Set<ScribeCategory>([
  'task', 'decision', 'progress', 'research', 'note',
  'daily_log', 'personal', 'financial', 'skip',
]);

/** Items below this confidence are dropped. */
export const CONFIDENCE_THRESHOLD = 0.6;

/** Items above this are auto-routed without flagging. */
export const HIGH_CONFIDENCE = 0.8;

/** Max threads to batch in a single Venice call. */
const BATCH_SIZE = 3;

// ── Known projects + vault context (loaded from vault at startup) ───

let knownProjects: string[] = [];
let vaultContext = '';

export function setKnownProjects(projects: string[]): void {
  knownProjects = projects;
  logger.info({ count: projects.length }, 'Classifier loaded known projects');
}

export function setVaultContext(context: string): void {
  vaultContext = context;
  logger.info({ length: context.length }, 'Classifier loaded vault context for dedup awareness');
}

// ── System prompt ───────────────────────────────────────────────────

function buildSystemPrompt(): string {
  const projectList = knownProjects.length > 0
    ? knownProjects.map(p => `- ${p}`).join('\n')
    : '(none detected)';

  return `You are Scribe, a conversation classification system for a personal AI assistant. You analyze conversation threads between the user and the assistant and extract actionable or noteworthy information.

## Your Job

Given conversation threads, extract discrete items and classify each one. Multiple items can come from a single thread. Return ONLY items worth capturing. Skip idle chat, greetings, debugging noise, and transient commands.

## Classification Categories

- task: An action item that is STILL OPEN. Something that has NOT been completed yet. If the user asks for something and the assistant confirms it is done in the SAME thread, that is NOT a task -- it is progress. Examples: the user says "build X" and nobody confirms it done; the user adds something to a to-do list; the user says "we need to do X later".
- decision: A choice was made. The user decided X over Y, with reasoning.
- progress: Something was COMPLETED, built, fixed, or shipped. This includes things the user asked for that the assistant then built and confirmed done within the same conversation.
- research: A topic the user wants researched or explored deeper. Must be an active research request, not something already researched and delivered. Examples: the user says "have the researcher look into X"; the user says "we need to research Y"; the user asks for a deep dive on Z.
- note: A fact, reference, technical detail, or piece of information worth saving long-term. Must be specific enough to be useful. Route to a descriptive topic name, never a generic catch-all.
- daily_log: A notable event or activity worth logging in the daily note. Includes status observations like system metrics, agent counts, build results, and work session updates.
- personal: ONLY for family, health, lifestyle, relationships. NOT for work observations, status updates, build results, or system metrics. If in doubt, prefer daily_log.
- financial: Money, crypto, investments, spending decisions.
- skip: Not worth capturing. See SKIP rules below.

## CRITICAL: Task vs Progress Detection

This is the most important classification rule. READ THE FULL THREAD before classifying.

If the user says "build X" and the assistant responds with any of these completion signals, classify as PROGRESS, not task:
- "done", "built", "deployed", "live", "complete", "finished"
- "all tests passing", "tests pass", "compiled clean"
- "created", "installed", "configured", "wired up"
- "shipped", "merged", "committed"
- The user confirms with "nice", "perfect", "looks good", "that works"

Only classify as "task" if the item is clearly UNFINISHED at the end of the thread.

Examples:
- User: "build the spice system" ... Assistant: "Spice system built, 128 tests passing" -> PROGRESS (not task)
- User: "we need to set up the NAS eventually" ... (no completion) -> TASK
- User: "wire up paper trading" ... Assistant: "Connected, 10k balance confirmed" -> PROGRESS

## SKIP Rules (always classify as skip)

Never capture these as tasks, notes, or any other category:
- Operational commands: "restart the bot", "load new session", "start new session", "checkpoint", "convolife", "set backup"
- Session management: "start fresh", "let's back up", "new chat"
- Scheduling tweaks: "change the time to 7:30", "adjust the schedule" (unless it reveals a meaningful preference)
- Meta-tasks: "add that to the task list" (the task itself matters, not the instruction to add it)
- Debugging exchanges: error messages, stack traces, "try again", "that didn't work"
- Brief acknowledgments with no information content

## Known Projects

${projectList}

If an item relates to a known project, set the "project" field to the EXACT project name from the list above.
If it does not match any known project, set project to null.
Items without an obvious project match should still be captured -- just leave project as null.

IMPORTANT: Each extracted item must be independently matched to its correct project. Do not assume all items in a thread belong to the same project. Match each item to the project it specifically discusses. If the user discusses Matrix integration for one project and then network config for another in the same thread, those are TWO separate items with TWO different projects.

## Existing Vault Contents (avoid duplicates)

The vault already contains the following items. Do NOT extract items that duplicate or closely match existing content. If something is already captured below, classify it as "skip".

${vaultContext || '(vault index not loaded)'}

## Notes Routing

Every note MUST have a specific, descriptive "topic" field. Never use generic topics like "Scribe Notes" or "General". Examples:
- Good: "Blofin API", "VPN Comparison", "Trading Strategy Performance", "Syncthing Configuration"
- Bad: "Scribe Notes", "Notes", "General", "Misc"

## Confidence Scoring (calibrate carefully)

- 0.95: Explicit, unambiguous statement. The user literally said "decided to use X" or "task: do Y". Direct quote territory.
- 0.85-0.90: Clear from context. Action was taken, result confirmed, decision is obvious from the exchange.
- 0.70-0.80: Reasonable inference. Topic was discussed, direction was implied but not explicitly stated.
- 0.60-0.69: Borderline. Might be worth capturing but could also be noise. Use for implied preferences or passing mentions.
- Below 0.60: Probably noise. Do not include.

Distribute your scores across this range. If most items are 0.9, you are not calibrating correctly.

## Writing Style

Write ALL items in concise past-tense imperative matching this vault's existing style:
- Progress: "Built X", "Fixed Y", "Added Z", "Configured W". NOT "X has been built" or "X is running".
- Decisions: "Chose X over Y for Z". NOT "Decided to use X".
- Tasks: Short imperative: "Wire up paper trading", "Build NAS cluster".
- Notes: Factual, third person: "Blofin blocks VPN IPs". NOT "It was discovered that..."

Keep items tight -- one sentence max. Strip filler words.

## Rules

- Extract standalone items. Each must make sense without the full conversation.
- For decisions, include the choice AND the reasoning: "Chose pfSense over OPNsense for better VLAN support and documentation".
- Look specifically for decisions that are easy to miss: technology choices ("go with X over Y"), configuration locks ("use 1H timeframe"), strategic pivots ("swap SOL for VIRTUAL").
- Maximum 8 items per thread. Most threads should yield 0-3 items.
- If nothing is worth capturing, return exactly: []
- Return valid JSON array only. No explanation, no markdown fencing, no code blocks.
- When the user mentions a build, fix, or feature and the assistant completes it in the same thread, ALWAYS classify as progress, NEVER as task.
- Status observations like system metrics, agent counts, build results, or session health go to daily_log, NOT personal or note.

## Output Format

[
  {
    "category": "task|decision|progress|research|note|daily_log|personal|financial|skip",
    "content": "Clean, standalone description of the item",
    "project": "Exact project name or null",
    "topic": "Descriptive topic name for notes/research or null",
    "confidence": 0.85,
    "thread_id": "the thread ID provided"
  }
]`;
}

// ── Classification ──────────────────────────────────────────────────

interface RawClassifiedItem {
  category: string;
  content: string;
  project?: string | null;
  topic?: string | null;
  confidence: number;
  thread_id?: string;
}

/**
 * Classify a batch of threads in a single Venice call.
 * Returns all classified items across all threads.
 */
export async function classifyBatch(threads: ConversationThread[]): Promise<ClassifiedItem[]> {
  if (threads.length === 0) return [];

  const allItems: ClassifiedItem[] = [];

  // Process in batches
  for (let i = 0; i < threads.length; i += BATCH_SIZE) {
    const batch = threads.slice(i, i + BATCH_SIZE);
    const items = await classifyThreadBatch(batch);
    allItems.push(...items);
  }

  return allItems;
}

async function classifyThreadBatch(threads: ConversationThread[]): Promise<ClassifiedItem[]> {
  // Build the user message with all threads
  const threadBlocks = threads.map((thread, idx) => {
    const formatted = formatThreadForClassification(thread);
    return `=== Thread ${idx + 1} (id: ${thread.id}) ===\n${formatted}`;
  }).join('\n\n');

  const userMessage = threads.length === 1
    ? `Analyze this conversation thread and extract noteworthy items.\n\n${threadBlocks}`
    : `Analyze these ${threads.length} conversation threads and extract noteworthy items from each.\n\n${threadBlocks}`;

  const messages: VeniceChatMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: userMessage },
  ];

  try {
    const result = await veniceChat({
      messages,
      model: 'llama-3.3-70b',
      maxTokens: 4096,
      temperature: 0.3,
    });

    const parsed = parseClassificationResponse(result.text, threads);
    logger.info(
      { threadCount: threads.length, itemsExtracted: parsed.length, tokens: result.usage?.totalTokens },
      'Venice classification complete',
    );
    return parsed;

  } catch (err) {
    logger.error({ err, threadIds: threads.map(t => t.id) }, 'Venice classification failed');
    return [];
  }
}

/**
 * Parse Venice's JSON response into ClassifiedItem objects.
 * Handles malformed responses gracefully.
 */
function parseClassificationResponse(
  responseText: string,
  threads: ConversationThread[],
): ClassifiedItem[] {
  // Strip markdown code fences if Venice wraps them
  let cleaned = responseText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }

  let rawItems: RawClassifiedItem[];
  try {
    rawItems = JSON.parse(cleaned);
  } catch {
    // Try to find a JSON array in the response
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        rawItems = JSON.parse(match[0]);
      } catch {
        logger.warn({ response: cleaned.slice(0, 200) }, 'Failed to parse Venice classification response');
        return [];
      }
    } else {
      logger.warn({ response: cleaned.slice(0, 200) }, 'No JSON array found in Venice response');
      return [];
    }
  }

  if (!Array.isArray(rawItems)) return [];

  // Build thread lookup
  const threadMap = new Map(threads.map(t => [t.id, t]));

  const items: ClassifiedItem[] = [];

  for (const raw of rawItems) {
    // Validate category
    const category = raw.category as ScribeCategory;
    if (!VALID_CATEGORIES.has(category)) continue;
    if (category === 'skip') continue;

    // Validate confidence
    const confidence = typeof raw.confidence === 'number' ? raw.confidence : 0.5;
    if (confidence < CONFIDENCE_THRESHOLD) continue;

    // Validate content
    if (!raw.content || typeof raw.content !== 'string' || raw.content.trim().length < 5) continue;

    // Find the source thread
    const threadId = raw.thread_id || threads[0]?.id || '';
    const thread = threadMap.get(threadId) || threads[0];
    const sourceIds = thread ? thread.messages.map(m => m.id) : [];
    const timestamp = thread ? thread.startTime : Math.floor(Date.now() / 1000);

    items.push({
      category,
      content: raw.content.trim(),
      project: raw.project && typeof raw.project === 'string' ? raw.project : undefined,
      topic: raw.topic && typeof raw.topic === 'string' ? raw.topic : undefined,
      confidence,
      sourceMessageIds: sourceIds,
      timestamp,
      threadId,
    });
  }

  return items;
}

/**
 * Classify a single thread (convenience wrapper).
 */
export async function classifyThread(thread: ConversationThread): Promise<ClassifiedItem[]> {
  return classifyBatch([thread]);
}
