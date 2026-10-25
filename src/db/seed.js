// Seed the lot registry (from world.config zoning) and the two demo bots with starter lots.
// Idempotent: safe to run on every boot.
import { Bots, Lots } from './db.js';
import { generateToken } from '../security/security.js';

function fiat(token, cfg) { return Math.round(token * cfg.zoning.currency.fiatPerToken); }

// Deterministic lot layout per tier, limited to a sane number of registry rows for display.
export function seedLots(cfg) {
  if (!cfg.zoning || Lots.count() > 0) return;
  const cur = cfg.zoning.currency;
  for (const tier of cfg.zoning.tiers) {
    const sellableAcres = tier.totalAcres - (tier.reservedAcres || 0);
    const totalLots = Math.floor(sellableAcres / tier.lotSizeAcres);
    // Materialize a display sample of lots (registry rows); availableCount computed separately.
    const sample = Math.min(totalLots, tier.id === 'waterfront' ? 24 : tier.id === 'countryside' ? 18 : 24);
    const [x0, z0, x1, z1] = tier.mapRect;
    const cols = Math.ceil(Math.sqrt(sample));
    for (let i = 0; i < sample; i++) {
      const r = Math.floor(i / cols), c = i % cols;
      const bx = x0 + (c + 0.5) * (x1 - x0) / cols;
      const bz = z0 + (r + 0.5) * (z1 - z0) / Math.ceil(sample / cols);
      const id = `${tier.id}-${String(i + 1).padStart(3, '0')}`;
      Lots.upsert({
        id, tier: tier.id,
        boundaries: JSON.stringify({ x: Math.round(bx), z: Math.round(bz), w: 28, h: 22 }),
        acreage: tier.lotSizeAcres,
        list_price_token: tier.pricePerLotToken,
        list_price_fiat: fiat(tier.pricePerLotToken, cfg),
        owner: null, assigned_bot: null,
        permissions: '{}', decor_layout: '[]', reserved: 0,
        label: `${tier.name} Lot ${i + 1}`,
      });
    }
  }
  // Reserved flagship estate (not for sale)
  Lots.upsert({
    id: 'waterfront-flagship', tier: 'waterfront',
    boundaries: JSON.stringify({ x: -120, z: -120, w: 90, h: 70 }),
    acreage: cfg.zoning.tiers[0].reservedAcres,
    list_price_token: 0, list_price_fiat: 0,
    owner: 'eldermere', assigned_bot: null, permissions: '{}', decor_layout: '[]',
    reserved: 1, label: cfg.zoning.tiers[0].reservedName,
  });
}

// Compute available lot counts = sellable acreage / lot size, per tier.
export function tierSummary(cfg) {
  return cfg.zoning.tiers.map(t => {
    const sellableAcres = t.totalAcres - (t.reservedAcres || 0);
    const totalLots = Math.floor(sellableAcres / t.lotSizeAcres);
    const sold = Lots.byTier(t.id).filter(l => l.owner && !l.reserved).length;
    return {
      id: t.id, name: t.name, blurb: t.blurb, color: t.color,
      totalAcres: t.totalAcres, reservedAcres: t.reservedAcres || 0, reservedName: t.reservedName || null,
      lotSizeAcres: t.lotSizeAcres,
      pricePerLotToken: t.pricePerLotToken,
      pricePerLotFiat: fiat(t.pricePerLotToken, cfg),
      availableLots: totalLots - sold, totalLots,
    };
  });
}

// Create two demo bots if absent. Returns their fresh plaintext tokens ONCE (for logging to RUN only).
export function seedDemoBots(cfg) {
  const want = [
    { id: 'elowen', name: 'Elowen (Host)', avatar: null, brain: 'offline', owner: 'eldermere', home_lot: 'waterfront-001' },
    { id: 'fenn', name: 'Fenn', avatar: null, brain: 'offline', owner: 'eldermere', home_lot: 'countryside-001' },
  ];
  const created = [];
  for (const w of want) {
    let bot = Bots.get(w.id);
    if (!bot) {
      const tok = generateToken();
      Bots.upsert({ id: w.id, name: w.name, avatar: w.avatar, home_lot: w.home_lot, status: 'idle',
        token_hash: tok.hash, token_prefix: tok.prefix, scopes: 'join,move,say,emote,status,sit,look,follow,enter_lot,place_object',
        owner: w.owner, brain: w.brain, created_at: Date.now() });
      // assign starter lot + small office
      const lot = Lots.get(w.home_lot);
      if (lot) {
        Lots.assignBot(lot.id, w.id);
        Lots.setDecor(lot.id, [
          { type: 'desk', pos: [0, 0, 0], rot: 0 },
          { type: 'project_board', pos: [2, 0, -1], rot: 0 },
          { type: 'name_sign', pos: [-2, 0, 1], rot: 0 },
          { type: 'status_lantern', pos: [1, 0, 2], rot: 0 },
        ]);
      }
      created.push({ id: w.id, name: w.name, token: tok.raw });
    }
  }
  return created;
}
