// ─── Match page ───────────────────────────────────
let currentUser   = null;
let currentLobby  = null;
let currentFixture = null;
let allPicks      = [];   // all picks in this lobby
let myPickNames   = [];   // my two player names
let playerPoints  = {};   // player_name → total points this match

// ─── Init ─────────────────────────────────────────
async function initMatch() {
  currentUser = await requireAuth();

  const params  = new URLSearchParams(window.location.search);
  const lobbyId = params.get('lobby');
  if (!lobbyId) { window.location.href = 'index.html'; return; }

  await loadLobbyData(lobbyId);
  // Wire My Team link
  const teamLink = document.getElementById('my-team-link');
  if (teamLink) teamLink.href = `team.html?lobby=${lobbyId}`;

  renderFixtureBar();
  renderPotBar();
  await loadPicksAndEvents();
  renderMyTeam();
  renderLeaderboard();
  subscribeToMatch(lobbyId);
}

// ─── Load lobby + fixture ──────────────────────────
async function loadLobbyData(lobbyId) {
  const { data: lobby, error } = await sb
    .from('lobbies')
    .select(`*, fixtures(*), lobby_players(user_id)`)
    .eq('id', lobbyId)
    .single();

  if (error || !lobby) { window.location.href = 'index.html'; return; }
  currentLobby   = lobby;
  currentFixture = lobby.fixtures;

  // Enrich lobby_players with usernames from profiles
  const rawPlayers = lobby.lobby_players || [];
  if (rawPlayers.length > 0) {
    const uids = rawPlayers.map(p => p.user_id);
    const { data: profiles } = await sb
      .from('profiles').select('id, username').in('id', uids);
    const nameMap = {};
    (profiles || []).forEach(p => nameMap[p.id] = p.username);
    currentLobby.lobby_players = rawPlayers.map(p => ({
      user_id:  p.user_id,
      username: nameMap[p.user_id] || 'Player'
    }));
  }
}

// ─── Load picks + events ───────────────────────────
async function loadPicksAndEvents() {
  // All picks for this lobby
  // Fetch picks and join with lobby_players to get usernames
  const { data: picks } = await sb
    .from('picks')
    .select('user_id, player_name, player_team, position, points')
    .eq('lobby_id', currentLobby.id);

  const lobbyPlayers = currentLobby.lobby_players || [];

  allPicks = (picks || []).map(p => ({
    ...p,
    username: lobbyPlayers.find(lp => lp.user_id === p.user_id)?.username || 'Unknown'
  }));

  myPickNames = allPicks
    .filter(p => p.user_id === currentUser.id)
    .map(p => p.player_name);

  // Tally points per player
  playerPoints = {};
  allPicks.forEach(p => {
    playerPoints[p.player_name] = (playerPoints[p.player_name] || 0) + (p.points ?? 0);
  });

  // Events for this fixture
  const { data: events } = await sb
    .from('match_events')
    .select('*')
    .eq('fixture_id', currentFixture.id)
    .order('minute', { ascending: false });

  renderEvents(events || []);
}

// ─── Fixture bar ───────────────────────────────────
function renderFixtureBar() {
  const f = currentFixture;
  document.getElementById('mfb-abbr-home').textContent = f.home_abbr;
  document.getElementById('mfb-name-home').textContent = f.home_team;
  document.getElementById('mfb-abbr-away').textContent = f.away_abbr;
  document.getElementById('mfb-name-away').textContent = f.away_team;

  const scoreEl = document.getElementById('mfb-score');
  const timeEl  = document.getElementById('mfb-time');

  if (f.status === 'live') {
    scoreEl.textContent = `${f.home_score ?? 0} — ${f.away_score ?? 0}`;
    timeEl.textContent  = `${f.minute}'`;
  } else if (f.status === 'ft') {
    scoreEl.textContent = `${f.home_score ?? 0} — ${f.away_score ?? 0}`;
    timeEl.textContent  = 'FT';
    timeEl.style.animation = 'none';
    timeEl.style.color = 'var(--text-3)';
    document.getElementById('ft-btn').classList.remove('hidden');
  } else {
    scoreEl.textContent = 'vs';
    timeEl.textContent  = formatKickOff(f.kick_off);
    timeEl.style.animation = 'none';
    timeEl.style.color = 'var(--text-3)';
  }
}

// ─── Pot bar ───────────────────────────────────────
function renderPotBar() {
  const fee     = currentLobby.entry_fee || 0;
  const players = currentLobby.lobby_players?.length || 6;
  const pot     = fee * players;
  document.getElementById('pot-total').textContent = pot.toLocaleString();
  document.getElementById('pot-1st').textContent   = Math.round(pot * 0.8).toLocaleString();
  document.getElementById('pot-2nd').textContent   = Math.round(pot * 0.2).toLocaleString();
}

// ─── My team ───────────────────────────────────────
function renderMyTeam() {
  const container = document.getElementById('my-player-cards');
  const myTotal   = myPickNames.reduce((sum, name) => sum + (playerPoints[name] || 0), 0);

  if (myPickNames.length === 0) {
    container.innerHTML = `<div class="empty">No picks found for your team.</div>`;
    document.getElementById('my-total-pts').textContent = '0 pts';
    return;
  }

  container.innerHTML = myPickNames.map(name => {
    const pts    = playerPoints[name] || 0;
    const events = getPlayerEvents(name);
    const pos    = getPlayerPos(name);
    const team   = getPlayerTeam(name);

    const eventBadges = events.map(e => {
      const cls = e.type === 'goal' ? 'goal' : e.type === 'assist' ? 'assist' : 'card';
      const icon = e.type === 'goal' ? '⚽' : e.type === 'assist' ? '🅰' : e.type === 'yellow_card' ? '🟨' : '🟥';
      return `<span class="mpc-event ${cls}">${icon} ${e.minute}'</span>`;
    }).join('');

    return `
      <div class="match-player-card">
        <div class="mpc-pos ${pos.toLowerCase()}">${pos}</div>
        <div class="mpc-info">
          <div class="mpc-name">${escHtml(name)}</div>
          <div class="mpc-team">${escHtml(team)}</div>
        </div>
        <div class="mpc-events">${eventBadges}</div>
        <div class="mpc-points">
          <span class="mpc-pts">${pts}</span>
          <span class="mpc-pts-label">pts</span>
        </div>
      </div>
    `;
  }).join('');

  document.getElementById('my-total-pts').textContent = `${myTotal} pts`;
}

