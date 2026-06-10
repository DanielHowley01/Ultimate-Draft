// ─── Draft page ───────────────────────────────────
let currentUser    = null;
let currentLobby   = null;
let currentFixture = null;
let lobbyPlayers   = [];
let pickedPlayers  = {};
let myPicks        = [];
let isMyTurn       = false;
let pickTimer      = null;
let autoStartTimer = null;
let timeLeft       = 20;
let autoTimeLeft   = 60;
const PICK_TIME    = 20;
const AUTO_START   = 60;
const PICKS_EACH   = 2;

// ─── Init ─────────────────────────────────────────
async function initDraft() {
  currentUser = await requireAuth();

  const params  = new URLSearchParams(window.location.search);
  const lobbyId = params.get('lobby');
  if (!lobbyId) { window.location.href = 'index.html'; return; }

  await loadLobbyAndFixture(lobbyId);
  renderFixtureBar();
  subscribeToLobby(lobbyId);

  if (currentLobby.status === 'drafting' && currentLobby.draft_order?.length > 0) {
    await enterDraftBoard();
  } else {
    enterWaitingRoom();
  }
}

// ─── Load lobby + fixture ──────────────────────────
async function loadLobbyAndFixture(lobbyId) {
  // Don't select ready column — it may not exist yet; handle separately
  const { data: lobby, error } = await sb
    .from('lobbies')
    .select(`*, lobby_players(user_id), fixtures(*)`)
    .eq('id', lobbyId)
    .single();

  if (error || !lobby) {
    console.error('loadLobbyAndFixture error:', error);
    window.location.href = 'index.html';
    return;
  }

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
    lobbyPlayers = rawPlayers.map(p => ({
      user_id:  p.user_id,
      username: nameMap[p.user_id] || 'Player',
      ready:    false
    }));
  } else {
    lobbyPlayers = [];
  }
}

// ════════════════════════════════════════════════════
// WAITING ROOM
// ════════════════════════════════════════════════════

function enterWaitingRoom() {
  document.getElementById('waiting-room').classList.remove('hidden');
  document.getElementById('draft-board').classList.add('hidden');

  const isHost   = currentLobby.host_id === currentUser.id;
  const hostBtn  = document.getElementById('host-start-btn');
  const deleteBtn = document.getElementById('host-delete-btn');
  if (hostBtn)   isHost ? hostBtn.classList.remove('hidden')   : hostBtn.classList.add('hidden');
  if (deleteBtn) isHost ? deleteBtn.classList.remove('hidden') : deleteBtn.classList.add('hidden');

  renderWaitingPlayers();
  startAutoStartCountdown();
}

function renderWaitingPlayers() {
  const container = document.getElementById('waiting-players');
  if (!container) return;

  const allReady = lobbyPlayers.length > 0 && lobbyPlayers.every(p => p.ready);

  container.innerHTML = lobbyPlayers.map(p => {
    const isYou       = p.user_id === currentUser.id;
    const displayName = p.username || (isYou ? 'You' : 'Player');
    const initial     = displayName.charAt(0).toUpperCase();
    return `
      <div class="waiting-player ${p.ready ? 'ready' : ''}">
        <div class="waiting-player-avatar ${isYou ? 'you' : ''}">${initial}</div>
        <span class="waiting-player-name">${displayName}${isYou ? ' (you)' : ''}</span>
        <span class="waiting-player-status">${p.ready ? '✓ Ready' : 'Waiting...'}</span>
      </div>
    `;
  }).join('');

  // Sync ready button
  const myPlayer = lobbyPlayers.find(p => p.user_id === currentUser.id);
  const readyBtn = document.getElementById('ready-btn');
  if (readyBtn && myPlayer?.ready) {
    readyBtn.textContent = '✓ Ready!';
    readyBtn.disabled    = true;
    readyBtn.classList.add('btn-ready-done');
  }

  // Hint text
  const readyCount = lobbyPlayers.filter(p => p.ready).length;
  const hintEl = document.getElementById('waiting-hint');
  if (hintEl) {
    hintEl.textContent = allReady
      ? 'All ready — starting now!'
      : `${readyCount} / ${lobbyPlayers.length} ready`;
  }

  if (allReady) kickOffDraft();
}

