/** Bind every G9 random operation, including idle prefixes, to acknowledgements retained by the player. */
import type { RoundProof } from './records.ts';
import type { OutcomeCheck } from './games.ts';
import { authorizedSteps, PayoutTape, UnprovenPayoutError, type PayoutContext } from './payout-common.ts';
import { DECK_CODES, isCardCode } from './shoe.ts';
import { replayBaccaratStrike } from './baccarat-payout.ts';

const multiplierBaccarat = new Set(['blitz-baccarat', 'blitz-baccarat-max', 'jade-baccarat', 'gold-baccarat']);
export function auditDrawAuthorization(proof: RoundProof, context: PayoutContext): OutcomeCheck | null {
  const game = proof.gameId;
  if (game !== 'hilo' && game !== 'bull-run' && game !== 'blitz-solo' && !multiplierBaccarat.has(game)) return null;
  try {
    const allowed = game === 'hilo' ? ['hilo-init', 'hilo-exchange', 'hilo-guess'] as const : game === 'bull-run' ? ['trading-trade'] as const : game === 'blitz-solo' ? ['blackjack-board'] as const : ['baccarat-free', 'baccarat-deal'] as const;
    const steps = authorizedSteps(proof, context, allowed);
    for (const [index, step] of steps.entries()) {
      const auth = context.authorizedDraws![String(step.nonce)]!;
      const tape = new PayoutTape(step);
      if (game === 'hilo') {
        const card = DECK_CODES[tape.int(52)]!;
        if (!isCardCode(auth.card)) throw new UnprovenPayoutError(`nonce ${step.nonce}: the Hi-Lo card actually observed by the player is missing`);
        if (card !== auth.card) throw new Error(`nonce ${step.nonce}: Hi-Lo drew ${card}, the player observed ${auth.card}`);
        if (auth.kind === 'hilo-guess') {
          if (proof.roundId === null) throw new Error(`nonce ${step.nonce}: an acknowledged Hi-Lo guess was moved outside its round`);
          if (step.draws.length > 1) tape.int(1_000_000);
        }
        tape.finish();
      } else if (game === 'bull-run') {
        if (proof.roundId === null) throw new Error(`nonce ${step.nonce}: an acknowledged trade was moved outside its round`);
        tape.int(990); tape.int(0x1_0000_0000); tape.finish();
      } else if (game === 'blitz-solo') {
        if (proof.roundId === null) throw new Error(`nonce ${step.nonce}: an acknowledged blackjack board was moved outside its round`);
        tape.int(100); tape.finish();
      } else {
        if (steps.length !== context.shoeKinds?.length) throw new Error('the authorized strike steps do not match the committed hand slices');
        const kind = context.shoeKinds[index];
        if (kind === 'unknown') throw new UnprovenPayoutError('the free/paid identity of a multiplier hand is not proven');
        if (auth.kind !== `baccarat-${kind}`) throw new Error(`nonce ${step.nonce}: the committed hand does not match the player's ${auth.kind} request`);
        replayBaccaratStrike(game, tape);
      }
    }
    return { checked: false, summary: null, errors: [] };
  } catch (e) {
    return e instanceof UnprovenPayoutError ? { checked: false, summary: null, errors: [], unproven: [e.message] } : { checked: false, summary: null, errors: [e instanceof Error ? e.message : String(e)] };
  }
}
