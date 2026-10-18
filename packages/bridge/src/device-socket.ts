/**
 * The slice of a WebSocket that DeviceConnection and the pairing handler use.
 * A real `ws` socket satisfies it (LAN), and so does a relay VirtualSocket.
 */
export interface DeviceSocket {
  on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): unknown
  on(event: 'close', listener: () => void): unknown
  on(event: 'error', listener: () => void): unknown
  send(data: string | Buffer): void
  close(code?: number, reason?: string): void
  readonly bufferedAmount: number
  /**
   * Largest single frame this socket can carry, if it has a limit. A LAN socket has
   * none worth worrying about; a relayed one is capped by the relay at 1 MiB.
   */
  readonly maxFrameBytes?: number
}
