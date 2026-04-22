/**
 * Self-study session runner.
 *
 * When agents are idle, they run study sessions to improve future performance.
 * Uses Venice (privacy-first, zero data retention) for LLM reasoning.
 * Knowledge entries are stored to the shared learning database.
 *
 * Study topics rotate through:
 * - feedback_analysis: Learn from past task scores and comments
 * - specialty_research: Deep-dive into the agent's specialty areas
 * - task_simulation: Practice by simulating realistic task scenarios
 * - cross_agent_learning: Learn from other agents' high-quality knowledge
 */

import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { veniceChat } from '../venice.js';
import { decryptAgeFile } from '../env.js';
import { logger } from '../logger.js';
import { getLearningDb } from './index.js';
import { storeKnowledge, getKnowledge } from './knowledge.js';
import { getFeedback } from './feedback.js';
import type { KnowledgeEntry } from './knowledge.js';
import type { FeedbackEntry } from './feedback.js';

export type StudyTopic = 'feedback_analysis' | 'specialty_research' | 'task_simulation' | 'cross_agent_learning';

export interface StudyResult {
  topic: StudyTopic;
  insight: string;
  knowledgeId: string;
  tokensUsed: number;
}

export interface StudyConfig {
  /** Agent name */
  agent: string;
  /** Agent's specialty areas */
  specialties: string[];
  /** Agent's role description */
  roleDescription: string;
  /** Minimum interval between study sessions (ms). Default 30 min. */
  intervalMs?: number;
  /** Venice model to use. Default llama-3.3-70b */
  model?: string;
}

/**
 * Ensure VENICE_API_KEY is available in process.env.
 * Workers run from bots/<name>/ which may not have the key.
 * Falls back to reading from BRIDGE_MAIN_ROOT's encrypted .env.
 */
function ensureVeniceKey(): void {
  if (process.env.VENICE_API_KEY) return;

  const mainRoot = process.env.BRIDGE_MAIN_ROOT;
  if (!mainRoot) return;

  // Try encrypted .env.age at main project root
  const decrypted = decryptAgeFile(path.join(mainRoot, '.env.age'));
  if (decrypted) {
    const match = decrypted.match(/^VENICE_API_KEY=(.+)$/m);
    if (match) {
      process.env.VENICE_API_KEY = match[1].trim();
      return;
    }
  }

  // Fallback: plaintext .env
  try {
    const envPath = path.join(mainRoot, '.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      const match = content.match(/^VENICE_API_KEY=(.+)$/m);
      if (match) {
        process.env.VENICE_API_KEY = match[1].trim();
      }
    }
  } catch { /* non-fatal */ }
}

const STUDY_TOPICS: StudyTopic[] = [
  'feedback_analysis',
  'specialty_research',
  'task_simulation',
  'cross_agent_learning',
];

/**
 * Check if enough time has passed since the last study session.
 */
export function canStudy(agent: string, intervalMs = 1_800_000): boolean {
  const db = getLearningDb();
  const row = db.prepare(
    'SELECT MAX(created_at) as last_study FROM agent_study_log WHERE agent = ?'
  ).get(agent) as { last_study: number | null } | undefined;

  if (!row?.last_study) return true;

  const elapsed = Date.now() - row.last_study * 1000;
  return elapsed >= intervalMs;
}

/**
 * Pick the next study topic by rotating through topics with the fewest entries.
 */
function pickTopic(agent: string, hasFeedback: boolean): StudyTopic {
  const eligible = hasFeedback
    ? STUDY_TOPICS
    : STUDY_TOPICS.filter(t => t !== 'feedback_analysis');

  const db = getLearningDb();
  const counts = new Map<StudyTopic, number>();
  for (const topic of eligible) counts.set(topic, 0);

  const rows = db.prepare(
    'SELECT topic, COUNT(*) as count FROM agent_knowledge WHERE agent = ? GROUP BY topic'
  ).all(agent) as Array<{ topic: string; count: number }>;

  for (const row of rows) {
    if (eligible.includes(row.topic as StudyTopic)) {
      counts.set(row.topic as StudyTopic, row.count);
    }
  }

  let minTopic = eligible[0];
  let minCount = Infinity;
  for (const [topic, count] of counts) {
    if (count < minCount) {
      minCount = count;
      minTopic = topic;
    }
  }
  return minTopic;
}

/**
 * Build the study prompt based on topic and agent context.
 */
