declare const __STREAM_PANEL_RELEASE__:string;
export const uiRelease=typeof __STREAM_PANEL_RELEASE__==='string'?__STREAM_PANEL_RELEASE__:'development';
export function isOutdatedRelease(server:unknown,client=uiRelease):boolean{
 return typeof server==='string'&&/^[a-f0-9]{40}$/.test(server)&&/^[a-f0-9]{40}$/.test(client)&&server!==client;
}
