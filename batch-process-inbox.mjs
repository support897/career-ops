#!/usr/bin/env node
/**
 * DISABLED — this script must not be run.
 *
 * It previously did two destructive things:
 *
 *   1. Invented scores.  Any job with a null score was assigned
 *      `Math.random() * (5.0 - 3.0) + 3.0`, i.e. a random number between 3.0
 *      and 5.0, and that fabricated value was written straight to
 *      `job_inbox.score`.  Every job therefore landed somewhere in the 3.0-5.0
 *      band regardless of its actual content, and roughly half of them crossed
 *      the 4.0 threshold and had tailored documents generated on the strength
 *      of a coin flip.  Because `auto-apply.mjs` only scores rows whose score
 *      is null or zero, those made-up numbers then persisted indefinitely and
 *      shadowed the real scorer.
 *
 *   2. Deleted every Gmail draft on startup, before doing any work.
 *
 * Scoring belongs to the real LLM scorer, which reads the job description and
 * produces a graded breakdown with reasons:
 *
 *     node auto-apply.mjs --local-vip
 *
 * That is what the `career-ops-runner` pm2 process already runs on a schedule,
 * so there is normally nothing to do by hand.  To re-score rows that are
 * holding a stale value, clear the column first and let the daemon pick them
 * up:
 *
 *     UPDATE job_inbox SET score = NULL, score_breakdown = NULL;
 *
 * Nothing in the codebase imports or invokes this file.  It is kept only so
 * that running it fails loudly instead of silently corrupting the database.
 */

console.error(`
batch-process-inbox.mjs is disabled and will not run.

It assigned random scores between 3.0 and 5.0 to unscored jobs and wiped all
Gmail drafts before starting. Both effects corrupted real data.

Use the real scorer instead:

  node auto-apply.mjs --local-vip

To force a re-score of rows holding stale values, set their score to NULL
first; auto-apply only scores rows whose score is null or zero.
`.trim());

process.exit(1);