async function markReady() {
  const btn = document.getElementById('ready-btn');
  if (btn) { btn.disabled = true; btn.textContent = '✓ Ready!'; btn.classList.add('btn-ready-done'); }

  // Try DB update (may need RLS policy: allow UPDATE where auth.uid() = user_id)
  const { error } = await sb.from('lobby_players')
    .update({ ready: true })
    .eq('lobby_id', currentLobby.id)
    .eq('user_id',  currentUser.id);

  if (error) console.warn('ready update:', error.code, error.message);

  // Update local state regardless
  const me = lobbyPlayers.find(p => p.user_id === currentUser.id);
  if (me) me.ready = true;

  const allReady = lobbyPlayers.every(p => p.ready);
  if (allReady) kickOffDraft();
  else          renderWaitingPlayers();
}

function startAutoStartCountdown() {
  clearInterval(autoStartTimer);
  autoTimeLeft = AUTO_START;
  updateAutoBar();

  autoStartTimer = setInterval(() => {
    autoTimeLeft--;
    updateAutoBar();
    if (autoTimeLeft <= 0) {
      clearInterval(autoStartTimer);
      kickOffDraft();
    }
  }, 1000);
}

function updateAutoBar() {
  const el = document.getElementById('auto-start-countdown');
  const fill = document.getElementById('auto-fill');
  if (el)   el.textContent = autoTimeLeft;
  if (fill) {
    fill.style.width      = (autoTimeLeft / AUTO_START * 100) + '%';
    fill.style.background = autoTimeLeft <= 10 ? 'var(--red)' : autoTimeLeft <= 20 ? 'var(--amber)' : 'var(--accent)';
  }
}

// ─── Delete lobby (host only) ──────────────────────
async function deleteLobby() {
  if (!confirm('Delete this lobby? Entry fees will be refunded.')) return;

  // Refund all players
  const playerIds = lobbyPlayers.map(p => p.user_id);
  const fee       = currentLobby.entry_fee || 0;
  if (fee > 0 && playerIds.length > 0) {
    for (const uid of playerIds) {
      const { data: profile } = await sb.from('profiles').select('coins').eq('id', uid).single();
      if (profile) {
        await sb.from('profiles').update({ coins: profile.coins + fee }).eq('id', uid);
      }
    }
  }

  // Delete lobby_players then lobby
  await sb.from('lobby_players').delete().eq('lobby_id', currentLobby.id);
  await sb.from('lobbies').delete().eq('id', currentLobby.id);

  toast('Lobby deleted — fees refunded', 'ok');
  setTimeout(() => { window.location.href = `lobby.html?fixture=${currentFixture.id}`; }, 1200);
}

// ─── Kick off the draft ────────────────────────────
async function kickOffDraft() {
  clearInterval(autoStartTimer);

  // Re-fetch to avoid race conditions
  const { data: latest } = await sb
    .from('lobbies').select('*').eq('id', currentLobby.id).single();

  if (latest) currentLobby = { ...currentLobby, ...latest };

  if (currentLobby.status === 'drafting' && currentLobby.draft_order?.length > 0) {
    await enterDraftBoard();
    return;
  }

  if (lobbyPlayers.length === 0) { toast('No players in lobby', 'err'); return; }

  const shuffled = [...lobbyPlayers.map(p => p.user_id)].sort(() => Math.random() - 0.5);

  const { data: updated, error } = await sb
    .from('lobbies')
    .update({ status: 'drafting', draft_order: shuffled, current_pick: 0 })
    .eq('id', currentLobby.id)
    .select().single();

  if (error) { console.error('kickOffDraft:', error); toast('Failed to start draft', 'err'); return; }
  if (updated) currentLobby = { ...currentLobby, ...updated };

  await enterDraftBoard();
}

// ════════════════════════════════════════════════════
// DRAFT BOARD
// ════════════════════════════════════════════════════

