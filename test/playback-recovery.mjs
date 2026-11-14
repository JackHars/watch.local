import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPlaybackRecovery} from '../public/playback-recovery.mjs';

test('native and desktop failures move forward, coalesce duplicate errors and stop when sources are exhausted', async () => {
  const pending=Promise.withResolvers(), calls=[], replacements=[], errors=[];
  let switches=0, inspected=0;
  const recovery=createPlaybackRecovery({
    inspect:async()=>{inspected++;return {provider:'cinejoy',attemptedProviders:['cinejoy']};},
    resolve:async exclude=>{calls.push(exclude);if(calls.length===1)return pending.promise;throw Error('No other enabled provider has a playable source.');},
    beforeSwitch:()=>switches++,replace:out=>replacements.push(out.provider),failed:error=>errors.push(error),
  });
  const first=recovery.recover('Video failed');
  await recovery.recover('Duplicate HLS error');assert.equal(recovery.busy,true);
  pending.resolve({provider:'zstream',attemptedProviders:['cinejoy','tvids','zstream']});await first;
  assert.deepEqual(calls,[['cinejoy']]);assert.deepEqual(replacements,['zstream']);assert.equal(inspected,1);
  await recovery.recover('Next source failed');
  assert.deepEqual(calls[1],['cinejoy','tvids','zstream']);assert.equal(switches,2);assert.equal(errors.length,1);
  await recovery.recover('Another error');assert.equal(calls.length,2);
});
test('closing playback aborts recovery, and an old server cannot loop back to a failed provider', async () => {
  const controller=new AbortController(), pending=Promise.withResolvers();let replaced=0,errors=0;
  const recovery=createPlaybackRecovery({current:{provider:'cinejoy'},signal:controller.signal,resolve:()=>pending.promise,replace:()=>replaced++,failed:()=>errors++});
  const request=recovery.recover('failed');controller.abort();pending.resolve({provider:'zstream'});await request;
  assert.equal(replaced,0);assert.equal(errors,0);
  const old=createPlaybackRecovery({current:{provider:'cinejoy'},resolve:async()=>({provider:'cinejoy'}),replace:()=>replaced++,failed:()=>errors++});
  await old.recover('failed');await old.recover('failed again');assert.equal(replaced,0);assert.equal(errors,1);
});
test('native resolution errors are surfaced without retrying providers that have already failed server-side', async () => {
  let resolves=0;const errors=[];
  const recovery=createPlaybackRecovery({inspect:async()=>{throw Error('No provider returned playable HLS');},resolve:async()=>resolves++,failed:message=>errors.push(message)});
  await recovery.recover('Native video failed');assert.equal(resolves,0);assert.deepEqual(errors,['No provider returned playable HLS']);
});
