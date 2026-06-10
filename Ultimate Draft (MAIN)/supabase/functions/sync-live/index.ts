// sync-live: runs every 60 seconds
// Updates scores, match events, and player points for all live fixtures
// Deploy: supabase functions deploy sync-live
// Cron:   supabase functions schedule sync-live --cron "* * * * *"

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const RAPIDAPI_KEY = Deno.env.get('APIFOOTBALL_KEY')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

async function apiGet(path: string) {
  const res = await fetch(`https://v3.football.api-sports.io${path}`, {
    headers: { 'x-apisports-key': RAPIDAPI_KEY }
  })
  return res.json()
}

function mapStatus(s: string): string {
  if (['1H','2H','ET','BT','P','INT'].includes(s)) return 'live'
  if (['FT','AET','PEN'].includes(s))              return 'ft'
  return 'upcoming'
}

// ─── Scoring rules ─────────────────────────────────
function pointsForEvent(type: string, detail: string, pos: string): number {
  const t = type.toLowerCase()
  const d = detail.toLowerCase()

  if (t === 'goal') {
    if (d.includes('own goal')) return -2
    return 6
  }
  if (t === 'card') {
    if (d.includes('yellow')) return -1
    if (d.includes('red'))    return -3
  }
  if (t === 'subst') return 0 // substitution — handled via appearance points separately
  return 0
}

function assistPoints(): number { return 4 }

Deno.serve(async () => {
  // Get all live fixtures in our DB
  const { data: liveFixtures } = await sb
    .from('fixtures')
    .select('id, api_fixture_id, home_team, away_team')
    .eq('status', 'live')

  if (!liveFixtures?.length) {
    return new Response(JSON.stringify({ ok: true, live: 0 }), {
      headers: { 'Content-Type': 'application/json' }
    })
  }

  let eventsProcessed = 0

  for (const fixture of liveFixtures) {
    try {
      // 1. Update score + minute
      const fixtureData = await apiGet(`/fixtures?id=${fixture.api_fixture_id}`)
      const f = fixtureData.response?.[0]
      if (f) {
        const status = mapStatus(f.fixture.status.short)
        await sb.from('fixtures').update({
          status,
          minute:     f.fixture.status.elapsed || 0,
          home_score: f.goals.home ?? 0,
          away_score: f.goals.away ?? 0,
        }).eq('id', fixture.id)

        // Mark lobbies complete when FT
        if (status === 'ft') {
          await sb.from('lobbies')
            .update({ status: 'complete' })
            .eq('fixture_id', fixture.id)
            .neq('status', 'complete')
        }
      }

      // 2. Fetch all events for this fixture
      const eventsData = await apiGet(`/fixtures/events?fixture=${fixture.api_fixture_id}`)
      const apiEvents  = eventsData.response || []

      // 3. Get existing events so we don't duplicate
      const { data: existingEvents } = await sb
        .from('match_events')
        .select('api_event_key')
        .eq('fixture_id', fixture.id)

      const existingKeys = new Set((existingEvents || []).map((e: any) => e.api_event_key))

      // 4. Get all picks for lobbies in this fixture
      const { data: lobbyIds } = await sb
        .from('lobbies')
        .select('id')
        .eq('fixture_id', fixture.id)
        .in('status', ['active', 'complete'])

      const lobbyIdList = (lobbyIds || []).map((l: any) => l.id)

      const picksByPlayer: Record<string, any[]> = {}
      if (lobbyIdList.length > 0) {
        const { data: picks } = await sb
          .from('picks')
          .select('id, user_id, player_name, points, lobby_id')
          .in('lobby_id', lobbyIdList)

        for (const pick of picks || []) {
          if (!picksByPlayer[pick.player_name]) picksByPlayer[pick.player_name] = []
          picksByPlayer[pick.player_name].push(pick)
        }
      }

      // 5. Process each event
      for (const event of apiEvents) {
        const eventType   = event.type        // Goal, Card, subst, Var
        const eventDetail = event.detail      // Normal Goal, Yellow Card etc
        const minute      = event.time.elapsed
        const playerName  = event.player?.name
        const assistName  = event.assist?.name

        // Unique key to prevent duplicates
        const eventKey = `${fixture.api_fixture_id}-${minute}-${eventType}-${playerName}`
        if (existingKeys.has(eventKey)) continue

        const pts = pointsForEvent(eventType, eventDetail, '')
        const teamName = event.team?.name || ''

        // Insert match event
        await sb.from('match_events').insert({
          fixture_id:    fixture.id,
          player_name:   playerName || '',
          team_name:     teamName,
          type:          eventType.toLowerCase().replace(' ', '_'),
          detail:        eventDetail,
          minute,
          points:        pts,
          api_event_key: eventKey
        })

        eventsProcessed++

        // Award points to picks for the scorer
        if (playerName && pts !== 0 && picksByPlayer[playerName]) {
          for (const pick of picksByPlayer[playerName]) {
            await sb.from('picks')
              .update({ points: pick.points + pts })
              .eq('id', pick.id)
            pick.points += pts // update local cache
          }
        }

        // Award assist points
        if (assistName && eventType === 'Goal' && !eventDetail.toLowerCase().includes('own goal')) {
          const aPts = assistPoints()
          const assistKey = `${fixture.api_fixture_id}-${minute}-Assist-${assistName}`
          if (!existingKeys.has(assistKey)) {
            await sb.from('match_events').insert({
              fixture_id:    fixture.id,
              player_name:   assistName,
              team_name:     teamName,
              type:          'assist',
              detail:        `Assist (${minute}')`,
              minute,
              points:        aPts,
              api_event_key: assistKey
            })
            existingKeys.add(assistKey)

            if (picksByPlayer[assistName]) {
              for (const pick of picksByPlayer[assistName]) {
                await sb.from('picks')
                  .update({ points: pick.points + aPts })
                  .eq('id', pick.id)
                pick.points += aPts
              }
            }
          }
        }

        existingKeys.add(eventKey)
      }

      // 6. Appearance points — award once per pick if player appeared
      // (2pts for 90 mins, 1pt for 45+ mins) — set when FT
      if (f && mapStatus(f.fixture.status.short) === 'ft') {
        await awardAppearancePoints(fixture.id, lobbyIdList, apiEvents, f.fixture.status.elapsed || 90)
      }

    } catch (err) {
      console.error(`Fixture ${fixture.id} error:`, err)
    }
  }

  return new Response(JSON.stringify({ ok: true, live: liveFixtures.length, eventsProcessed }), {
    headers: { 'Content-Type': 'application/json' }
  })
})

