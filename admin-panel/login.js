const API = window.location.origin + '/api';

document.getElementById('password').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') doLogin();
});
document.getElementById('email').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') document.getElementById('password').focus();
});
document.getElementById('btn').addEventListener('click', doLogin);

async function doLogin() {
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const err = document.getElementById('err');
  const btn = document.getElementById('btn');

  err.style.display = 'none';
  if (!email || !password) {
    err.textContent = 'Veuillez remplir tous les champs';
    err.style.display = 'block';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Connexion...';

  try {
    const res = await fetch(API + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();

    if (!res.ok || data.user?.role !== 'ADMIN') {
      err.textContent = data.error || 'Accès refusé — compte non administrateur';
      err.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Se connecter';
      return;
    }

    await fetch(API + '/auth/admin-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ token: data.token }),
    });

    window.location.href = window.location.pathname.replace(/\/login\.html$/, '') + '/';
  } catch {
    err.textContent = 'Erreur réseau, réessayez';
    err.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Se connecter';
  }
}
