import { isRelayId } from '@dorabot-remote/protocol'
import { handlePush } from './push.js'
import { Room } from './room.js'

export interface Env {
  ROOM: DurableObjectNamespace
  /** Service-account JSON for FCM. A Worker secret; absent means push is off. */
  FCM_SERVICE_ACCOUNT?: string
}

export { Room }

const ROUTE = /^\/(h|d|push)\/([^/]+)$/

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/health') return new Response('ok')

    const m = ROUTE.exec(url.pathname)
    if (!m) return new Response('not found', { status: 404 })
    const [, route, relayId] = m as unknown as [string, string, string]
    // Validate before touching a Durable Object: every distinct name is a new room.
    if (!isRelayId(relayId)) return new Response('not found', { status: 404 })

    const stub = env.ROOM.get(env.ROOM.idFromName(relayId))

    if (route === 'push') {
      return handlePush(request, relayId, {
        serviceAccount: env.FCM_SERVICE_ACCOUNT,
        fetch: (input, init) => fetch(input, init),
        now: () => Date.now(),
        rateLimit: async () => (await stub.fetch(`https://room/rate/${relayId}`, { method: 'POST' })).status === 204,
      })
    }

    if (request.method !== 'GET') return new Response('method not allowed', { status: 405 })
    return stub.fetch(request)
  },
} satisfies ExportedHandler<Env>
