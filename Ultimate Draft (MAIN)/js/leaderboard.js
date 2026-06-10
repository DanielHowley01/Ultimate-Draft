// ─── Leaderboard page ────────────────────────────
let currentPeriod = 'week';
let currentUserId = null;

async function initLeaderboard() {
  const user = await requireAuth();
  currentUserId = user.id;

  // Update nav coin balance from profile
  const { data: profile } = await sb
    .from('profiles')
    .select('coins')
    .eq('id', user.id)
    .single();
  if (profile) {
    document.getElementById('nav-coin-balance').textContent = profile.coins;
  }

  await loadLeaderboard('week');
}

// ─── Load leaderboard ────────────────────────────
async function loadLeaderboard(period) {
  const podiumEl = document.getElementById('lb-podium');
  const listEl   = document.getElementById('lb-list');

  podiumEl.innerHTML = `<div class="loading-fixtures"><div class="spinner"></div></div>`;
  listEl.innerHTML   = '';

  // Build date filter
  let fromDate = null;
  const now = new Date();
  if (period === 'week') {
    fromDate = new Date(now);
    fromDate.setDate(now.getDate() - 7);
  } else if (period === 'month') {
    fromDate = new Date(now);
    fromDate.setMonth(now.getMonth() - 1);
  }

  // Fetch profiles ordered by net_coins desc
  let query = sb
    .from('profiles')
    .select('id, username, coins, matches_played, wins, net_coins')
    .order('net_coins', { ascending: false })
    .limit(50);

  // Note: weekly/monthly filtering would ideally come from a
  // leaderboard_snapshots table. For now all periods show net_coins ranking.
  const { data: rows, error } = await query;

  if (error) {
    podiumEl.innerHTML = '';
    listEl.innerHTML = `<div class="empty">Failed to load leaderboard (${error.code}).</div>`;
    console.error('loadLeaderboard error:', error);
    return;
  }

  if (!rows || rows.length === 0) {
    podiumEl.innerHTML = '';
    listEl.innerHTML = `<div class="empty">No players yet — be the first to play!</div>`;
    return;
  }

  renderPodium(rows.slice(0, 3));
  renderList(rows);
}

// ─── Render podium (top 3) ───────────────────────
function renderPodium(top3) {
  const podiumEl = document.getElementById('lb-podium');

  // Order: 2nd, 1st, 3rd for visual layout
  const order = [top3[1], top3[0], top3[2]].filter(Boolean);
  const positions = top3[1] ? ['second', 'first', 'third'] : ['first'];

  podiumEl.innerHTML = order.map((p, i) => {
    const pos = positions[i];
    const isFirst = pos === 'first';
    const initial = p.username.charAt(0).toUpperCase();
    return `
      <div class="podium-item ${pos}">
        ${isFirst ? `<div class="podium-crown">🏆</div>` : ''}
        <div class="podium-avatar ${isFirst ? 'gold' : ''}">${initial}</div>
        <div class="podium-name">${escHtml(p.username)}</div>
        <div class="podium-stat"><span class="coin">${p.net_coins?.toLocaleString() ?? 0}</span></div>
        <div class="podium-base ${pos}">${pos === 'first' ? 1 : pos === 'second' ? 2 : 3}</div>
      </div>
    `;
  }).join('');
}

// ─── Render full list ────────────────────────────
function renderList(rows) {
  const listEl = document.getElementById('lb-list');

  listEl.innerHTML = rows.map((p, i) => {
    const rank     = i + 1;
    const isYou    = p.id === currentUserId;
    const initial  = p.username.charAt(0).toUpperCase();
    const winRate  = p.matches_played > 0
      ? Math.round((p.wins / p.matches_played) * 100) + '%'
      : '—';

    const rankClass = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '';
    const rowClass  = isYou ? 'lb-row you' : rank <= 3 ? 'lb-row top3' : 'lb-row';
    const avatarClass = isYou ? 'lb-avatar you' : rank === 1 ? 'lb-avatar gold' : 'lb-avatar';

    return `
      <div class="${rowClass}">
        <div class="lb-rank ${rankClass}">${rank}</div>
        <div class="${avatarClass}">${initial}</div>
        <div class="lb-info">
          <span class="lb-name">${escHtml(p.username)}${isYou ? ' <span class="you-tag">You</span>' : ''}</span>
          <span class="lb-meta">${p.matches_played ?? 0} matches · ${p.wins ?? 0} wins</span>
        </div>
        <div class="lb-right">
          <div class="lb-winrate">${winRate}</div>
          <div class="lb-coins"><span class="coin">${p.net_coins?.toLocaleString() ?? 0}</span></div>
        </div>
      </div>
    `;
  }).join('');
}

// ─── Period switch ───────────────────────────────
function switchPeriod(period, btn) {
  document.querySelectorAll('.lb-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentPeriod = period;

  const labels = { week: 'Top managers this week', month: 'Top managers this month', all: 'All-time rankings' };
  document.getElementById('lb-sub').textContent = labels[period];

  loadLeaderboard(period);
}

// ─── Theme toggle ────────────────────────────────
function toggleTheme() {
  const html = document.documentElement;
  html.setAttribute('data-theme', html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
}

// ─── Escape HTML ─────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Init ────────────────────────────────────────
initLeaderboard();
