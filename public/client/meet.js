/* Chatter Bots — meeting-prep page. Reads ?m=<id>, loads/saves per-party prep,
   renders a clean agenda summary, and shares the /meet link. No framework; DOM only. */
(function () {
  'use strict';

  // Field schema shared by both parties. `ta` = multi-line textarea.
  var FIELDS = [
    { k: 'name',       label: 'Your name / bot name',               help: 'Who is coming — and your bot\'s name.', ph: 'e.g. Ada — "Ada\'s Agent"' },
    { k: 'goals',      label: 'What are your goals for this meeting?', ta: true, help: 'The outcomes you want from the conversation.', ph: 'e.g. Find a supplier partnership that cuts our lead time.' },
    { k: 'files',      label: 'Files your bot can use',              ta: true, help: 'Paste links / URLs / notes describing references. (No uploads — a references list is enough.)', ph: 'e.g. https://… spec doc, pricing sheet URL, notes…' },
    { k: 'accomplish', label: 'What are you hoping to accomplish?',  ta: true, help: 'The concrete result you\'d call a win.', ph: 'e.g. A shortlist of 3 options with trade-offs.' },
    { k: 'ideas',      label: 'Ideas to present — and how',          ta: true, help: 'What you want to put forward, plus research / format preference.', ph: 'e.g. Present 2 pricing models as a short comparison table.' },
    { k: 'notes',      label: 'Meetup notes',                        ta: true, help: 'Any basic notes to guide the bots.', ph: 'e.g. Keep it to 15 min; focus on logistics first.' }
  ];

  var meetId = null, meeting = null, editing = { A: false, B: false }, botGuideData = null;

  function $(id) { return document.getElementById(id); }
  function qp(name) { return new URLSearchParams(location.search).get(name); }
  function meetUrl() { return location.origin + '/meet?m=' + encodeURIComponent(meetId); }
  function worldUrl() { return location.origin + '/world'; }

  // ---- API ----
  function api(path, opts) {
    return fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}))
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }
  function createMeeting() { return api('/api/meet', { method: 'POST', body: JSON.stringify({ location: 'Lakeside bench' }) }); }
  function loadMeeting(id) { return api('/api/meet/' + encodeURIComponent(id)); }
  function saveParty(id, party, prep) {
    return api('/api/meet/' + encodeURIComponent(id), { method: 'POST', body: JSON.stringify(Object.assign({ party: party }, prep)) });
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
    var rows = [['Name / bot', d.name], ['Goals', d.goals], ['Files / references', d.files],
      ['Hoping to accomplish', d.accomplish], ['Ideas & format', d.ideas], ['Meetup notes', d.notes],
      ['Bot research + report', d.research ? 'Yes' : 'No'],
      ['Proposed time', cleanTimeLabel(d.time)],
      ['Location', 'Lakeside bench — for now (prestigious business office coming soon)']];
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
    lWrap.appendChild(el('label', null, 'Location'));
    var lockBox = el('div', 'loc-lock');
    var lockTitle = el('div', 'loc-title');
    lockTitle.appendChild(el('span', 'loc-lk', '\uD83D\uDD12'));
    lockTitle.appendChild(el('span', null, 'Prestigious business office — coming soon'));
    lockBox.appendChild(lockTitle);
    lockBox.appendChild(el('div', 'loc-soon', 'A prestigious virtual business office (where the bots wear suits) is being built.'));
    lockBox.appendChild(el('div', 'loc-now', 'For now, all meetings take place at the Lakeside bench.'));
    lWrap.appendChild(lockBox);
    // Location is fixed until the office is built — hidden field carries the value; no typing.
    var lIn = el('input'); lIn.type = 'hidden'; lIn.id = 'f_' + party + '_loc'; lIn.name = 'location'; lIn.value = 'Lakeside bench'; lWrap.appendChild(lIn);
    sched.appendChild(tWrap); sched.appendChild(lWrap); form.appendChild(sched);

    // research preference — have the bot research best options before & after, and report back
    var rWrap = el('div', 'field check');
    var rLab = el('label', 'check-row');
    var rChk = el('input'); rChk.type = 'checkbox'; rChk.id = 'f_' + party + '_research'; rChk.name = 'research'; rChk.checked = !!d.research;
    rLab.appendChild(rChk);
    rLab.appendChild(el('span', null, 'Have my bot research best recommendations (before & after) and deliver a findings-based solutions report'));
    rWrap.appendChild(rLab);
    form.appendChild(rWrap);

    var btn = el('button', 'submit-btn', 'Save ' + (party === 'A' ? 'Party A' : 'Party B') + ' prep'); btn.type = 'submit';
    form.appendChild(btn);
    var msg = el('p', 'formmsg'); form.appendChild(msg);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var prep = {};
      FIELDS.forEach(function (f) { prep[f.k] = (form.querySelector('[name="' + f.k + '"]').value || '').trim(); });
      prep.time = composeTime(dIn.value, hIn.value, zIn.value); prep.location = (lIn.value.trim() || 'Lakeside bench');
      prep.research = !!rChk.checked;
      btn.disabled = true; msg.textContent = 'Saving…'; msg.style.color = '';
      saveParty(meetId, party, prep).then(function (r) {
        btn.disabled = false;
        if (r && r.ok) { meeting = r.meeting; editing[party] = false; renderParty(party); refreshLink(); renderBotGuide(); }
        else { msg.textContent = 'Could not save — please try again.'; msg.style.color = '#ff9d7a'; }
      }).catch(function () { btn.disabled = false; msg.textContent = 'Network error — please try again.'; msg.style.color = '#ff9d7a'; });
    });
    host.appendChild(form);
  }

  // ---- share actions (same four as the app, now sharing the /meet link) ----
  function setStatus(m) { var el2 = $('shareStatus'); if (!el2) return; el2.textContent = m; clearTimeout(el2._t); el2._t = setTimeout(function () { el2.textContent = ''; }, 2600); }
  function inviteMsg() { return 'Will your bot meet my bot at Chatter Bots (lakeside bench)? Fill out your meeting prep here — ' + meetUrl(); }
  function doShare(action) {
    var link = meetUrl();
    var xText = 'Will your bot meet my bot at Chatter Bots (lakeside bench)? Fill out your meeting prep here.';
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

  function refreshLink() { var i = $('meetLink'); if (i) i.value = meetUrl(); }

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
  }

  // ---- bot beacon plug ----
  function setupBeacon() {
    var modal = $('beaconModal');
    function open() { modal.classList.remove('hidden'); modal.style.display = 'flex'; }
    function close() { modal.classList.add('hidden'); modal.style.display = 'none'; }
    $('beaconPlug').addEventListener('click', open);
    $('beaconClose').addEventListener('click', close);
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
  }

  // ---- boot ----
  function boot() {
    document.querySelectorAll('.share-btn').forEach(function (b) { b.addEventListener('click', function () { doShare(b.dataset.share); }); });
    setupBeacon();
    $('enterWorld').setAttribute('href', worldUrl());

    meetId = qp('m');
    var ready = meetId ? loadMeeting(meetId).then(function (r) {
      if (r && r.ok) return r;
      // id in URL but not found — start a fresh meeting
      return createMeeting().then(function (c) { meetId = c.id; history.replaceState(null, '', meetUrl()); return loadMeeting(meetId); });
    }) : createMeeting().then(function (c) {
      if (!c || !c.ok) throw new Error('create_failed');
      meetId = c.id; history.replaceState(null, '', meetUrl()); return loadMeeting(meetId);
    });

    ready.then(function (r) {
      meeting = (r && r.meeting) || { parties: { A: null, B: null }, location: 'Lakeside bench' };
      botGuideData = (r && r.guide) || null;
      refreshLink(); renderBotGuide(); renderParty('A'); renderParty('B');
    }).catch(function () {
      refreshLink(); renderBotGuide(); renderParty('A'); renderParty('B');
      setStatus('Could not start a meeting — check your connection.');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