async function enterDraftBoard() {
  clearInterval(autoStartTimer);
  document.getElementById('waiting-room').classList.add('hidden');
  document.getElementById('draft-board').classList.remove('hidden');

  await loadExistingPicks();
  renderPlayerPool();
  renderDraftOrder();
  updateTurnUI();
}

async function loadExistingPicks() {
  const { data: picks } = await sb
    .from('picks').select('player_name, user_id').eq('lobby_id', currentLobby.id);

  (picks || []).forEach(p => {
    const picker = lobbyPlayers.find(lp => lp.user_id === p.user_id);
    pickedPlayers[p.player_name] = picker?.username || 'Taken';
    if (p.user_id === currentUser.id && !myPicks.includes(p.player_name)) {
      myPicks.push(p.player_name);
    }
  });
  myPicks.forEach((name, i) => fillPickSlot(i + 1, name));
}

function renderPlayerPool() {
  const pool = document.getElementById('draft-pool');
  const f    = currentFixture;
  const homePlayers = getSquad(f, 'home');
  const awayPlayers = getSquad(f, 'away');

  pool.innerHTML = `
    <div class="draft-team-col">
      <div class="draft-team-header home-header">
        <span class="draft-team-label">${f.home_team}</span>
        <span class="draft-team-count">${homePlayers.length} players</span>
      </div>
      <div class="draft-players" id="home-players">
        ${homePlayers.map(p => playerCardHTML(p)).join('')}
      </div>
    </div>
    <div class="draft-team-col">
      <div class="draft-team-header away-header">
        <span class="draft-team-label">${f.away_team}</span>
        <span class="draft-team-count">${awayPlayers.length} players</span>
      </div>
      <div class="draft-players" id="away-players">
        ${awayPlayers.map(p => playerCardHTML(p)).join('')}
      </div>
    </div>
  `;

  Object.keys(pickedPlayers).forEach(name => markPicked(name, pickedPlayers[name]));
}

function getSquad(fixture, side) {
  const key = side === 'home' ? 'home_squad' : 'away_squad';
  if (fixture[key] && Array.isArray(fixture[key]) && fixture[key].length > 0) return fixture[key];
  const team = side === 'home' ? fixture.home_team : fixture.away_team;
  return Array.from({ length: 8 }, (_, i) => ({
    name: `${team} P${i + 1}`,
    pos:  ['GK','DEF','DEF','DEF','MID','MID','FWD','FWD'][i]
  }));
}

function playerCardHTML(p) {
  const safe = p.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
  return `
    <div class="player-card" data-name="${p.name.replace(/"/g,'&quot;')}" onclick="onPlayerClick('${safe}')">
      <div class="player-card-pos ${p.pos.toLowerCase()}">${p.pos}</div>
      <div class="player-card-name">${p.name}</div>
      <div class="player-card-pick"></div>
    </div>
  `;
}

function renderDraftOrder() {
  const list        = document.getElementById('draft-order-list');
  const order       = currentLobby.draft_order || lobbyPlayers.map(p => p.user_id);
  const pickNo      = currentLobby.current_pick ?? 0;
  const activeIndex = pickNo % Math.max(order.length, 1);

  list.innerHTML = order.map((uid, i) => {
    const player = lobbyPlayers.find(p => p.user_id === uid);
    const name   = player?.username || '?';
    const isYou  = uid === currentUser.id;
    return `
      <div class="draft-order-item ${i === activeIndex ? 'active' : ''}">
        <div class="draft-order-avatar ${isYou ? 'you' : ''}">${name.charAt(0).toUpperCase()}</div>
        <span class="draft-order-name">${name}</span>
        <span class="draft-order-pick">P${i + 1}</span>
      </div>
    `;
  }).join('');
}

