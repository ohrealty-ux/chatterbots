// Demo orchestration: two bots (a concierge host + an agent) walk to the lakeside bench,
// sit facing each other, hold a short back-and-forth, and run one collaborative whiteboard task.
// Uses the OFFLINE brain so it works with no external keys. Loop-breaker caps the back-and-forth.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bots, Board, ChatLog } from '../db/db.js';
import { OfflineBrain } from '../brains/offline.js';
import { GrokBrain, grokAvailable } from '../brains/grok.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRANSCRIPT_DIR = path.join(__dirname, '..', '..', 'data', 'transcripts');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function brainFor(botRow, persona) {
  if (botRow.brain === 'grok' && grokAvailable()) return new GrokBrain(persona);
  return new OfflineBrain(persona);
}

export class DemoRunner {
  constructor(world, gateway, log) {
    this.world = world; this.gateway = gateway; this.log = log || console.log;
    this.running = false;
    this.lastTranscript = null;
  }

  async run(botIds) {
    if (this.running) return { ok: false, error: 'demo_already_running' };
    this.running = true;
    fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(TRANSCRIPT_DIR, `demo-${stamp}.txt`);
    this.lastTranscript = file;
    const transcript = [];
    const rec = (line) => { transcript.push(line); this.log('[demo] ' + line); fs.writeFileSync(file, transcript.join('\n') + '\n'); };

    try {
      const [idA, idB] = botIds;
      const botA = Bots.get(idA), botB = Bots.get(idB);
      if (!botA || !botB) { this.running = false; return { ok: false, error: 'demo_bots_missing' }; }
      const personaA = { name: botA.name, role: 'concierge', partnerName: botB.name };
      const personaB = { name: botB.name, role: 'agent', partnerName: botA.name };
      const brainA = brainFor(botA, personaA);
      const brainB = brainFor(botB, personaB);

      rec(`=== Chatter Bots demo transcript (${new Date().toISOString()}) ===`);
      rec(`Brains: ${botA.name}=${brainA.name}, ${botB.name}=${brainB.name}`);

      // 1) both join
      this.gateway.handleAction(botA, 'join', {});
      this.gateway.handleAction(botB, 'join', {});
      await sleep(300);

      // 2) walk to the lakeside bench
      this.gateway.handleAction(botA, 'move_to', { place: 'the bench' });
      this.gateway.handleAction(botB, 'move_to', { place: 'the bench' });
      rec(`${botA.name} and ${botB.name} walk to the lakeside bench at Chatter Bots Commons.`);
      await this._waitArrive(botA.id, botB.id, 9000);

      // 3) sit facing each other
      const sa = this.gateway.handleAction(botA, 'sit', { seat: 'lb-1' });
      const sb = this.gateway.handleAction(botB, 'sit', { seat: 'lb-2' });
      rec(`${botA.name} sits (${sa.seat || 'seat'}), ${botB.name} sits (${sb.seat || 'seat'}), facing each other.`);
      this.gateway.handleAction(botA, 'set_status', { status: 'working' });
      this.gateway.handleAction(botB, 'set_status', { status: 'working' });
      await sleep(400);

      // 4) back-and-forth conversation with loop breaker
      const lb = this.world.config.botDefaults.loopBreaker;
      const started = Date.now();
      let heard = null;
      const openers = [
        { bot: botA, brain: brainA, persona: personaA, mode: 'greet' },
      ];
      // opener
      {
        const { text, tokens } = await brainA.respond({ perception: this.world.perceive('bot:' + botA.id), heard: null, mode: 'greet' });
        this._budget(botA.id, tokens);
        this.gateway.handleAction(botA, 'say', { text });
        rec(`${botA.name}: ${text}`);
        heard = text;
      }
      let turn = 0;
      let speaker = botB, listener = botA, sBrain = brainB, lBrain = brainA;
      while (turn < lb.maxTurns && (Date.now() - started) < lb.maxSeconds * 1000) {
        await sleep(900);
        const perception = this.world.perceive('bot:' + speaker.id);
        const { text, tokens } = await sBrain.respond({ perception, heard, mode: 'talk' });
        const used = this._budget(speaker.id, tokens);
        if (used > this.world.config.botDefaults.dailyBrainTokenBudget) { rec(`[loop-breaker] ${speaker.name} hit daily token budget.`); break; }
        this.gateway.handleAction(speaker, 'say', { text });
        rec(`${speaker.name}: ${text}`);
        heard = text;
        // swap
        [speaker, listener] = [listener, speaker];
        [sBrain, lBrain] = [lBrain, sBrain];
        turn++;
      }
      rec(`[loop-breaker] conversation capped after ${turn + 1} turns.`);

      // 5) collaborative whiteboard task — alternate posts to the shared Project Board
      rec(`--- Work session: collaborative whiteboard ---`);
      this.gateway.handleAction(botA, 'emote', { emote: 'think' });
      const task = OfflineBrain.whiteboardTask();
      for (const step of task.steps) {
        await sleep(700);
        const who = step.by === 'a' ? botA : botB;
        Board.add('commons-board', who.name, step.text);
        // also announce in chat so it appears in the shared log + bubbles
        this.gateway.handleAction(who, 'say', { text: `[board] ${step.text}` });
        rec(`${who.name} posts to Project Board: ${step.text}`);
      }
      this.gateway.handleAction(botA, 'set_status', { status: 'done' });
      this.gateway.handleAction(botB, 'set_status', { status: 'done' });
      this.gateway.handleAction(botA, 'emote', { emote: 'cheer' });
      rec(`Both bots set status DONE. Collaborative task "${task.title}" complete.`);
      rec(`=== end transcript ===`);

      this.running = false;
      return { ok: true, transcript: file, lines: transcript.length };
    } catch (e) {
      this.running = false;
      rec(`[error] ${e.message}`);
      return { ok: false, error: e.message, transcript: file };
    }
  }

  _budget(botId, tokens) { return Bots.addTokens(botId, tokens || 0); }

  async _waitArrive(idA, idB, timeoutMs) {
    const start = Date.now();
    const target = this.world.resolvePlace('the bench') || this.world.config.commons.center;
    while (Date.now() - start < timeoutMs) {
      const a = this.world.get('bot:' + idA), b = this.world.get('bot:' + idB);
      const near = (e) => e && Math.hypot(e.pos[0] - target[0], e.pos[2] - target[2]) < 6;
      if (near(a) && near(b)) return;
      await sleep(300);
    }
  }
}
