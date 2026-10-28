/**
 * What fairshoe-verify does, without files or a terminal (the page in web/ runs the same code): sort JSON values into
 * one bundle (what the player kept, what the server revealed), run the verifiers on everything in it and report every
 * check as provable, ok (but not provable), failed or pending (not checkable yet), with the reasons. The whole bundle
 * is provable only when at least one shoe, proof or pair was checked and every check is provable; a bundle whose
 * shoes and proofs all wait for their reveal is pending. A pending shoe or proof is still checked for what it binds
 * already (verifyShoeCommit, verifyProofBinding): a contradiction with the kept pair fails before any reveal.
 *
 * A bundle is an object with any of these keys (all optional, at least one record to check):
 *
 *   kept     PairSeen        the pair as the player kept it before sending the client seed, with that seed
 *   own      PlayerRecords   the player's own records of that pair (proofs and shoes received, nonce, cuts, hands, tables)
 *   pairs    [PairSeen]      other kept pairs of the game (earlier pairs whose shoes dealt rounds of this one)
 *   seed     SeedReveal      the pair's reveal
 *   proofs   [RoundProof]    the pair's round proofs
 *   shoes    [ShoeRecord]    shoes ({ commit, reveal }) of the pair's chains and of earlier pairs that dealt its rounds
 *   later    [RoundProof]    proofs of later pairs dealt from this pair's shoes after the rotation
 *   records  PairRecords     the server's list of the pair's proofs and shoes
 *   note     string          a comment, ignored
 *
 * A value may also be one record as a server hands it out (a round proof, a shoe record, a reveal, a record list) or
 * an array of them. Several values make one bundle: lists are joined, a record given twice must be the same.
 */
import {
  ALG,
  LIB,
  verifyPair,
  verifyProofBinding,
  verifyRound,
  verifySeedReveal,
  verifyShoe,
  verifyShoeCommit,
  type PairRecords,
  type PairSeen,
  type PlayerRecords,
  type RoundProof,
  type SeedReveal,
  type ShoeRecord,
} from '../src/index.ts';

export interface Bundle {
  kept?: PairSeen;
  own?: PlayerRecords;
  pairs?: PairSeen[];
  seed?: SeedReveal;
  proofs?: RoundProof[];
  shoes?: ShoeRecord[];
  later?: RoundProof[];
  /** Earlier verified payout records for carry/Portfolio continuity. */
  prior?: RoundProof[];
  records?: PairRecords;
}

const SINGLE = ['kept', 'own', 'seed', 'records'] as const;
const LISTS = ['pairs', 'proofs', 'shoes', 'later', 'prior'] as const;
const KEYS: readonly string[] = [...SINGLE, ...LISTS, 'note'];

/** The input cannot be read as a bundle (exit code 3): nothing was verified. */
export class InputError extends Error {}

/** provable: ok and bound to the player's records; ok: the records agree, not provable; pending: not checkable yet. */
export type Status = 'provable' | 'ok' | 'failed' | 'pending';

export interface Check {
  kind: 'kept' | 'reveal' | 'shoe' | 'proof' | 'pair' | 'records';
  id: string;
  /** What was checked, for a reader. */
  label: string;
  status: Status;
  ok: boolean;
  /** null: the check has no such notion (a reveal on its own, a missing kept pair). */
  provable: boolean | null;
  errors: string[];
  /** While ok: what is missing for provable. */
  unproven: string[];
}

export interface Report {
  alg: string;
  lib: string;
  /** pending: no shoe, proof or pair could be checked yet (nothing failed). */
  status: Status;
  ok: boolean;
  provable: boolean;
  checks: Check[];
}

/** Exit codes of fairshoe-verify: ok and pending share 2 (not provable, nothing failed); 4 is a fault of the verifier itself. */
export const EXIT = { provable: 0, failed: 1, ok: 2, pending: 2, input: 3, internal: 4 } as const;

