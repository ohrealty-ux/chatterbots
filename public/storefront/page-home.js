import { renderTiers, wireLeadForm } from '/store.js';
document.getElementById('yr').textContent = new Date().getFullYear();
const t = document.getElementById('tiers'); if (t) renderTiers(t);
const f = document.getElementById('leadForm'); if (f) wireLeadForm(f, 'irl');
