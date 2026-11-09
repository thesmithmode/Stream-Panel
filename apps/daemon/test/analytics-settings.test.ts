import test from 'node:test';import assert from 'node:assert/strict';
import {analyticsSettings,analyticsBotLogins,analyticsCalculationSettings} from '../src/analytics-settings.js';
test('analytics settings preserve valid thresholds and reject invalid persistent rules',()=>{
 const defaults=analyticsSettings();assert.equal(defaults.regularThresholdPercent,80);assert.equal(defaults.coreWindowDays,90);
 for(const coreWindowDays of [30,90,180])assert.equal(analyticsSettings({coreWindowDays}).coreWindowDays,coreWindowDays);
 assert.deepEqual(analyticsSettings({regularThresholdPercent:80,minSessions:1,timezone:'UTC'}),{...defaults,regularThresholdPercent:80,minSessions:1,timezone:'UTC'});
 for(const value of [null,[],false,{coreWindowDays:0},{coreWindowDays:365},{coreWindowDays:"90"}, {regularThresholdPercent:1.5},{regularThresholdPercent:101},{regularThresholdPercent:-1},{minSessions:1.5},{minMinutes:-1},{minMessages:1e7},{chatWindowMinutes:0},{coreRule:'bad'},{timezone:'invalid'},{timezone:5},{unknown:true}])assert.throws(()=>analyticsSettings(value),/INVALID_ANALYTICS_SETTINGS/);
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

test('bot modes override profile defaults without conflating highlighting or accepting malformed filters',()=>{
 const config={excludedBotLogins:['custom-bot'],analyticsSettings:analyticsSettings()};
 assert.deepEqual(analyticsBotLogins({},config),['custom-bot']);
 for(const includeBots of ['1','true'])assert.equal(analyticsBotLogins({includeBots},config),false);
 config.analyticsSettings.includeBots=true;
 assert.equal(analyticsBotLogins({},config),false);
 for(const includeBots of ['0','false'])assert.deepEqual(analyticsBotLogins({includeBots},config),['custom-bot']);
 for(const includeBots of ['bad',1,true,null])assert.throws(()=>analyticsBotLogins({includeBots},config),/INVALID_BOT_FILTER/);
 for(const key of ['includeBots','highlightBots','highlightHumans'])assert.throws(()=>analyticsSettings({[key]:'true'}),/INVALID_ANALYTICS_SETTINGS/);
});
test('highlight and bot preferences persist independently in each profile configuration',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{join}=await import('node:path'),{tmpdir}=await import('node:os'),{Configuration}=await import('../src/config.js');
 const dir=await mkdtemp(join(tmpdir(),'sp-bot-preferences-'));
 try{
  for(const profile of ['ruslan','gulnaz']){const c=new Configuration(join(dir,profile));await c.load();c.value.analyticsSettings=analyticsSettings({includeBots:profile==='gulnaz',highlightBots:profile==='ruslan',highlightHumans:profile==='gulnaz'});await c.save();}
  for(const profile of ['gulnaz','ruslan']){const c=new Configuration(join(dir,profile));await c.load();assert.equal(c.value.analyticsSettings!.includeBots,profile==='gulnaz');assert.equal(c.value.analyticsSettings!.highlightBots,profile==='ruslan');assert.equal(c.value.analyticsSettings!.highlightHumans,profile==='gulnaz');}
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('highlighting leaves calculation settings and historical variants unchanged',()=>{
 assert.deepEqual(analyticsCalculationSettings({highlightBots:false,highlightHumans:false,includeBots:true}),analyticsCalculationSettings());
});
