import test from 'node:test';import assert from 'node:assert/strict';
import {analyticsSettings} from '../src/analytics-settings.js';
test('analytics settings preserve valid thresholds and reject invalid persistent rules',()=>{
 const defaults=analyticsSettings();assert.equal(defaults.regularThresholdPercent,50);
 assert.deepEqual(analyticsSettings({regularThresholdPercent:80,minSessions:1,timezone:'UTC'}),{...defaults,regularThresholdPercent:80,minSessions:1,timezone:'UTC'});
 for(const value of [null,[],false, {regularThresholdPercent:1.5},{regularThresholdPercent:101},{regularThresholdPercent:-1},{minSessions:1.5},{minMinutes:-1},{minMessages:1e7},{chatWindowMinutes:0},{coreRule:'bad'},{timezone:'invalid'},{timezone:5},{unknown:true}])assert.throws(()=>analyticsSettings(value),/INVALID_ANALYTICS_SETTINGS/);
});
