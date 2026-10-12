/** DA legacy wall-clock values require an explicit offset; ISO values carry their own. */
export function parseDonationTime(raw:string,offsetMinutes:number|null):number|null {
 if(offsetMinutes!==null&&(!Number.isInteger(offsetMinutes)||Math.abs(offsetMinutes)>840))throw new Error('INVALID_UTC_OFFSET');
 const iso=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw);
 if(iso){
  const wall=raw.slice(0,19),d=new Date(Date.UTC(Number(raw.slice(0,4)),Number(raw.slice(5,7))-1,Number(raw.slice(8,10)),Number(raw.slice(11,13)),Number(raw.slice(14,16)),Number(raw.slice(17,19))));
  const at=Date.parse(raw);if(!Number.isFinite(at)||d.toISOString().slice(0,19)!==wall)throw new Error('INVALID_DA_DATE');return at;
 }
 if(offsetMinutes===null)return null;
 const m=/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw);
 if(!m)throw new Error('INVALID_DA_TIME');
 const d=new Date(Date.UTC(Number(m[1]),Number(m[2])-1,Number(m[3]),Number(m[4]),Number(m[5]),Number(m[6])));
 if(d.toISOString().slice(0,19).replace('T',' ')!==raw)throw new Error('INVALID_DA_DATE');
 return d.getTime()-offsetMinutes*60000;
}
