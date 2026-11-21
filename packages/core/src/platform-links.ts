/** Public platform profile link of a person's identity, as returned by /api/v1/persons/:id/platform-links. */
export interface PlatformLink {identityId:string;source:'twitch'|'youtube';url:string}
