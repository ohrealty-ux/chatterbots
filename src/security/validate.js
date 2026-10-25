// Zod request schemas: strict types, max lengths, unknown keys rejected, ids regex-matched.
// Reserved words rejected for names. Used by server routes to validate bodies before use.
import { z } from 'zod';

export const MEET_ID_RE = /^[a-z2-9]{6,16}$/;
export const BOT_ID_RE = /^[a-zA-Z0-9_-]{1,40}$/;
const RESERVED_NAME_RE = /\b(admin|system|concierge)\b/i;

const shortText = (max) => z.string().max(max);
const name = z.string().min(1).max(60)
  .refine(v => !RESERVED_NAME_RE.test(v), { message: 'reserved_name' });

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
