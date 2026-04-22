#!/usr/bin/env node
/**
 * Learning System CLI
 *
 * Allows agents (and humans) to interact with the shared learning database.
 *
 * Usage:
 *   node dist/learning/cli.js search <query> [--agent <name>] [--limit <n>]
 *   node dist/learning/cli.js store <agent> <topic> <specialty> <insight> [--source <source>]
 *   node dist/learning/cli.js feedback <agent> <task_id> <score> <summary> [--comments <text>] [--lessons <text>]
 *   node dist/learning/cli.js stats [--agent <name>]
 *   node dist/learning/cli.js knowledge [--agent <name>] [--limit <n>]
 *   node dist/learning/cli.js study <agent> --specialties <list> --role <description>
 *   node dist/learning/cli.js delete <id>
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { initLearning } from './index.js';
import { storeKnowledge, getKnowledge, getKnowledgeStats, deleteKnowledge } from './knowledge.js';
import { storeFeedback, getFeedbackStats } from './feedback.js';
import { searchLearning } from './search.js';
import { runStudySession, canStudy } from './study.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve project root (cli.js lives in dist/learning/)
const PROJECT_ROOT = process.env.BRIDGE_MAIN_ROOT
  || process.env.APEX_ROOT
  || path.resolve(__dirname, '..', '..');

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length) {
      const key = args[i].slice(2);
      flags[key] = args[++i];
    } else {
      positional.push(args[i]);
    }
  }

  return { positional, flags };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    printUsage();
    process.exit(1);
  }

  // Initialize learning system
  initLearning(PROJECT_ROOT);

  const command = args[0];
  const { positional, flags } = parseArgs(args.slice(1));

  switch (command) {
    case 'search': {
      const query = positional.join(' ');
      if (!query) {
        console.error('Usage: learning-cli search <query> [--agent <name>] [--limit <n>]');
        process.exit(1);
      }
      const results = searchLearning(query, {
        agent: flags.agent,
        limit: flags.limit ? parseInt(flags.limit, 10) : 5,
      });
      if (results.length === 0) {
        console.log('No relevant knowledge found.');
      } else {
        for (const hit of results) {
          console.log(`[${hit.type}] (score: ${hit.score.toFixed(3)}) ${hit.text}`);
          console.log('');
        }
      }
      break;
    }

    case 'store': {
      const [agent, topic, specialty, ...insightParts] = positional;
      const insight = insightParts.join(' ');
      if (!agent || !topic || !specialty || !insight) {
        console.error('Usage: learning-cli store <agent> <topic> <specialty> <insight> [--source <source>]');
        process.exit(1);
      }
      const id = storeKnowledge({
        agent,
        topic,
        specialty,
        insight,
        source: flags.source || 'manual',
        quality: 1.0,
      });
      console.log(`Stored knowledge: ${id}`);
      break;
    }

    case 'feedback': {
      const [agent, taskId, scoreStr, ...summaryParts] = positional;
      const summary = summaryParts.join(' ');
      if (!agent || !taskId || !scoreStr || !summary) {
        console.error('Usage: learning-cli feedback <agent> <task_id> <score> <summary> [--comments <text>] [--lessons <text>]');
        process.exit(1);
      }
      const id = storeFeedback({
        agent,
        task_id: taskId,
        task_summary: summary,
        score: parseFloat(scoreStr),
        comments: flags.comments || '',
        lessons_learned: flags.lessons || null,
      });
      console.log(`Stored feedback: ${id}`);
      break;
    }

    case 'stats': {
      const kStats = getKnowledgeStats();
      const fStats = getFeedbackStats(flags.agent);
      console.log('=== Knowledge Base ===');
      console.log(`Total entries: ${kStats.totalEntries}`);
      console.log(`Average quality: ${kStats.avgQuality}`);
      console.log(`By agent: ${JSON.stringify(kStats.byAgent)}`);
      console.log(`By topic: ${JSON.stringify(kStats.byTopic)}`);
      console.log('');
      console.log('=== Task Feedback ===');
      console.log(`Total tasks: ${fStats.totalTasks}`);
      console.log(`Average score: ${fStats.avgScore}/5`);
      console.log(`Trend: ${fStats.recentTrend}`);
      console.log(`By agent: ${JSON.stringify(fStats.byAgent)}`);
      break;
    }

    case 'knowledge': {
      const entries = getKnowledge({
        agent: flags.agent,
        limit: flags.limit ? parseInt(flags.limit, 10) : 20,
      });
      if (entries.length === 0) {
        console.log('No knowledge entries found.');
      } else {
        for (const entry of entries) {
          const date = new Date(entry.created_at * 1000).toISOString().split('T')[0];
          console.log(`[${entry.agent}] ${date} - ${entry.topic}/${entry.specialty}`);
          console.log(`  ${entry.insight.slice(0, 200)}`);
          console.log(`  Source: ${entry.source} | Quality: ${entry.quality} | ID: ${entry.id}`);
          console.log('');
        }
      }
      break;
    }

    case 'study': {
      const agent = positional[0];
      if (!agent) {
        console.error('Usage: learning-cli study <agent> --specialties <list> --role <description>');
        process.exit(1);
      }

      const intervalMs = flags.interval ? parseInt(flags.interval, 10) : 1_800_000;
      if (!canStudy(agent, intervalMs)) {
        console.log(`${agent} studied too recently. Skipping.`);
        break;
      }

      const specialties = flags.specialties ? flags.specialties.split(',') : ['general'];
      const role = flags.role || `A specialized agent focused on ${specialties.join(', ')}`;

      console.log(`Running study session for ${agent}...`);
      const result = await runStudySession({
        agent,
        specialties,
        roleDescription: role,
        intervalMs,
        model: flags.model,
      });

      console.log(`Topic: ${result.topic}`);
      console.log(`Tokens used: ${result.tokensUsed}`);
      console.log(`Knowledge ID: ${result.knowledgeId}`);
      console.log(`Insight: ${result.insight.slice(0, 500)}`);
      break;
    }

    case 'delete': {
      const id = positional[0];
      if (!id) {
        console.error('Usage: learning-cli delete <id>');
        process.exit(1);
      }
      const deleted = deleteKnowledge(id);
      console.log(deleted ? `Deleted: ${id}` : `Not found: ${id}`);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

function printUsage(): void {
  console.log(`
Learning System CLI

Commands:
  search <query>              Search knowledge + feedback (BM25 + temporal decay)
  store <agent> <topic> ...   Store a knowledge entry
  feedback <agent> <task_id>  Store task feedback
  stats                       Show learning statistics
  knowledge                   List knowledge entries
  study <agent>               Run a study session
  delete <id>                 Delete a knowledge entry

Flags:
  --agent <name>         Filter by agent
  --limit <n>            Max results
  --source <source>      Knowledge source label
  --comments <text>      Feedback comments
  --lessons <text>       Lessons learned from feedback
  --specialties <a,b>    Comma-separated specialties (for study)
  --role <description>   Agent role description (for study)
  --model <model>        Venice model for study (default: llama-3.3-70b)
  --interval <ms>        Min study interval in ms (default: 1800000)
`);
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
