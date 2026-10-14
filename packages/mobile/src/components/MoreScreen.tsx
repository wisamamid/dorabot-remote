import { useState, type ReactNode } from 'react'
import { useConnection } from '../lib/connection.js'
import { LockIcon } from './ScopeGate.js'
import { SettingsScreen } from './SettingsScreen.js'
import { TerminalScreen } from './TerminalScreen.js'
import { Dot, Layer, Row, Screen } from './ui.js'

type Sub = 'terminal' | 'settings' | null

export function MoreScreen(): ReactNode {
  const conn = useConnection()
  const [sub, setSub] = useState<Sub>(null)
  const tone = conn.state === 'ready' ? (conn.gatewayConnected ? 'good' : 'warn') : conn.state === 'disconnected' ? 'bad' : 'idle'

  return (
    <div className="relative h-full">
      <Screen title="More">
        <div className="scroll h-full space-y-1.5 px-3 py-3">
          <Row
            title={
              <span className="flex items-center gap-2">
                <Dot tone={tone} />
                {conn.host?.name ?? conn.pairing?.hostName ?? 'Not paired'}
              </span>
            }
            subtitle={conn.state === 'ready' ? (conn.gatewayConnected ? 'Connected' : 'Reachable, dorabot is not running') : (conn.stateDetail ?? conn.state)}
          />
          <Row
            title="Terminal"
            subtitle="A shell on your Mac"
            onClick={() => setSub('terminal')}
            trailing={!conn.hasScope('terminal') ? <LockIcon className="size-5 text-ink-400" /> : undefined}
          />
          <Row title="Settings" subtitle="Permissions, this device, disconnect" onClick={() => setSub('settings')} />
        </div>
      </Screen>
      {sub && (
        <Layer>
          {sub === 'terminal' ? <TerminalScreen onBack={() => setSub(null)} /> : <SettingsScreen onBack={() => setSub(null)} />}
        </Layer>
      )}
    </div>
  )
}
