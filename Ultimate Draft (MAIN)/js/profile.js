// ─── Profile page ────────────────────────────────
let currentUser = null;
let currentProfile = null;

async function initProfile() {
  currentUser = await requireAuth();
  await loadProfile();
  await loadHistory();
}

// ─── Load profile ─────────────────────────────────
async function loadProfile() {
  let { data: profile, error } = await sb
    .from('profiles')
    .select('*')
    .eq('id', currentUser.id)
    .single();

  // PGRST116 = no rows found — profile row doesn't exist yet, auto-create it
  if (error?.code === 'PGRST116') {
    const fallbackUsername = currentUser.email?.split('@')[0] || 'Player';
    const { data: created, error: createError } = await sb
      .from('profiles')
      .insert({
        id: currentUser.id,
        username: fallbackUsername,
        coins: 500,
        matches_played: 0,
        wins: 0,
        net_coins: 0
      })
      .select()
      .single();

    if (createError) {
      console.error('Profile create error:', createError);
      showProfileError(`${createError.code}: ${createError.message}`);
      return;
    }
    profile = created;
    error = null;
  }

  if (error || !profile) {
    console.error('loadProfile error:', error);
    showProfileError(error ? `${error.code}: ${error.message}` : 'No profile data returned');
    return;
  }

  currentProfile = profile;

  // Avatar
  const avatar = document.getElementById('profile-avatar');
  avatar.textContent = profile.username.charAt(0).toUpperCase();

  // Username and joined date
  document.getElementById('profile-username').textContent = profile.username;
  const joined = new Date(profile.created_at);
  document.getElementById('profile-joined').textContent =
    'Joined ' + joined.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  // Coins
  document.getElementById('profile-coins').textContent = profile.coins;
  document.getElementById('nav-coin-balance').textContent = profile.coins;
  const modalBalance = document.getElementById('modal-coin-balance');
  if (modalBalance) modalBalance.textContent = profile.coins;

  // Stats
  const winRate = profile.matches_played > 0
    ? Math.round((profile.wins / profile.matches_played) * 100)
    : 0;

  document.getElementById('stat-matches').textContent = profile.matches_played ?? 0;
  document.getElementById('stat-wins').textContent    = profile.wins ?? 0;
  document.getElementById('stat-winrate').textContent = winRate + '%';

  const netEl = document.getElementById('stat-net');
  const net = profile.net_coins ?? 0;
  netEl.textContent  = (net >= 0 ? '+' : '') + net;
  netEl.style.color  = net >= 0 ? 'var(--accent)' : 'var(--red)';
}

// Show error inline in the profile header so it's always visible
function showProfileError(msg) {
  document.getElementById('profile-username').textContent = 'Failed to load profile';
  document.getElementById('profile-joined').textContent   = msg;
  document.getElementById('profile-avatar').textContent   = '!';
  document.getElementById('profile-avatar').style.cssText =
    'background:var(--red-dim);border-color:var(--red);color:var(--red)';
}

// ─── Load match history ───────────────────────────
async function loadHistory() {
  const { data: picks, error } = await sb
    .from('picks')
    .select(`
      id, lobby_id, user_id, player_name, player_team, position, points, pick_number, created_at,
      lobbies (
        entry_fee,
        fixture_id,
        fixtures (
          home_team,
          away_team,
          league
        )
      )
    `)
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    console.error('loadHistory error:', error);
    document.getElementById('history-list').innerHTML =
      `<div class="empty">Failed to load match history (${error.code}).</div>`;
    return;
  }

  if (!picks || picks.length === 0) {
    document.getElementById('history-list').innerHTML =
      `<div class="empty">No matches played yet — join a lobby to get started.</div>`;
    return;
  }

  // Group picks by lobby
  const lobbyMap = {};
  picks.forEach(pick => {
    if (!lobbyMap[pick.lobby_id]) {
      lobbyMap[pick.lobby_id] = {
        lobby_id: pick.lobby_id,
        fixture: pick.lobbies?.fixtures,
        entry_fee: pick.lobbies?.entry_fee,
        picks: [],
        total_points: 0,
        created_at: pick.created_at
      };
    }
    lobbyMap[pick.lobby_id].picks.push(pick);
    lobbyMap[pick.lobby_id].total_points += (pick.points ?? 0);
  });

  const list = document.getElementById('history-list');
  list.innerHTML = '';

  Object.values(lobbyMap).forEach(match => {
    const fixture = match.fixture;
    if (!fixture) return;

    const pickNames = match.picks.map(p => p.player_name).join(' · ');
    const pts = match.total_points;

    const row = document.createElement('div');
    row.className = 'history-row';
    row.innerHTML = `
      <div class="history-result">
        <span style="font-size:11px;font-weight:700;color:var(--text-3)">—</span>
      </div>
      <div class="history-info">
        <div class="history-fixture">${fixture.home_team} vs ${fixture.away_team}</div>
        <div class="history-meta">${fixture.league} · ${formatDate(match.created_at)}</div>
      </div>
      <div class="history-picks">${pickNames}</div>
      <div class="history-right">
        <div class="history-pts">${pts} pts</div>
      </div>
    `;
    list.appendChild(row);
  });
}

// ─── Watch ad for coins ───────────────────────────
async function watchAd() {
  toast('Ad played — +50 coins added!', 'ok');
  const newCoins = currentProfile.coins + 50;
  await sb.from('profiles')
    .update({ coins: newCoins })
    .eq('id', currentUser.id);
  currentProfile.coins = newCoins;
  document.getElementById('profile-coins').textContent = newCoins;
  document.getElementById('nav-coin-balance').textContent = newCoins;
}

// ─── Buy coins ────────────────────────────────────
function buyCoins() {
  toast('Coin purchase coming soon', 'inf');
}

// ─── Edit profile ──────────────────────────────────
async function editProfile() {
  const newUsername = prompt('Enter new username:', currentProfile.username);
  if (!newUsername || newUsername === currentProfile.username) return;
  if (newUsername.length < 3) {
    toast('Username must be at least 3 characters', 'err');
    return;
  }

  const { error } = await sb.from('profiles')
    .update({ username: newUsername })
    .eq('id', currentUser.id);

  if (error) {
    toast('Username already taken', 'err');
    return;
  }

  currentProfile.username = newUsername;
  document.getElementById('profile-username').textContent = newUsername;
  document.getElementById('profile-avatar').textContent = newUsername.charAt(0).toUpperCase();
  toast('Username updated!', 'ok');
}

// ─── Sign out ──────────────────────────────────────
async function signOut() {
  await sb.auth.signOut();
  window.location.href = 'login.html';
}

// ─── Format date ──────────────────────────────────
function formatDate(isoString) {
  const date = new Date(isoString);
  const now = new Date();
  const diff = Math.floor((now - date) / (1000 * 60 * 60 * 24));
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return `${diff} days ago`;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// ─── Theme toggle ──────────────────────────────────
function toggleTheme() {
  const html = document.documentElement;
  html.setAttribute('data-theme', html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
}

// ─── Init ──────────────────────────────────────────
initProfile();
