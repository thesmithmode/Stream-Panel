import test from 'node:test';
import assert from 'node:assert/strict';
import {readAnalyticsContext,writeAnalyticsContext} from './analytics-context.ts';
import {analyticsView} from './analytics-view.ts';
test('navigation context survives profile changes, accepts reactive proxies and returns independent snapshots',()=>{
 assert.equal(readAnalyticsContext(),undefined);
 const view=new Proxy(analyticsView({dailyMetric:'active',dailyPlatform:'youtube'}),{});
 writeAnalyticsContext({from:'2026-10-01',to:'2026-10-26',source:'youtube',category:'game',timezone:'UTC',period:'custom',liveEnd:false,view});
 const snapshot=readAnalyticsContext()!;assert.equal(snapshot.view.dailyMetric,'active');assert.equal(snapshot.timezone,'UTC');snapshot.view.dailyMetric='online';assert.equal(readAnalyticsContext()!.view.dailyMetric,'active');
});
