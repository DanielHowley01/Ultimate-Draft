// ─── Lobby page ──────────────────────────────────
let currentFixture = null;
let currentUser    = null;
let selectedStake  = 50;

async function initLobby() {
  currentUser = await requireAuth();

  const params    = new URLSearchParams(window.location.search);
  const fixtureId = params.get('fixture');
  if (!fixtureId) { window.location.href = 'index.html'; return; }

  await loadFixture(fixtureId);
  await loadLobbies(fixtureId);
  await loadCoinBalance();
  subscribeToLobbies(fixtureId);
}

// ─── Load coin balance ────────────────────────────
async function loadCoinBalance() {
  const { data: profile } = await sb
    .from('profiles').select('coins').eq('id', currentUser.id).single();
  if (profile) {
    document.getElementById('nav-coin-balance').textContent = profile.coins;
    document.getElementById('modal-coin-balance').textContent = profile.coins;
  }
}

// ─── Load fixture ─────────────────────────────────
async function loadFixture(fixtureId) {
  const { data: fixture, error } = await sb
    .from('fixtures').select('*').eq('id', fixtureId).single();

  if (error || !fixture) { window.location.href = 'index.html'; return; }
  currentFixture = fixture;

  document.querySelector('.fh-team-name-home').textContent  = fixture.home_team;
  document.querySelector('.fh-team-name-away').textContent  = fixture.away_team;
  document.querySelector('.fh-team-badge-home').textContent = fixture.home_abbr;
  document.querySelector('.fh-team-badge-away').textContent = fixture.away_abbr;
  document.querySelector('.fh-league-name').textContent     = fixture.league;
  document.querySelector('.modal-fixture-name').textContent =
    `${fixture.home_team} vs ${fixture.away_team}`;

  // Hide new lobby button if fixture is over
  if (fixture.status === 'ft') {
    const newBtn = document.querySelector('.section-header .btn-primary');
    if (newBtn) { newBtn.disabled = true; newBtn.textContent = 'Fixture ended'; newBtn.style.opacity = '0.4'; }
  }

  const badge = document.querySelector('.fixture-header-league .badge');
  if (fixture.status === 'live') {
    document.querySelector('.fh-score').textContent = `${fixture.home_score} — ${fixture.away_score}`;
    document.querySelector('.fh-time').textContent  = `${fixture.minute}'`;
    document.querySelector('.fh-time').classList.add('live-pulse');
    badge.className   = 'badge badge-live';
    badge.textContent = 'Live';
  } else if (fixture.status === 'ft') {
    document.querySelector('.fh-score').textContent = `${fixture.home_score} — ${fixture.away_score}`;
    document.querySelector('.fh-time').textContent  = 'FT';
    badge.className   = 'badge badge-soon';
    badge.textContent = 'FT';
  } else {
    document.querySelector('.fh-score').textContent = 'vs';
    document.querySelector('.fh-time').textContent  = formatKickOff(fixture.kick_off);
    badge.className   = 'badge badge-soon';
    badge.textContent = 'Soon';
  }
}

// ─── Load lobbies ─────────────────────────────────
async function loadLobbies(fixtureId) {
  const { data: lobbies, error } = await sb
    .from('lobbies')
    .select(`*, lobby_players(user_id)`)
    .eq('fixture_id', fixtureId)
    .in('status', ['waiting', 'drafting'])
    .order('created_at', { ascending: true });

  if (error) { toast('Failed to load lobbies', 'err'); return; }
  renderLobbies(lobbies || []);
}

// ─── Render lobbies ───────────────────────────────
function renderLobbies(lobbies) {
  const list = document.getElementById('lobbies-list');
  list.innerHTML = '';

  if (lobbies.length === 0) {
    list.innerHTML = `<div class="empty">No open lobbies — create the first one!</div>`;
    return;
  }

  lobbies.forEach((lobby, index) => {
    const players   = lobby.lobby_players || [];
    const spots     = 6 - players.length;
    const isFull    = spots === 0;
    const isInLobby = players.some(p => p.user_id === currentUser.id);
    const isHost    = lobby.host_id === currentUser.id;

    const card = document.createElement('div');
    card.className = `lobby-card${isFull ? ' full' : ''}${isInLobby ? ' in-lobby' : ''}`;

    const slots = Array.from({ length: 6 }, (_, i) =>
      `<div class="slot ${i < players.length ? 'filled' : 'empty'}"></div>`
    ).join('');

    // Right side content depends on state
    let rightContent;
    if (isInLobby) {
      if (lobby.status === 'drafting') {
        rightContent = `
          <a href="draft.html?lobby=${lobby.id}" class="btn btn-primary btn-sm">Rejoin draft</a>`;
      } else if (isHost) {
        rightContent = `
          <button class="btn btn-primary btn-sm" onclick="hostStartDraft('${lobby.id}', event)">Start game</button>
          <div class="lobby-spots">You're the host</div>`;
      } else {
        rightContent = `
          <div class="lobby-spots you-badge">✓ You're in</div>
          <div class="lobby-spots">Waiting for host...</div>`;
      }
    } else if (isFull) {
      rightContent = `<span class="badge badge-full">Full</span>`;
    } else {
      rightContent = `
        <div class="lobby-stake"><span class="coin">${lobby.entry_fee}</span></div>
        <div class="lobby-spots">${spots} spot${spots !== 1 ? 's' : ''} left</div>
        <span class="badge badge-open">Open</span>`;
    }

    card.innerHTML = `
      <div class="lobby-card-left">
        <div class="lobby-number">#${index + 1}</div>
        <div class="lobby-info">
          <div class="lobby-host">${isHost ? '<strong>Your lobby</strong>' : `<span class="coin" style="font-size:13px">${lobby.entry_fee}</span>`}</div>
          <div class="lobby-slots">${slots}</div>
        </div>
      </div>
      <div class="lobby-card-right">${rightContent}</div>
    `;

    // Click to join (only if not already in and not full)
    if (!isInLobby && !isFull) {
      card.style.cursor = 'pointer';
      card.addEventListener('click', (e) => {
        if (!e.target.closest('button') && !e.target.closest('a')) joinLobby(lobby.id);
      });
    }

    list.appendChild(card);
  });
}

