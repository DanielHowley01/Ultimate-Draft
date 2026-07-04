-- ═══════════════════════════════════════════════════════════════
-- Ultimate Draft — keep fixtures up to date automatically
-- Run this once in the Supabase SQL Editor. Safe to re-run.
--
-- Without this, sync-fixtures / sync-live only run when you invoke
-- them manually — which is why the main page goes stale.
-- ═══════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────
-- 0. IMMEDIATE CLEANUP — fixes the main page right now.
-- Flags any fixture that kicked off 4+ hours ago and never got
-- marked FT (stale "upcoming" and frozen "live" rows).
-- ───────────────────────────────────────────────────────────────
UPDATE fixtures
SET status = 'ft'
WHERE status <> 'ft'
  AND kick_off < now() - interval '4 hours';

-- ───────────────────────────────────────────────────────────────
-- 1. ENABLE EXTENSIONS
-- ───────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ───────────────────────────────────────────────────────────────
-- 2. SCHEDULE THE EDGE FUNCTIONS
-- sync-fixtures: every 10 minutes (pulls fixtures + lineups,
--                marks finished games FT, sweeps stale rows)
-- sync-live:     every minute (live scores, events, points)
--
-- The Bearer token below is your project's public anon key (the
-- same one shipped in js/app.js). If you've enabled "Enforce JWT
-- verification" OFF for these functions, the header is ignored
-- but harmless.
-- ───────────────────────────────────────────────────────────────
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname IN ('sync-fixtures-every-10min', 'sync-live-every-min');

SELECT cron.schedule(
  'sync-fixtures-every-10min',
  '*/10 * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://bpjvjznbueeqigpfsakh.supabase.co/functions/v1/sync-fixtures',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJwanZqem5idWVlcWlncGZzYWtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4NjAwMTEsImV4cCI6MjA5NjQzNjAxMX0.bUzdKiK9kzxd-cjm5yQiWuGf7cb78vH8bW0ZfbGoa_Y'
    ),
    body    := '{}'::jsonb
  );
  $$
);

SELECT cron.schedule(
  'sync-live-every-min',
  '* * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://bpjvjznbueeqigpfsakh.supabase.co/functions/v1/sync-live',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJwanZqem5idWVlcWlncGZzYWtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4NjAwMTEsImV4cCI6MjA5NjQzNjAxMX0.bUzdKiK9kzxd-cjm5yQiWuGf7cb78vH8bW0ZfbGoa_Y'
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- Hourly DB-side safety net in case an edge function run fails:
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'sweep-stale-fixtures';

SELECT cron.schedule(
  'sweep-stale-fixtures',
  '5 * * * *',
  $$
  UPDATE fixtures
  SET status = 'ft'
  WHERE status <> 'ft'
    AND kick_off < now() - interval '4 hours';
  $$
);

-- ───────────────────────────────────────────────────────────────
-- 3. VERIFY — should list the 3 jobs
-- ───────────────────────────────────────────────────────────────
SELECT jobname, schedule, active FROM cron.job ORDER BY jobname;

-- To check runs later:
--   SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;
