-- 004_merge_default_tenant.sql — move pipeline output to the tenant the UI reads.
--
-- vps-daemon.mjs invoked auto-apply.mjs with a hardcoded `--userId default`,
-- while the dashboard and /api/jobs read job_inbox for VIP_USER_ID
-- (user_3GfaXsz2WyxzFl0LcD4ktVnNsCS). Every scored job, generated document and
-- Gmail draft therefore landed under 'default' — a tenant nothing queries. 190
-- fully processed jobs were invisible while the dashboard showed 12 old rows.
--
-- The daemon now derives the id from VIP_USER_ID. This moves the rows already
-- written under 'default' across, skipping any URL the real tenant already has
-- (the unique key is (user_id, url), so a straight UPDATE would fail on those).
--
-- Idempotent: after it runs, no 'default' rows remain to move.

BEGIN;

\set target_user 'user_3GfaXsz2WyxzFl0LcD4ktVnNsCS'

-- 1. Drop 'default' duplicates of URLs the target tenant already holds. The
--    target copy is the one the dashboard has been showing, so it wins.
DELETE FROM job_inbox d
 WHERE d.user_id = 'default'
   AND EXISTS (
     SELECT 1 FROM job_inbox t
      WHERE t.user_id = :'target_user'
        AND t.url = d.url
   );

-- 2. Re-home the remainder.
UPDATE job_inbox
   SET user_id = :'target_user',
       updated_at = NOW()
 WHERE user_id = 'default';

COMMIT;

-- Report the outcome.
SELECT user_id,
       COUNT(*)                              AS jobs,
       COUNT(*) FILTER (WHERE score >= 4.0)  AS ready_4plus,
       COUNT(*) FILTER (WHERE gmail_draft_id IS NOT NULL) AS with_draft
  FROM job_inbox
 GROUP BY user_id
 ORDER BY jobs DESC;
