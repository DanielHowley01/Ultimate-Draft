// ─── Team page ────────────────────────────────────
let currentUser   = null;
let currentLobby  = null;
let currentFixture = null;

async function initTeam() {
  currentUser = await requireAuth();

  const params  = new URLSearchParams(window.location.search);
  const lobbyId = params.get('lobby');
  if (!lobbyId) { window.location.href = 'index.html'; return; }

  // Load lobby + fixture
  const { data: lobby, error } = await sb
    .from('lobbies')
    .select(`*, fixtures(*)`)
    .eq('id', lobbyId)
    .single();

  if (error || !lobby) { window.location.href = 'index.html'; return; }
  currentLobby   = lobby;
  currentFixture = lobby.fixtures;

  renderFixtureBar();
  await renderPicks(lobbyId);
  setBackLink(lobbyId);
  subscribeToUpdates(lobbyId);
}

// ─── Fixture bar ───────────────────────────────────
function renderFixtureBar() {
  const f = currentFixture;
  document.getElementById('tfb-abbr-home').textContent = f.home_abbr;
  document.getElementById('tfb-name-home').textContent = f.home_team;
  document.getElementById('tfb-abbr-away').textContent = f.away_abbr;
  document.getElementById('tfb-name-away').textContent = f.away_team;

  const scoreEl = document.getElementById('tfb-score');
  const timeEl  = document.getElementById('tfb-time');

  if (f.status === 'live') {
    scoreEl.textContent = `${f.home_score ?? 0} — ${f.away_score ?? 0}`;
    timeEl.textContent  = `${f.minute}'`;
  } else if (f.status === 'ft') {
    scoreEl.textContent = `${f.home_score ?? 0} — ${f.away_score ?? 0}`;
    timeEl.textContent  = 'FT';
    timeEl.style.animation = 'none';
    timeEl.style.color     = 'var(--text-3)';
  } else {
    scoreEl.textContent = 'vs';
    timeEl.textContent  = formatKickOff(f.kick_off);
    timeEl.style.animation = 'none';
    timeEl.style.color     = 'var(--text-3)';
  }
}

// ─── My picks ──────────────────────────────────────
async function renderPicks(lobbyId) {
  const { data: picks } = await sb
    .from('picks')
    .select('player_name, player_team, position, points')
    .eq('lobby_id', lobbyId)
    .eq('user_id', currentUser.id);

  const container = document.getElementById('team-picks');

  if (!picks || picks.length === 0) {
    container.innerHTML = `<div class="empty" style="padding:16px 0">No picks found.</div>`;
    document.getElementById('team-total').textContent = '0';
    return;
  }

  // Load events for my players
  const playerNames = picks.map(p => p.player_name);
  const { data: events } = await sb
    .from('match_events')
    .select('player_name, type, minute, points')
    .eq('fixture_id', currentFixture.id)
    .in('player_name', playerNames)
    .order('minute', { ascending: true });

  const eventsMap = {};
  (events || []).forEach(e => {
    if (!eventsMap[e.player_name]) eventsMap[e.player_name] = [];
    eventsMap[e.player_name].push(e);
  });

  let total = 0;
  container.innerHTML = picks.map(pick => {
    total += (pick.points ?? 0);
    const pos = (pick.position || 'MID').toLowerCase();
    const playerEvents = eventsMap[pick.player_name] || [];

    const eventBadges = playerEvents.map(e => {
      const cls  = e.type === 'goal' ? 'goal' : e.type === 'assist' ? 'assist' : 'card';
      const icon = e.type === 'goal' ? '⚽' : e.type === 'assist' ? '🅰' : e.type === 'yellow_card' ? '🟨' : '🟥';
      return `<span class="tpc-event ${cls}">${icon} ${e.minute}'</span>`;
    }).join('');

    return `
      <div class="team-player-card">
        <div class="tpc-left">
          <div class="tpc-pos ${pos}">${pick.position || 'MID'}</div>
          <div class="tpc-info">
            <div class="tpc-name">${escHtml(pick.player_name)}</div>
            <div class="tpc-team">${escHtml(pick.player_team || '')}</div>
          </div>
        </div>
        <div class="tpc-events">${eventBadges}</div>
        <div class="tpc-pts">
          <span class="tpc-pts-num">${pick.points ?? 0}</span>
          <span class="tpc-pts-label">pts</span>
        </div>
      </div>
    `;
  }).join('');

  document.getElementById('team-total').textContent = total;
}

// ─── Back link ─────────────────────────────────────
function setBackLink(lobbyId) {
  const btn = document.getElementById('back-btn');
  if (currentFixture.status === 'ft') {
    btn.textContent = 'See results';
    btn.href = `results.html?lobby=${lobbyId}`;
  } else {
    btn.textContent = '← Back to live match';
    btn.href = `match.html?lobby=${lobbyId}`;
  }
}

// ─── Realtime — re-render picks when points update ─
function subscribeToUpdates(lobbyId) {
  sb.channel('team-' + lobbyId)
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'picks',
      filter: `lobby_id=eq.${lobbyId}`
    }, () => renderPicks(lobbyId))
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'fixtures',
      filter: `id=eq.${currentFixture.id}`
    }, (payload) => {
      currentFixture = { ...currentFixture, ...payload.new };
      renderFixtureBar();
      setBackLink(lobbyId);
    })
    .subscribe();
}

// ─── Helpers ──────────────────────────────────────
function formatKickOff(iso) {
  if (!iso) return 'TBC';
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toggleTheme() {
  const html = document.documentElement;
  html.setAttribute('data-theme', html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
}

initTeam();
