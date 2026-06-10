import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const API_KEY      = Deno.env.get('APIFOOTBALL_KEY')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
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
  if (pos === 'Goalkeeper') return 'GK'
  if (pos === 'Defender')   return 'DEF'
  if (pos === 'Midfielder') return 'MID'
  return 'FWD'
}

Deno.serve(async () => {
  const now  = new Date()
  const from = now.toISOString().split('T')[0]
  const to   = new Date(now.getTime() + 7 * 86400000).toISOString().split('T')[0]

  let totalUpserted = 0

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
        continue
      }

      const fixtures = data.response || []
      console.log(`League ${leagueId} (${meta.name}): ${fixtures.length} fixtures`)

      for (const f of fixtures) {
        const status = mapStatus(f.fixture.status.short)
        if (status === 'ft') continue

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
    }
  }

  return new Response(JSON.stringify({ ok: true, upserted: totalUpserted, from, to }), {
    headers: { 'Content-Type': 'application/json' }
  })
})

async function syncLineups(dbId: string, apiId: number, homeTeam: string, awayTeam: string) {
  const { data: existing } = await sb
    .from('fixtures').select('home_squad').eq('id', dbId).single()
  if (existing?.home_squad?.length > 0) return

  const data = await apiGet(`/fixtures/lineups?fixture=${apiId}`)
  if (!data.response?.length) return

  const home = data.response.find((t: any) => t.team.name === homeTeam)
  const away = data.response.find((t: any) => t.team.name === awayTeam)

  const toSquad = (l: any) => l ? [
    ...(l.startXI || []).map((p: any) => ({ name: p.player.name, pos: mapPos(p.player.pos) })),
    ...(l.substitutes || []).map((p: any) => ({ name: p.player.name, pos: mapPos(p.player.pos) }))
  ] : []

  await sb.from('fixtures').update({
    home_squad: toSquad(home),
    away_squad: toSquad(away)
  }).eq('id', dbId)
}
