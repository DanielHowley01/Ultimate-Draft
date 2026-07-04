-- ═══════════════════════════════════════════════════════════════
-- Ultimate Draft — "No fixtures showing" diagnostics
-- Run each block in the Supabase SQL Editor and read the output.
-- ═══════════════════════════════════════════════════════════════

-- 1. What's actually in the fixtures table?
--    If this returns nothing (or only 'ft' rows), the sync function
--    isn't inserting anything → the problem is the API side.
SELECT status, count(*) AS fixtures,
       min(kick_off) AS earliest, max(kick_off) AS latest
FROM fixtures
GROUP BY status
ORDER BY status;

-- 2. Any World Cup rows at all?
SELECT id, home_team, away_team, league, status, kick_off
FROM fixtures
WHERE league ILIKE '%world%'
ORDER BY kick_off
LIMIT 20;

-- 3. Are the cron jobs installed and firing?
SELECT jobname, schedule, active FROM cron.job ORDER BY jobname;

SELECT j.jobname, d.status, d.return_message, d.start_time
FROM cron.job_run_details d
JOIN cron.job j ON j.jobid = d.jobid
ORDER BY d.start_time DESC
LIMIT 20;

-- 4. Did the scheduled HTTP calls to the edge function succeed?
--    status_code 200 = good; 401 = auth; 404 = function not deployed.
SELECT id, status_code, content::text AS response, created
FROM net._http_response
ORDER BY id DESC
LIMIT 10;
