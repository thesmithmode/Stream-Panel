import test from 'node:test';
import assert from 'node:assert/strict';
import {missingTwitchPresence} from './presence-quality.ts';
test('night stream messages with no observed people are missing presence; ordinary and YouTube-only streams are not',()=>{
 assert.equal(missingTwitchPresence(Array.from({length:246},(_,i)=>({at:i*60000,twitchMessages:i%30===0?1:0,observed:0}))),true);
 assert.equal(missingTwitchPresence([{at:0,twitchMessages:2},{at:60000,observed:1}]),false);
 assert.equal(missingTwitchPresence([{at:0,youtubeMessages:2}]),false);
 assert.equal(missingTwitchPresence([{at:0}]),false);
 assert.equal(missingTwitchPresence([]),false);
});
