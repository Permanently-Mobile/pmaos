/**
 * Scribe -- test harness.
 *
 * Runs the classification pipeline and dumps results to a review folder
 * instead of writing to the vault. The owner reviews, then we go live.
 *
 * Usage: npx tsx src/scribe/test-run.ts [lookbackDays]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { initScribeDb, getUnprocessedMessages, getMessagesSince } from './db.js';
import { buildThreads, formatThreadForClassification } from './threader.js';
import { classifyBatch, setKnownProjects } from './classifier.js';
import { loadKnownProjects, loadCompletedTasks, isTaskAlreadyCompleted } from './vault-scanner.js';
import { logger } from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAIN_ROOT = path.resolve(__dirname, '..', '..');
const REVIEW_DIR = path.join(MAIN_ROOT, 'workspace', 'scribe-review');

async function main(): Promise<void> {
  const lookbackDays = parseInt(process.argv[2] || '3', 10);

  console.log(`\n=== Scribe Test Run ===`);
  console.log(`Lookback: ${lookbackDays} days`);
  console.log(`Output: ${REVIEW_DIR}\n`);

  // Init DB (read-only for main, scribe.db for state)
  initScribeDb(MAIN_ROOT, path.join(MAIN_ROOT, 'workspace', 'scribe-review'));

  // Load vault context
  const projects = loadKnownProjects();
  setKnownProjects(projects);
  console.log(`Known projects: ${projects.join(', ')}\n`);

  // Pull messages
  const since = Math.floor(Date.now() / 1000) - (lookbackDays * 86400);
  const messages = getMessagesSince(since);
  console.log(`Messages found: ${messages.length}`);

  if (messages.length === 0) {
    console.log('No messages to process. Done.');
    return;
  }

  // Thread
  const threads = buildThreads(messages);
  console.log(`Threads built: ${threads.length}\n`);

  // Write threads to review file
  const threadsFile = path.join(REVIEW_DIR, 'threads.md');
  const threadLines: string[] = ['# Scribe Test Run - Threads\n'];
  for (const thread of threads) {
    threadLines.push(`## Thread: ${thread.topicSummary}`);
    threadLines.push(`ID: ${thread.id} | Messages: ${thread.messages.length} | ${new Date(thread.startTime * 1000).toISOString()}`);
    threadLines.push('```');
    threadLines.push(formatThreadForClassification(thread));
    threadLines.push('```\n');
  }
  fs.writeFileSync(threadsFile, threadLines.join('\n'), 'utf-8');
  console.log(`Threads written to: ${threadsFile}`);

  // Classify via Venice
  console.log('\nClassifying via Venice...');
  const items = await classifyBatch(threads);
  console.log(`Items classified: ${items.length}`);

  // Cross-reference tasks against vault completed items
  const completedTasks = loadCompletedTasks();
  let reclassified = 0;
  for (const item of items) {
    if (item.category === 'task' && isTaskAlreadyCompleted(item.content, completedTasks)) {
      item.category = 'progress';
      reclassified++;
    }
  }
  console.log(`Reclassified (task->progress via vault): ${reclassified}\n`);

  // Write classified items to review files
  const itemsJsonFile = path.join(REVIEW_DIR, 'classified-items.json');
  fs.writeFileSync(itemsJsonFile, JSON.stringify(items, null, 2), 'utf-8');

  const itemsMdFile = path.join(REVIEW_DIR, 'classified-items.md');
  const itemLines: string[] = [
    '# Scribe Test Run - Classified Items\n',
    `Run: ${new Date().toISOString()}`,
    `Lookback: ${lookbackDays} days`,
    `Messages: ${messages.length}`,
    `Threads: ${threads.length}`,
    `Items extracted: ${items.length}\n`,
    '---\n',
  ];

  // Group by category
  const byCategory = new Map<string, typeof items>();
  for (const item of items) {
    const list = byCategory.get(item.category) || [];
    list.push(item);
    byCategory.set(item.category, list);
  }

  for (const [category, catItems] of byCategory) {
    itemLines.push(`## ${category.toUpperCase()} (${catItems.length} items)\n`);
    for (const item of catItems) {
      itemLines.push(`- **[${(item.confidence * 100).toFixed(0)}%]** ${item.content}`);
      if (item.project) itemLines.push(`  Project: ${item.project}`);
      if (item.topic) itemLines.push(`  Topic: ${item.topic}`);
    }
    itemLines.push('');
  }

  // Also show what would route where
  itemLines.push('---\n## Routing Preview\n');
  for (const item of items) {
    let dest = '?';
    switch (item.category) {
      case 'task': dest = `Tasks.md (${item.project || 'Backlog'})`; break;
      case 'decision': dest = item.project ? `Projects/${item.project}/${item.project}.md Decision Log` : 'Daily Notes Log'; break;
      case 'progress': dest = item.project ? `Projects/${item.project}/${item.project}.md Progress Log` : 'Daily Notes Log'; break;
      case 'research': dest = 'Deepdives & Ongoing.md'; break;
      case 'note': dest = `Notes/${item.topic || 'Scribe Notes'}.md`; break;
      case 'daily_log': dest = `Daily Notes/${new Date(item.timestamp * 1000).toISOString().slice(0, 10)}.md Log`; break;
      case 'personal': dest = `Daily Notes/${new Date(item.timestamp * 1000).toISOString().slice(0, 10)}.md Personal Notes`; break;
      case 'financial': dest = `Daily Notes/${new Date(item.timestamp * 1000).toISOString().slice(0, 10)}.md [Financial]`; break;
    }
    itemLines.push(`| ${item.category} | ${item.content.slice(0, 60)} | -> ${dest} |`);
  }

  fs.writeFileSync(itemsMdFile, itemLines.join('\n'), 'utf-8');

  console.log(`\n=== Results ===`);
  console.log(`Threads review:  ${threadsFile}`);
  console.log(`Items (readable): ${itemsMdFile}`);
  console.log(`Items (JSON):     ${itemsJsonFile}`);
  console.log(`\nReview these files, then we go live.`);
}

main().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});
