const formatters=new Map<string,Intl.DateTimeFormat>();
/** ICU formatters own native memory outside the JS heap; share a bounded set. */
export function dateTimeFormatter(locale:string,options:Intl.DateTimeFormatOptions):Intl.DateTimeFormat{
 const key=JSON.stringify([locale,Object.entries(options).sort(([a],[b])=>a.localeCompare(b))]);
 let formatter=formatters.get(key);
 if(formatter){formatters.delete(key);formatters.set(key,formatter);return formatter;}
 formatter=new Intl.DateTimeFormat(locale,options);
 while(formatters.size>=32)formatters.delete(formatters.keys().next().value!);
 formatters.set(key,formatter);return formatter;
}
