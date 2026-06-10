// ─── Sign In ────────────────────────────────────
async function handleSignIn() {
  const email    = document.getElementById('in-email').value.trim();
  const password = document.getElementById('in-pass').value;

  if (!email || !password) {
    toast('Please fill in all fields', 'err');
    return;
  }

  const btn = document.querySelector('#form-in .btn-primary');
  btn.textContent = 'Signing in...';
  btn.disabled = true;

  const { error } = await sb.auth.signInWithPassword({ email, password });

  if (error) {
    toast(error.message, 'err');
    btn.textContent = 'Sign in';
    btn.disabled = false;
    return;
  }

  window.location.href = 'index.html';
}

// ─── Sign Up ────────────────────────────────────
async function handleSignUp() {
  const username = document.getElementById('up-name').value.trim();
  const email    = document.getElementById('up-email').value.trim();
  const password = document.getElementById('up-pass').value;

  if (!username || !email || !password) {
    toast('Please fill in all fields', 'err');
    return;
  }

  if (username.length < 3) {
    toast('Username must be at least 3 characters', 'err');
    return;
  }

  if (password.length < 8) {
    toast('Password must be at least 8 characters', 'err');
    return;
  }

  // Check username not taken
  const { data: existing } = await sb
    .from('profiles')
    .select('username')
    .eq('username', username)
    .single();

  if (existing) {
    toast('Username already taken', 'err');
    return;
  }

  const btn = document.querySelector('#form-up .btn-primary');
  btn.textContent = 'Creating account...';
  btn.disabled = true;

  const { error } = await sb.auth.signUp({
    email,
    password,
    options: {
      data: { username }
    }
  });

  if (error) {
    toast(error.message, 'err');
    btn.textContent = 'Create account';
    btn.disabled = false;
    return;
  }

  toast('Account created — welcome!', 'ok');
  setTimeout(() => window.location.href = 'index.html', 1000);
}

// ─── Google ─────────────────────────────────────
async function handleGoogle() {
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin + '/index.html'
    }
  });

  if (error) toast(error.message, 'err');
}

// ─── Redirect if already logged in ──────────────
(async () => {
  const user = await getUser();
  if (user) window.location.href = 'index.html';
})();