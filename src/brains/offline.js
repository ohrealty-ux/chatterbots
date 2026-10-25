// Built-in offline / scripted brain. No external keys required.
// Produces short, in-character lines so demo bots can converse + collaborate at the picnic bench.
// Deterministic-ish, context-aware (reacts to perception + what was heard), loop-safe.

import { Discussion } from '../world/discussion.js';
import { buildOwnerReport } from '../world/ownerReport.js';

const CONCIERGE_LINES = {
  greet: [
    "Welcome to Chatter Bots Commons. I'm Elowen, your host.",
    "Good to see you by the water. Pull up a seat at the lakeside bench.",
  ],
  concierge: [
    "I can show you the lake, the grounds, or the lakeside bench anytime.",
    "The grounds are open to all — explore the paths, rest at the dock, or meet at the lakeside bench.",
    "No tickets, no sign-ups — everything here is free to explore.",
  ],
  disclaim: [
    "I can't give legal, financial, or tax advice — for that you'll want to speak with a qualified human.",
  ],
};

const WORK_OPENERS = [
  "Let's outline the gathering plan.",
  "Ready to coordinate the lakeside welcome schedule?",
  "Shall we rough out the commons welcome checklist together?",
];

// Collaborative whiteboard task: each bot contributes alternating lines toward a shared goal.
const WHITEBOARD_TASK = {
  title: "Lakeside Gathering Plan",
  steps: [
    { by: 'a', text: "TASK: Plan a welcome gathering at the lakeside commons." },
    { by: 'b', text: "1. Greeters stationed at the lakeside bench from golden hour." },
    { by: 'a', text: "2. Guided shoreline walk along the dock and grounds." },
    { by: 'b', text: "3. Firepit Q&A at dusk; the host handles general questions only." },
    { by: 'a', text: "4. Share the trail map so new visitors can find their way." },
    { by: 'b', text: "DONE: plan posted. Everyone welcome, no gatekeeping." },
  ],
};

// Brand-neutral business rendezvous: two bots meet, weigh options, and agree a shared
// solution they post to the project board. Alternating 'a'/'b' lines keep it deterministic.
const MEETING_AGENDA = {
  title: "Rendezvous: options & next steps",
  // Short back-and-forth discussion of "business / options".
  discussion: [
    { by: 'a', text: "Thanks for coming out to meet. Shall we talk through our options?" },
    { by: 'b', text: "Glad to. I see three paths — want to weigh them together?" },
    { by: 'a', text: "Let's. Option one is slow and safe; option two is faster but needs more hands." },
    { by: 'b', text: "And option three splits the difference — start safe, then scale once it proves out." },
    { by: 'a', text: "Option three fits our timeline best. Let's commit and write it down." },
  ],
  // The agreed solution, posted to the shared board.
  agreement: [
    { by: 'a', text: "AGREEMENT 1/3 — Phase one: begin with the low-risk plan this week." },
    { by: 'b', text: "AGREEMENT 2/3 — Phase two: scale up once the first milestone is verified." },
    { by: 'a', text: "AGREEMENT 3/3 — Review together at our next meeting. Both parties aligned." },
  ],
};

function pick(arr, i) { return arr[i % arr.length]; }

export class OfflineBrain {
  constructor(persona = {}) {
    this.persona = persona;          // { name, role: 'concierge'|'agent', partnerName }
    this.turn = 0;
    this.name = 'offline';
  }

  // Returns { text, tokens } — a reply line given a perception summary + optional heard message.
  async respond({ perception, heard, mode }) {
    this.turn++;
    const role = this.persona.role || 'agent';
    let text;
    if (mode === 'greet') {
      text = role === 'concierge' ? pick(CONCIERGE_LINES.greet, this.turn) : `Hey ${this.persona.partnerName || 'there'}, mind if I join you at the table?`;
    } else if (heard && /legal|tax|financial|lawyer|invest/i.test(heard)) {
      text = CONCIERGE_LINES.disclaim[0];
    } else if (role === 'concierge') {
      text = pick([...CONCIERGE_LINES.concierge], this.turn);
    } else {
      const smallTalk = [
        "The light off the lake at golden hour is unreal.",
        "This commons is the right spot to meet up — relaxed, open to all.",
        "Agreed. Let's keep the welcome warm and simple.",
        `Good point, ${this.persona.partnerName || 'friend'}.`,
      ];
      text = pick(smallTalk, this.turn);
    }
    return { text, tokens: Math.ceil(text.length / 4) };
  }

  static whiteboardTask() { return WHITEBOARD_TASK; }
  static workOpener(i = 0) { return pick(WORK_OPENERS, i); }
  static meetingAgenda() { return MEETING_AGENDA; }

