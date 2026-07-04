// ─── Results page ─────────────────────────────────
let currentUser   = null;
let currentLobby  = null;
let currentFixture = null;
let allPicks      = [];

async function initResults() {
  currentUser = await requireAuth();

  const params  = new URLSearchParams(window.location.search);
  const lobbyId = params.get('lobby');
  if (!lobbyId) { window.location.href = 'index.html'; return; }

  await loadData(lobbyId);
  renderFixtureBar();
  await settleResults();
  renderWinnerBanner();
  renderStandings();
  renderBreakdown();
  renderCoinSummary();
  renderActions();
}

// ─── Load lobby + fixture + picks ─────────────────
async function loadData(lobbyId) {
  const { data: lobby, error } = await sb
    .from('lobbies')
    .select(`*, lobby_players(user_id, username), fixtures(*)`)
    .eq('id', lobbyId)
    .single();

  if (error || !lobby) { window.location.href = 'index.html'; return; }
  currentLobby   = lobby;
  currentFixture = lobby.fixtures;

  const { data: picks } = await sb
    .from('picks')
    .select('user_id, player_name, player_team, position, points, pick_number')
    .eq('lobby_id', lobbyId);

  // Attach username from lobby_players
  const lobbyPlayers = lobby.lobby_players || [];
  allPicks = (picks || []).map(p => ({
    ...p,
    username: lobbyPlayers.find(lp => lp.user_id === p.user_id)?.username || 'Unknown'
  }));
}

// ─── Settle results (award coins if not done yet) ─
async function settleResults() {
  if (currentLobby.settled) return;

  // Never settle before full time — opening this page mid-match must
  // not pay out prizes on a half-finished score
  if (currentFixture.status !== 'ft') return;

  // Atomically claim the settlement: only ONE client can flip
  // settled false -> true. Everyone else gets zero rows back and
  // stops here, so prizes can't be paid twice when several players
  // open the results page at the same moment.
  const { data: claimed } = await sb
    .from('lobbies')
    .update({ settled: true, status: 'complete' })
    .eq('id', currentLobby.id)
    .eq('settled', false)
    .select();

  if (!claimed || claimed.length === 0) {
    currentLobby.settled = true;   // someone else already settled
    return;
  }

  // Build user totals
  const userTotals = buildUserTotals();
  const sorted     = Object.entries(userTotals).sort(([,a],[,b]) => b.total - a.total);

  const fee    = currentLobby.entry_fee || 0;
  const pot    = fee * (currentLobby.lobby_players?.length || sorted.length);
  const prize1 = Math.round(pot * 0.8);
  const prize2 = Math.round(pot * 0.2);

  // Award coins to top 2
  for (let i = 0; i < Math.min(2, sorted.length); i++) {
    const [uid] = sorted[i];
    const prize  = i === 0 ? prize1 : prize2;
    if (prize <= 0) continue;

    const { data: profile } = await sb
      .from('profiles').select('coins, wins, matches_played, net_coins').eq('id', uid).single();
    if (!profile) continue;

    await sb.from('profiles').update({
      coins:          profile.coins + prize,
      wins:           i === 0 ? (profile.wins || 0) + 1 : profile.wins,
      matches_played: (profile.matches_played || 0) + 1,
      net_coins:      (profile.net_coins || 0) + prize - fee
    }).eq('id', uid);
  }

  // Update non-winners' stats
  for (let i = 2; i < sorted.length; i++) {
    const [uid] = sorted[i];
    const { data: profile } = await sb
      .from('profiles').select('matches_played, net_coins').eq('id', uid).single();
    if (!profile) continue;
    await sb.from('profiles').update({
      matches_played: (profile.matches_played || 0) + 1,
      net_coins:      (profile.net_coins || 0) - fee
    }).eq('id', uid);
  }

  currentLobby.settled = true;
}

// ─── Build per-user point totals ──────────────────
function buildUserTotals() {
  const totals = {};
  allPicks.forEach(p => {
    if (!totals[p.user_id]) {
      totals[p.user_id] = { username: p.username, total: 0, picks: [] };
    }
    totals[p.user_id].total += (p.points ?? 0);
    totals[p.user_id].picks.push(p);
  });
  return totals;
}