// ─── Leaderboard ───────────────────────────────────
function renderLeaderboard() {
  // Group picks by user, sum points
  const userTotals = {};
  allPicks.forEach(p => {
    if (!userTotals[p.user_id]) {
      userTotals[p.user_id] = { username: p.username, total: 0, picks: [] };
    }
    userTotals[p.user_id].total += (playerPoints[p.player_name] || 0);
    userTotals[p.user_id].picks.push(p.player_name);
  });

  const sorted = Object.entries(userTotals)
    .sort(([,a],[,b]) => b.total - a.total);

  const list = document.getElementById('match-lb-list');
  list.innerHTML = sorted.map(([uid, data], i) => {
    const rank    = i + 1;
    const isYou   = uid === currentUser.id;
    const initial = data.username.charAt(0).toUpperCase();
    const pickStr = data.picks.join(' · ');
    return `
      <div class="match-lb-row ${isYou ? 'you' : ''} ${rank === 1 ? 'first' : ''}">
        <div class="match-lb-rank">${rank}</div>
        <div class="match-lb-avatar ${isYou ? 'you' : ''}">${initial}</div>
        <div class="match-lb-info">
          <span class="match-lb-name">${escHtml(data.username)}${isYou ? ' <span class="you-tag">You</span>' : ''}</span>
          <span class="match-lb-picks">${escHtml(pickStr)}</span>
        </div>
        <div class="match-lb-pts">${data.total}</div>
      </div>
    `;
  }).join('') || `<div class="empty">Waiting for picks...</div>`;
}

// ─── Events feed ───────────────────────────────────
function renderEvents(events) {
  const feed = document.getElementById('events-feed');
  if (!events.length) {
    feed.innerHTML = `<div class="empty" style="padding:12px 0">No events yet</div>`;
    return;
  }

  feed.innerHTML = events.map(e => {
    const isMyPlayer = myPickNames.includes(e.player_name);
    const icon  = e.type === 'goal' ? '⚽' : e.type === 'assist' ? '🅰' : e.type === 'yellow_card' ? '🟨' : e.type === 'red_card' ? '🟥' : '📋';
    const pts   = e.points ?? 0;
    const ptsCls = pts > 0 ? 'positive' : pts < 0 ? 'negative' : '';
    const ptsStr = pts !== 0 ? (pts > 0 ? `+${pts} pts` : `${pts} pt`) : '';
    return `
      <div class="match-event-item ${isMyPlayer ? 'my-event' : ''}">
        <div class="event-time">${e.minute}'</div>
        <div class="event-icon">${icon}</div>
        <div class="event-info">
          <span class="event-player">${escHtml(e.player_name)}</span>
          <span class="event-team">${escHtml(e.team_name || '')}</span>
        </div>
        ${ptsStr ? `<div class="event-pts ${ptsCls}">${ptsStr}</div>` : ''}
      </div>
    `;
  }).join('');
}

// ─── Helpers — look up player data from squad lists ─
function getPlayerEvents(name) {
  // From match_events cached during loadPicksAndEvents
  return (window._matchEvents || []).filter(e => e.player_name === name);
}

function getPlayerPos(name) {
  // Use position stored on the pick row — no need to look up squad
  const pick = allPicks.find(p => p.player_name === name);
  return pick?.position || 'MID';
}

function getPlayerTeam(name) {
  const pick = allPicks.find(p => p.player_name === name);
  return pick?.player_team || '';
}

// ─── Realtime subscriptions ────────────────────────
function subscribeToMatch(lobbyId) {
  sb.channel('match-' + currentFixture.id)
    // Fixture score/time updates
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'fixtures',
      filter: `id=eq.${currentFixture.id}`
    }, (payload) => {
      currentFixture = { ...currentFixture, ...payload.new };
      renderFixtureBar();
      // Auto-redirect to results when match ends
      if (payload.new.status === 'ft') {
        setTimeout(() => {
          window.location.href = `results.html?lobby=${currentLobby.id}`;
        }, 3000); // 3s delay so players see the final score
      }
    })
    // New match events (goals, cards etc)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'match_events',
      filter: `fixture_id=eq.${currentFixture.id}`
    }, async () => {
      await loadPicksAndEvents();
      renderMyTeam();
      renderLeaderboard();
    })
    // Points updates on picks
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'picks',
      filter: `lobby_id=eq.${lobbyId}`
    }, async () => {
      await loadPicksAndEvents();
      renderMyTeam();
      renderLeaderboard();
    })
    .subscribe();
}

// ─── Navigation ────────────────────────────────────
function goToResults() {
  window.location.href = `results.html?lobby=${currentLobby.id}`;
}

function toggleTheme() {
  const html = document.documentElement;
  html.setAttribute('data-theme', html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
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

// ─── Boot ──────────────────────────────────────────
initMatch();
