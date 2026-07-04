// ─── Index page ───────────────────────────────────
let allFixtures  = [];
let currentUser  = null;
let activeTab    = 'fixtures';

async function initIndex() {
  currentUser = await requireAuth();

  const { data: profile } = await sb
    .from('profiles').select('coins').eq('id', currentUser.id).single();
  if (profile) document.getElementById('nav-coin-balance').textContent = profile.coins;

  await Promise.all([loadFixtures(), loadMyGames()]);

  if (sessionStorage.getItem('returnToMyGames')) {
    sessionStorage.removeItem('returnToMyGames');
    switchTab('mygames', document.getElementById('tab-mygames'));
  }

  subscribeToFixtures();
}

// ─── Tab switching ────────────────────────────────
function switchTab(tab, btn) {
  activeTab = tab;
  document.querySelectorAll('.home-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('panel-fixtures').classList.toggle('hidden', tab !== 'fixtures');
  document.getElementById('panel-mygames').classList.toggle('hidden',  tab !== 'mygames');
}

// ════════════════════════════════════════════════════
// FIXTURES TAB
// ════════════════════════════════════════════════════
async function loadFixtures() {
  const list = document.getElementById('fixtures-list');
  list.innerHTML = `<div class="loading-fixtures"><div class="spinner"></div></div>`;

  const { data: fixtures, error } = await sb
    .from('fixtures')
    .select('*')
    .order('kick_off', { ascending: true });

  if (error) {
    list.innerHTML = `<div class="empty">Failed to load fixtures. Please try again.</div>`;
    return;
  }
  if (!fixtures || fixtures.length === 0) {
    list.innerHTML = `<div class="empty">No fixtures available right now. Check back soon.</div>`;
    return;
  }

  // Filter out finished + stale fixtures:
  // - anything marked ft
  // - "upcoming" games whose kick-off passed >3h ago (sync missed them)
  // - "live" games that kicked off >5h ago (stale live flag)
  const nowMs = Date.now();
  allFixtures = fixtures.filter(f => {
    if (f.status === 'ft') return false;
    const ko = f.kick_off ? new Date(f.kick_off).getTime() : nowMs;
    if (f.status === 'live')  return ko > nowMs - 5 * 3600000;
    return ko > nowMs - 3 * 3600000;
  });
  renderFixtures(allFixtures);
}

async function renderFixtures(fixtures) {
  const list = document.getElementById('fixtures-list');
  list.innerHTML = '';

  const fixtureIds = fixtures.map(f => f.id);
  if (fixtureIds.length === 0) {
    list.innerHTML = `<div class="empty">No fixtures available right now. Check back soon.</div>`;
    return;
  }

  const { data: lobbyCounts } = await sb
    .from('lobbies')
    .select('fixture_id')
    .in('fixture_id', fixtureIds)
    .eq('status', 'waiting');

  const countMap = {};
  (lobbyCounts || []).forEach(l => {
    countMap[l.fixture_id] = (countMap[l.fixture_id] || 0) + 1;
  });

  // Separate live from upcoming, sort upcoming by kick_off
  const liveFixtures     = fixtures.filter(f => f.status === 'live');
  const upcomingFixtures = fixtures
    .filter(f => f.status !== 'live')
    .sort((a, b) => new Date(a.kick_off) - new Date(b.kick_off));

  const ordered = [...liveFixtures, ...upcomingFixtures];

  if (ordered.length === 0) {
    list.innerHTML = `<div class="empty">No fixtures available right now. Check back soon.</div>`;
    return;
  }

  // Group by date, then by league within each date
  const dateGroups = {};
  ordered.forEach(f => {
    const label = f.status === 'live' ? '🔴 Live Now' : getDateLabel(f.kick_off);
    if (!dateGroups[label]) dateGroups[label] = {};
    if (!dateGroups[label][f.league]) dateGroups[label][f.league] = [];
    dateGroups[label][f.league].push(f);
  });

  Object.entries(dateGroups).forEach(([dateLabel, leagueGroups]) => {
    const dateHeader = document.createElement('div');
    dateHeader.className = 'date-header';
    dateHeader.textContent = dateLabel;
    list.appendChild(dateHeader);

    Object.entries(leagueGroups).forEach(([league, matches]) => {
      const isLive = matches.some(m => m.status === 'live');
      const group  = document.createElement('div');
      group.className      = 'league-group';
      group.dataset.league = matches[0].league_slug || '';

      group.innerHTML = `
        <div class="league-header">
          <span class="league-name">${league}</span>
          ${isLive
            ? `<span class="badge badge-live">Live</span>`
            : `<span class="badge badge-soon">Upcoming</span>`}
        </div>
      `;

      matches.forEach(fixture => {
        const count = countMap[fixture.id] || 0;
        const row   = document.createElement('div');
        row.className = 'fixture-row card-interactive';
        row.onclick   = () => goToLobby(fixture.id);

        // Rows are already grouped under a date header (Today / Tomorrow / etc),
        // so the pill only needs the time — keeps it narrow on mobile.
        const timeDisplay = fixture.status === 'live'
          ? `<span class="score-time live">${fixture.minute}'</span>`
          : `<span class="score-time">${formatTimeOnly(fixture.kick_off)}</span>`;

        const lobbyDisplay = count > 0
          ? `<span class="fixture-lobbies">${count} ${count === 1 ? 'lobby' : 'lobbies'}</span>`
          : `<span class="fixture-lobbies new">+ Create first lobby</span>`;

        row.innerHTML = `
          <div class="fixture-teams">
            <span class="team-name">
              ${crestHTML(fixture.home_logo, fixture.home_abbr)}
              <span class="team-full">${fixture.home_team}</span>
              <span class="team-abbr">${fixture.home_abbr || ''}</span>
            </span>
            <div class="fixture-score">${timeDisplay}</div>
            <span class="team-name right">
              <span class="team-full">${fixture.away_team}</span>
              <span class="team-abbr">${fixture.away_abbr || ''}</span>
              ${crestHTML(fixture.away_logo, fixture.away_abbr)}
            </span>
          </div>
          <div class="fixture-meta">
            ${lobbyDisplay}
            <span class="fixture-arrow">›</span>
          </div>
        `;
        group.appendChild(row);
      });

      list.appendChild(group);
    });
  });
}

function filterLeague(league, btn) {
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderFixtures(league === 'all' ? allFixtures : allFixtures.filter(f => f.league_slug === league));
}

function goToLobby(fixtureId) {
  window.location.href = `lobby.html?fixture=${fixtureId}`;
}

// ════════════════════════════════════════════════════
// MY GAMES TAB
// ════════════════════════════════════════════════════
async function loadMyGames() {
  const list = document.getElementById('my-games-list');
  list.innerHTML = `<div class="loading-fixtures"><div class="spinner"></div></div>`;

  const { data: mySlots, error } = await sb
    .from('lobby_players')
    .select(`
      lobby_id,
      lobbies (
        id, status, settled, entry_fee, current_pick, draft_order,
        fixture_id,
        fixtures ( home_team, away_team, home_abbr, away_abbr, league, status, minute, home_score, away_score, kick_off )
      )
    `)
    .eq('user_id', currentUser.id)
    .order('lobby_id');

  if (error) {
    list.innerHTML = `<div class="empty">Failed to load your games.</div>`;
    return;
  }

  if (!mySlots || mySlots.length === 0) {
    list.innerHTML = `<div class="empty">No active games — join a lobby to get started!</div>`;
    updateMyGamesCount(0);
    return;
  }

  const seen = new Set();
  const lobbies = mySlots
    .map(s => s.lobbies)
    .filter(l => l && !seen.has(l.id) && seen.add(l.id))
    // Hide only lobbies that are fully done AND settled (prizes paid).
    // sync-live flips lobbies to 'complete' at FT — if we hid those
    // immediately, nobody could ever open results and get paid out.
    .filter(l => !(l.status === 'complete' && l.settled))
    // Fixture finished but lobby never started (stuck in waiting/drafting):
    // hide it — the DB sweep refunds fees and closes these.
    // Keep 'active' lobbies on FT fixtures visible so the user can open
    // results and prizes get settled.
    .filter(l => !(l.fixtures?.status === 'ft' &&
                   (l.status === 'waiting' || l.status === 'drafting')));

  if (lobbies.length === 0) {
    list.innerHTML = `<div class="empty">No active games — join a lobby to get started!</div>`;
    updateMyGamesCount(0);
    return;
  }

  updateMyGamesCount(lobbies.length);
  renderMyGames(lobbies);
}

function renderMyGames(lobbies) {
  const list = document.getElementById('my-games-list');
  list.innerHTML = '';

  const grouped = {};
  lobbies.forEach(l => {
    const fid = l.fixture_id;
    if (!grouped[fid]) grouped[fid] = { fixture: l.fixtures, lobbies: [] };
    grouped[fid].lobbies.push(l);
  });

  Object.values(grouped).forEach(({ fixture: f, lobbies: fLobbies }) => {
    const group = document.createElement('div');
    group.className = 'league-group';

    const scoreStr = (f.status === 'live' || f.status === 'ft')
      ? `${f.home_score ?? 0}–${f.away_score ?? 0}`
      : formatKickOff(f.kick_off);

    const badgeHtml = f.status === 'live'
      ? `<span class="badge badge-live">Live</span>`
      : f.status === 'ft'
      ? `<span class="badge badge-soon">FT</span>`
      : `<span class="badge badge-soon">Upcoming</span>`;

    group.innerHTML = `
      <div class="league-header">
        <span class="league-name">${f.home_team} vs ${f.away_team}
          <span class="mygame-score">${scoreStr}</span>
        </span>
        ${badgeHtml}
      </div>
    `;

    fLobbies.forEach((lobby, i) => {
      const card = document.createElement('div');
      card.className = 'fixture-row card-interactive';

      const fixtureDone = f.status === 'ft' || lobby.status === 'complete';

      const statusLabel = fixtureDone                ? 'Finished — view results'
                        : lobby.status === 'waiting'  ? 'Waiting room'
                        : lobby.status === 'drafting' ? 'Drafting...'
                        : lobby.status === 'active'   ? 'Live match'
                        : 'Finished';

      const statusCls = fixtureDone                 ? 'game-status-wait'
                      : lobby.status === 'active'   ? 'game-status-live'
                      : lobby.status === 'drafting' ? 'game-status-draft'
                      : 'game-status-wait';

      const dest = fixtureDone
        ? `results.html?lobby=${lobby.id}`
        : (lobby.status === 'waiting' || lobby.status === 'drafting')
        ? `draft.html?lobby=${lobby.id}`
        : `match.html?lobby=${lobby.id}`;

      card.onclick = () => window.location.href = dest;
      card.innerHTML = `
        <div class="fixture-teams">
          <span class="team-name" style="font-size:13px">Lobby #${i + 1}</span>
        </div>
        <div class="fixture-meta">
          <span class="fixture-lobbies ${statusCls}">${statusLabel}</span>
          <span class="coin" style="font-size:13px">${lobby.entry_fee}</span>
          <span class="fixture-arrow">›</span>
        </div>
      `;
      group.appendChild(card);
    });

    list.appendChild(group);
  });
}

function updateMyGamesCount(n) {
  const badge = document.getElementById('my-games-count');
  if (n > 0) { badge.textContent = n; badge.classList.remove('hidden'); }
  else        { badge.classList.add('hidden'); }
}

// ─── Realtime ─────────────────────────────────────
function subscribeToFixtures() {
  sb.channel('fixtures-index')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'fixtures' },
      () => loadFixtures())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'lobby_players',
      filter: `user_id=eq.${currentUser.id}` },
      () => loadMyGames())
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'lobbies' },
      () => loadMyGames())
    .subscribe();

  // Fallback refresh: realtime can silently drop; re-pull every 60s
  // and whenever the user returns to the tab
  setInterval(() => { if (!document.hidden) loadFixtures(); }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { loadFixtures(); loadMyGames(); }
  });
}

// ─── Helpers ──────────────────────────────────────
function getDateLabel(isoString) {
  if (!isoString) return 'Upcoming';
  const date     = new Date(isoString);
  const now      = new Date();
  const today    = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const matchDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (matchDay.getTime() === today.getTime())    return 'Today';
  if (matchDay.getTime() === tomorrow.getTime()) return 'Tomorrow';
  return date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

// Crest image with graceful fallback — hides itself if the URL 404s
function crestHTML(logoUrl, abbr) {
  if (!logoUrl) return '';
  return `<img class="team-crest" src="${logoUrl}" alt="${abbr || ''}" loading="lazy" onerror="this.style.display='none'">`;
}

// Time only — used inside fixture rows where the date header already
// says which day it is
function formatTimeOnly(isoString) {
  if (!isoString) return 'TBC';
  return new Date(isoString).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function formatKickOff(isoString) {
  if (!isoString) return 'TBC';
  const date = new Date(isoString);
  const now  = new Date();
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return time;
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  if (date.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' + time;
}

function toggleTheme() {
  const html = document.documentElement;
  html.setAttribute('data-theme', html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
}

initIndex();