// ------------------------------------------------------------------------------------------------ input

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** JSON with sorted keys: the same record in two files compares equal whatever the key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

const isIds = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === 'string');

type RecordKind = 'proof' | 'shoe' | 'seed' | 'records';

/** What a single record is, by its fields. */
function recordKind(v: Obj): RecordKind | null {
  const keys = Object.keys(v);
  if (Array.isArray(v.steps) && typeof v.seedId === 'string') return 'proof';
  if (isObj(v.commit) && keys.every((k) => k === 'commit' || k === 'reveal')) return 'shoe';
  if (typeof v.serverSeed === 'string' && typeof v.lastNonce === 'number' && typeof v.seedId === 'string') return 'seed';
  if (typeof v.seedId === 'string' && isIds(v.proofs) && isIds(v.shoes)) return 'records';
  return null;
}

const idOf = {
  pairs: (p: unknown) => String((p as Obj)?.seedId),
  proofs: (p: unknown) => String((p as Obj)?.id),
  later: (p: unknown) => String((p as Obj)?.id),
  prior: (p: unknown) => String((p as Obj)?.id),
  shoes: (s: unknown) => String(((s as Obj)?.commit as Obj | undefined)?.shoe),
};

/** What each list holds, at least: an entry without it is an input error, not a record to check. */
const ENTRY: Record<(typeof LISTS)[number], string> = {
  pairs: 'a kept pair (no "seedId")',
  proofs: 'a round proof (no "id", "seedId" or "steps")',
  later: 'a round proof (no "id", "seedId" or "steps")',
  prior: 'a round proof (no "id", "seedId" or "steps")',
  shoes: 'a shoe record (no "commit")',
};

function fits(key: (typeof LISTS)[number], v: Obj): boolean {
  if (key === 'pairs') return typeof v.seedId === 'string';
  if (key === 'shoes') return isObj(v.commit);
  return typeof v.id === 'string' && typeof v.seedId === 'string' && Array.isArray(v.steps);
}

const WHAT: Record<string, string> = {
  kept: 'kept pair',
  own: 'set of own records',
  seed: 'reveal',
  records: 'record list',
  pairs: 'kept pair',
  proofs: 'proof',
  later: 'proof',
  prior: 'proof',
  shoes: 'shoe',
};

/**
 * One bundle from JSON values (`name`: where each came from, for the messages). Throws InputError for a value that is
 * neither a bundle nor a record, for a field of the wrong kind and for two different values of one record.
 */
