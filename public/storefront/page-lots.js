import { renderLots, renderTiers } from '/store.js';
document.getElementById('yr').textContent = new Date().getFullYear();
const tiersEl = document.getElementById('tiers'); if (tiersEl) renderTiers(tiersEl);
const state = { tier: location.hash.slice(1) || '', avail: '', sort: '' };
const grid = document.getElementById('lotgrid');
renderLots(grid, state).then(draw => {
  const ts = document.getElementById('f-tier'); if (state.tier) ts.value = state.tier;
  ts.addEventListener('change', () => { state.tier = ts.value; draw(); });
  document.getElementById('f-avail').addEventListener('change', e => { state.avail = e.target.value; draw(); });
  document.getElementById('f-sort').addEventListener('change', e => { state.sort = e.target.value; draw(); });
});
