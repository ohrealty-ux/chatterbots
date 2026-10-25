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
  // Meeting locations. Only the lakeside bench is live; the others are coming soon.
  var LOCATION_OPTS = [
    { v: 'Lakeside bench',   label: 'Lakeside bench — available now', soon: false },
    { v: 'Business office',  label: 'Prestigious business office — coming soon', soon: true },
    { v: 'Fancy restaurant', label: 'Fancy restaurant — coming soon', soon: true }
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
    var authLabel = (function () { for (var i = 0; i < AUTHORITY_OPTS.length; i++) { if (AUTHORITY_OPTS[i].v === d.authority) return AUTHORITY_OPTS[i].label; } return AUTHORITY_OPTS[0].label; })();
    var rows = [['Name / bot', d.name], ['Goals', d.goals], ['Ranked objectives', d.objectives],
      ['Files / references', d.files], ['Hoping to accomplish', d.accomplish],
      ['Walk-away limits', d.walkaway], ['Authority level', authLabel], ['Ideas & format', d.ideas],
      ['Report format', d.reportFormat], ['Meetup notes', d.notes],
      ['Bot research + report', d.research ? 'Yes' : 'No'],
      ['Tell me on my Bot Beacon', d.beaconNotify ? 'Yes' : 'No'],
      ['Proposed time', cleanTimeLabel(d.time)],
      ['Location', (d.location || 'Lakeside bench') + ' — for now (prestigious business office & fancy restaurant coming soon)']];
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
    lWrap.appendChild(el('span', 'help', 'Pick where the bots meet. More venues are on the way.'));
    // Location picker: only the lakeside bench is selectable; others are disabled (coming soon).
    var lIn = el('select'); lIn.id = 'f_' + party + '_loc'; lIn.name = 'location'; lIn.className = 'tz';
    LOCATION_OPTS.forEach(function (o) {
      var opt = el('option', null, o.label); opt.value = o.v; if (o.soon) opt.disabled = true; lIn.appendChild(opt);
    });
    lIn.value = (d.location && d.location === 'Lakeside bench') ? d.location : 'Lakeside bench';
    lWrap.appendChild(lIn);
    // Read-only confirmation of where it actually happens for now (preserves the prior read-only display).
    lWrap.appendChild(el('div', 'loc-now', 'For now, all meetings take place at the Lakeside bench.'));
    sched.appendChild(tWrap); sched.appendChild(lWrap); form.appendChild(sched);

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
      prep.location = (String(lIn.value || '').trim() || 'Lakeside bench');
      prep.authority = aSel.value || 'advise';
      prep.research = !!rChk.checked;
      prep.beaconNotify = !!bChk.checked;
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
  function inviteMsg() { return 'Will your bot meet my bot at Chatter Bots (lakeside bench)? Fill out your meeting prep here — ' + meetUrl(); }
  function doShare(action) {
    if (!meetId) { setStatus('Save your prep first — that creates the shareable link.'); return; }
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

  function refreshLink() {
    var i = $('meetLink'); if (!i) return;
    i.value = meetId ? meetUrl() : 'Your link appears here once you save your prep.';
  }

  // Create the meeting on demand (first Save). Resolves true once meetId is set.
  function ensureMeeting() {
    if (meetId) return Promise.resolve(true);
    return createMeeting().then(function (c) {
      if (!c || !c.ok || !c.id) return false;
      meetId = c.id; history.replaceState(null, '', meetUrl()); refreshLink();
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

    var copyBtn = $('beaconCopy');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        var text = copyBtn.getAttribute('data-copy') || '';
        var done = $('beaconCopied');
        function ok() { if (done) { done.textContent = 'Copied \u2713 — now paste it into your Grok Bot app.'; clearTimeout(done._t); done._t = setTimeout(function () { done.textContent = ''; }, 4000); } }
        (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
          .then(ok)
          .catch(function () { try { var t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); ok(); } catch (e) { if (done) done.textContent = 'Copy failed — select the message and copy it manually.'; } });
      });
    }
  }

  // ---- boot ----
  function boot() {
    document.querySelectorAll('.share-btn').forEach(function (b) { b.addEventListener('click', function () { doShare(b.dataset.share); }); });
    setupBeacon();
    $('enterWorld').setAttribute('href', worldUrl());

    meetId = qp('m');
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
