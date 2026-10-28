/** Public-only shared-lounge vector captured through the real client with official quicknet round one. */
import { describe, expect, it } from './harness.ts';
import { readFileSync } from 'node:fs';
import { verifyRound } from '../src/index.ts';
import type { PlayerRecords, RoundProof } from '../src/index.ts';
const vector = JSON.parse(readFileSync(new URL('../vectors/lounge.json', import.meta.url), 'utf8')) as {proof:RoundProof;own:PlayerRecords};
describe('public shared lounge vector',()=>{
  it('checks the beacon, bot plan, actual client observations and payouts without the reference server',()=>{
    expect(verifyRound(vector.proof,null,{own:vector.own})).toMatchObject({ok:true,provable:true,errors:[],unproven:[],outcome:{payoutsChecked:true}});
  });
  it('rejects a changed signature, wallet, card destination or observed action',()=>{
    const badSignature=structuredClone(vector.proof);badSignature.lounge!.beacon!.signature='0'.repeat(96);
    expect(verifyRound(badSignature,null,{own:vector.own}).ok).toBe(false);
    const badWallet=structuredClone(vector.proof);Object.values(badWallet.lounge!.ledger)[0]!.returned++;
    expect(verifyRound(badWallet,null,{own:vector.own}).ok).toBe(false);
    const places=structuredClone(vector.own);places.lounge![vector.proof.roundId!]!.places![0]='dealer';
    expect(verifyRound(vector.proof,null,{own:places}).ok).toBe(false);
    const actions=structuredClone(vector.own);actions.lounge![vector.proof.roundId!]!.observedActions![0]!.action='surrender';
    expect(verifyRound(vector.proof,null,{own:actions}).ok).toBe(false);
  });
  it('does not invent timely input evidence for a downloaded proof',()=>{
    const noEvents=structuredClone(vector.own);delete noEvents.lounge![vector.proof.roundId!]!.places;
    expect(verifyRound(vector.proof,null,{own:noEvents})).toMatchObject({ok:true,provable:false});
  });
});