function updateTurnUI() {
  const order      = currentLobby.draft_order || lobbyPlayers.map(p => p.user_id);
  const pickNo     = currentLobby.current_pick ?? 0;
  const totalPicks = order.length * PICKS_EACH;

  if (order.length === 0) return;

  if (pickNo >= totalPicks) {
    stopPickTimer();
    document.getElementById('turn-name').textContent = 'Draft complete!';
    document.getElementById('turn-sub').textContent  = 'Heading to match...';
    document.getElementById('countdown').textContent = '✓';
    sb.from('lobbies').update({ status: 'active' }).eq('id', currentLobby.id);
    setTimeout(() => { window.location.href = `match.html?lobby=${currentLobby.id}`; }, 2000);
    return;
  }

  const round       = Math.floor(pickNo / order.length) + 1;
  const pickInRound = (pickNo % order.length) + 1;
  const currentUid  = order[pickNo % order.length];
  const picker      = lobbyPlayers.find(p => p.user_id === currentUid);
  const name        = picker?.username || '?';

  isMyTurn = currentUid === currentUser.id;

  document.getElementById('turn-avatar').textContent       = name.charAt(0).toUpperCase();
  document.getElementById('turn-name').textContent         = isMyTurn ? '⚡ Your turn — pick a player!' : `${name} is picking`;
  document.getElementById('turn-sub').textContent          = `Round ${round}, Pick ${pickInRound} of ${totalPicks}`;
  document.getElementById('turn-avatar').style.borderColor = isMyTurn ? 'var(--accent)' : 'var(--border)';
  document.getElementById('turn-avatar').style.color       = isMyTurn ? 'var(--accent)' : 'var(--text-2)';
  document.getElementById('turn-avatar').style.background  = isMyTurn ? 'var(--accent-dim)' : 'var(--bg-3)';

  document.querySelectorAll('.player-card:not(.picked)').forEach(c => {
    c.style.pointerEvents = isMyTurn ? 'auto' : 'none';
    c.style.opacity       = isMyTurn ? '1' : '0.45';
  });

  if (isMyTurn) startPickTimer(); else stopPickTimer();
  renderDraftOrder();
}

async function onPlayerClick(name) {
  if (!isMyTurn)            { toast('Wait for your turn', 'err'); return; }
  if (pickedPlayers[name])  { toast('Already picked', 'err');     return; }
  if (myPicks.length >= PICKS_EACH) return;

  isMyTurn = false;
  stopPickTimer();
  markPicked(name, 'You');
  myPicks.push(name);
  fillPickSlot(myPicks.length, name);
  await submitPick(name);
}

async function submitPick(playerName) {
  const allPlayers = [
    ...(currentFixture.home_squad || []).map(p => ({ ...p, team: currentFixture.home_team })),
    ...(currentFixture.away_squad || []).map(p => ({ ...p, team: currentFixture.away_team }))
  ];
  const playerData = allPlayers.find(p => p.name === playerName);
  const pickNumber = (currentLobby.current_pick ?? 0) + 1;

  const { error } = await sb.from('picks').insert({
    lobby_id:    currentLobby.id,
    user_id:     currentUser.id,
    fixture_id:  currentFixture.id,
    player_name: playerName,
    player_team: playerData?.team || '',
    position:    playerData?.pos  || 'MID',
    pick_number: pickNumber,
    points:      0
  });

  if (error) {
    console.error('submitPick:', error);
    toast('Failed to submit pick — try again', 'err');
    myPicks.pop(); delete pickedPlayers[playerName];
    renderPlayerPool(); isMyTurn = true; startPickTimer();
    return;
  }

  const nextPick = (currentLobby.current_pick ?? 0) + 1;
  await sb.from('lobbies').update({ current_pick: nextPick }).eq('id', currentLobby.id);
}

function markPicked(name, pickerUsername) {
  pickedPlayers[name] = pickerUsername;
  const card = document.querySelector(`.player-card[data-name="${name.replace(/"/g,'&quot;')}"]`);
  if (!card) return;
  card.classList.add('picked');
  card.style.pointerEvents = 'none';
  card.style.opacity = '0.45';
  card.querySelector('.player-card-pick').textContent = (pickerUsername || '✓').substring(0, 6);
}