// ─── Fixture bar ───────────────────────────────────
function renderFixtureBar() {
  const f = currentFixture;
  document.getElementById('rfb-abbr-home').textContent = f.home_abbr;
  document.getElementById('rfb-name-home').textContent = f.home_team;
  document.getElementById('rfb-abbr-away').textContent = f.away_abbr;
  document.getElementById('rfb-name-away').textContent = f.away_team;
  document.getElementById('rfb-score').textContent =
    `${f.home_score ?? 0} — ${f.away_score ?? 0}`;
}

// ─── Winner banner ─────────────────────────────────
function renderWinnerBanner() {
  const totals = buildUserTotals();
  const sorted = Object.entries(totals).sort(([,a],[,b]) => b.total - a.total);
  if (!sorted.length) return;

  const [winnerUid, winnerData] = sorted[0];
  const isMe   = winnerUid === currentUser.id;
  const fee    = currentLobby.entry_fee || 0;
  const pot    = fee * (currentLobby.lobby_players?.length || sorted.length);
  const prize1 = Math.round(pot * 0.8);

  document.getElementById('winner-banner').innerHTML = `
    <div class="winner-crown">${isMe ? '🏆' : '🥇'}</div>
    <div class="winner-info">
      <div class="winner-label">${isMe ? 'You won!' : 'Winner'}</div>
      <div class="winner-name">${isMe ? 'You' : escHtml(winnerData.username)}</div>
      <div class="winner-pts">${winnerData.total} pts</div>
    </div>
    <div class="winner-prize">
      <div class="winner-prize-label">${isMe ? 'You earned' : 'Prize'}</div>
      <div class="coin winner-prize-amount">${prize1}</div>
    </div>
  `;
}

// ─── Final standings ───────────────────────────────
function renderStandings() {
  const totals = buildUserTotals();
  const sorted = Object.entries(totals).sort(([,a],[,b]) => b.total - a.total);
  const fee    = currentLobby.entry_fee || 0;
  const pot    = fee * (currentLobby.lobby_players?.length || sorted.length);
  const prizes = [Math.round(pot * 0.8), Math.round(pot * 0.2)];

  const rankClass = (i) => i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';

  document.getElementById('results-standings').innerHTML = sorted.map(([uid, data], i) => {
    const isMe      = uid === currentUser.id;
    const initial   = data.username.charAt(0).toUpperCase();
    const pickNames = data.picks.map(p => p.player_name).join(' · ');
    const prize     = prizes[i] ?? 0;
    const payoutHtml = prize > 0
      ? `<div class="results-payout win"><span class="coin">${prize}</span></div>`
      : `<div class="results-payout loss">—</div>`;

    return `
      <div class="results-row ${isMe ? 'you' : ''}">
        <div class="results-rank ${rankClass(i)}">${i + 1}</div>
        <div class="results-avatar ${isMe ? 'you' : ''}">${initial}</div>
        <div class="results-info">
          <span class="results-name">${isMe ? 'You' : escHtml(data.username)}</span>
          <span class="results-picks">${escHtml(pickNames)}</span>
        </div>
        <div class="results-right">
          <div class="results-pts">${data.total}</div>
          ${payoutHtml}
        </div>
      </div>
    `;
  }).join('');
}

