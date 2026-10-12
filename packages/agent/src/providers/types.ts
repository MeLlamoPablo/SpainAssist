/**
 * pi-ai `Credential` shape, as stored by the app and served to agent hosts over the bridge:
 *   { type: 'api_key', key } | { type: 'oauth', access, refresh, expires, clientId, scopes, ... }
 */
export type PiCredential = Record<string, unknown> & { type: 'api_key' | 'oauth' };

/** Progress of an OAuth login: waiting for the user, then trading the code for tokens. */
export type LoginStage = 'waiting' | 'exchanging';
