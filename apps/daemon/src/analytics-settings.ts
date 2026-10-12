export const defaultAnalyticsSettings={regularThresholdPercent:80,minSessions:3,minMinutes:30,minMessages:5,chatWindowMinutes:5,coreRule:'either' as 'either'|'both'|'frequency',timezone:'Europe/Moscow'};
export type AnalyticsSettings=typeof defaultAnalyticsSettings;
/** The persisted profile rule and the API rule use one validated contract. */
export function analyticsSettings(input:unknown={}):AnalyticsSettings{
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('INVALID_ANALYTICS_SETTINGS');
 const raw=input as Record<string,unknown>,value={...defaultAnalyticsSettings,...raw};
 if(Object.keys(raw).some(key=>!(key in defaultAnalyticsSettings)))throw new Error('INVALID_ANALYTICS_SETTINGS');
 const limits={regularThresholdPercent:100,minSessions:1000,minMinutes:129600,minMessages:1000000,chatWindowMinutes:30};
 for(const [key,max] of Object.entries(limits)){
  const n=value[key as keyof AnalyticsSettings];
  if(typeof n!=='number'||!Number.isInteger(n)||n<(key==='chatWindowMinutes'?1:0)||n>max)throw new Error('INVALID_ANALYTICS_SETTINGS');
 }
 if(!['either','both','frequency'].includes(value.coreRule)||typeof value.timezone!=='string')throw new Error('INVALID_ANALYTICS_SETTINGS');
 try{new Intl.DateTimeFormat('ru-RU',{timeZone:value.timezone});}catch{throw new Error('INVALID_ANALYTICS_SETTINGS');}
 return value as AnalyticsSettings;
}
