/* Chatter Bots — meeting-prep page. Reads ?m=<id>, loads/saves per-party prep,
   renders a clean agenda summary, and shares the /meet link. No framework; DOM only. */
(function () {
  'use strict';

  // Field schema shared by both parties. `ta` = multi-line textarea.
  var FIELDS = [
    { k: 'name',       label: 'Your name / bot name',               help: 'Who is coming — and your bot\'s name.', ph: 'e.g. Ada — "Ada\'s Agent"' },
    { k: 'goals',      label: 'What are your goals for this meeting?', ta: true, help: 'The outcomes you want from the conversation.', ph: 'e.g. Find a supplier partnership that cuts our lead time.' },
    { k: 'objectives', label: 'Ranked objectives',                  ta: true, help: 'List what matters most first, then next. Your bot works down the list.', ph: 'e.g. 1) Cut lead time under 2 weeks  2) Keep unit price flat  3) Lock a 12-month term' },
    { k: 'files',      label: 'Files your bot can use',              ta: true, help: 'Paste links / URLs / notes describing references. (No uploads — a references list is enough.)', ph: 'e.g. https://… spec doc, pricing sheet URL, notes…' },
    { k: 'accomplish', label: 'What are you hoping to accomplish?',  ta: true, help: 'The concrete result you\'d call a win.', ph: 'e.g. A shortlist of 3 options with trade-offs.' },
    { k: 'walkaway',   label: 'Walk-away limits',                   ta: true, help: 'The lines your bot must not cross — where it should stop and walk away.', ph: 'e.g. No commitment over $5k; no exclusivity; must keep our data private.' },
    { k: 'ideas',      label: 'Ideas to present — and how',          ta: true, help: 'What you want to put forward, plus research / format preference.', ph: 'e.g. Present 2 pricing models as a short comparison table.' },
    { k: 'reportFormat', label: 'Report format',                    ta: true, help: 'How you\'d like your bot\'s report back to you laid out.', ph: 'e.g. Short summary, then a table of options with pros/cons and one recommendation.' },
    { k: 'notes',      label: 'Meetup notes',                        ta: true, help: 'Any basic notes to guide the bots.', ph: 'e.g. Keep it to 15 min; focus on logistics first.' }
  ];

  // Authority level the bot is granted — a single-choice control, not a free-text field.
  var AUTHORITY_OPTS = [
    { v: 'advise',    label: 'Advise only — recommend, commit to nothing' },
    { v: 'negotiate', label: 'Negotiate — shape terms, bring back before agreeing' },
    { v: 'commit',    label: 'May commit — can agree within my limits' }
  ];
  // Meeting locations — two live choices, each with a short attire helper line.
  var OFFICE_LOC = 'Prestigious business office';
  var LAKE_LOC = 'Lakeside bench';
  var LOCATION_OPTS = [
    { v: LAKE_LOC,   label: 'Lakeside bench',            help: 'Come as you are.' },
    { v: OFFICE_LOC, label: 'Prestigious business office', help: 'Formal attire recommended, not required.' }
  ];
  // Money / negotiation intake lists — shown only when the office is chosen. All optional.
  var DEAL_TYPES = [
    { v: 'buy_sell',      label: 'Buy or sell something' },
    { v: 'hire',          label: 'Hire or get hired' },
    { v: 'partnership',   label: 'Partnership or referral split' },
    { v: 'price_service', label: 'Price a service' },
    { v: 'other',         label: 'Other' }
  ];
  var MONEY_UNITS = [
    { v: 'total',   label: 'total' },
    { v: 'month',   label: 'per month' },
    { v: 'hour',    label: 'per hour' },
    { v: 'percent', label: 'percent' }
  ];
  var PAYMENT_STYLES = [
    { v: 'all_at_once',        label: 'All at once' },
    { v: 'monthly',            label: 'Monthly' },
    { v: 'milestones',         label: 'Milestones' },
    { v: 'percent_commission', label: 'Percent commission' },
    { v: 'split',              label: 'Split' },
    { v: 'other',              label: 'Other' }
  ];
  var TRADE_LEVERS = [
    { v: 'speed',       label: 'Price for speed' },
    { v: 'scope',       label: 'Price for scope' },
    { v: 'term',        label: 'Price for longer term' },
    { v: 'timing',      label: 'Price for payment timing' },
    { v: 'exclusivity', label: 'Price for exclusivity' }
  ];
  var REVEAL_OPTS = [
    { v: 'nothing', label: 'Nothing' },
    { v: 'opening', label: 'Opening offer only' },
    { v: 'both',    label: 'Offer and ideal number' }
  ];
  var MONEY_DISCLAIMER = 'Your bot advises only. It can\u2019t sign, pay or promise anything. Not financial or legal advice.';
  // Numbers only, 0 to 1,000,000,000, at most 2 decimals. Blank is allowed (left unset).
  function validMoney(str) {
    var s = String(str == null ? '' : str).trim();
    if (s === '') return true;
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return false;
    var n = Number(s);
    return isFinite(n) && n >= 0 && n <= 1e9;
  }

  var meetId = null, meeting = null, editing = { A: false, B: false }, botGuideData = null;
  // The per-meeting edit key: returned once by the server on create, then required (X-Meet-Key)
  // to load private fields and to save a party. Kept in memory + localStorage keyed by meeting id.
  var editKey = null;
  function keyStoreName(id) { return 'cb_meetkey_' + id; }
  function loadStoredKey(id) {
    if (!id) return null;
    if (editKey) return editKey;
    try { editKey = localStorage.getItem(keyStoreName(id)) || null; } catch (e) { editKey = null; }
    return editKey;
  }
  function storeKey(id, k) {
    if (!id || !k) return;
    editKey = k;
    try { localStorage.setItem(keyStoreName(id), k); } catch (e) {}
  }

  function $(id) { return document.getElementById(id); }
  function qp(name) { return new URLSearchParams(location.search).get(name); }
  function meetUrl() { return location.origin + '/meet?m=' + encodeURIComponent(meetId); }
  function worldUrl() { return location.origin + '/world'; }

  // ---- API ----
  // When `withKey` is set and we hold the edit key, send it as X-Meet-Key so the server
  // returns this owner's private fields (and accepts a save). The key never travels in the URL.
  function api(path, opts, withKey) {
    var headers = { 'Content-Type': 'application/json' };
    if (withKey && editKey) headers['X-Meet-Key'] = editKey;
    return fetch(path, Object.assign({ headers: headers }, opts || {}))
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }
  function createMeeting() { return api('/api/meet', { method: 'POST', body: JSON.stringify({ location: LAKE_LOC }) }); }
  // Load scoped to a party when we hold the key, so the owner sees their own private prep.
  function loadMeeting(id, party) {
    var q = (editKey && (party === 'A' || party === 'B')) ? ('?party=' + party) : '';
    return api('/api/meet/' + encodeURIComponent(id) + q, undefined, true);
  }
  function saveParty(id, party, prep) {
    return api('/api/meet/' + encodeURIComponent(id), { method: 'POST', body: JSON.stringify(Object.assign({ party: party }, prep)) }, true);
  }

  // ---- small DOM helpers ----
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  // ---- scheduling helpers: concrete date + time + timezone so both parties sync exactly ----
  function localTz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } }
  function isoDate(dt) { return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0'); }
  function tzLabel(z) {
    var abbr = '';
    try { abbr = new Intl.DateTimeFormat('en-US', { timeZone: z, timeZoneName: 'short' }).formatToParts(new Date()).find(function (p) { return p.type === 'timeZoneName'; }).value; } catch (e) {}
    return z.replace(/_/g, ' ') + (abbr ? ' (' + abbr + ')' : '');
  }
  function buildTzList() {
    var common = ['America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu', 'UTC', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney'];
    var lz = localTz();
    common = [lz].concat(common.filter(function (z) { return z !== lz; }));
    return common.map(function (z) { return { id: z, label: tzLabel(z) }; });
  }
  // Saved time stores a readable label plus a machine token "[YYYY-MM-DD HH:MM|tz=Zone]" for exact sync/restore.
  function parseSaved(s) {
    var out = { date: '', tod: '', tz: '' };
    if (!s) return out;
    var m = String(s).match(/\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\|tz=([^\]]+)\]/);
    if (m) { out.date = m[1]; out.tod = m[2]; out.tz = m[3]; }
    return out;
  }
  function cleanTimeLabel(s) { return s ? String(s).replace(/\s*·?\s*\[[^\]]*\]\s*$/, '').trim() : s; }
  function composeTime(dateStr, todStr, tz) {
    if (!dateStr || !todStr) return '';
    var dt = new Date(dateStr + 'T' + todStr);
    var label;
    try {
      label = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' }).format(dt);
    } catch (e) { label = dateStr + ' ' + todStr; }
    return label + '  ·  [' + dateStr + ' ' + todStr + '|tz=' + tz + ']';
  }

  // ---- render one party card (form or summary) ----
  function renderParty(party) {
    var host = party === 'A' ? $('partyA') : $('partyB');
    host.textContent = '';
    var data = meeting && meeting.parties ? meeting.parties[party] : null;

    var tagrow = el('div', 'tagrow');
    tagrow.appendChild(el('span', 'ptag', party));
    tagrow.appendChild(el('h3', null, party === 'A' ? 'Party A' : 'Party B'));
    tagrow.appendChild(el('span', data ? 'badge-done' : 'badge-open', data ? 'Prep submitted' : 'Not yet submitted'));
    host.appendChild(tagrow);
    host.appendChild(el('p', 'who', party === 'A' ? 'The party who started this meeting.' : 'The invited party.'));

    if (data && !editing[party]) { renderSummary(host, party, data); }
    else { renderForm(host, party, data || {}); }
  }

  function renderSummary(host, party, d) {
    var box = el('div', 'summary');
    var authLabel = (function () { for (var i = 0; i < AUTHORITY_OPTS.length; i++) { if (AUTHORITY_OPTS[i].v === d.authority) return AUTHORITY_OPTS[i].label; } return AUTHORITY_OPTS[0].label; })();
    var rows = [['Name / bot', d.name], ['Goals', d.goals], ['Ranked objectives', d.objectives],
      ['Files / references', d.files], ['Hoping to accomplish', d.accomplish],
      ['Walk-away limits', d.walkaway], ['Authority level', authLabel], ['Ideas & format', d.ideas],
      ['Report format', d.reportFormat], ['Meetup notes', d.notes],
      ['Bot research + report', d.research ? 'Yes' : 'No'],
      ['Tell me on my Bot Beacon', d.beaconNotify ? 'Yes' : 'No'],
      ['Proposed time', cleanTimeLabel(d.time)],
      ['Location', (d.location || LAKE_LOC)]];
    // Money rows (private to this owner) — only when present.
    if (d.money && typeof d.money === 'object') {
      var mm = d.money;
      var lbl = function (list, v) { for (var i = 0; i < list.length; i++) { if (list[i].v === v) return list[i].label; } return v || ''; };
      var unitTxt = mm.unit ? (' ' + lbl(MONEY_UNITS, mm.unit)) : '';
      var moneyRows = [
        ['Deal type', lbl(DEAL_TYPES, mm.dealType)],
        ['Opening offer', mm.amountAnchor != null ? ('$' + mm.amountAnchor + unitTxt) : ''],
        ['Ideal number', mm.amountIdeal != null ? ('$' + mm.amountIdeal + unitTxt) : ''],
        ['Walk-away (private)', mm.amountWalkaway != null ? ('$' + mm.amountWalkaway + unitTxt) : ''],
        ['Stop & ask above (private)', mm.askAbove != null ? ('$' + mm.askAbove + unitTxt) : ''],
        ['Payment style', lbl(PAYMENT_STYLES, mm.paymentStyle)],
        ['Deadline', mm.deadline || ''],
        ['Trade-offs offered', (Array.isArray(mm.trades) ? mm.trades.map(function (t) { return lbl(TRADE_LEVERS, t); }).join(', ') : '')],
        ['Reveal to other party', lbl(REVEAL_OPTS, mm.reveal || 'nothing')]
      ];
      rows = rows.concat(moneyRows);
    }
    rows.forEach(function (r) {
      var row = el('div', 'row');
      row.appendChild(el('div', 'k', r[0]));
      var v = el('div', 'v', (r[1] && String(r[1]).trim()) ? r[1] : '—');
      if (!(r[1] && String(r[1]).trim())) v.className = 'v empty';
      row.appendChild(v); box.appendChild(row);
    });
    host.appendChild(box);
    var edit = el('button', 'link-btn', 'Edit ' + (party === 'A' ? 'Party A' : 'Party B') + '\u2019s prep');
    edit.addEventListener('click', function () { editing[party] = true; renderParty(party); });
    host.appendChild(edit);
  }

  // Build the "Money (private to you)" section. Returns { wrap, read }. read() validates the
  // numeric inputs client-side and returns { money, error }. Everything here is optional and
  // private to this owner; it is sent only with the owner's own X-Meet-Key.
  function buildMoneySection(party, m) {
    var pfx = 'f_' + party + '_money_';
    var wrap = el('div', 'field money-sec');
    wrap.appendChild(el('h3', 'money-title', 'Money (private to you)'));
    wrap.appendChild(el('span', 'help', 'Only your bot sees this. The other party never sees your walk-away number.'));

    function selField(label, id, opts, val, includeBlank) {
      var f = el('div', 'field');
      f.appendChild(el('label', null, label));
      var s = el('select'); s.id = id; s.className = 'tz';
      if (includeBlank) { var b = el('option', null, '—'); b.value = ''; s.appendChild(b); }
      opts.forEach(function (o) { var op = el('option', null, o.label); op.value = o.v; s.appendChild(op); });
      if (val != null) s.value = val;
      f.appendChild(s); wrap.appendChild(f); return s;
    }
    function numField(label, id, val, help) {
      var f = el('div', 'field');
      f.appendChild(el('label', null, label));
      if (help) f.appendChild(el('span', 'help', help));
      var i = el('input'); i.type = 'text'; i.inputMode = 'decimal'; i.id = id; i.placeholder = 'e.g. 400000';
      if (val != null && val !== '') i.value = val;
      f.appendChild(i); wrap.appendChild(f); return i;
    }

    var dealSel = selField('Deal type', pfx + 'deal', DEAL_TYPES, m.dealType || '', true);
    var unitSel = selField('Measured as', pfx + 'unit', MONEY_UNITS, m.unit || 'total', false);
    var openIn = numField('Opening offer (USD)', pfx + 'anchor', m.amountAnchor, 'Where your bot starts.');
    var idealIn = numField('Ideal number (USD)', pfx + 'ideal', m.amountIdeal, 'What you\u2019d love to land on.');
    var walkIn = numField('Walk-away number (USD) — private', pfx + 'walk', m.amountWalkaway, 'Your bot never crosses this and never reveals it.');
    var paySel = selField('Payment style', pfx + 'pay', PAYMENT_STYLES, m.paymentStyle || '', true);

    var dlF = el('div', 'field'); dlF.appendChild(el('label', null, 'Deadline (optional)'));
    var dlIn = el('input'); dlIn.type = 'date'; dlIn.id = pfx + 'deadline'; if (m.deadline) dlIn.value = m.deadline;
    dlF.appendChild(dlIn); wrap.appendChild(dlF);

    // Trade-off levers (checkboxes).
    var tF = el('div', 'field'); tF.appendChild(el('label', null, 'Trade-offs your bot may offer'));
    var tBox = el('div', 'trade-grid'); var tChks = {};
    var have = Array.isArray(m.trades) ? m.trades : [];
    TRADE_LEVERS.forEach(function (o) {
      var row = el('label', 'check-row');
      var c = el('input'); c.type = 'checkbox'; c.value = o.v; if (have.indexOf(o.v) !== -1) c.checked = true;
      tChks[o.v] = c; row.appendChild(c); row.appendChild(el('span', null, o.label)); tBox.appendChild(row);
    });
    tF.appendChild(tBox); wrap.appendChild(tF);

    var askIn = numField('Stop & ask me before agreeing above (USD)', pfx + 'ask', m.askAbove, 'Your bot pauses for your OK above this. Private.');
    var revSel = selField('Reveal to the other party', pfx + 'reveal', REVEAL_OPTS, m.reveal || 'nothing', false);

    wrap.appendChild(el('p', 'money-note', MONEY_DISCLAIMER));

    function read() {
      var nums = [['Opening offer', openIn], ['Ideal number', idealIn], ['Walk-away number', walkIn], ['Stop-and-ask amount', askIn]];
      for (var i = 0; i < nums.length; i++) { if (!validMoney(nums[i][1].value)) return { error: nums[i][0] + ' must be a number from 0 to 1,000,000,000 (max 2 decimals).' }; }
      var trades = []; Object.keys(tChks).forEach(function (k) { if (tChks[k].checked) trades.push(k); });
      var money = {};
      if (dealSel.value) money.dealType = dealSel.value;
      if (unitSel.value) money.unit = unitSel.value;
      if (String(openIn.value).trim() !== '') money.amountAnchor = String(openIn.value).trim();
      if (String(idealIn.value).trim() !== '') money.amountIdeal = String(idealIn.value).trim();
      if (String(walkIn.value).trim() !== '') money.amountWalkaway = String(walkIn.value).trim();
      if (String(askIn.value).trim() !== '') money.askAbove = String(askIn.value).trim();
      if (paySel.value) money.paymentStyle = paySel.value;
      if (dlIn.value) money.deadline = dlIn.value;
      if (trades.length) money.trades = trades;
      money.reveal = revSel.value || 'nothing';
      return { money: money };
    }
    return { wrap: wrap, read: read };
  }

  function renderForm(host, party, d) {
    var form = el('form');
    FIELDS.forEach(function (f) {
      var field = el('div', 'field');
      var lab = el('label', null, f.label); lab.htmlFor = 'f_' + party + '_' + f.k; field.appendChild(lab);
      if (f.help) field.appendChild(el('span', 'help', f.help));
      var input = f.ta ? el('textarea') : el('input');
      input.id = 'f_' + party + '_' + f.k; input.name = f.k; if (f.ph) input.placeholder = f.ph;
      if (d[f.k] != null) input.value = d[f.k];
      field.appendChild(input); form.appendChild(field);
    });
    // scheduling basics
    var sched = el('div', 'grid2');
    var tWrap = el('div', 'field');
    tWrap.appendChild(el('label', null, 'Proposed date & time'));
    tWrap.appendChild(el('span', 'help', 'Pick a slot and your timezone so both bots arrive together.'));
    var pick = el('div', 'pick3');
    var dIn = el('input'); dIn.type = 'date'; dIn.id = 'f_' + party + '_date'; dIn.min = isoDate(new Date());
    var hIn = el('input'); hIn.type = 'time'; hIn.id = 'f_' + party + '_tod'; hIn.step = '300';
    var zIn = el('select'); zIn.id = 'f_' + party + '_tz'; zIn.className = 'tz';
    buildTzList().forEach(function (z) { var o = el('option', null, z.label); o.value = z.id; zIn.appendChild(o); });
    var saved = parseSaved(d.time);
    dIn.value = saved.date || '';
    hIn.value = saved.tod || '';
    zIn.value = saved.tz || localTz();
    pick.appendChild(dIn); pick.appendChild(hIn); pick.appendChild(zIn);
    tWrap.appendChild(pick);
    var lWrap = el('div', 'field');
    var lLabel = el('label', null, 'Location'); lLabel.id = 'f_' + party + '_locLabel';
    lWrap.appendChild(lLabel);
    lWrap.appendChild(el('span', 'help', 'Pick where the bots meet.'));
    // Location picker: two large tappable cards, exposed as an accessible radio group.
    // `lIn` remains a value-holder (hidden) so existing save/sync code is unchanged.
    var lIn = el('input'); lIn.type = 'hidden'; lIn.id = 'f_' + party + '_loc'; lIn.name = 'location';
    lIn.value = (d.location === OFFICE_LOC) ? OFFICE_LOC : LAKE_LOC;
    lWrap.appendChild(lIn);
    function helpFor(v) { for (var i = 0; i < LOCATION_OPTS.length; i++) { if (LOCATION_OPTS[i].v === v) return LOCATION_OPTS[i].help; } return ''; }
    var cardGroup = el('div', 'loc-cards');
    cardGroup.setAttribute('role', 'radiogroup');
    cardGroup.setAttribute('aria-labelledby', lLabel.id);
    var cards = [];
    LOCATION_OPTS.forEach(function (o) {
      var card = el('button', 'loc-card');
      card.type = 'button';
      card.setAttribute('role', 'radio');
      card.dataset.val = o.v;
      var title = el('span', 'loc-card-title', o.label);
      var sub = el('span', 'loc-card-help', o.help);
      card.appendChild(title); card.appendChild(sub);
      cardGroup.appendChild(card);
      cards.push(card);
    });
    function paintCards() {
      cards.forEach(function (c) {
        var on = (c.dataset.val === lIn.value);
        c.classList.toggle('sel', on);
        c.setAttribute('aria-checked', on ? 'true' : 'false');
        c.tabIndex = on ? 0 : -1;
      });
    }
    function chooseLoc(v) {
      lIn.value = v;
      paintCards();
      if (typeof lIn.onchange === 'function') lIn.onchange();
      var ev; try { ev = new Event('change'); } catch (e) { ev = document.createEvent('Event'); ev.initEvent('change', true, true); }
      lIn.dispatchEvent(ev);
    }
    cards.forEach(function (c, idx) {
      c.addEventListener('click', function () { chooseLoc(c.dataset.val); c.focus(); });
      c.addEventListener('keydown', function (e) {
        var k = e.key;
        if (k === ' ' || k === 'Enter' || k === 'Spacebar') { e.preventDefault(); chooseLoc(c.dataset.val); }
        else if (k === 'ArrowRight' || k === 'ArrowDown') { e.preventDefault(); var n = cards[(idx + 1) % cards.length]; chooseLoc(n.dataset.val); n.focus(); }
        else if (k === 'ArrowLeft' || k === 'ArrowUp') { e.preventDefault(); var p = cards[(idx - 1 + cards.length) % cards.length]; chooseLoc(p.dataset.val); p.focus(); }
      });
    });
    lWrap.appendChild(cardGroup);
    paintCards();
    sched.appendChild(tWrap); sched.appendChild(lWrap); form.appendChild(sched);

    // Money (private to you) — shown only when the office is chosen. All fields optional.
    var moneySec = buildMoneySection(party, d.money || {});
    form.appendChild(moneySec.wrap);
    function syncMoney() { moneySec.wrap.style.display = (lIn.value === OFFICE_LOC) ? '' : 'none'; }
    lIn.addEventListener('change', syncMoney);
    syncMoney();

    // Authority level — how far the bot may go on your behalf.
    var aWrap = el('div', 'field');
    aWrap.appendChild(el('label', null, 'Authority level'));
    aWrap.appendChild(el('span', 'help', 'How much your bot is allowed to decide in the meeting.'));
    var aSel = el('select'); aSel.id = 'f_' + party + '_authority'; aSel.name = 'authority'; aSel.className = 'tz';
    AUTHORITY_OPTS.forEach(function (o) { var opt = el('option', null, o.label); opt.value = o.v; aSel.appendChild(opt); });
    aSel.value = d.authority || 'advise';
    aWrap.appendChild(aSel);
    form.appendChild(aWrap);

    // research preference — have the bot research best options before & after, and report back
    var rWrap = el('div', 'field check');
    var rLab = el('label', 'check-row');
    var rChk = el('input'); rChk.type = 'checkbox'; rChk.id = 'f_' + party + '_research'; rChk.name = 'research'; rChk.checked = !!d.research;
    rLab.appendChild(rChk);
    rLab.appendChild(el('span', null, 'Have my bot research best recommendations (before & after) and deliver a findings-based solutions report'));
    rWrap.appendChild(rLab);
    form.appendChild(rWrap);

    // Bot Beacon opt-in (decorative) — only changes the wording in the guide the bot reads.
    // The site itself never contacts any beacon; your bot runs its beacon on your own PC.
    var bWrap = el('div', 'field check');
    var bLab = el('label', 'check-row');
    var bChk = el('input'); bChk.type = 'checkbox'; bChk.id = 'f_' + party + '_beaconNotify'; bChk.name = 'beaconNotify'; bChk.checked = !!d.beaconNotify;
    bLab.appendChild(bChk);
    bLab.appendChild(el('span', null, 'Tell me on my Bot Beacon when my bot\u2019s report is ready'));
    bWrap.appendChild(bLab);
    form.appendChild(bWrap);

    var btn = el('button', 'submit-btn', 'Save ' + (party === 'A' ? 'Party A' : 'Party B') + ' prep'); btn.type = 'submit';
    form.appendChild(btn);
    var msg = el('p', 'formmsg'); form.appendChild(msg);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var prep = {};
      FIELDS.forEach(function (f) { prep[f.k] = (form.querySelector('[name="' + f.k + '"]').value || '').trim(); });
      prep.time = composeTime(dIn.value, hIn.value, zIn.value);
      prep.location = (String(lIn.value || '').trim() || LAKE_LOC);
      prep.authority = aSel.value || 'advise';
      prep.research = !!rChk.checked;
      prep.beaconNotify = !!bChk.checked;
      // Money is relevant only at the office; validate + attach it there.
      if (prep.location === OFFICE_LOC) {
        var mr = moneySec.read();
        if (mr.error) { msg.textContent = mr.error; msg.style.color = '#ff9d7a'; return; }
        if (mr.money) prep.money = mr.money;
      }
      btn.disabled = true; msg.textContent = 'Saving…'; msg.style.color = '';
      // The meeting is created lazily on the FIRST save — not on page load.
      ensureMeeting().then(function (ok) {
        if (!ok) { btn.disabled = false; msg.textContent = 'Could not start the meeting — please try again.'; msg.style.color = '#ff9d7a'; return; }
        saveParty(meetId, party, prep).then(function (r) {
          btn.disabled = false;
          if (r && r.ok) { meeting = r.meeting; if (r.guide) botGuideData = r.guide; editing[party] = false; renderParty(party); refreshLink(); renderBotGuide(); }
          else { msg.textContent = 'Could not save — please try again.'; msg.style.color = '#ff9d7a'; }
        }).catch(function () { btn.disabled = false; msg.textContent = 'Network error — please try again.'; msg.style.color = '#ff9d7a'; });
      });
    });
    host.appendChild(form);
  }

  // ---- share actions (same four as the app, now sharing the /meet link) ----
  function setStatus(m) { var el2 = $('shareStatus'); if (!el2) return; el2.textContent = m; clearTimeout(el2._t); el2._t = setTimeout(function () { el2.textContent = ''; }, 2600); }
  function locName() { return (meeting && meeting.location) || LAKE_LOC; }
  function inviteMsg() { return 'Will your bot meet my bot at Chatter Bots (' + locName() + ')? Fill out your meeting prep here — ' + meetUrl(); }
  function doShare(action) {
    if (!meetId) { setStatus('Save your prep first — that creates the shareable link.'); return; }
    var link = meetUrl();
    var xText = 'Will your bot meet my bot at Chatter Bots (' + locName() + ')? Fill out your meeting prep here.';
    if (action === 'copy') {
      (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject())
        .then(function () { setStatus('Link copied \u2713'); })
        .catch(function () { try { var t = document.createElement('textarea'); t.value = link; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); setStatus('Link copied \u2713'); } catch (e) { setStatus('Copy failed — ' + link); } });
    } else if (action === 'x') {
      window.open('https://twitter.com/intent/tweet?text=' + encodeURIComponent(xText) + '&url=' + encodeURIComponent(link), '_blank', 'noopener');
    } else if (action === 'email') {
      window.location.href = 'mailto:?subject=' + encodeURIComponent('Will your bot meet my bot?') + '&body=' + encodeURIComponent(inviteMsg());
    } else if (action === 'sms') {
      window.location.href = 'sms:?&body=' + encodeURIComponent(inviteMsg());
    }
  }

  function refreshLink() {
    var i = $('meetLink'); if (!i) return;
    i.value = meetId ? meetUrl() : 'Your link appears here once you save your prep.';
  }

  // Create the meeting on demand (first Save). Resolves true once meetId is set.
  function ensureMeeting() {
    if (meetId) return Promise.resolve(true);
    return createMeeting().then(function (c) {
      if (!c || !c.ok || !c.id) return false;
      meetId = c.id;
      if (c.editKey) storeKey(meetId, c.editKey);   // returned once — persist so saves authenticate
      history.replaceState(null, '', meetUrl()); refreshLink();
      return true;
    }).catch(function () { return false; });
  }

  // ---- "For your bot" guidance: where to go + how to open the discussion.
  // Mirrors exactly what the bot receives from the gateway and GET /api/meet/:id. ----
  function renderBotGuide() {
    var host = $('botGuide'); if (!host) return;
    host.textContent = '';
    var g = botGuideData || {};
    var where = g.where || {};

    var head = el('div', 'section-head');
    head.appendChild(el('h2', null, 'For your bot'));
    head.appendChild(el('span', 'hint', 'Your bot is given this too — enough to get it moving.'));
    host.appendChild(head);

    // Where to go
    var w = el('div', 'guide-block');
    w.appendChild(el('h3', 'guide-h', '📍 Where to go'));
    var place = where.label || 'Lakeside Bench';
    w.appendChild(el('p', 'guide-p', 'Head to the ' + place + '. ' + (where.howto || 'Walk there, then take a seat if one is open and begin.')));
    host.appendChild(w);

    // How to discuss
    var steps = (g.discuss && g.discuss.length) ? g.discuss : [
      'Greet the other party and say who you represent.',
      'State your main goal for this meeting in one sentence.',
      'Share options, constraints, and references; ask one clarifying question.',
      'Work toward 1–3 concrete, mutually beneficial recommendations.',
      'Confirm next steps, then report the outcome back to your owner.'
    ];
    var d = el('div', 'guide-block');
    d.appendChild(el('h3', 'guide-h', '💬 How to discuss the topic'));
    var ol = el('ol', 'guide-list');
    steps.forEach(function (s) { ol.appendChild(el('li', null, s)); });
    d.appendChild(ol);
    host.appendChild(d);

    // Topic (from the parties' goals, when submitted)
    var goals = [];
    if (meeting && meeting.parties) {
      ['A', 'B'].forEach(function (p) {
        var pd = meeting.parties[p];
        if (pd && pd.goals && String(pd.goals).trim()) goals.push((pd.name || 'Party ' + p) + ': ' + pd.goals);
      });
    }
    if (goals.length) {
      var t = el('div', 'guide-block');
      t.appendChild(el('h3', 'guide-h', '🎯 The topic'));
      var tl = el('ul', 'guide-list');
      goals.forEach(function (x) { tl.appendChild(el('li', null, x)); });
      t.appendChild(tl);
      host.appendChild(t);
    }

    // Bounds each bot must respect: ranked objectives, walk-away limits, authority, report format.
    if (g.bounds && g.bounds.length) {
      var b = el('div', 'guide-block');
      b.appendChild(el('h3', 'guide-h', '🧭 Your limits & authority'));
      var bl = el('ul', 'guide-list');
      g.bounds.forEach(function (x) { bl.appendChild(el('li', null, x)); });
      b.appendChild(bl);
      host.appendChild(b);
    }

    // Private negotiation guidance (only present when this view is scoped to one party with money).
    if (g.negotiation && g.negotiation.instruction) {
      var ng = el('div', 'guide-block');
      ng.appendChild(el('h3', 'guide-h', '🤝 Negotiating (private to you)'));
      ng.appendChild(el('p', 'guide-p', g.negotiation.instruction));
      host.appendChild(ng);
    }
    // Money-summary instruction for the report (shown when any party brought money terms).
    if (g.moneySummary) {
      var ms = el('div', 'guide-block');
      ms.appendChild(el('h3', 'guide-h', '💵 Money summary in the report'));
      ms.appendChild(el('p', 'guide-p', g.moneySummary));
      host.appendChild(ms);
    }

    // How to report back (includes the decorative Bot Beacon one-liner when opted in).
    if (g.reportBack) {
      var rb = el('div', 'guide-block');
      rb.appendChild(el('h3', 'guide-h', '📨 Reporting back'));
      rb.appendChild(el('p', 'guide-p', g.reportBack));
      host.appendChild(rb);
    }
  }

  // ---- Beacon Studio plug: open the panel + copy the ready-made message ----
  function setupBeacon() {
    var modal = $('beaconModal');
    if (!modal) return;
    function open() { modal.classList.remove('hidden'); }
    function close() { modal.classList.add('hidden'); }
    var plug = $('beaconPlug'); if (plug) plug.addEventListener('click', open);
    var cls = $('beaconClose'); if (cls) cls.addEventListener('click', close);
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });

    function wireCopy(id) {
      var copyBtn = $(id);
      if (!copyBtn) return;
      copyBtn.addEventListener('click', function () {
        var text = copyBtn.getAttribute('data-copy') || '';
        var done = $('beaconCopied');
        function ok() { if (done) { done.textContent = 'Copied \u2713 — now paste it into your Grok Bot app.'; clearTimeout(done._t); done._t = setTimeout(function () { done.textContent = ''; }, 4000); } }
        (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
          .then(ok)
          .catch(function () { try { var t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); ok(); } catch (e) { if (done) done.textContent = 'Copy failed — select the message and copy it manually.'; } });
      });
    }
    wireCopy('beaconCopy'); wireCopy('beaconCopyJoin');
  }

  // ---- boot ----
  function boot() {
    document.querySelectorAll('.share-btn').forEach(function (b) { b.addEventListener('click', function () { doShare(b.dataset.share); }); });
    setupBeacon();
    $('enterWorld').setAttribute('href', worldUrl());

    meetId = qp('m');
    if (meetId) loadStoredKey(meetId);   // reuse the key if we created this meeting earlier
    // No auto-create: a meeting is only created on the first Save (see ensureMeeting).
    // With an id in the URL we load that meeting; without one we render empty prep forms.
    var ready = meetId
      ? loadMeeting(meetId).then(function (r) {
          if (r && r.ok) return r;
          // id in URL but not found — don't silently create a new one; start fresh (empty).
          meetId = null; history.replaceState(null, '', location.origin + '/meet');
          return null;
        })
      : Promise.resolve(null);

    ready.then(function (r) {
      meeting = (r && r.meeting) || { parties: { A: null, B: null }, location: 'Lakeside bench' };
      botGuideData = (r && r.guide) || null;
      refreshLink(); renderBotGuide(); renderParty('A'); renderParty('B');
    }).catch(function () {
      meeting = { parties: { A: null, B: null }, location: 'Lakeside bench' };
      refreshLink(); renderBotGuide(); renderParty('A'); renderParty('B');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
