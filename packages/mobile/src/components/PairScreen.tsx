import { decodePairingPayload, pairWithHost, type PairingPayload } from '@dorabot-remote/protocol'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useConnection } from '../lib/connection.js'
import { haptic, isNative, onPairingUrl, scanQr, suggestDeviceName } from '../lib/platform.js'
import { Button, Card } from './ui.js'

const createSocket = (url: string) => new WebSocket(url) as never

/**
 * First run. Scan the QR the Mac is showing, or paste the code underneath it.
 *
 * The QR carries the host's public key, so pairing is authenticated to that exact
 * machine. Nothing here asks for a password, and no credential ever travels in
 * the clear.
 */
export function PairScreen(): ReactNode {
  const { savePairing } = useConnection()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [manual, setManual] = useState(false)
  const [pasted, setPasted] = useState('')
  const [deviceName, setDeviceName] = useState(suggestDeviceName())
  const nameRef = useRef(deviceName)
  nameRef.current = deviceName

  // Opened from the Camera app, or from a link anywhere else on the phone.
  useEffect(() => {
    return onPairingUrl((url) => {
      try {
        void connectWith(decodePairingPayload(url))
      } catch (err) {
        setError((err as Error).message)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function connectWith(payload: PairingPayload): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const result = await pairWithHost({
        payload,
        deviceName: nameRef.current.trim() || suggestDeviceName(),
        platform: isNative ? (navigator.userAgent.includes('Android') ? 'android' : 'ios') : 'web',
        createSocket,
      })
      await haptic('success')
      await savePairing(result)
    } catch (err) {
      await haptic('warning')
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function onScan(): Promise<void> {
    setError(null)
    const res = await scanQr()
    if (!res.ok) {
      setError(res.error ?? 'Could not scan.')
      setManual(true)
      return
    }
    try {
      await connectWith(decodePairingPayload(res.value!))
    } catch (err) {
      setError(`That does not look like a dorabot pairing code. ${(err as Error).message}`)
    }
  }

  async function onPaste(): Promise<void> {
    setError(null)
    try {
      await connectWith(decodePairingPayload(pasted))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="scroll flex h-full flex-col justify-center gap-7 px-6 py-10">
      <div className="space-y-2">
        <div className="mb-5 flex size-12 items-center justify-center rounded-2xl bg-mint-900 text-mint-500">
          <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="3" y="3" width="7" height="7" rx="1.5" />
            <rect x="14" y="3" width="7" height="7" rx="1.5" />
            <rect x="3" y="14" width="7" height="7" rx="1.5" />
            <path d="M14 14h3v3h-3zM18 18h3v3h-3z" />
          </svg>
        </div>
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.02em]">Pair with your Mac</h1>
        <p className="text-[15px] leading-relaxed text-ink-300">
          On the Mac running dorabot, start the bridge and open the pairing page. Scan the code it shows.
        </p>
      </div>

      <Card className="space-y-3">
        <label className="block text-[13px] font-medium uppercase tracking-wider text-ink-400">
          This device will appear as
        </label>
        <input
          value={deviceName}
          onChange={(e) => setDeviceName(e.target.value)}
          maxLength={40}
          className="w-full rounded-lg border border-ink-600 bg-ink-900 px-3 py-2.5"
          placeholder="iPhone"
        />
      </Card>

      {error && (
        <Card tone="danger">
          <div className="text-[14px] leading-relaxed text-rose-glow">{error}</div>
        </Card>
      )}

      <div className="space-y-3">
        {!manual && (
          <Button variant="primary" onClick={() => void onScan()} disabled={busy} className="w-full">
            {busy ? 'Pairing…' : 'Scan QR code'}
          </Button>
        )}

        {manual ? (
          <Card className="space-y-3">
            <label className="block text-[13px] font-medium uppercase tracking-wider text-ink-400">
              Paste the pairing link
            </label>
            <textarea
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              rows={4}
              placeholder="dorabot-remote://pair#…"
              className="selectable w-full rounded-lg border border-ink-600 bg-ink-900 px-3 py-2.5 font-mono text-[13px] leading-relaxed"
            />
            <p className="text-[13px] leading-relaxed text-ink-400">
              Run <span className="font-mono text-ink-200">dorabot-remote pair</span> on the Mac and copy the link it
              prints, or copy it from the pairing page.
            </p>
            <Button variant="primary" onClick={() => void onPaste()} disabled={busy || pasted.trim().length < 10} className="w-full">
              {busy ? 'Pairing…' : 'Pair'}
            </Button>
          </Card>
        ) : (
          <Button variant="ghost" onClick={() => setManual(true)} className="w-full">
            Paste a code instead
          </Button>
        )}
      </div>

      <p className="text-center text-[13px] leading-relaxed text-ink-500">
        Your phone talks straight to your Mac on your network. Away from home it goes through a relay that only ever sees encrypted data.
      </p>
    </div>
  )
}