// ─── Your breakdown ────────────────────────────────
async function renderBreakdown() {
  const myPicks = allPicks.filter(p => p.user_id === currentUser.id);
  // Order by position: GK → DEF → MID → FWD
  const POS_ORDER = { GK: 0, DEF: 1, MID: 2, FWD: 3 };
  const posRank = p => POS_ORDER[String(p.position || 'MID').toUpperCase()] ?? 2;
  myPicks.sort((a, b) => posRank(a) - posRank(b) || a.player_name.localeCompare(b.player_name));
  if (!myPicks.length) {
    document.getElementById('results-breakdown').innerHTML =
      `<div class="empty" style="padding:16px 0">No picks found.</div>`;
    return;
  }

  // Load events for this fixture
  const { data: events } = await sb
    .from('match_events')
    .select('*')
    .eq('fixture_id', currentFixture.id)
    .order('minute', { ascending: true });

  const eventsMap = {};
  (events || []).forEach(e => {
    if (!eventsMap[e.player_name]) eventsMap[e.player_name] = [];
    eventsMap[e.player_name].push(e);
  });

  const kind = (e) => {
    const t = String(e.event_type || e.type || '').toLowerCase();
    const d = String(e.detail || '').toLowerCase();
    if (t === 'card') return d.includes('red') ? 'red_card' : 'yellow_card';
    if (t === 'goal' && d.includes('own')) return 'own_goal';
    return t;
  };

  document.getElementById('results-breakdown').innerHTML = myPicks.map(pick => {
    const playerEvents = eventsMap[pick.player_name] || [];
    const eventRows = playerEvents.map(e => {
      const t     = kind(e);
      const icon  = t === 'goal' ? '⚽' : t === 'own_goal' ? '⚽' : t === 'assist' ? '🅰' : t === 'yellow_card' ? '🟨' : '🟥';
      const pts   = e.points ?? 0;
      const label = t === 'goal' ? `Goal (${e.minute}')` : t === 'own_goal' ? `Own goal (${e.minute}')` : t === 'assist' ? `Assist (${e.minute}')` : t === 'yellow_card' ? `Yellow card (${e.minute}')` : `Red card (${e.minute}')`;
      return `
        <div class="breakdown-event">
          <span class="be-icon">${icon}</span>
          <span class="be-desc">${label}</span>
          <span class="be-pts ${pts >= 0 ? 'positive' : 'negative'}">${pts >= 0 ? '+' : ''}${pts}</span>
        </div>
      `;
    }).join('') || `<div class="breakdown-event"><span class="be-desc" style="color:var(--text-3)">No events this match</span></div>`;

    const pos = (pick.position || 'MID').toLowerCase();
    return `
      <div class="breakdown-player">
        <div class="breakdown-player-header">
          <div class="bp-pos ${pos}">${pick.position || 'MID'}</div>
          <div class="bp-name">${escHtml(pick.player_name)}</div>
          <div class="bp-team">${escHtml(pick.player_team || '')}</div>
          <div class="bp-total">${pick.points ?? 0} pts</div>
        </div>
        <div class="breakdown-events">${eventRows}</div>
      </div>
    `;
  }).join('');
}

// ─── Coin summary ──────────────────────────────────
function renderCoinSummary() {
  const totals  = buildUserTotals();
  const sorted  = Object.entries(totals).sort(([,a],[,b]) => b.total - a.total);
  const myRank  = sorted.findIndex(([uid]) => uid === currentUser.id);
  const fee     = currentLobby.entry_fee || 0;
  const pot     = fee * (currentLobby.lobby_players?.length || sorted.length);
  const prizes  = [Math.round(pot * 0.8), Math.round(pot * 0.2)];
  const prize   = prizes[myRank] ?? 0;
  const net     = prize - fee;
  const netCls  = net >= 0 ? 'positive' : 'negative';
  const netStr  = (net >= 0 ? '+' : '') + net;

  document.getElementById('coin-summary').innerHTML = `
    <div class="rcs-row">
      <span class="rcs-label">Entry fee</span>
      <span class="coin negative">-${fee}</span>
    </div>
    <div class="rcs-row">
      <span class="rcs-label">Winnings</span>
      <span class="coin ${prize > 0 ? 'positive' : ''}">${prize > 0 ? '+' : ''}${prize}</span>
    </div>
    <div class="rcs-divider"></div>
    <div class="rcs-row total">
      <span class="rcs-label">Net ${net >= 0 ? 'gain' : 'loss'}</span>
      <span class="coin ${netCls}">${netStr}</span>
    </div>
  `;
}

// ─── Navigation ────────────────────────────────────
function playAgain() {
  // Only valid if fixture is still open (shouldn't normally be reachable when FT)
  window.location.href = `lobby.html?fixture=${currentFixture.id}`;
}

function goHome() {
  sessionStorage.setItem('returnToMyGames', '1');
  window.location.href = 'index.html';
}

function renderActions() {
  const actionsEl = document.querySelector('.results-actions');
  if (currentFixture.status === 'ft') {
    // Fixture is over — no point going back to lobby
    actionsEl.innerHTML = `
      <button class="btn btn-primary btn-lg" onclick="goHome()">
        Find another match
      </button>
    `;
  }
  // Otherwise keep both buttons (e.g. results viewed mid-match edge case)
}

function toggleTheme() {
  const html = document.documentElement;
  html.setAttribute('data-theme', html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
}

// ─── Helpers ──────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

initResults();
