// Admin console. Session-cookie auth (the __Host-adm cookie is sent automatically with
// credentials:'same-origin'); the per-session CSRF token is held in memory and sent in the
// X-CSRF-Token header on every state-changing request. No password or token is ever stored
// in sessionStorage/localStorage, and nothing is sent via an Authorization header.
// All server/bot/user-supplied strings are rendered with textContent (never innerHTML).
let CSRF = '';
const $ = s => document.querySelector(s);

// GET: cookie only, no CSRF needed.
async function apiGet(path) {
  try { const r = await fetch(path, { credentials: 'same-origin' }); return await r.json(); }
  catch { return { ok: false }; }
}
// State-changing: cookie + JSON content-type + CSRF header. Body is always JSON (even if {}).
async function apiPost(path, body) {
  try {
    const r = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
      body: JSON.stringify(body || {}),
    });
    return await r.json();
  } catch { return { ok: false }; }
}

function showLogin() { $('#panel').style.display = 'none'; $('#login').style.display = 'block'; }
function showPanel() { $('#login').style.display = 'none'; $('#panel').style.display = 'block'; }

let refreshTimer = null;
async function login() {
  const password = $('#pw').value;
  let j;
  try {
    const r = await fetch('/admin/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    j = await r.json();
  } catch { j = { ok: false }; }
  if (j.ok && j.csrf) {
    CSRF = j.csrf;
    $('#pw').value = '';
    $('#loginMsg').textContent = '';
    showPanel();
    await refresh();
    if (!refreshTimer) refreshTimer = setInterval(refresh, 5000);
  } else {
    $('#loginMsg').textContent = 'Wrong password.';
    $('#loginMsg').style.color = '#ffb24a';
  }
}

async function logout() {
  await apiPost('/admin/api/logout');
  CSRF = '';
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  showLogin();
}

async function refresh() {
  const j = await apiGet('/admin/api/state');
  if (j.ok) { if (j.csrf) CSRF = j.csrf; render(j); }
  else { // session expired or not authenticated
    CSRF = '';
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    showLogin();
  }
}

function row(parent, text) {
  const d = document.createElement('div');
  d.className = 'logrow';
  d.textContent = text;
  parent.appendChild(d);
}

function render(j) {
  $('#freezeState').textContent = j.frozen ? 'BOTS FROZEN' : 'bots active';
  $('#freezeBtn').textContent = j.frozen ? 'Unfreeze all bots' : 'Freeze all bots';
  $('#envState').textContent = `Grok brain: ${j.grok ? 'enabled' : 'offline fallback'}`;

  // Pending bots — approve / reject / revoke.
  const pending = $('#pending'); pending.textContent = '';
  const pend = j.pending || [];
  if (!pend.length) { const e = document.createElement('div'); e.className = 's muted'; e.textContent = 'No pending bots.'; pending.appendChild(e); }
  for (const b of pend) {
    const c = document.createElement('div'); c.className = 'lot';
    const h = document.createElement('h4'); h.textContent = b.name; c.appendChild(h);
    const s = document.createElement('div'); s.className = 's';
    const when = b.created_at ? new Date(b.created_at).toLocaleString() : '';
    s.textContent = `${b.id} · ${b.owner || '—'}${when ? ' · ' + when : ''}${b.hasFace ? ' · face' : ''}`;
    c.appendChild(s);
    const mk = (label, fn, cls = 'btn-ghost') => {
      const btn = document.createElement('button'); btn.className = 'btn ' + cls + ' rowbtn';
      btn.textContent = label; btn.addEventListener('click', fn); c.appendChild(btn);
    };
    mk('Approve', async () => { const r = await apiPost(`/admin/api/bot/${b.id}/approve`); if (r.token) prompt('Approved. World pass (copy now, shown once):', r.token); refresh(); }, 'btn-gold');
    mk('Reject', async () => { await apiPost(`/admin/api/bot/${b.id}/reject`); refresh(); });
    mk('Revoke', async () => { await apiPost(`/admin/api/bot/${b.id}/revoke`); refresh(); });
    pending.appendChild(c);
  }

  const bots = $('#bots'); bots.textContent = '';
  for (const b of j.bots) {
    const c = document.createElement('div'); c.className = 'lot';
    const h = document.createElement('h4'); h.textContent = b.name + (b.revoked ? ' (revoked)' : ''); c.appendChild(h);
    const s = document.createElement('div'); s.className = 's'; s.textContent = `${b.id} · ${b.brain} · ${b.status} · tokens today ${b.tokensToday}`; c.appendChild(s);
    const mk = (label, fn, cls = 'btn-ghost') => {
      const btn = document.createElement('button'); btn.className = 'btn ' + cls + ' rowbtn';
      btn.textContent = label; btn.addEventListener('click', fn); c.appendChild(btn);
    };
    mk('Kill', async () => { await apiPost(`/admin/api/bot/${b.id}/kill`); refresh(); });
    mk('Revoke', async () => { await apiPost(`/admin/api/bot/${b.id}/revoke`); refresh(); });
    mk('Rotate token', async () => { const r = await apiPost(`/admin/api/bot/${b.id}/rotate`); if (r.token) prompt('New world pass (copy now):', r.token); });
    mk('Delete', async () => { if (confirm('Delete ' + b.name + '?')) { await apiPost(`/admin/api/bot/${b.id}/delete`); refresh(); } });
    bots.appendChild(c);
  }

  const wl = $('#waitlist'); wl.textContent = ''; (j.waitlist || []).forEach(w => row(wl, `${new Date(w.created_at).toLocaleString()} · ${w.email} · ${w.tier || '-'} · ${w.lot_id || '-'}`));
  const ld = $('#leads'); ld.textContent = ''; (j.leads || []).forEach(l => row(ld, `${new Date(l.created_at).toLocaleString()} · [${l.kind}] ${l.name} · ${l.email} · ${l.phone || ''} · ${l.message || ''}`));
  const au = $('#audit'); au.textContent = ''; (j.audit || []).forEach(a => row(au, `${new Date(a.created_at).toLocaleString()} · ${a.actor} · ${a.action} · ${a.detail || ''}`));
  const mo = $('#mod'); mo.textContent = ''; (j.moderation || []).forEach(m => row(mo, `${new Date(m.created_at).toLocaleString()} · ${m.actor} · ${m.action} · ${m.target || ''}`));
}

$('#loginBtn').addEventListener('click', login);
$('#pw').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
$('#logoutBtn').addEventListener('click', logout);
$('#freezeBtn').addEventListener('click', async () => { const st = await apiGet('/admin/api/state'); await apiPost('/admin/api/freeze', { frozen: !st.frozen }); refresh(); });
$('#demoBtn').addEventListener('click', async () => { const r = await apiPost('/admin/api/demo'); alert(r.message || 'Demo started'); });
$('#createBot').addEventListener('click', async () => {
  const r = await apiPost('/admin/api/bot', { name: $('#nbName').value, owner: $('#nbOwner').value, brain: $('#nbBrain').value });
  if (r.ok) { $('#createMsg').textContent = ''; prompt('Bot created. World pass (copy now, shown once):', r.token); refresh(); }
  else { $('#createMsg').textContent = 'Failed'; }
});

// Resume an existing admin session on load (cookie may still be valid); otherwise show login.
refresh();
