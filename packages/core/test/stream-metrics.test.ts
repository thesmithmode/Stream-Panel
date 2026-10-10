import test from 'node:test';
import assert from 'node:assert/strict';
import {streamMetrics} from '../src/stream-metrics.js';
const minute=60000;
test('stream metrics keep platforms separate, merge linked authors and weight partial minutes without filling gaps',()=>{
 const segments=[{from:30000,to:180000}];
 const data=streamMetrics(segments,[{observed_at_ms:0,twitch_viewers:10,youtube_viewers:4},{observed_at_ms:minute,twitch_viewers:20,youtube_viewers:null},{observed_at_ms:minute+15000,twitch_viewers:30,youtube_viewers:null},{observed_at_ms:180000,twitch_viewers:99,youtube_viewers:99}],new Map([[0,new Set(['linked','other'])],[minute,new Set(['linked'])],[180000,new Set(['outside'])]]));
 assert.equal(data.uniqueChatters,2);assert.equal(data.peakChatters,2);assert.equal(data.meanChatters,.8);
 assert.equal(data.viewers.twitch.peak,30);assert.equal(data.viewers.twitch.mean,70/3);assert.equal(data.viewers.twitch.knownMinutes,1.5);assert.equal(data.viewers.twitch.coverageRatio,.6);
 assert.equal(data.viewers.youtube.peak,4);assert.equal(data.viewers.youtube.mean,4);assert.equal(data.viewers.youtube.coverageRatio,.2);
});
test('known zero viewers differ from unknown and category segments exclude unrelated minutes',()=>{
 const data=streamMetrics([{from:minute,to:2*minute}],[{observed_at_ms:0,twitch_viewers:99,youtube_viewers:99},{observed_at_ms:minute,twitch_viewers:0,youtube_viewers:null}],new Map());
 assert.equal(data.viewers.twitch.mean,0);assert.equal(data.viewers.twitch.peak,0);assert.equal(data.viewers.twitch.viewerMinutes,0);assert.equal(data.viewers.twitch.coverageRatio,1);
 assert.equal(data.viewers.youtube.mean,null);assert.equal(data.viewers.youtube.peak,null);assert.equal(data.viewers.youtube.viewerMinutes,null);assert.equal(data.viewers.youtube.coverageRatio,0);assert.equal(data.meanChatters,0);
 const empty=streamMetrics([],[],new Map());assert.equal(empty.meanChatters,null);assert.equal(empty.viewers.twitch.coverageRatio,null);
});
