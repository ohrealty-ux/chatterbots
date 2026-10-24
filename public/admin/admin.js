// Admin console. All rendering via textContent (no innerHTML with server data).
let PW = sessionStorage.getItem('ivy_admin_pw') || '';
const $ = s => document.querySelector(s);
const hdr = () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + PW });

async function api(path, method = 'GET', body) {
  const r = await fetch(path, { method, headers: hdr(), body: body ? JSON.stringify(body) : undefined });
  return r.json();
}

async function login() {
  PW = $('#pw').value;
  const j = await api('/admin/api/state');
  if (j.ok) { sessionStorage.setItem('ivy_admin_pw', PW); $('#login').style.display = 'none'; $('#panel').style.display = 'block'; render(j); setInterval(refresh, 5000); }
  else { $('#loginMsg').textContent = 'Wrong password.'; $('#loginMsg').style.color = '#ffb24a'; }
}
async function refresh() { const j = await api('/admin/api/state'); if (j.ok) render(j); }

function row(parent, text) { const d = document.createElement('div'); d.textContent = text; d.style.cssText = 'padding:4px 0;border-bottom:1px solid rgba(255,255,255,.08)'; parent.appendChild(d); }

function render(j) {
  $('#freezeState').textContent = j.frozen ? 'BOTS FROZEN' : 'bots active';
  $('#freezeBtn').textContent = j.frozen ? 'Unfreeze all bots' : 'Freeze all bots';
  $('#envState').textContent = `Grok brain: ${j.grok ? 'enabled' : 'offline fallback'} · Bot Beacons: ${j.beacons ? 'enabled' : 'disabled'}`;
  const bots = $('#bots'); bots.textContent = '';
  for (const b of j.bots) {
    const c = document.createElement('div'); c.className = 'lot';
    const h = document.createElement('h4'); h.textContent = b.name + (b.revoked ? ' (revoked)' : ''); c.appendChild(h);
    const s = document.createElement('div'); s.className = 's'; s.textContent = `${b.id} · ${b.brain} · ${b.status} · tokens today ${b.tokensToday}`; c.appendChild(s);
    const mk = (label, fn, cls = 'btn-ghost') => { const btn = document.createElement('button'); btn.className = 'btn ' + cls; btn.style.cssText = 'margin-top:6px;padding:6px 10px;font-size:.8rem;width:auto;margin-right:6px'; btn.textContent = label; btn.addEventListener('click', fn); c.appendChild(btn); };
    mk('Kill', async () => { await api(`/admin/api/bot/${b.id}/kill`, 'POST'); refresh(); });
    mk('Revoke', async () => { await api(`/admin/api/bot/${b.id}/revoke`, 'POST'); refresh(); });
    mk('Rotate token', async () => { const r = await api(`/admin/api/bot/${b.id}/rotate`, 'POST'); if (r.token) prompt('New token (copy now):', r.token); });
    mk('Delete', async () => { if (confirm('Delete ' + b.name + '?')) { await api(`/admin/api/bot/${b.id}/delete`, 'POST'); refresh(); } }, 'btn-ghost');
    bots.appendChild(c);
  }
  const wl = $('#waitlist'); wl.textContent = ''; (j.waitlist || []).forEach(w => row(wl, `${new Date(w.created_at).toLocaleString()} · ${w.email} · ${w.tier || '-'} · ${w.lot_id || '-'}`));
  const ld = $('#leads'); ld.textContent = ''; (j.leads || []).forEach(l => row(ld, `${new Date(l.created_at).toLocaleString()} · [${l.kind}] ${l.name} · ${l.email} · ${l.phone || ''} · ${l.message || ''}`));
  const au = $('#audit'); au.textContent = ''; (j.audit || []).forEach(a => row(au, `${new Date(a.created_at).toLocaleString()} · ${a.actor} · ${a.action} · ${a.detail || ''}`));
  const mo = $('#mod'); mo.textContent = ''; (j.moderation || []).forEach(m => row(mo, `${new Date(m.created_at).toLocaleString()} · ${m.actor} · ${m.action} · ${m.target || ''}`));
}

$('#loginBtn').addEventListener('click', login);
$('#pw').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
$('#freezeBtn').addEventListener('click', async () => { const st = await api('/admin/api/state'); await api('/admin/api/freeze', 'POST', { frozen: !st.frozen }); refresh(); });
$('#demoBtn').addEventListener('click', async () => { const r = await api('/admin/api/demo', 'POST'); alert(r.message || 'Demo started'); });
$('#createBot').addEventListener('click', async () => {
  const r = await api('/admin/api/bot', 'POST', { name: $('#nbName').value, owner: $('#nbOwner').value, brain: $('#nbBrain').value });
  if (r.ok) { $('#createMsg').textContent = ''; prompt('Bot created. Token (copy now, shown once):', r.token); refresh(); }
  else { $('#createMsg').textContent = 'Failed'; }
});
if (PW) login();