// ─── Appearance points (awarded at FT) ────────────
async function awardAppearancePoints(
  fixtureId: string,
  lobbyIds: string[],
  events: any[],
  totalMinutes: number
) {
  if (!lobbyIds.length) return

  // Build substitution map: playerName → minutes played
  const subsOff: Record<string, number> = {}
  const subsOn:  Record<string, number> = {}
  for (const e of events) {
    if (e.type === 'subst') {
      if (e.player?.name) subsOff[e.player.name] = e.time.elapsed  // subbed off
      if (e.assist?.name) subsOn[e.assist.name]  = e.time.elapsed  // subbed on
    }
  }

  const { data: picks } = await sb
    .from('picks')
    .select('id, player_name, points, appearance_awarded')
    .in('lobby_id', lobbyIds)
    .not('appearance_awarded', 'is', true)

  for (const pick of picks || []) {
    const name = pick.player_name
    let minsPlayed = totalMinutes

    if (subsOff[name]) minsPlayed = subsOff[name]           // came off
    else if (subsOn[name]) minsPlayed = totalMinutes - subsOn[name] // came on

    const appPts = minsPlayed >= 90 ? 2 : minsPlayed >= 45 ? 1 : 0
    if (appPts > 0) {
      await sb.from('picks').update({
        points:             pick.points + appPts,
        appearance_awarded: true
      }).eq('id', pick.id)
    }
  }
}
