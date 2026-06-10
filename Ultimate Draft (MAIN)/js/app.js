// ─── Supabase config ───────────────────────────
const SUPABASE_URL = 'https://bpjvjznbueeqigpfsakh.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJwanZqem5idWVlcWlncGZzYWtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4NjAwMTEsImV4cCI6MjA5NjQzNjAxMX0.bUzdKiK9kzxd-cjm5yQiWuGf7cb78vH8bW0ZfbGoa_Y';

const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storageKey: 'ultimatedraftlive_auth',
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true
  }
});

// ─── Theme ─────────────────────────────────────
function toggleTheme() {
  const html = document.documentElement;
  const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
}

function loadTheme() {
  const saved = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
}

loadTheme();

// ─── Auth helpers ───────────────────────────────
async function getUser() {
  const { data: { user } } = await sb.auth.getUser();
  return user;
}

async function requireAuth() {
  const user = await getUser();
  if (!user) window.location.href = 'login.html';
  return user;
}

// ─── Coin helpers ───────────────────────────────
async function getCoins(userId) {
  const { data } = await sb.from('profiles')
    .select('coins')
    .eq('id', userId)
    .single();
  return data?.coins ?? 0;
}

async function updateCoins(userId, amount) {
  const current = await getCoins(userId);
  const { error } = await sb.from('profiles')
    .update({ coins: current + amount })
    .eq('id', userId);
  return !error;
}

// ─── Toast ──────────────────────────────────────
function toast(msg, type = 'ok') {
  let container = document.querySelector('.toasts');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toasts';
    document.body.appendChild(container);
  }
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  container.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ─── Nav coin balance ────────────────────────────
async function loadNavCoins() {
  const user = await getUser();
  if (!user) return;
  const { data: profile } = await sb
    .from('profiles')
    .select('coins, username')
    .eq('id', user.id)
    .single();
  const el = document.getElementById('nav-coin-balance');
  if (el && profile) el.textContent = profile.coins;
}