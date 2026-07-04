-- ═══════════════════════════════════════════════════════════════
-- Ultimate Draft — Supabase SQL Editor optimisation script
-- Safe to run more than once. Run the whole thing in one go.
-- ═══════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────
-- 1. POSITION DATA HYGIENE
-- Fix any picks saved with lowercase / odd position values so the
-- GK → DEF → MID → FWD ordering and badge colours always work.
-- ───────────────────────────────────────────────────────────────
UPDATE picks SET position = UPPER(position)
WHERE position IS NOT NULL AND position <> UPPER(position);

UPDATE picks SET position = 'MID'
WHERE position IS NULL OR position NOT IN ('GK','DEF','MID','FWD');

ALTER TABLE picks ALTER COLUMN position SET DEFAULT 'MID';

ALTER TABLE picks DROP CONSTRAINT IF EXISTS picks_position_check;
ALTER TABLE picks ADD CONSTRAINT picks_position_check
  CHECK (position IN ('GK','DEF','MID','FWD'));

-- ───────────────────────────────────────────────────────────────
-- 2. DRAFT INTEGRITY
-- Remove any duplicate picks (same player drafted twice in one
-- lobby — a race the 20s auto-pick timer can cause), then block it
-- permanently. The client already handles the insert error and
-- re-enables the turn, so this makes the draft race-proof.
-- ───────────────────────────────────────────────────────────────
DELETE FROM picks a
USING picks b
WHERE a.lobby_id = b.lobby_id
  AND a.player_name = b.player_name
  AND a.ctid > b.ctid;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_pick_per_lobby
  ON picks (lobby_id, player_name);

-- Required for the sync-fixtures edge function's upsert
-- (onConflict: 'api_fixture_id') to work correctly.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_fixtures_api_id
  ON fixtures (api_fixture_id);

-- ───────────────────────────────────────────────────────────────
-- 3. HOT-PATH INDEXES
-- Matches the exact queries the pages run.
-- ───────────────────────────────────────────────────────────────
-- team.html / match.html / results.html: picks by lobby (+ user)
CREATE INDEX IF NOT EXISTS idx_picks_lobby_user
  ON picks (lobby_id, user_id);

-- scoring lookups by fixture
CREATE INDEX IF NOT EXISTS idx_picks_fixture
  ON picks (fixture_id);

-- match_events fetched by fixture, ordered by minute, filtered by player
CREATE INDEX IF NOT EXISTS idx_events_fixture_minute
  ON match_events (fixture_id, minute);
CREATE INDEX IF NOT EXISTS idx_events_fixture_player
  ON match_events (fixture_id, player_name);

-- lobby membership lookups (draft waiting room, joins)
CREATE INDEX IF NOT EXISTS idx_lobby_players_lobby
  ON lobby_players (lobby_id);
CREATE INDEX IF NOT EXISTS idx_lobby_players_user
  ON lobby_players (user_id);

-- fixture lists filtered by status and sorted by kick-off
CREATE INDEX IF NOT EXISTS idx_fixtures_status_kickoff
  ON fixtures (status, kick_off);

-- lobbies listed per fixture
CREATE INDEX IF NOT EXISTS idx_lobbies_fixture
  ON lobbies (fixture_id);

-- ───────────────────────────────────────────────────────────────
-- 4. WAITING-ROOM "READY" SUPPORT
-- draft.js updates lobby_players.ready — make sure the column and
-- the RLS policy it needs actually exist.
-- ───────────────────────────────────────────────────────────────
ALTER TABLE lobby_players
  ADD COLUMN IF NOT EXISTS ready boolean NOT NULL DEFAULT false;

DROP POLICY IF EXISTS "players update own ready" ON lobby_players;
CREATE POLICY "players update own ready" ON lobby_players
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ───────────────────────────────────────────────────────────────
-- 5. REALTIME
-- The pages subscribe to postgres_changes on these tables; make
-- sure they're in the realtime publication (ignore if already in).
-- ───────────────────────────────────────────────────────────────
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE picks;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE fixtures;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE lobbies;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE lobby_players;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;

-- ───────────────────────────────────────────────────────────────
-- 6. KEEP QUERY PLANS FRESH
-- ───────────────────────────────────────────────────────────────
ANALYZE picks;
ANALYZE match_events;
ANALYZE fixtures;
ANALYZE lobbies;
ANALYZE lobby_players;
