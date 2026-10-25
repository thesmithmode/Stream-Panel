import type WebSocket from "ws";
export type SocketFactory = (url: string, options: WebSocket.ClientOptions) => WebSocket;
export interface ConnectionStatus {
    state: string;
    detail: string;
    account?: string;
    lastEventAt?: number;
    lastSyncAt?:number;
    lastFollowersAt?:number;
    capabilities: Record<string, string>;
}
export const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("INVALID_PROVIDER_OBJECT");
    return value as Record<string, unknown>;
};
export const string = (value: unknown): string => typeof value === "string" ? value : "";
