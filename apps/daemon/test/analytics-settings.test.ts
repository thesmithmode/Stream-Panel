import test from 'node:test';import assert from 'node:assert/strict';
import {analyticsSettings} from '../src/analytics-settings.js';
test('analytics settings preserve valid thresholds and reject invalid persistent rules',()=>{
 const defaults=analyticsSettings();assert.equal(defaults.regularThresholdPercent,80);
 assert.deepEqual(analyticsSettings({regularThresholdPercent:80,minSessions:1,timezone:'UTC'}),{...defaults,regularThresholdPercent:80,minSessions:1,timezone:'UTC'});
 for(const value of [null,[],false, {regularThresholdPercent:1.5},{regularThresholdPercent:101},{regularThresholdPercent:-1},{minSessions:1.5},{minMinutes:-1},{minMessages:1e7},{chatWindowMinutes:0},{coreRule:'bad'},{timezone:'invalid'},{timezone:5},{unknown:true}])assert.throws(()=>analyticsSettings(value),/INVALID_ANALYTICS_SETTINGS/);
});
test('existing profile threshold is raised once; subsequent saved preferences survive restart',async()=>{
 const {mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises');const {join}=await import('node:path');const {tmpdir}=await import('node:os');const {Configuration}=await import('../src/config.js');
 const dir=await mkdtemp(join(tmpdir(),'sp-core80-'));try{
  const c=new Configuration(dir);await c.load();c.value.analyticsSettings=analyticsSettings({regularThresholdPercent:60});await c.save();
  const saved=JSON.parse(await readFile(join(dir,'secrets.json'),'utf8'));delete saved.coreAttendance80Applied;await writeFile(join(dir,'secrets.json'),JSON.stringify(saved));
  const upgrade=new Configuration(dir);await upgrade.load();assert.equal(upgrade.value.analyticsSettings!.regularThresholdPercent,80);
  upgrade.value.analyticsSettings=analyticsSettings({regularThresholdPercent:70});await upgrade.save();const restart=new Configuration(dir);await restart.load();assert.equal(restart.value.analyticsSettings!.regularThresholdPercent,70);
 }finally{await rm(dir,{recursive:true,force:true});}
});
