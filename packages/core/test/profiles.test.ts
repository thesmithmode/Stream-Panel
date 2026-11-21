import test from 'node:test';
import assert from 'node:assert/strict';
import {PROFILES,isProfileName} from '../src/profiles.js';
test('the installation has exactly the two known profiles, in owner-first order',()=>{
 assert.deepEqual([...PROFILES],['ruslan','gulnaz']);
 for(const value of PROFILES)assert.equal(isProfileName(value),true);
 for(const value of ['', 'Ruslan', 'admin', undefined, null, 1, {}])assert.equal(isProfileName(value),false);
});
