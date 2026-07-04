-- ═══════════════════════════════════════════════════════════════
-- Ultimate Draft — clean up lobbies stuck on finished (FT) games
-- Run once in the Supabase SQL Editor. Safe to re-run.
--
-- A lobby only leaves "My Games" when status = 'complete'. That flag
-- is normally set by sync-live at full time — but if sync wasn't
-- running when the match ended, lobbies stay 'waiting' / 'drafting' /
-- 'active' forever. This fixes existing stuck lobbies and keeps it
-- from happening again.
-- ═══════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────
-- 1. IMMEDIATE CLEANUP
-- a) Lobbies that NEVER started (waiting/drafting) before the match
--    ended: refund every member's entry fee, then close the lobby.
--    settled = true stops the results page from paying out a pot
--    for a game that never happened.
-- ───────────────────────────────────────────────────────────────
WITH stale AS (
  SELECT l.id, COALESCE(l.entry_fee, 0) AS entry_fee
  FROM lobbies l
  JOIN fixtures f ON f.id = l.fixture_id
  WHERE f.status = 'ft'
    AND l.status IN ('waiting', 'drafting')
),
refunds AS (
  SELECT lp.user_id, SUM(s.entry_fee) AS amount
  FROM stale s
  JOIN lobby_players lp ON lp.lobby_id = s.id
  GROUP BY lp.user_id
),
pay AS (
  UPDATE profiles p
  SET coins = p.coins + r.amount
  FROM refunds r
  WHERE p.id = r.user_id
  RETURNING p.id
)
UPDATE lobbies
SET status = 'complete', settled = true
WHERE id IN (SELECT id FROM stale);

-- b) Lobbies that DID play ('active') on an FT fixture are left
--    alone on purpose: they now show as "Finished — view results"
--    in My Games, and opening the results page settles prizes and
--    marks them complete. Nothing to do here.

-- ───────────────────────────────────────────────────────────────
-- 2. UPDATE THE HOURLY SWEEP JOB
-- Replaces the previous sweep with one that also refunds + closes
-- never-started lobbies after their fixture is flagged FT.
-- ───────────────────────────────────────────────────────────────
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'sweep-stale-fixtures';

SELECT cron.schedule(
  'sweep-stale-fixtures',
  '5 * * * *',
  $$
  -- Flag long-past fixtures as FT
  UPDATE fixtures
  SET status = 'ft'
  WHERE status <> 'ft'
    AND kick_off < now() - interval '4 hours';

  -- Refund + close lobbies that never started before FT
  WITH stale AS (
    SELECT l.id, COALESCE(l.entry_fee, 0) AS entry_fee
    FROM lobbies l
    JOIN fixtures f ON f.id = l.fixture_id
    WHERE f.status = 'ft'
      AND l.status IN ('waiting', 'drafting')
  ),
  refunds AS (
    SELECT lp.user_id, SUM(s.entry_fee) AS amount
    FROM stale s
    JOIN lobby_players lp ON lp.lobby_id = s.id
    GROUP BY lp.user_id
  ),
  pay AS (
    UPDATE profiles p
    SET coins = p.coins + r.amount
    FROM refunds r
    WHERE p.id = r.user_id
    RETURNING p.id
  )
  UPDATE lobbies
  SET status = 'complete', settled = true
  WHERE id IN (SELECT id FROM stale);
  $$
);

-- ───────────────────────────────────────────────────────────────
-- 3. VERIFY
-- Should return zero rows once cleanup has run:
-- ───────────────────────────────────────────────────────────────
SELECT l.id, l.status AS lobby_status, f.status AS fixture_status,
       f.home_team, f.away_team, f.kick_off
FROM lobbies l
JOIN fixtures f ON f.id = l.fixture_id
WHERE f.status = 'ft'
  AND l.status IN ('waiting', 'drafting');
