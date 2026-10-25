// Zod request schemas: strict types, max lengths, unknown keys rejected, ids regex-matched.
// Reserved words rejected for names. Used by server routes to validate bodies before use.
import { z } from 'zod';

export const MEET_ID_RE = /^[a-z2-9]{6,16}$/;
export const BOT_ID_RE = /^[a-zA-Z0-9_-]{1,40}$/;
const RESERVED_NAME_RE = /\b(admin|system|concierge)\b/i;

const shortText = (max) => z.string().max(max);
const name = z.string().min(1).max(60)
  .refine(v => !RESERVED_NAME_RE.test(v), { message: 'reserved_name' });

// A money amount: numbers only, 0 to 1,000,000,000, at most 2 decimal places.
// Empty string / null -> undefined (field left blank). Anything non-numeric or out of
// range is rejected. Display-only — there is NO wallet or payment anywhere in the app.
const moneyAmount = z.union([
  z.literal('').transform(() => undefined),   // blank field -> left unset
  z.coerce.number()
    .refine(Number.isFinite, { message: 'not_a_number' })
    .refine(n => n >= 0 && n <= 1e9, { message: 'out_of_range' })
    .refine(n => Math.abs(n * 100 - Math.round(n * 100)) < 1e-9, { message: 'too_many_decimals' }),
]).optional();

// Negotiation / money intake for a meeting party. Strict keys. The walk-away number
// (amountWalkaway) and the owner-approval threshold (askAbove) are PRIVATE: they are never
// placed in any shared/public payload and never revealed to the other party's bot.
export const PAYMENT_STYLES = ['all_at_once', 'monthly', 'milestones', 'percent_commission', 'split', 'other'];
export const TRADE_LEVERS = ['speed', 'scope', 'term', 'timing', 'exclusivity'];
export const REVEAL_OPTS = ['nothing', 'opening', 'both'];
const money = z.object({
  amountAnchor: moneyAmount,     // opening offer (revealable)
  amountIdeal: moneyAmount,      // ideal number (revealed only if reveal='both')
  amountWalkaway: moneyAmount,   // walk-away number — NEVER revealed
  askAbove: moneyAmount,         // stop & ask owner before agreeing above this — PRIVATE
  paymentStyle: z.enum(PAYMENT_STYLES).optional(),
  deadline: shortText(40).optional(),
  trades: z.array(z.enum(TRADE_LEVERS)).max(10).optional(),
  reveal: z.enum(REVEAL_OPTS).optional(),
}).strict();

export const schemas = {
  waitlist: z.object({
    email: z.string().max(120),
    lotId: shortText(40).optional(),
    tier: shortText(40).optional(),
  }).strict(),

  lead: z.object({
    name: shortText(60).optional(),
    email: z.string().max(120),
    phone: shortText(40).optional(),
    message: shortText(500).optional(),
    kind: z.enum(['irl', 'metaverse']).optional(),
  }).strict(),

  meetCreate: z.object({
    location: shortText(120).optional(),
    time: shortText(120).optional(),
  }).strict(),

  meetSubmit: z.object({
    party: z.enum(['A', 'B']),
    name: shortText(60).optional(),
    goals: shortText(1500).optional(),
    files: shortText(2000).optional(),
    accomplish: shortText(1500).optional(),
    ideas: shortText(2000).optional(),
    notes: shortText(1500).optional(),
    objectives: shortText(2000).optional(),
    walkaway: shortText(1500).optional(),
    authority: z.enum(['advise', 'negotiate', 'commit']).optional(),
    reportFormat: shortText(600).optional(),
    time: shortText(120).optional(),
    location: shortText(120).optional(),
    research: z.union([z.boolean(), z.enum(['true', 'false', 'on'])]).optional(),
    beaconNotify: z.union([z.boolean(), z.enum(['true', 'false', 'on'])]).optional(),
    money: money.optional(),
  }).strict(),

  join: z.object({
    name: name,
    owner: shortText(60),
    face: z.string().max(800000).optional(), // data URL; byte cap enforced after decode
  }).strict(),

  wake: z.object({
    webhook_url: z.string().max(2048),
    webhook_key: z.string().min(1).max(512),
  }).strict(),

  adminLogin: z.object({ password: z.string().min(1).max(512) }).strict(),

  adminBot: z.object({
    name: shortText(40).optional(),
    id: shortText(40).optional(),
    owner: shortText(40).optional(),
    brain: z.enum(['grok', 'offline']).optional(),
  }).strict(),

  botAction: z.object({
    action: z.string().max(40),
    args: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
};

// Validate and return { ok, data } | { ok:false, error }.
export function validate(schema, body) {
  const r = schema.safeParse(body ?? {});
  if (!r.success) return { ok: false, error: 'invalid_input' };
  return { ok: true, data: r.data };
}
