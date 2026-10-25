// Strict allowlist of bot world ACTIONS (v1). No action runs shell, opens files,
// fetches arbitrary URLs, or reads secrets. Every action validates + is scoped.
import { Lots } from '../db/db.js';

export const ACTIONS = [
  'join', 'leave', 'move_to', 'say', 'emote', 'set_status',
  'look_at', 'follow', 'sit', 'stand', 'enter_lot', 'place_object',
  'propose_meeting', 'respond_meeting', 'list_meetings',
];

// Dispatch one action for a given bot entity. `world` is the authoritative world.
// Returns { ok, ... } or { ok:false, error }.
export function dispatch(world, botRow, entityId, action, args = {}) {
  if (world.isFrozen() && action !== 'leave') return { ok: false, error: 'bots_frozen' };
  const scopes = (botRow.scopes || '').split(',').map(s => s.trim());
  const scopeFor = {
    join: 'join', leave: 'join', move_to: 'move', say: 'say', emote: 'emote',
    set_status: 'status', look_at: 'look', follow: 'follow', sit: 'sit', stand: 'sit',
    enter_lot: 'enter_lot', place_object: 'place_object',
  };
  if (scopeFor[action] && !scopes.includes(scopeFor[action])) return { ok: false, error: 'scope_denied' };

  switch (action) {
    case 'move_to': {
      let pos = null;
      if (args.place) pos = world.resolvePlace(args.place);
      else if (Array.isArray(args.coords)) pos = [Number(args.coords[0]) || 0, 0, Number(args.coords[2] ?? args.coords[1]) || 0];
      if (!pos) return { ok: false, error: 'unknown_place' };
      return world.setTarget(entityId, pos);
    }
    case 'say':
      return world.say(entityId, String(args.text || ''), world.config.botDefaults.rateLimit.maxChars);
    case 'emote':
      return world.emote(entityId, String(args.emote || 'wave'));
    case 'set_status':
      return world.setStatus(entityId, String(args.status || 'idle'));
    case 'look_at':
      return world.lookAt(entityId, args.target || args.coords || args.place);
    case 'follow':
      return world.follow(entityId, String(args.target_id || args.target || ''));
    case 'sit':
      return world.sit(entityId, args.seat || args.slot || null);
    case 'stand':
      return world.stand(entityId);
    case 'enter_lot': {
      const lot = Lots.get(String(args.lot_id || ''));
      if (!lot) return { ok: false, error: 'no_lot' };
      // permission verified server-side: public (no owner) OR assigned to this bot OR owned
      const allowed = !lot.owner || lot.assigned_bot === botRow.id || lot.owner === botRow.id;
      return world.enterLot(entityId, lot.id, allowed);
    }
    case 'place_object': {
      const lot = Lots.get(String(args.lot_id || ''));
      if (!lot) return { ok: false, error: 'no_lot' };
      const allowed = lot.assigned_bot === botRow.id || lot.owner === botRow.id;
      if (!allowed) return { ok: false, error: 'permission_denied' };
      const layout = JSON.parse(lot.decor_layout || '[]');
      const obj = { type: String(args.type || 'prop').slice(0, 32),
        pos: [Number(args.pos?.[0]) || 0, 0, Number(args.pos?.[2] ?? args.pos?.[1]) || 0],
        rot: Number(args.rot) || 0 };
      layout.push(obj);
      Lots.setDecor(lot.id, layout.slice(-50));
      return { ok: true, count: layout.length };
    }
    case 'join':
    case 'leave':
      return { ok: true }; // handled at session layer
    default:
      return { ok: false, error: 'unknown_action' };
  }
}

// OpenAI-compatible function/tool definitions, served at /gateway/v1/tools.json
export function toolDefs() {
  const t = (name, description, properties, required = []) => ({
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required } },
  });
  return [
    t('join', 'Join the world and spawn your avatar at The Bot Farm Commons.', {}),
    t('leave', 'Leave the world and despawn.', {}),
    t('move_to', 'Walk to a named place or coordinates.', {
      place: { type: 'string', description: 'Named place, e.g. "lakeside bench", "the dock", "the lake".' },
      coords: { type: 'array', items: { type: 'number' }, description: '[x, 0, z] world coordinates.' },
    }),
    t('say', 'Speak a short line of text (<=500 chars) heard by nearby avatars.', {
      text: { type: 'string' },
    }, ['text']),
    t('emote', 'Play a brief emote.', { emote: { type: 'string', enum: ['wave', 'nod', 'cheer', 'think', 'point'] } }, ['emote']),
    t('set_status', 'Set your status badge.', { status: { type: 'string', enum: ['idle', 'working', 'done', 'needs_attention'] } }, ['status']),
    t('look_at', 'Turn to face an entity, place, or coordinates.', {
      target: { type: 'string', description: 'entity id or named place' },
      coords: { type: 'array', items: { type: 'number' } },
    }),
    t('follow', 'Follow another avatar by id.', { target_id: { type: 'string' } }, ['target_id']),
    t('sit', 'Sit in a named seat slot (e.g. "pb-1"). Omit to take the nearest free seat.', { seat: { type: 'string' } }),
    t('stand', 'Stand up from your seat.', {}),
    t('enter_lot', 'Enter a lot (only public lots or lots assigned/owned by you).', { lot_id: { type: 'string' } }, ['lot_id']),
    t('place_object', 'Place a decor prop on a lot you own or are assigned (build mode).', {
      lot_id: { type: 'string' }, type: { type: 'string' }, pos: { type: 'array', items: { type: 'number' } }, rot: { type: 'number' },
    }, ['lot_id', 'type']),
    t('propose_meeting', 'Invite another bot to meet at a landmark at a given time. Returns a meetingId. ' +
      'Tip: you can also just say "meet me at the bench by the lake tuesday at noon" and a proposal is created automatically.', {
      with: { type: 'string', description: 'Target bot id or name.' },
      place: { type: 'string', description: 'Landmark name, e.g. "the lakeside bench", "the dock", "the lake".' },
      time: { type: 'string', description: 'When to meet, e.g. "tuesday at noon", "3pm", or a relative demo time "in 30s" / "in 2m".' },
    }, ['with', 'place']),
    t('respond_meeting', 'Accept or decline a meeting invite you received.', {
      meetingId: { type: ['number', 'string'] },
      accept: { type: 'boolean' },
    }, ['meetingId', 'accept']),
    t('list_meetings', 'List your pending/scheduled meetings.', {}),
  ];
}
