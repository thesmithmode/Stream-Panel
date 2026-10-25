import test from 'node:test';import assert from 'node:assert/strict';import {screenVersion,refreshInterval,type Changes} from './refresh-policy.ts';
const base:Changes={versions:{activity:1,people:1,donations:1,follows:1,subscribers:1},activeStream:null,stream:null,connectionRevision:'connection',dataEpoch:'epoch',checkedAt:100000};
test('offline and hidden-independent cadence is five minutes; only the current live context uses one minute',()=>{
 assert.equal(refreshInterval(0,'analytics','',base),300);
 const live={...base,activeStream:'live',stream:{id:'live',endedAt:null,revision:1}};
 assert.equal(refreshInterval(0,'stream','child-id',live),60);assert.equal(refreshInterval(0,'connections','',live),300);
 assert.equal(refreshInterval(0,'stream','old',{...live,stream:{id:'old',endedAt:50000,revision:1}}),300);
 assert.equal(refreshInterval(900,'analytics','',live),900);
});
test('unchanged checks and subscriber counts do not dirty the large analytics report',()=>{
 const later={...base,checkedAt:900000,versions:{...base.versions,subscribers:2}};
 assert.equal(screenVersion('analytics','',base),screenVersion('analytics','',later));
 assert.notEqual(screenVersion('analytics','',base),screenVersion('analytics','',{...later,versions:{...later.versions,donations:2}}));
 assert.notEqual(screenVersion('overview','',base),screenVersion('overview','',{...base,dataEpoch:'after-restore'}));
 const live={...base,activeStream:'live'};assert.notEqual(screenVersion('analytics','',live),screenVersion('analytics','',{...live,checkedAt:200000}));
});
