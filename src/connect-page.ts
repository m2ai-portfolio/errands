import { randomBytes } from 'node:crypto'
import http from 'node:http'

// A tiny LAN-served page that runs Stripe.js's Financial Connections flow in
// the customer's browser. The publishable key is embedded (it is public by
// design); the client secret for a given session is fetched over /secret only
// after collect() has been called and is never printed to a log.
//
// The page itself is gated behind a per-server random token: /connect requires
// it as a `t` query param, and the page then sends it back as the
// `x-errands-token` header on every /secret and /done call. Without the token,
// /secret and /done refuse with 401 and leave any pending collect() untouched.

export interface ConnectPage {
  url: string
  collect: (clientSecret: string) => Promise<string[]>
  close: () => Promise<void>
}

interface ServeConnectPageOptions {
  publishableKey: string
  host: string
  port?: number
}

function pageHtml(publishableKey: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Connect your bank</title></head>
<body>
<p id="status">Connecting to Stripe...</p>
<script src="https://js.stripe.com/v3/"></script>
<script>
(async function () {
  const statusEl = document.getElementById('status');
  try {
    const token = new URLSearchParams(location.search).get('t') || '';
    const stripe = Stripe(${JSON.stringify(publishableKey)});
    const secretResponse = await fetch('/secret', { headers: { 'x-errands-token': token } });
    const { clientSecret } = await secretResponse.json();
    const result = await stripe.collectFinancialConnectionsAccounts({ clientSecret });
    const accountIds = (result.financialConnectionsSession?.accounts ?? []).map((a) => a.id);
    await fetch('/done', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-errands-token': token },
      body: JSON.stringify({ accountIds }),
    });
    statusEl.textContent = 'Done, you can close this tab';
  } catch (err) {
    statusEl.textContent = 'Something went wrong. You can close this tab and try again.';
  }
})();
</script>
</body>
</html>`
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8')
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch (err) {
        reject(err as Error)
      }
    })
    req.on('error', reject)
  })
}

export async function serveConnectPage(opts: ServeConnectPageOptions): Promise<ConnectPage> {
  const { publishableKey, host } = opts
  const port = opts.port ?? 4747
  const token = randomBytes(16).toString('hex')

  let pendingClientSecret: string | null = null
  let resolvePending: ((accountIds: string[]) => void) | null = null
  let rejectPending: ((err: Error) => void) | null = null

  function headerToken(req: http.IncomingMessage): string | null {
    const header = req.headers['x-errands-token']
    const value = Array.isArray(header) ? header[0] : header
    return value ?? null
  }

  function collect(clientSecret: string): Promise<string[]> {
    if (rejectPending) rejectPending(new Error('CONNECT_SUPERSEDED'))
    pendingClientSecret = clientSecret
    return new Promise<string[]>((resolve, reject) => {
      resolvePending = resolve
      rejectPending = reject
    })
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const method = req.method ?? 'GET'
      const parsedUrl = new URL(req.url ?? '', 'http://internal')
      const pathname = parsedUrl.pathname

      if (method === 'GET' && pathname === '/connect') {
        if (parsedUrl.searchParams.get('t') !== token) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'NOT_FOUND' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(pageHtml(publishableKey))
        return
      }

      if (method === 'GET' && pathname === '/secret') {
        if (headerToken(req) !== token) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'UNAUTHORIZED' }))
          return
        }
        if (pendingClientSecret === null) {
          res.writeHead(409, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'NOT_READY' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ clientSecret: pendingClientSecret }))
        return
      }

      if (method === 'POST' && pathname === '/done') {
        if (headerToken(req) !== token) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'UNAUTHORIZED' }))
          return
        }
        try {
          const body = (await readJsonBody(req)) as { accountIds?: unknown }

          // Validate accountIds is an array of strings
          if (
            !Array.isArray(body.accountIds) ||
            !body.accountIds.every((id) => typeof id === 'string')
          ) {
            const reject = rejectPending
            resolvePending = null
            rejectPending = null
            pendingClientSecret = null
            if (reject) reject(new Error('CONNECT_BAD_DONE_BODY'))
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'BAD_DONE_BODY' }))
            return
          }

          const accountIds = body.accountIds
          const resolve = resolvePending
          resolvePending = null
          rejectPending = null
          pendingClientSecret = null
          if (resolve) resolve(accountIds)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        } catch {
          const reject = rejectPending
          resolvePending = null
          rejectPending = null
          pendingClientSecret = null
          if (reject) reject(new Error('CONNECT_BAD_DONE_BODY'))
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'BAD_JSON' }))
        }
        return
      }

      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'NOT_FOUND' }))
    })()
  })

  await new Promise<void>((resolve) => {
    server.listen(port, '0.0.0.0', resolve)
  })

  const address = server.address()
  const boundPort = typeof address === 'object' && address !== null ? address.port : port

  const url = `http://${host}:${boundPort}/connect?t=${token}`

  return {
    url,
    collect,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}