function fillPickSlot(slotNum, name) {
  const slot = document.getElementById('pick-slot-' + slotNum);
  if (!slot) return;
  slot.classList.remove('empty'); slot.classList.add('filled');
  slot.querySelector('.your-pick-slot-name').textContent = name;
}

function startPickTimer() {
  stopPickTimer();
  timeLeft = PICK_TIME;
  updatePickTimerUI();
  pickTimer = setInterval(() => {
    timeLeft--;
    updatePickTimerUI();
    if (timeLeft <= 0) { stopPickTimer(); autoPickRandom(); }
  }, 1000);
}

function stopPickTimer() { clearInterval(pickTimer); pickTimer = null; }

function updatePickTimerUI() {
  document.getElementById('countdown').textContent = timeLeft;
  const fill = document.getElementById('timer-fill');
  fill.style.width      = (timeLeft / PICK_TIME * 100) + '%';
  fill.style.background = timeLeft <= 5 ? 'var(--red)' : timeLeft <= 10 ? 'var(--amber)' : 'var(--accent)';
  document.getElementById('countdown').style.color = timeLeft <= 5 ? 'var(--red)' : 'var(--accent)';
}

function autoPickRandom() {
  const available = [...document.querySelectorAll('.player-card:not(.picked)')];
  if (available.length > 0)
    onPlayerClick(available[Math.floor(Math.random() * available.length)].dataset.name);
}

function subscribeToLobby(lobbyId) {
  sb.channel('draft-' + lobbyId)
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'lobbies', filter: `id=eq.${lobbyId}`
    }, async (payload) => {
      const wasWaiting = currentLobby.status !== 'drafting';
      currentLobby = { ...currentLobby, ...payload.new };
      if (wasWaiting && payload.new.status === 'drafting') {
        await enterDraftBoard();
      } else if (document.getElementById('draft-board') && !document.getElementById('draft-board').classList.contains('hidden')) {
        updateTurnUI();
      }
    })
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'picks', filter: `lobby_id=eq.${lobbyId}`
    }, (payload) => {
      const p = payload.new;
      const picker = lobbyPlayers.find(lp => lp.user_id === p.user_id);
      markPicked(p.player_name, picker?.username || 'Taken');
      if (p.user_id === currentUser.id && !myPicks.includes(p.player_name)) {
        myPicks.push(p.player_name);
        fillPickSlot(myPicks.length, p.player_name);
      }
    })
    .subscribe();
}

function renderFixtureBar() {
  const f = currentFixture;
  document.querySelectorAll('.dfb-name-home').forEach(el => el.textContent = f.home_team);
  document.querySelectorAll('.dfb-name-away').forEach(el => el.textContent = f.away_team);
  document.querySelectorAll('.dfb-abbr-home').forEach(el => el.textContent = f.home_abbr);
  document.querySelectorAll('.dfb-abbr-away').forEach(el => el.textContent = f.away_abbr);
  const scoreEl = document.getElementById('dfb-score');
  const timeEl  = document.getElementById('dfb-time');
  const badgeEl = document.getElementById('dfb-badge');
  if (f.status === 'live') {
    scoreEl.textContent = `${f.home_score} — ${f.away_score}`;
    timeEl.textContent  = `${f.minute}'`;
    timeEl.classList.add('live-pulse');
    badgeEl.className = 'badge badge-live'; badgeEl.textContent = 'Live';
  } else if (f.status === 'ft') {
    scoreEl.textContent = `${f.home_score} — ${f.away_score}`;
    timeEl.textContent  = 'FT';
    badgeEl.className   = 'badge badge-soon'; badgeEl.textContent = 'FT';
  } else {
    scoreEl.textContent = 'vs';
    timeEl.textContent  = formatKickOff(f.kick_off);
    badgeEl.className   = 'badge badge-soon'; badgeEl.textContent = 'Soon';
  }
}

function formatKickOff(iso) {
  if (!iso) return 'TBC';
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function toggleTheme() {
  const html = document.documentElement;
  html.setAttribute('data-theme', html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
}

initDraft();