function buildStudyPrompt(
  topic: StudyTopic,
  config: StudyConfig,
  feedback: FeedbackEntry[],
  knowledge: KnowledgeEntry[],
): string {
  const specialties = config.specialties.length > 0
    ? config.specialties.join(', ')
    : 'general-purpose tasks';

  const recentFeedback = feedback.slice(0, 10);
  const feedbackSummary = recentFeedback.length > 0
    ? recentFeedback
        .map(f => `- Score ${f.score}/5: "${f.task_summary}" -- ${f.comments || 'no comment'}`)
        .join('\n')
    : 'No feedback yet.';

  const existingKnowledge = knowledge.slice(0, 5)
    .map(k => `- [${k.topic}] ${k.insight.slice(0, 150)}`)
    .join('\n') || 'None yet.';

  const base = `You are ${config.agent}, a self-improving autonomous agent.
Role: ${config.roleDescription}
Specialties: ${specialties}

You are conducting a study session to improve your future task performance.

## Your existing knowledge
${existingKnowledge}

## Recent feedback from completed tasks
${feedbackSummary}
`;

  switch (topic) {
    case 'feedback_analysis':
      return `${base}
## Task: Feedback Analysis

Analyze the feedback patterns above. What patterns emerge? What kinds of tasks scored well vs poorly? What specific improvements should you make?

Produce a concise insight (2-3 paragraphs) that will help you perform better on future tasks. Focus on actionable takeaways.`;

    case 'specialty_research':
      return `${base}
## Task: Specialty Deep-Dive

As a specialist in ${specialties}, research and articulate:
1. Common best practices and quality standards
2. Frequent pitfalls and how to avoid them
3. Patterns that distinguish excellent work from mediocre work

Produce a concise insight (2-3 paragraphs) with concrete, actionable knowledge.`;

    case 'task_simulation':
      return `${base}
## Task: Practice Simulation

Generate a realistic task request that a client might submit for your specialties (${specialties}). Then produce an outline of how you would approach it, covering key decisions, quality checks, and deliverable structure.

Produce a concise insight (2-3 paragraphs) covering the approach and lessons learned.`;

    case 'cross_agent_learning':
      return `${base}
## Task: Cross-Agent Learning

Review the knowledge entries above. Some may come from other agents with different specialties. Identify patterns, techniques, or insights that could transfer to your own work in ${specialties}.

Produce a concise insight (2-3 paragraphs) about what you can adopt from other agents' experiences.`;
  }
}

/**
 * Run a study session for the given agent.
 * Returns the insight generated and the knowledge entry ID.
 */
export async function runStudySession(config: StudyConfig): Promise<StudyResult> {
  const db = getLearningDb();
  const model = config.model || 'llama-3.3-70b';

  // Get agent's recent feedback and knowledge
  const feedback = getFeedback({ agent: config.agent, limit: 20 });
  const knowledge = getKnowledge({ agent: config.agent, limit: 10 });

  // For cross-agent learning, also pull high-quality shared knowledge
  const sharedKnowledge = getKnowledge({ limit: 10 });
  const allKnowledge = [...knowledge, ...sharedKnowledge.filter(k => k.agent !== config.agent)].slice(0, 10);

  const topic = pickTopic(config.agent, feedback.length > 0);
  const prompt = buildStudyPrompt(topic, config, feedback, allKnowledge);

  // Rotate specialties for study
  const specialtyPool = config.specialties.length > 0 ? config.specialties : ['general'];
  const topicEntries = knowledge.filter(k => k.topic === topic);
  const specialty = specialtyPool[topicEntries.length % specialtyPool.length];

  let insight = 'No insight produced.';
  let tokensUsed = 0;

  // Ensure Venice API key is available (workers may not have it in their local .env)
  ensureVeniceKey();

  try {
    const result = await veniceChat({
      model,
      messages: [
        {
          role: 'system',
          content: 'You are a self-improving AI agent conducting a study session. Produce concise, actionable insights. No filler, no cliches. Focus on practical takeaways.',
        },
        { role: 'user', content: prompt },
      ],
      maxTokens: 1024,
      temperature: 0.7,
    });

    insight = result.text.trim() || 'No insight produced.';
    tokensUsed = result.usage?.totalTokens || 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ agent: config.agent, topic, err: msg }, 'Study session Venice call failed');
    insight = `Study session failed: ${msg}`;
  }

  // Store the knowledge entry
  const source = topic === 'feedback_analysis' && feedback.length > 0
    ? `${feedback.length} feedback entries (avg ${(feedback.reduce((s, f) => s + f.score, 0) / feedback.length).toFixed(1)}/5)`
    : `scheduled ${topic} session`;

  const knowledgeId = storeKnowledge({
    agent: config.agent,
    topic,
    specialty,
    insight,
    source,
    quality: 1.0,
  });

  // Log the study session
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO agent_study_log (agent, topic, specialty, tokens_used, knowledge_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(config.agent, topic, specialty, tokensUsed, knowledgeId, now);

  logger.info({
    agent: config.agent,
    topic,
    specialty,
    tokensUsed,
    knowledgeId,
  }, 'Study session complete');

  return { topic, insight, knowledgeId, tokensUsed };
}