// ─── Host: start game immediately ─────────────────
async function hostStartDraft(lobbyId, e) {
  e.stopPropagation();
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = 'Starting...';

  const { data: lobby } = await sb
    .from('lobbies')
    .select('*, lobby_players(user_id)')
    .eq('id', lobbyId)
    .single();

  if (!lobby) { toast('Lobby not found', 'err'); btn.disabled = false; return; }

  const playerIds = lobby.lobby_players.map(p => p.user_id);
  const shuffled  = [...playerIds].sort(() => Math.random() - 0.5);

  await sb.from('lobbies').update({
    status: 'drafting',
    draft_order: shuffled,
    current_pick: 0
  }).eq('id', lobbyId);

  window.location.href = `draft.html?lobby=${lobbyId}`;
}

// ─── Join lobby ───────────────────────────────────
async function joinLobby(lobbyId) {
  const { data: profile } = await sb
    .from('profiles').select('coins').eq('id', currentUser.id).single();

  const { data: lobby } = await sb
    .from('lobbies').select('*, lobby_players(user_id)').eq('id', lobbyId).single();

  if (!lobby)                              { toast('Lobby not found', 'err');    return; }
  if (lobby.lobby_players.length >= 6)     { toast('Lobby is full', 'err');      return; }
  if (profile.coins < lobby.entry_fee)     { toast('Not enough coins', 'err');   return; }

  const already = lobby.lobby_players.some(p => p.user_id === currentUser.id);
  if (already) { window.location.href = `draft.html?lobby=${lobbyId}`; return; }

  // Deduct coins
  const { error: deductErr } = await sb.from('profiles')
    .update({ coins: profile.coins - lobby.entry_fee }).eq('id', currentUser.id);
  if (deductErr) { toast('Failed to deduct coins', 'err'); return; }

  // Insert player — no username column
  const { error } = await sb.from('lobby_players').insert({
    lobby_id: lobbyId,
    user_id:  currentUser.id
  });

  if (error) {
    await sb.from('profiles').update({ coins: profile.coins }).eq('id', currentUser.id);
    toast('Failed to join lobby', 'err');
    return;
  }

  await sb.from('lobbies')
    .update({ player_count: lobby.lobby_players.length + 1 }).eq('id', lobbyId);

  toast('Joined lobby!', 'ok');
  window.location.href = `draft.html?lobby=${lobbyId}`;
}

// ─── Create lobby ──────────────────────────────────
async function createLobby() {
  const { data: profile } = await sb
    .from('profiles').select('coins').eq('id', currentUser.id).single();

  if (profile.coins < selectedStake) { toast('Not enough coins', 'err'); return; }

  const btn = document.querySelector('.modal-footer .btn-primary');
  btn.textContent = 'Creating...';
  btn.disabled    = true;

  await sb.from('profiles')
    .update({ coins: profile.coins - selectedStake }).eq('id', currentUser.id);

  const { data: lobby, error } = await sb.from('lobbies').insert({
    fixture_id:   currentFixture.id,
    host_id:      currentUser.id,
    entry_fee:    selectedStake,
    status:       'waiting',
    player_count: 1
  }).select().single();

  if (error) {
    await sb.from('profiles').update({ coins: profile.coins }).eq('id', currentUser.id);
    toast('Failed to create lobby', 'err');
    btn.textContent = 'Create & join';
    btn.disabled    = false;
    return;
  }

  // Join own lobby — no username column
  await sb.from('lobby_players').insert({
    lobby_id: lobby.id,
    user_id:  currentUser.id
  });

  toast('Lobby created!', 'ok');
  hideCreateModal();
  window.location.href = `draft.html?lobby=${lobby.id}`;
}

// ─── Stake selector ────────────────────────────────
function selectStake(btn, amount) {
  document.querySelectorAll('.stake-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  selectedStake = amount;
  const pot = amount * 6;
  document.getElementById('payout-1st').textContent = Math.round(pot * 0.8);
  document.getElementById('payout-2nd').textContent = Math.round(pot * 0.2);
}

// ─── Modal ─────────────────────────────────────────
function showCreateModal() {
  document.getElementById('create-modal').classList.remove('hidden');
}

function hideCreateModal(e) {
  if (!e || e.target.id === 'create-modal' || e.target.classList.contains('modal-close')) {
    document.getElementById('create-modal').classList.add('hidden');
    const btn = document.querySelector('.modal-footer .btn-primary');
    btn.textContent = 'Create & join';
    btn.disabled    = false;
  }
}

// ─── Realtime ──────────────────────────────────────
function subscribeToLobbies(fixtureId) {
  sb.channel('lobbies-' + fixtureId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'lobbies',
      filter: `fixture_id=eq.${fixtureId}` }, () => loadLobbies(fixtureId))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'lobby_players' },
      () => loadLobbies(fixtureId))
    .subscribe();
}

// ─── Helpers ───────────────────────────────────────
function formatKickOff(isoString) {
  if (!isoString) return 'TBC';
  return new Date(isoString).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function toggleTheme() {
  const html = document.documentElement;
  html.setAttribute('data-theme', html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
}

initLobby();