export function collect(inputs: ReadonlyArray<{ name: string; value: unknown }>): Bundle {
  const out: Record<string, unknown> = {};
  const from = new Map<string, string>();
  const single = (key: (typeof SINGLE)[number], value: unknown, name: string): void => {
    if (!isObj(value)) throw new InputError(`${name}: "${key}" is not an object`);
    if (key === 'records' && (!isIds(value.proofs) || !isIds(value.shoes))) throw new InputError(`${name}: a record list needs "proofs" and "shoes", lists of ids`);
    const had = out[key];
    if (had !== undefined && canonical(had) !== canonical(value))
      throw new InputError(`${name}: a second ${WHAT[key]} that differs from the one in ${from.get(key)}: verify one pair at a time`);
    if (had === undefined) {
      out[key] = value;
      from.set(key, name);
    }
  };
  const list = (key: (typeof LISTS)[number], values: unknown, name: string): void => {
    if (!Array.isArray(values)) throw new InputError(`${name}: "${key}" is not an array`);
    const have = (out[key] ??= []) as unknown[];
    for (const v of values) {
      if (!isObj(v)) throw new InputError(`${name}: an entry of "${key}" is not an object`);
      if (!fits(key, v)) throw new InputError(`${name}: an entry of "${key}" is not ${ENTRY[key]}`);
      const id = idOf[key](v);
      const twin = have.find((x) => idOf[key](x) === id);
      if (twin === undefined) {
        have.push(v);
        from.set(`${key}:${id}`, name);
      } else if (canonical(twin) !== canonical(v)) throw new InputError(`${name}: ${WHAT[key]} ${id} differs from the one in ${from.get(`${key}:${id}`)}`);
    }
  };
  const take = (value: unknown, name: string, nested: boolean): void => {
    if (Array.isArray(value)) {
      if (nested) throw new InputError(`${name}: an array inside an array`);
      value.forEach((v, i) => take(v, `${name}[${i}]`, true));
      return;
    }
    if (!isObj(value)) throw new InputError(`${name}: neither a bundle nor a record of ${ALG}`);
    const keys = Object.keys(value);
    if (keys.length > 0 && keys.every((k) => KEYS.includes(k))) {
      if (nested) throw new InputError(`${name}: a bundle inside an array`);
      for (const k of SINGLE) if (value[k] !== undefined) single(k, value[k], name);
      for (const k of LISTS) if (value[k] !== undefined) list(k, value[k], name);
      return;
    }
    const kind = recordKind(value);
    if (kind === 'proof') list('proofs', [value], name);
    else if (kind === 'shoe') list('shoes', [value], name);
    else if (kind === 'seed') single('seed', value, name);
    else if (kind === 'records') single('records', value, name);
    else {
      const unknown = keys.filter((k) => !KEYS.includes(k));
      const not = unknown.length > 0 ? `; not ${unknown.slice(0, 5).join(', ')}` : '';
      throw new InputError(`${name}: neither a bundle (keys ${KEYS.join(', ')}${not}) nor a record of ${ALG}`);
    }
  };
  for (const { name, value } of inputs) take(value, name, false);
  const b = out as Bundle;
  if (!b.seed && !b.proofs?.length && !b.shoes?.length) throw new InputError('nothing to verify: no reveal, no proof, no shoe');
  return b;
}

// ------------------------------------------------------------------------------------------------ checks

function statusOf(ok: boolean, provable: boolean | null): Status {
  return !ok ? 'failed' : provable === false ? 'ok' : 'provable';
}

const NO_KEPT = 'the pair as kept before the client seed was sent is not given';

function shoeLabel(s: ShoeRecord): string {
  const c = (s?.commit ?? {}) as Partial<ShoeRecord['commit']>;
  const r = s?.reveal;
  const base = `shoe ${String(c.shoe)} (${String(c.gameId)} table ${String(c.table)}, shoe ${String(c.shoeNo)}`;
  if (!r) return `${base}, still in play: checkable once it is over)`;
  const cut = r.cut ? `cut ${String(r.cut.at)} by ${String(r.cut.by)}` : 'no cut';
  const hands = Array.isArray(r.rounds) ? r.rounds.length : 0;
  return `${base}, ${String(r.status)}, ${cut}, ${hands} ${hands === 1 ? 'hand' : 'hands'})`;
}

function proofLabel(p: RoundProof, outcome: string | null): string {
  const steps = Array.isArray(p?.steps) ? p.steps : [];
  const nonces = steps.length === 0 ? 'no nonce' : `${steps.length === 1 ? 'nonce' : 'nonces'} ${steps.map((s) => String(s?.nonce)).join(', ')}`;
  const what = p?.roundId === null ? 'steps outside a round' : `round ${String(p?.roundId)}`;
  return `proof ${String(p?.id)} (${String(p?.gameId)} ${what}, ${nonces}${outcome ? `, ${outcome}` : ''})`;
}

function outcomeText(p: RoundProof, checked: boolean, summary: string | null): string | null {
  if ((p?.outcome as { void?: unknown } | null)?.void === true) return 'void round';
  if (p?.roundId === null || p?.outcome === null) return null;
  if (checked) return `outcome checked: ${summary ?? ''}`.trim();
  // A partly mapped game says what it compared (solo blackjack: its cards; a baccarat variant: its tableau).
  return summary ? `outcome not checked: ${summary}` : 'outcome not checked: no mapping for this game yet (its draws and cards are checked)';
}

