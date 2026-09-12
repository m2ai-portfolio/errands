import http from 'node:http'

// A tiny LAN-served page that runs Stripe.js's Financial Connections flow in
// the customer's browser. The publishable key is embedded (it is public by
// design); the client secret for a given session is fetched over /secret only
// after collect() has been called and is never printed to a log.

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
    const stripe = Stripe(${JSON.stringify(publishableKey)});
    const secretResponse = await fetch('/secret');
    const { clientSecret } = await secretResponse.json();
    const result = await stripe.collectFinancialConnectionsAccounts({ clientSecret });
    const accountIds = (result.financialConnectionsSession?.accounts ?? []).map((a) => a.id);
    await fetch('/done', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

  let pendingClientSecret: string | null = null
  let resolvePending: ((accountIds: string[]) => void) | null = null
  let rejectPending: ((err: Error) => void) | null = null

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
      const url = req.url ?? ''

      if (method === 'GET' && url === '/connect') {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(pageHtml(publishableKey))
        return
      }

      if (method === 'GET' && url === '/secret') {
        if (pendingClientSecret === null) {
          res.writeHead(409, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'NOT_READY' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ clientSecret: pendingClientSecret }))
        return
      }

      if (method === 'POST' && url === '/done') {
        try {
          const body = (await readJsonBody(req)) as { accountIds?: string[] }
          const accountIds = body.accountIds ?? []
          const resolve = resolvePending
          resolvePending = null
          rejectPending = null
          pendingClientSecret = null
          if (resolve) resolve(accountIds)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        } catch {
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

  const url = `http://${host}:${boundPort}/connect`

  return {
    url,
    collect,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}
