export interface NetStatus {
  connected: boolean
  connectionType: string
}

/**
 * A network change that invalidates the current socket: coming back online, or
 * moving between interfaces (Wi-Fi to cellular). Going offline alone does not
 * trigger a reconnect (there is nothing to connect to); the socket is replaced
 * when a network returns.
 */
export function shouldReconnect(prev: NetStatus | null, next: NetStatus): boolean {
  if (!next.connected) return false
  if (!prev) return false
  return !prev.connected || prev.connectionType !== next.connectionType
}
