import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const API_KEY = Deno.env.get('APIFOOTBALL_KEY') ?? ''
const sb = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

async function apiGet(path: string) {
  const res = await fetch(`https://v3.football.api-sports.io${path}`, {
    headers: { 'x-apisports-key': API_KEY }
  })
  return res.json()
}

// ─── Scoring ──────────────────────────────────────
// Goal:            +6
// Assist:          +4
// Own goal:        -2
// Yellow card:     -1
// Red card:        -3
// 90 mins played:  +2 (+1 for 45+ = 3 total)
// 45+ mins played: +1
// Clean sheet DEF: +4
// Clean sheet MID: +1

function scoreEvent(type: string, detail: string): number {
  const t = type.toLowerCase()
  const d = detail.toLowerCase()
  if (t === 'goal') {
    if (d.includes('own goal')) return -2
    return 6
  }
  if (t === 'card') {
    if (d.includes('yellow card')) return -1
    if (d.includes('red card'))    return -3
  }
  return 0
}

function appearancePoints(minsPlayed: number): number {
  if (minsPlayed >= 90) return 3  // +1 for 45+ AND +2 for 90
  if (minsPlayed >= 45) return 1
  return 0
}

Deno.serve(async (_req) => {
  console.log('sync-live starting')

  const { data: liveFixtures, error: dbError } = await sb
    .from('fixtures')
    .select('id, api_fixture_id, home_team, away_team')
    .eq('status', 'live')

  if (dbError) {
    console.error('DB error:', dbError.message)
    return new Response(JSON.stringify({ error: dbError.message }), { status: 500 })
  }

  console.log(`Found ${liveFixtures?.length ?? 0} live fixtures`)

  if (!liveFixtures?.length) {
    return new Response(JSON.stringify({ ok: true, live: 0 }), {
      headers: { 'Content-Type': 'application/json' }
    })
  }

  let eventsProcessed = 0

  for (const fixture of liveFixtures) {
    try {
      console.log(`Processing: ${fixture.home_team} vs ${fixture.away_team}`)

      // 1. Get current fixture state + all events in one call each
      const [fixtureRes, eventsRes] = await Promise.all([
        apiGet(`/fixtures?id=${fixture.api_fixture_id}`),
        apiGet(`/fixtures/events?fixture=${fixture.api_fixture_id}`)
      ])

      const f          = fixtureRes.response?.[0]
      const apiEvents  = eventsRes.response ?? []

      if (!f) { console.error('No fixture data'); continue }

      const short  = f.fixture.status.short
      const status = ['1H','2H','ET','BT','P','INT'].includes(short) ? 'live'
                   : ['FT','AET','PEN'].includes(short) ? 'ft' : 'upcoming'
      const minute = f.fixture.status.elapsed ?? 0

      // 2. Update fixture score/minute/status
      await sb.from('fixtures').update({
        status,
        minute,
        home_score: f.goals.home ?? 0,
        away_score: f.goals.away ?? 0,
      }).eq('id', fixture.id)

      console.log(`${fixture.home_team} ${f.goals.home}-${f.goals.away} ${fixture.away_team} ${minute}' [${status}]`)

      // 3. Get lobbies for this fixture
      const { data: lobbyRows } = await sb
        .from('lobbies').select('id')
        .eq('fixture_id', fixture.id)
        .in('status', ['active', 'complete', 'drafting'])

      const lobbyIdList = (lobbyRows ?? []).map((l: any) => l.id)

      // 4. Build pick map: playerName → [pick rows]
      const pickMap: Record<string, any[]> = {}
      if (lobbyIdList.length > 0) {
        const { data: picks } = await sb
          .from('picks')
          .select('id, player_name, points, lobby_id, appearance_awarded')
          .in('lobby_id', lobbyIdList)
        for (const pick of picks ?? []) {
          if (!pickMap[pick.player_name]) pickMap[pick.player_name] = []
          pickMap[pick.player_name].push(pick)
        }
      }

      console.log(`${Object.keys(pickMap).length} picked players across ${lobbyIdList.length} lobbies`)

      // 5. Get already-processed event keys
      const { data: existing } = await sb
        .from('match_events')
        .select('api_event_key')
        .eq('fixture_id', fixture.id)
      const existingKeys = new Set((existing ?? []).map((e: any) => e.api_event_key))

      // 6. Process events
      for (const event of apiEvents) {
        const type     = event.type ?? ''
        const detail   = event.detail ?? ''
        const evtMin   = event.time?.elapsed ?? 0
        const player   = event.player?.name ?? ''
        const assist   = event.assist?.name ?? ''
        const teamName = event.team?.name ?? ''
        const eventKey = `${fixture.api_fixture_id}-${evtMin}-${type}-${player}`

        if (existingKeys.has(eventKey)) continue

        const pts = scoreEvent(type, detail)

        // Insert event
        const { error: evtErr } = await sb.from('match_events').insert({
          fixture_id:    fixture.id,
          player_name:   player,
          team:          teamName,
          event_type:    type.toLowerCase(),
          detail,
          minute:        evtMin,
          points:        pts,
          api_event_key: eventKey
        })

        if (evtErr) { console.error('Event insert:', evtErr.message); continue }

        existingKeys.add(eventKey)
        eventsProcessed++
        if (pts !== 0) console.log(`${player} ${type} ${evtMin}' = ${pts}pts`)

        // Award points to picks
        if (pts !== 0 && player && pickMap[player]) {
          for (const pick of pickMap[player]) {
            await sb.from('picks')
              .update({ points: (pick.points ?? 0) + pts })
              .eq('id', pick.id)
            pick.points = (pick.points ?? 0) + pts
          }
        }

        // Assist: +4pts
        if (type === 'Goal' && !detail.toLowerCase().includes('own') && assist) {
          const assistKey = `${fixture.api_fixture_id}-${evtMin}-assist-${assist}`
          if (!existingKeys.has(assistKey)) {
            await sb.from('match_events').insert({
              fixture_id:    fixture.id,
              player_name:   assist,
              team:          teamName,
              event_type:    'assist',
              detail:        `Assist (${evtMin}')`,
              minute:        evtMin,
              points:        4,
              api_event_key: assistKey
            })
            existingKeys.add(assistKey)
            console.log(`${assist} assist ${evtMin}' = 4pts`)

            if (pickMap[assist]) {
              for (const pick of pickMap[assist]) {
                await sb.from('picks')
                  .update({ points: (pick.points ?? 0) + 4 })
                  .eq('id', pick.id)
                pick.points = (pick.points ?? 0) + 4
              }
            }
          }
        }
      }

      // 7. Appearance points at FT
      if (status === 'ft') {
        // Mark lobbies complete
        await sb.from('lobbies').update({ status: 'complete' })
          .eq('fixture_id', fixture.id)
          .neq('status', 'complete')

        // Build substitution map
        const subsOff: Record<string, number> = {}
        const subsOn:  Record<string, number> = {}
        for (const e of apiEvents) {
          if (e.type === 'subst') {
            if (e.player?.name)  subsOff[e.player.name] = e.time?.elapsed ?? 90
            if (e.assist?.name)  subsOn[e.assist.name]  = e.time?.elapsed ?? 0
          }
        }

        // Award appearance points to all picks not yet awarded
        for (const [playerName, picks] of Object.entries(pickMap)) {
          for (const pick of picks as any[]) {
            if (pick.appearance_awarded) continue

            let minsPlayed = 90
            if (subsOff[playerName])      minsPlayed = subsOff[playerName]
            else if (subsOn[playerName])  minsPlayed = 90 - subsOn[playerName]

            const appPts = appearancePoints(minsPlayed)
            console.log(`Appearance: ${playerName} ${minsPlayed}' = +${appPts}pts`)

            await sb.from('picks').update({
              points:             (pick.points ?? 0) + appPts,
              appearance_awarded: true
            }).eq('id', pick.id)
          }
        }

        console.log('FT — appearance points awarded')
      }

    } catch (err) {
      console.error(`Fixture ${fixture.id} error:`, err)
    }
  }

  console.log(`Done. Events: ${eventsProcessed}`)
  return new Response(JSON.stringify({ ok: true, live: liveFixtures.length, eventsProcessed }), {
    headers: { 'Content-Type': 'application/json' }
  })
})