/**
 * Runs the verifiers on everything in the bundle: each shoe (with the player's cut and hands of it), each proof (with
 * its pair's server seed), the reveal, the pair with everything on record, and the server's record list against the
 * records given. Without a kept pair the reveal stands in for it: the records are checked against each other, nothing
 * is provable.
 */
export function verifyBundle(b: Bundle): Report {
  const checks: Check[] = [];
  const seed = b.seed ?? null;
  const own = b.own;
  const shoes = b.shoes ?? [];
  const proofs = b.proofs ?? [];
  const later = b.later ?? [];
  const prior = b.prior ?? [];
  const payoutPool = [...proofs, ...later, ...prior];
  const loungeOnly = proofs.length > 0 && proofs.every((p) => p.lounge !== undefined) && !seed && shoes.length === 0;
  const pairs = b.pairs ?? [];
  // Stand-in from the reveal: the server's word, so it binds nothing.
  const stand: PairSeen | null =
    !b.kept && seed
      ? { seedId: seed.seedId, gameId: seed.gameId, serverSeedHash: seed.serverSeedHash, root: seed.root, clientSeed: seed.clientSeed, clientSeedBy: seed.clientSeedBy, committedAt: seed.committedAt, clientSeedAt: seed.clientSeedAt }
      : null;
  const kept = b.kept ?? stand;
  // The kept pair with its reveal time once revealed (no shoe of its chains is committed after it), as verifyPair does.
  const main: PairSeen | null = kept && seed && seed.seedId === kept.seedId ? { ...kept, revealedAt: kept.revealedAt ?? seed.revealedAt } : kept;
  const all: PairSeen[] = [...(main ? [main] : []), ...pairs.filter((p) => p?.seedId !== main?.seedId)];
  const keptOf = (seedId: unknown): PairSeen | undefined => all.find((p) => p?.seedId === seedId);
  const add = (c: Check): void => {
    checks.push(c);
  };

  if (!b.kept && !loungeOnly)
    add({
      kind: 'kept',
      id: '',
      label: 'kept pair',
      status: 'ok',
      ok: true,
      provable: null,
      errors: [],
      unproven: [stand ? `${NO_KEPT}: the records are checked against the reveal, which is the server's word` : `${NO_KEPT}: nothing is bound to what the player saw`],
    });

  for (const s of shoes) {
    const id = String(s?.commit?.shoe);
    if (!s?.reveal) {
      // Still in play: its commitment against the kept pair of its chain already.
      const r = verifyShoeCommit(s.commit, { pair: keptOf(s.commit?.origin?.seedId) ?? null });
      add({ kind: 'shoe', id, label: shoeLabel(s), status: r.ok ? 'pending' : 'failed', ok: r.ok, provable: null, errors: r.errors, unproven: r.unproven });
      continue;
    }
    const expectedCut = own?.cuts?.[id];
    const hands = own?.hands?.[id];
    const r = verifyShoe(s.commit, s.reveal, {
      pair: keptOf(s.commit?.origin?.seedId) as PairSeen,
      expectedRules: own?.shoeRules?.[id], shuffles: own?.shuffles?.[id], refused: own?.refused?.[id],
      ...(expectedCut !== undefined ? { expectedCut } : {}),
      ...(hands !== undefined ? { hands } : {}),
    });
    add({ kind: 'shoe', id, label: shoeLabel(s), status: statusOf(r.ok, r.provable), ok: r.ok, provable: r.provable, errors: r.errors, unproven: r.unproven ?? [] });
  }

  for (const p of [...proofs, ...later]) {
    const id = String(p?.id);
    const serverSeed = p?.serverSeed ?? (seed && seed.seedId === p?.seedId ? seed.serverSeed : null);
    if ((serverSeed === null || serverSeed === undefined) && !p.lounge) {
      // Not revealed yet: what it binds against the kept pair already.
      const r = verifyProofBinding(p, { pair: keptOf(p?.seedId) ?? null, pairs: all });
      add({ kind: 'proof', id, label: proofLabel(p, 'server seed not revealed yet: checkable after the rotation'), status: r.ok ? 'pending' : 'failed', ok: r.ok, provable: null, errors: r.errors, unproven: r.unproven });
      continue;
    }
    const pair = keptOf(p?.seedId);
    const r = verifyRound(p, serverSeed, { ...(pair ? { pair } : {}), shoes, pairs: all, prior: payoutPool, ...(own ? { own } : {}) });
    add({
      kind: 'proof',
      id,
      label: proofLabel(p, r.outcome.payoutsChecked ? `payouts checked: ${r.outcome.summary ?? ''}` : outcomeText(p, r.outcome.checked, r.outcome.summary)),
      status: statusOf(r.ok, r.provable),
      ok: r.ok,
      provable: r.provable,
      errors: r.errors,
      unproven: r.unproven ?? [],
    });
  }

  if (seed) {
    const r = verifySeedReveal(seed);
    add({ kind: 'reveal', id: String(seed.seedId), label: `reveal ${String(seed.seedId)} (${String(seed.gameId)})`, status: r.ok ? 'ok' : 'failed', ok: r.ok, provable: null, errors: r.errors, unproven: [] });
    if (kept) {
      const r2 = verifyPair(seed, proofs, shoes, { pair: kept, pairs, prior, ...(later.length ? { later } : {}), ...(own ? { own } : {}) });
      const n = r2.counts;
      const label =
        `pair ${String(seed.seedId)} (${String(seed.gameId)}): ${n.proofs} ${n.proofs === 1 ? 'proof' : 'proofs'}, ${n.steps} ${n.steps === 1 ? 'step' : 'steps'}` +
        `${n.discarded ? ` (${n.discarded} discarded)` : ''}${n.voided ? `, ${n.voided} void` : ''}, ${n.shoes} ${n.shoes === 1 ? 'shoe' : 'shoes'}` +
        `${n.running ? ` (${n.running} in play)` : ''}${n.free ? `, ${n.free} free ${n.free === 1 ? 'hand' : 'hands'}` : ''}`;
      add({ kind: 'pair', id: String(seed.seedId), label, status: statusOf(r2.ok, r2.provable), ok: r2.ok, provable: r2.provable, errors: r2.errors, unproven: r2.unproven ?? [] });
    }
  } else if (b.kept) {
    add({ kind: 'pair', id: String(b.kept.seedId), label: `pair ${String(b.kept.seedId)} (${String(b.kept.gameId)}): not revealed yet, checkable after the rotation`, status: 'pending', ok: true, provable: null, errors: [], unproven: [] });
  }

  if (b.records) {
    const rec = b.records;
    const errors: string[] = [];
    const unproven: string[] = [];
    const pairId = seed?.seedId ?? b.kept?.seedId;
    if (pairId !== undefined && rec.seedId !== pairId) errors.push(`the record list is of pair ${String(rec.seedId)}, the records given of ${String(pairId)}`);
    const proofIds = new Set(proofs.map((p) => p?.id));
    const shoeIds = new Set(shoes.filter((s) => s?.commit?.origin?.seedId === rec.seedId).map((s) => s?.commit?.shoe));
    for (const id of rec.proofs) if (!proofIds.has(id)) unproven.push(`the server lists proof ${id}: not given here`);
    for (const id of rec.shoes) if (!shoeIds.has(id)) unproven.push(`the server lists shoe ${id}: not given here`);
    for (const p of proofs) if (p?.seedId === rec.seedId && !rec.proofs.includes(p.id)) errors.push(`proof ${String(p.id)} of the pair is not in the server's list`);
    for (const id of shoeIds) if (!rec.shoes.includes(id as string)) errors.push(`shoe ${String(id)} of the pair's chains is not in the server's list`);
    const ok = errors.length === 0;
    const provable = ok && unproven.length === 0;
    add({
      kind: 'records',
      id: String(rec.seedId),
      label: `record list of pair ${String(rec.seedId)}: ${rec.proofs.length} ${rec.proofs.length === 1 ? 'proof' : 'proofs'}, ${rec.shoes.length} ${rec.shoes.length === 1 ? 'shoe' : 'shoes'}`,
      status: statusOf(ok, provable),
      ok,
      provable,
      errors,
      unproven,
    });
  }

  // Without a kept pair nothing is provable, however well the records agree.
  if (!b.kept && !loungeOnly)
    for (const c of checks)
      if (c.provable === true) {
        c.provable = false;
        c.status = 'ok';
        c.unproven = [...c.unproven, NO_KEPT];
      }

  const ok = checks.every((c) => c.ok);
  // Only a shoe, a proof or a pair proves something: the record list, the reveal and the kept pair only add to them.
  const checked = checks.filter((c) => (c.kind === 'shoe' || c.kind === 'proof' || c.kind === 'pair') && c.status !== 'pending');
  const judged = checks.filter((c) => c.status !== 'pending' && c.provable !== null);
  const provable = ok && !!b.kept && checked.length > 0 && judged.every((c) => c.provable === true);
  const status: Status = !ok ? 'failed' : provable ? 'provable' : checked.length === 0 && checks.some((c) => c.status === 'pending') ? 'pending' : 'ok';
  return { alg: ALG, lib: LIB, status, ok, provable, checks };
}

