// Storefront client logic. No secrets, no wallet. Renders tiers/lots, handles waitlist + lead forms.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// mobile nav
const burger = $('.burger');
if (burger) burger.addEventListener('click', () => $('.nav .links')?.classList.toggle('open'));

const fmt = n => n.toLocaleString('en-US');

// waitlist modal (shared)
function ensureModal() {
  let m = $('#wl-modal');
  if (m) return m;
  m = document.createElement('div'); m.className = 'modal'; m.id = 'wl-modal';
  const card = document.createElement('div'); card.className = 'card';
  card.innerHTML = ''; // built with DOM, no untrusted content
  const h = document.createElement('h3'); h.textContent = 'Deeds coming soon';
  const p = document.createElement('p'); p.textContent = 'On-chain deeds and Dogecoin checkout are a later release. Join the waitlist and we’ll email you the moment this lot can be reserved.';
  const lab = document.createElement('label'); lab.textContent = 'Your email';
  const inp = document.createElement('input'); inp.type = 'email'; inp.id = 'wl-email'; inp.placeholder = 'you@example.com';
  const btn = document.createElement('button'); btn.className = 'btn btn-gold'; btn.style.marginTop = '14px'; btn.textContent = 'Join the waitlist';
  const msg = document.createElement('div'); msg.className = 'msg'; msg.id = 'wl-msg';
  const close = document.createElement('a'); close.href = '#'; close.textContent = 'Close'; close.style.cssText = 'display:block;margin-top:14px;color:#9aa0ad';
  close.addEventListener('click', e => { e.preventDefault(); m.classList.remove('show'); });
  card.append(h, p, lab, inp, btn, msg, close);
  m.appendChild(card); document.body.appendChild(m);
  btn.addEventListener('click', async () => {
    const email = inp.value.trim();
    const r = await fetch('/api/waitlist', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, lotId: m.dataset.lot || '', tier: m.dataset.tier || '' }) });
    const j = await r.json();
    msg.textContent = j.ok ? '✓ ' + j.message : (j.error === 'invalid_email' ? 'Please enter a valid email.' : 'Something went wrong.');
    msg.style.color = j.ok ? '#7ddf8f' : '#ffb24a';
  });
  return m;
}
function openWaitlist(lotId, tier) { const m = ensureModal(); m.dataset.lot = lotId || ''; m.dataset.tier = tier || ''; $('#wl-msg').textContent = ''; m.classList.add('show'); }
window.openWaitlist = openWaitlist;

// render tiers (home + lots)
export async function renderTiers(el) {
  const r = await fetch('/api/tiers'); const j = await r.json();
  el.textContent = '';
  for (const t of j.tiers) {
    const card = document.createElement('div'); card.className = 'tier';
    const band = document.createElement('div'); band.className = 'band'; band.style.background = t.color;
    const body = document.createElement('div'); body.className = 'body';
    const h = document.createElement('h3'); h.textContent = t.name;
    const blurb = document.createElement('div'); blurb.className = 's'; blurb.textContent = t.blurb;
    const price = document.createElement('div'); price.className = 'price'; price.textContent = `Ɖ ${fmt(t.pricePerLotDoge)}`;
    const fiatd = document.createElement('div'); fiatd.className = 'fiat'; fiatd.textContent = `≈ $${fmt(t.pricePerLotFiat)} per lot · ${t.lotSizeAcres} acres`;
    const meta = document.createElement('div'); meta.className = 'meta';
    meta.textContent = `${fmt(t.availableLots)} lots available of ${fmt(t.totalLots)} · ${fmt(t.totalAcres)} acres total`
      + (t.reservedAcres ? ` · ${fmt(t.reservedAcres)} ac reserved (${t.reservedName})` : '');
    const btn = document.createElement('a'); btn.className = 'btn btn-ghost'; btn.href = '/lots.html#' + t.id; btn.textContent = 'Browse ' + t.name.split(' ')[0];
    body.append(h, blurb, price, fiatd, meta, btn); card.append(band, body); el.appendChild(card);
  }
}

// render lot grid with filters (lots page)
export async function renderLots(gridEl, filterState) {
  const [lr, tr] = await Promise.all([fetch('/api/lots'), fetch('/api/tiers')]);
  const lots = (await lr.json()).lots; const tiers = (await tr.json()).tiers;
  const tierName = Object.fromEntries(tiers.map(t => [t.id, t.name]));
  function draw() {
    gridEl.textContent = '';
    let list = lots.slice();
    if (filterState.tier) list = list.filter(l => l.tier === filterState.tier);
    if (filterState.avail === 'avail') list = list.filter(l => l.available);
    if (filterState.sort === 'price') list.sort((a, b) => a.priceDoge - b.priceDoge);
    if (filterState.sort === 'acre') list.sort((a, b) => b.acreage - a.acreage);
    if (!list.length) { const d = document.createElement('p'); d.textContent = 'No lots match these filters.'; gridEl.appendChild(d); return; }
    for (const l of list) {
      const c = document.createElement('div'); c.className = 'lot' + (l.available ? ' avail' : '') + (l.reserved ? ' reserved' : '');
      const h = document.createElement('h4'); h.textContent = l.label;
      const tn = document.createElement('div'); tn.className = 's'; tn.textContent = tierName[l.tier] || l.tier;
      const p = document.createElement('div'); p.className = 'p'; p.textContent = l.reserved ? 'Reserved — not for sale' : `Ɖ ${fmt(l.priceDoge)}`;
      const f = document.createElement('div'); f.className = 's'; f.textContent = l.reserved ? 'IvyRealty.Ai flagship' : `≈ $${fmt(l.priceFiat)} · ${l.acreage} acres`;
      c.append(h, tn, p, f);
      if (!l.reserved) {
        const b = document.createElement('button'); b.className = 'btn ' + (l.available ? 'btn-gold' : 'btn-ghost');
        b.textContent = l.available ? 'Buy' : 'Owned';
        if (l.available) b.addEventListener('click', () => openWaitlist(l.id, l.tier)); else b.disabled = true;
        c.appendChild(b);
      }
      gridEl.appendChild(c);
    }
  }
  draw();
  return draw;
}

// generic lead form
export function wireLeadForm(form, kind) {
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const data = { kind,
      name: form.name?.value, email: form.email?.value, phone: form.phone?.value, message: form.message?.value };
    const r = await fetch('/api/lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const j = await r.json();
    const msg = form.querySelector('.msg');
    msg.textContent = j.ok ? '✓ ' + j.message : (j.error === 'invalid_email' ? 'Please enter a valid email.' : 'Something went wrong.');
    msg.style.color = j.ok ? '#7ddf8f' : '#ffb24a';
    if (j.ok) form.reset();
  });
}
