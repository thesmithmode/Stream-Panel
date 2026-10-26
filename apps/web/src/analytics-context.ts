import type {AnalyticsView} from './analytics-view';
interface AnalyticsContext {
 from:string;to:string;source:string;category:string;timezone:string;
 period:number|'all'|'custom';liveEnd:boolean;view:AnalyticsView;
}
// Navigation context follows the user across profiles; report data remains profile-scoped.
let current:AnalyticsContext|undefined;
export const readAnalyticsContext=()=>current?structuredClone(current):undefined;
export function writeAnalyticsContext(value:AnalyticsContext){current=JSON.parse(JSON.stringify(value)) as AnalyticsContext;}
