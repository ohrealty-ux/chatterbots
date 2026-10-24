// Standalone, headless RENDEZVOUS demo (no browser, no server, no API key).
// Proves the full bot-to-bot meeting flow end to end:
//   propose -> accept -> scheduler fires -> both travel -> sit -> business discussion
//   -> agreement posted to the Project Board -> meeting marked done.
// A transcript of every step is saved to data/transcripts/.
//
// Run:  node src/world/meetingDemo.js        (or: npm run demo:meeting)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Run against a DEDICATED demo database by default so this never shares (or pollutes) the live
// server's world.db — sharing the SQLite file across processes is what trips better-sqlite3's
// teardown assertion on Node 24. Must be set BEFORE db.js is imported, so the db-touching
// modules are loaded dynamically inside main() below.
process.env.WORLD_DB = process.env.WORLD_DB || 'meeting-demo.db';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const TRANSCRIPT_DIR = path.join(ROOT, 'data', 'transcripts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { World } = await import('./world.js');
  const { Gateway } = await import('../gateway/gateway.js');
  const { RendezvousManager } = await import('../gateway/rendezvous.js');
  const { Meetings, Board, Bots, closeDb } = await import('../db/db.js');
  const { seedLots, seedDemoBots } = await import('../db/seed.js');

  // 1) Config (brand-neutral base is enough — this demo never loads the brokerage overlay).
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'world.config.json'), 'utf8'));

  // 2) Seed lots + demo bots (idempotent; creates elowen/fenn if missing).
  seedLots(config);
  seedDemoBots(config);

  // 3) Build the world, gateway and rendezvous manager (same wiring as server.js).
  const world = new World(config);
  const gateway = new Gateway(world);
  const rendezvous = new RendezvousManager(world, gateway, (...a) => {});
  gateway.rendezvous = rendezvous;

  // 4) Transcript capture: every rendezvous log line is persisted + echoed.
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(TRANSCRIPT_DIR, `meeting-${stamp}.txt`);
  const transcript = [];
  const rec = (line) => { transcript.push(line); console.log('[meeting-demo] ' + line); fs.writeFileSync(file, transcript.join('\n') + '\n'); };
  rendezvous.on('log', ({ line }) => rec(line));

  rec(`=== Eldermere RENDEZVOUS demo transcript (${new Date().toISOString()}) ===`);
  rec(`Both bots use the OFFLINE brain (no API key required).`);

  // 5) Make sure both bots are in the world.
  const A = 'elowen', B = 'fenn';
  const botA = Bots.get(A), botB = Bots.get(B);
  if (!botA || !botB) { rec(`[fatal] demo bots missing (${A}/${B}) — seeding did not run`); process.exit(1); }
  gateway.handleAction(botA, 'join', {});
  gateway.handleAction(botB, 'join', {});

  // 6) Bot A proposes a meeting to bot B "at the bench at Lake Elon", a few seconds out.
  rec(`--- Proposing meeting ---`);
  const prop = rendezvous.propose({ fromBotId: A, withRef: 'Fenn', place: 'the bench at lake elon', time: 'in 3s' });
  if (!prop.ok) { rec(`[fatal] propose failed: ${prop.error}`); process.exit(1); }
  const meetingId = prop.meetingId;

  // 7) Bot B accepts.
  rec(`--- Responding to meeting ---`);
  const resp = rendezvous.respond({ botId: B, meetingId, accept: true });
  if (!resp.ok) { rec(`[fatal] respond failed: ${resp.error}`); process.exit(1); }

  // list_meetings sanity check
  const open = rendezvous.list(A);
  rec(`list_meetings(${A}) -> ${JSON.stringify(open)}`);

  // 8) Wait for the scheduler to fire the accepted meeting and run it to completion.
  rec(`--- Waiting for scheduler to fire meeting #${meetingId} ---`);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const m = Meetings.get(meetingId);
    if (m && m.status === 'done') break;
    await sleep(500);
  }
  const final = Meetings.get(meetingId);
  rec(`Meeting #${meetingId} final status: ${final ? final.status : 'missing'}.`);

  // 9) Show what landed on the Project Board.
  rec(`--- Project Board (commons-board) latest posts ---`);
  for (const p of Board.byBoard('commons-board', 6)) rec(`[board] ${p.author}: ${p.text}`);

  rec(`=== end transcript ===`);
  rendezvous.stop();

  const ok = final && final.status === 'done';
  console.log('\nTranscript saved to:', file);
  console.log('Result:', ok ? 'PASS (meeting completed end to end)' : 'FAIL (meeting did not reach done)');
  // Clean shutdown. better-sqlite3 on Node 24 can trip a cleanup-hook assertion if transient
  // Statement wrappers are GC'd during process teardown (env already gone). Running GC now,
  // while the environment is still alive, retires those destructors safely; then close the DB
  // and hard-exit. (All proof — transcript + board posts — is already persisted above.)
  if (typeof global.gc === 'function') { global.gc(); global.gc(); }
  closeDb();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('[meeting-demo] fatal:', e); process.exit(1); });