// ------------------------------------------------------------------------------------------------ text

const WORD: Record<Status, string> = { provable: 'provable', ok: 'ok', failed: 'FAILED', pending: 'pending' };

/**
 * The reasons to show for each check (in the order of report.checks): the check of the whole pair repeats what the
 * checks of its shoes, proofs and reveal found, so a reason already shown there is left out there.
 */
export function reasons(report: Report): Array<{ errors: string[]; unproven: string[] }> {
  const shown = new Set<string>();
  for (const c of report.checks) {
    if (c.kind !== 'shoe' && c.kind !== 'proof' && c.kind !== 'reveal') continue;
    const prefix = c.kind === 'reveal' ? 'pair' : `${c.kind} ${c.id}`;
    for (const e of [...c.errors, ...c.unproven]) shown.add(`${prefix}: ${e}`);
  }
  return report.checks.map((c) => {
    const fresh = (e: string): boolean => c.kind !== 'pair' || !shown.has(e);
    return { errors: c.errors.filter(fresh), unproven: c.ok ? c.unproven.filter(fresh) : [] };
  });
}

/** The report as lines of text, as fairshoe-verify prints it. */
export function formatReport(report: Report): string[] {
  const lines: string[] = [`${report.alg} (${report.lib})`];
  const why = reasons(report);
  report.checks.forEach((c, i) => {
    lines.push(`  ${WORD[c.status].padEnd(9)} ${c.label}`);
    for (const e of why[i]!.errors) lines.push(`              error: ${e}`);
    for (const u of why[i]!.unproven) lines.push(`              ${c.status === 'pending' ? 'pending' : 'not provable'}: ${u}`);
  });
  const failed = report.checks.filter((c) => c.status === 'failed').length;
  const pending = report.checks.filter((c) => c.status === 'pending').length;
  const tail = pending ? `, ${pending} pending` : '';
  if (report.status === 'failed') lines.push(`result: FAILED (${failed} of ${report.checks.length} checks)${tail}`);
  else if (report.status === 'provable') lines.push(`result: provable${tail}`);
  else if (report.status === 'pending') lines.push(`result: pending (no shoe, proof or pair checkable yet)${tail}`);
  else lines.push(`result: ok, not provable${tail}`);
  return lines;
}
