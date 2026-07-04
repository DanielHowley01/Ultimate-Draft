import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const API_KEY      = Deno.env.get('APIFOOTBALL_KEY')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const LEAGUES: Record<number, { slug: string; name: string; season: number }> = {
  1:   { slug: 'worldcup',   name: 'World Cup',        season: 2026 },
  2:   { slug: 'ucl',        name: 'Champions League', season: 2025 },
  39:  { slug: 'pl',         name: 'Premier League',   season: 2025 },
  61:  { slug: 'ligue1',     name: 'Ligue 1',          season: 2025 },
  78:  { slug: 'bundesliga', name: 'Bundesliga',       season: 2025 },
  135: { slug: 'seriea',     name: 'Serie A',          season: 2025 },
  140: { slug: 'laliga',     name: 'La Liga',          season: 2025 },
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function apiGet(path: string) {
  const res = await fetch(`https://v3.football.api-sports.io${path}`, {
    headers: { 'x-apisports-key': API_KEY }
  })
  return res.json()
}

function mapStatus(s: string): string {
  if (['1H','2H','ET','BT','P','INT'].includes(s)) return 'live'
  if (['FT','AET','PEN'].includes(s))              return 'ft'
  return 'upcoming'
}

function mapPos(pos: string): string {
  if (!pos) return 'MID'
  const p = pos.toUpperCase()
  // API returns full words or single letters
  if (p === 'G' || p === 'GK' || p === 'GOALKEEPER')  return 'GK'
  if (p === 'D' || p === 'DEF' || p === 'DEFENDER')   return 'DEF'
  if (p === 'M' || p === 'MID' || p === 'MIDFIELDER') return 'MID'
  if (p === 'F' || p === 'FWD' || p === 'FORWARD' || p === 'ATTACKER') return 'FWD'
  return 'MID' // safe default
}

Deno.serve(async () => {
  const now  = new Date()
  // Start the window 1 day back so games that finished since the last
  // run get re-fetched and correctly flagged as FT
  const from = new Date(now.getTime() - 86400000).toISOString().split('T')[0]
  const to   = new Date(now.getTime() + 7 * 86400000).toISOString().split('T')[0]

  let totalUpserted = 0

  // Diagnostics returned in the response so failures are visible
  // without digging through logs
  const report: any = { live: 0, leagues: {}, errors: [] as any[] }

  // Sanity-check the API key / plan first — the most common cause of
  // "no fixtures" is a missing key, exhausted quota, or a free plan
  // (free plans only cover seasons 2021–2023, so season=2026 fails)
  try {
    const acct = await apiGet('/status')
    if (acct.errors && Object.keys(acct.errors).length > 0) {
      report.errors.push({ where: 'api-key', detail: acct.errors })
    } else if (acct.response) {
      report.account = {
        plan:     acct.response.subscription?.plan,
        requests: acct.response.requests, // { current, limit_day }
      }
      if (acct.response.requests?.current >= acct.response.requests?.limit_day) {
        report.errors.push({ where: 'api-quota', detail: 'Daily request limit reached' })
      }
    }
  } catch (err) {
    report.errors.push({ where: 'api-status', detail: String(err) })
  }

  // First: update any currently live fixtures regardless of date filter
  try {
    const liveData = await apiGet(`/fixtures?live=all`)
    if (liveData.errors && Object.keys(liveData.errors).length > 0) {
      report.errors.push({ where: 'live', detail: liveData.errors })
    }
    const liveFixtures = liveData.response || []
    report.live = liveFixtures.length
    console.log(`Live fixtures right now: ${liveFixtures.length}`)

    for (const f of liveFixtures) {
      const status = mapStatus(f.fixture.status.short)
      const row = {
        api_fixture_id: f.fixture.id,
        home_team:      f.teams.home.name,
        away_team:      f.teams.away.name,
        home_abbr:      f.teams.home.name.substring(0, 3).toUpperCase(),
        away_abbr:      f.teams.away.name.substring(0, 3).toUpperCase(),
        home_logo:      f.teams.home.logo ?? null,
        away_logo:      f.teams.away.logo ?? null,
        league:         f.league.name,
        league_slug:    f.league.name.toLowerCase().replace(/\s+/g, ''),
        kick_off:       f.fixture.date,
        status,
        minute:         f.fixture.status.elapsed || 0,
        home_score:     f.goals.home ?? 0,
        away_score:     f.goals.away ?? 0,
      }

      const { data: upserted, error } = await sb
        .from('fixtures')
        .upsert(row, { onConflict: 'api_fixture_id' })
        .select('id').single()

      if (error) { console.error('Live upsert error:', error.message); continue }
      if (upserted) {
        totalUpserted++
        // Always try to fetch lineups for live matches
        await sleep(200)
        await syncLineups(upserted.id, f.fixture.id, f.teams.home.name, f.teams.away.name)
      }
    }
  } catch (err) {
    console.error('Live fixtures error:', err)
  }

  await sleep(500)

  for (const [leagueIdStr, meta] of Object.entries(LEAGUES)) {
    const leagueId = Number(leagueIdStr)
    try {
      await sleep(500) // 500ms between each league = well under rate limit

      // World Cup (league 1): fetch all fixtures for the season, filter by date client-side
      // Other leagues: use from/to range
      const url = leagueId === 1
        ? `/fixtures?league=${leagueId}&season=${meta.season}`
        : `/fixtures?league=${leagueId}&season=${meta.season}&from=${from}&to=${to}`
      const data = await apiGet(url)

      if (data.errors && Object.keys(data.errors).length > 0) {
        console.error(`League ${leagueId} error:`, JSON.stringify(data.errors))
        report.errors.push({ where: meta.name, detail: data.errors })
        continue
      }

      const fixtures = data.response || []
      report.leagues[meta.name] = fixtures.length
      console.log(`League ${leagueId} (${meta.name}): ${fixtures.length} fixtures`)

      for (const f of fixtures) {
        const status = mapStatus(f.fixture.status.short)

        // Finished games: don't insert new ones, but DO flip existing
        // rows to 'ft' so they drop off the main page
        if (status === 'ft') {
          await sb.from('fixtures')
            .update({
              status: 'ft',
              minute: f.fixture.status.elapsed || 90,
              home_score: f.goals.home ?? 0,
              away_score: f.goals.away ?? 0,
            })
            .eq('api_fixture_id', f.fixture.id)
          continue
        }

        // For World Cup full-season fetch, skip fixtures more than 7 days away
        const kickOffDate = new Date(f.fixture.date)
        const daysAway = (kickOffDate.getTime() - now.getTime()) / 86400000
        if (daysAway > 7 && status === 'upcoming') continue

        const row = {
          api_fixture_id: f.fixture.id,
          home_team:      f.teams.home.name,
          away_team:      f.teams.away.name,
          home_abbr:      f.teams.home.name.substring(0, 3).toUpperCase(),
          away_abbr:      f.teams.away.name.substring(0, 3).toUpperCase(),
        home_logo:      f.teams.home.logo ?? null,
        away_logo:      f.teams.away.logo ?? null,
          league:         meta.name,
          league_slug:    meta.slug,
          kick_off:       f.fixture.date,
          status,
          minute:         f.fixture.status.elapsed || 0,
          home_score:     f.goals.home ?? 0,
          away_score:     f.goals.away ?? 0,
        }

        const { data: upserted, error } = await sb
          .from('fixtures')
          .upsert(row, { onConflict: 'api_fixture_id' })
          .select('id')
          .single()

        if (error) { console.error(`Upsert error:`, error.message); continue }
        totalUpserted++

        // Fetch lineups if kick-off within 2 hours or live
        if (upserted) {
          const hoursUntil = (new Date(f.fixture.date).getTime() - now.getTime()) / 3600000
          if (hoursUntil <= 2 || status === 'live') {
            await sleep(300)
            await syncLineups(upserted.id, f.fixture.id, f.teams.home.name, f.teams.away.name)
          }
        }
      }
    } catch (err) {
      console.error(`League ${leagueId} exception:`, err)
      report.errors.push({ where: meta.name, detail: String(err) })
    }
  }

  // Safety sweep: any fixture that kicked off more than 4 hours ago and
  // still isn't marked FT is stale (missed live sync, abandoned, etc.)
  // — flag it FT so it stops showing on the main page.
  const staleCutoff = new Date(now.getTime() - 4 * 3600000).toISOString()
  const { error: sweepErr } = await sb
    .from('fixtures')
    .update({ status: 'ft' })
    .neq('status', 'ft')
    .lt('kick_off', staleCutoff)
  if (sweepErr) console.error('Stale sweep error:', sweepErr.message)

  return new Response(JSON.stringify({ ok: true, upserted: totalUpserted, from, to, ...report }, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  })
})

async function syncLineups(dbId: string, apiId: number, homeTeam: string, awayTeam: string) {
  const { data: existing } = await sb
    .from('fixtures').select('home_squad').eq('id', dbId).single()
  if (existing?.home_squad?.length > 0) return

  const data = await apiGet(`/fixtures/lineups?fixture=${apiId}`)
  console.log(`Lineups for fixture ${apiId}: ${data.response?.length ?? 0} teams returned`)

  if (!data.response?.length) {
    console.log(`No lineups yet for fixture ${apiId}`)
    return
  }

  // Match by position (index 0 = home, index 1 = away) as fallback
  // Also try name match first
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')
  const home = data.response.find((t: any) =>
    normalize(t.team.name) === normalize(homeTeam)
  ) || data.response[0]

  const away = data.response.find((t: any) =>
    normalize(t.team.name) === normalize(awayTeam)
  ) || data.response[1]

  console.log(`Home lineup: ${home?.team?.name}, Away lineup: ${away?.team?.name}`)

  const toSquad = (l: any) => {
    if (!l) return []
    const players = [
      ...(l.startXI || []).map((p: any) => ({
        name: p.player.name,
        pos:  mapPos(p.player.pos || 'F')
      })),
      ...(l.substitutes || []).map((p: any) => ({
        name: p.player.name,
        pos:  mapPos(p.player.pos || 'F')
      }))
    ]
    console.log(`Squad size: ${players.length}`)
    return players
  }

  const homeSquad = toSquad(home)
  const awaySquad = toSquad(away)

  if (homeSquad.length === 0 && awaySquad.length === 0) {
    console.log('Both squads empty — lineups not confirmed yet')
    return
  }

  await sb.from('fixtures').update({
    home_squad: homeSquad,
    away_squad: awaySquad
  }).eq('id', dbId)

  console.log(`Saved lineups for fixture ${apiId}: ${homeSquad.length} home, ${awaySquad.length} away players`)
}
