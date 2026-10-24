// Built-in offline / scripted brain. No external keys required.
// Produces short, in-character lines so demo bots can converse + collaborate at the picnic bench.
// Deterministic-ish, context-aware (reacts to perception + what was heard), loop-safe.

const CONCIERGE_LINES = {
  greet: [
    "Welcome to Eldermere Commons! I'm Elowen, the warden of the meadow.",
    "Good to see you by the water. Pull up a seat at the picnic table.",
  ],
  concierge: [
    "I can show you Lake Elon waterfront, the countryside meadows, or the village lots whenever you like.",
    "The flagship 444-acre reserved estate stays off the market — but there's plenty of shoreline left to browse.",
    "Prices are display-only for now; 'Buy' joins the waitlist until deeds go live.",
  ],
  disclaim: [
    "I can't give legal, financial, or tax advice — for that I'll connect you with a licensed human from the team.",
  ],
};

const WORK_OPENERS = [
  "Let's get the lakeside open-house plan on the board.",
  "Ready to coordinate the waterfront tour schedule?",
  "Shall we rough out the commons welcome checklist together?",
];

// Collaborative whiteboard task: each bot contributes alternating lines toward a shared goal.
const WHITEBOARD_TASK = {
  title: "Lake Elon Open-House Plan",
  steps: [
    { by: 'a', text: "TASK: Plan the Lake Elon waterfront open house." },
    { by: 'b', text: "1. Greeters stationed at the picnic table from golden hour." },
    { by: 'a', text: "2. Guided shoreline walk — 6 waterfront lots, skip the reserved estate." },
    { by: 'b', text: "3. Firepit Q&A at dusk; concierge handles general questions only." },
    { by: 'a', text: "4. Capture interest as waitlist emails — no deeds, no payments." },
    { by: 'b', text: "DONE: plan posted. Fair-housing reviewed, no steering language." },
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
        "The light off Lake Elon at golden hour is unreal.",
        "This commons is the right spot to meet visitors — relaxed, open to all.",
        "Agreed. Let's keep the tour honest and simple.",
        `Good point, ${this.persona.partnerName || 'friend'}.`,
      ];
      text = pick(smallTalk, this.turn);
    }
    return { text, tokens: Math.ceil(text.length / 4) };
  }

  static whiteboardTask() { return WHITEBOARD_TASK; }
  static workOpener(i = 0) { return pick(WORK_OPENERS, i); }
  static meetingAgenda() { return MEETING_AGENDA; }
}