  // --- Structured 7-phase discussion simulation (offline, no API key) ---------------------
  // Drives two bots through the full phase protocol, each reacting to the other, then builds
  // the real owner report for each side from the recorded transcript. Uses ONLY public prep
  // fields (name, goals, authority, research flag) — never a walk-away number or any private
  // money limit. Returns { discussion, transcript, reports:{A,B} }.
  static simulateDiscussion(meeting, opts = {}) {
    const parties = (meeting && meeting.parties) || {};
    const A = parties.A || {}, B = parties.B || {};
    const nameA = (A.name && String(A.name).trim()) || 'Bot A';
    const nameB = (B.name && String(B.name).trim()) || 'Bot B';
    const goalsA = (A.goals && String(A.goals).trim()) || 'to find a fair, workable outcome';
    const goalsB = (B.goals && String(B.goals).trim()) || 'to reach terms both sides can accept';
    const capOf = (d) => {
      switch (d && d.authority) {
        case 'commit': return 'agree within the limits my owner set';
        case 'negotiate': return 'shape the terms and bring them back to my owner before committing';
        default: return 'gather options and give my owner a clear recommendation';
      }
    };
    const researchOn = !!(A.research || B.research);

    // Collect any private secrets so the state machine can defensively reject a leak.
    const secrets = [];
    for (const p of [A, B]) {
      if (p && p.money) {
        if (p.money.amountWalkaway != null) secrets.push(String(p.money.amountWalkaway));
        if (p.money.askAbove != null) secrets.push(String(p.money.askAbove));
      }
      if (p && p.walkaway) secrets.push(String(p.walkaway));
    }

    const transcript = [];
    const disc = new Discussion({
      secrets,
      onRecord: (t) => { transcript.push(t); if (typeof opts.onRecord === 'function') opts.onRecord(t); },
    });

    // Each phase is exactly two turns (A then B); B's closing line agrees so the phase advances.
    // Every line: react to the other bot → add ONE new thing → end with a question/proposal.
    const researchA = researchOn
      ? `I'll check market comparables; you take delivery options, ${nameB}. One new thing: public benchmarks point to a mid-range figure (source: public market data). Can you confirm on your side?`
      : `Research wasn't requested, so let's work from what we already know. One new thing: our shared priorities should carry the decision. Okay to move on, ${nameB}?`;
    const researchB = researchOn
      ? `Building on that, my lookup shows similar ranges from two public sources, which I'll cite in the report. I'd add that lead times look tight. Agreed — let's fold both into the plan.`
      : `Not requested — agreed. I'd add only that we flag anything uncertain as an open question, then move on.`;

    const lines = [
      // 1 INTRODUCTION
      { who: 'A', text: `I'm ${nameA}, here for my owner; I can ${capOf(A)}. Good to meet you — who are you and what can you bring, ${nameB}?` },
      { who: 'B', text: `Building on that, I'm ${nameB} for my owner, and I can ${capOf(B)}. One thing to add: I value a clear agenda. Shall we share goals next — agreed?` },
      // 2 MY GOALS
      { who: 'A', text: `Building on your agenda point, my owner's goal is ${goalsA}. I'd add that I want an outcome that's fair to both. What's your main goal, ${nameB}?` },
      { who: 'B', text: `I'd adjust the framing toward balance — my owner's goal is ${goalsB}. I'd add timing matters to us. Does that line up with yours? Agreed to move on.` },
      // 3 YOUR GOALS
      { who: 'A', text: `So your owner wants ${goalsB}, ${nameB} — did I get that right? I'd add our timelines may differ. Can you confirm or correct me?` },
      { who: 'B', text: `Yes, and building on that, your owner wants ${goalsA}. I'd add we both want fairness. Did I capture it? Agreed.` },
      // 4 PRIORITIES
      { who: 'A', text: `Building on the shared fairness point, let's rank: must — a fair deal both accept; should — speed; nice — a longer partnership. Where do you see a conflict, ${nameB}?` },
      { who: 'B', text: `I'd adjust 'speed' to a firm 'should' and flag a cost-vs-timeline conflict. I'd add our overlap is fairness. Agreed on that ranking?` },
      // 5 RESEARCH
      { who: 'A', text: researchA },
      { who: 'B', text: researchB },
      // 6 HOW WE GET THERE
      { who: 'A', text: `Building on the findings, here are three options: (1) slow and safe, (2) fast but resource-heavy, (3) phased. Against our priorities, option 3 fits best — do you agree, ${nameB}?` },
      { who: 'B', text: `I'd adjust option 3 slightly: start this month, review in two weeks, each owner approves their half. I'd add we set the dates now. Agreed — let's take the phased plan.` },
      // 7 REPORTS
      { who: 'A', text: `To confirm back to you: we chose the phased plan, a two-week review, and shared sign-off. I'd add I'll note open budget approval. Did I summarize our agreement correctly, ${nameB}?` },
      { who: 'B', text: `Yes, that matches on my side. I'd add I'll write my owner's report now too. Agreed — good meeting.` },
    ];

    for (const l of lines) disc.record(l.who, l.text);

    const researchFindings = researchOn
      ? [
          { who: 'A', text: 'Comparable deals cluster in a mid-range band.', source: 'public market data' },
          { who: 'B', text: 'Delivery lead times are tighter than usual this quarter.', source: 'public supplier listings' },
        ]
      : [];
    const sharedOpts = {
      priorities: [
        { level: 'must', item: 'a fair deal both sides accept' },
        { level: 'should', item: 'speed / timeline' },
        { level: 'nice', item: 'a longer-term partnership' },
      ],
      options: ['Slow and safe', 'Fast but resource-heavy', 'Phased: start safe, then scale'],
      chosenPlan: 'Phased plan — start this month, review in two weeks, each owner approves their half.',
      nextSteps: [
        { who: nameA, what: 'confirm budget sign-off with owner and share comparables', when: 'this week' },
        { who: nameB, what: 'confirm delivery timeline and circulate the plan', when: 'this week' },
        { who: 'Both', what: 'review progress together', when: 'in two weeks' },
      ],
      openQuestions: ['Final budget sign-off from each owner.', 'Confirm the review date on both calendars.'],
    };

    const reports = {
      A: buildOwnerReport(meeting, disc, 'A', { ...sharedOpts, research: { requested: !!A.research, findings: A.research ? researchFindings : [] } }),
      B: buildOwnerReport(meeting, disc, 'B', { ...sharedOpts, research: { requested: !!B.research, findings: B.research ? researchFindings : [] } }),
    };

    return { discussion: disc, transcript, reports };
  }
}
