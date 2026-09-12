import { afterEach, describe, expect, it } from 'vitest'
import { serveConnectPage } from '../src/connect-page.js'

describe('serveConnectPage', () => {
  let close: (() => Promise<void>) | undefined

  afterEach(async () => {
    if (close) await close()
    close = undefined
  })

  it('binds on the given host with no localhost in the url', async () => {
    const page = await serveConnectPage({ publishableKey: 'pk_test_1', host: '0.0.0.0', port: 0 })
    close = page.close
    expect(page.url).not.toContain('localhost')
    expect(page.url).toContain('/connect')
  })

  it('serves the connect page with the Stripe.js script and no secret key embedded', async () => {
    const page = await serveConnectPage({ publishableKey: 'pk_test_1', host: '0.0.0.0', port: 0 })
    close = page.close
    const boundHost = new URL(page.url).host
    const parsed = new URL(page.url)
    const response = await fetch(
      `http://127.0.0.1:${parsed.port}/connect?${parsed.searchParams.toString()}`,
    )
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('js.stripe.com/v3')
    expect(body).toContain('pk_test_1')
    expect(boundHost).not.toContain('localhost')
  })

  it('returns 404 from /connect without the correct token', async () => {
    const page = await serveConnectPage({ publishableKey: 'pk_test_1', host: '0.0.0.0', port: 0 })
    close = page.close
    const port = new URL(page.url).port
    const response = await fetch(`http://127.0.0.1:${port}/connect`)
    expect(response.status).toBe(404)
    const withWrongToken = await fetch(`http://127.0.0.1:${port}/connect?t=wrong`)
    expect(withWrongToken.status).toBe(404)
  })

  it('returns 409 from /secret before collect has been called', async () => {
    const page = await serveConnectPage({ publishableKey: 'pk_test_1', host: '0.0.0.0', port: 0 })
    close = page.close
    const port = new URL(page.url).port
    const token = new URL(page.url).searchParams.get('t')
    const response = await fetch(`http://127.0.0.1:${port}/secret`, {
      headers: { 'x-errands-token': token ?? '' },
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'NOT_READY' })
  })

  it('serves the secret once collect is called, and /done resolves collect', async () => {
    const page = await serveConnectPage({ publishableKey: 'pk_test_1', host: '0.0.0.0', port: 0 })
    close = page.close
    const port = new URL(page.url).port
    const token = new URL(page.url).searchParams.get('t') ?? ''

    const collected = page.collect('cs_1')

    const secretResponse = await fetch(`http://127.0.0.1:${port}/secret`, {
      headers: { 'x-errands-token': token },
    })
    expect(secretResponse.status).toBe(200)
    expect(await secretResponse.json()).toEqual({ clientSecret: 'cs_1' })

    const doneResponse = await fetch(`http://127.0.0.1:${port}/done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-errands-token': token },
      body: JSON.stringify({ accountIds: ['fca_1'] }),
    })
    expect(doneResponse.status).toBe(200)
    expect(await doneResponse.json()).toEqual({ ok: true })

    await expect(collected).resolves.toEqual(['fca_1'])
  })

  it('calling collect twice supersedes the first pending promise', async () => {
    const page = await serveConnectPage({ publishableKey: 'pk_test_1', host: '0.0.0.0', port: 0 })
    close = page.close
    const port = new URL(page.url).port
    const token = new URL(page.url).searchParams.get('t') ?? ''

    const first = page.collect('cs_1')
    const firstRejection = expect(first).rejects.toThrow('CONNECT_SUPERSEDED')

    const second = page.collect('cs_2')
    await fetch(`http://127.0.0.1:${port}/done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-errands-token': token },
      body: JSON.stringify({ accountIds: ['fca_2'] }),
    })

    await firstRejection
    await expect(second).resolves.toEqual(['fca_2'])
  })

  it('returns 404 for unknown routes', async () => {
    const page = await serveConnectPage({ publishableKey: 'pk_test_1', host: '0.0.0.0', port: 0 })
    close = page.close
    const port = new URL(page.url).port
    const response = await fetch(`http://127.0.0.1:${port}/nope`)
    expect(response.status).toBe(404)
  })

  it('close() stops the server', async () => {
    const page = await serveConnectPage({ publishableKey: 'pk_test_1', host: '0.0.0.0', port: 0 })
    close = page.close
    const port = new URL(page.url).port
    await page.close()
    close = undefined
    await expect(fetch(`http://127.0.0.1:${port}/connect`)).rejects.toBeTruthy()
  })

  it('/done with malformed body rejects collect and returns 400', async () => {
    const page = await serveConnectPage({ publishableKey: 'pk_test_1', host: '0.0.0.0', port: 0 })
    close = page.close
    const port = new URL(page.url).port
    const token = new URL(page.url).searchParams.get('t') ?? ''

    const collected = page.collect('cs_1')
    // Suppress the unhandled rejection warning by adding a catch handler
    collected.catch(() => {})

    const doneResponse = await fetch(`http://127.0.0.1:${port}/done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-errands-token': token },
      body: 'not json',
    })
    expect(doneResponse.status).toBe(400)

    await expect(collected).rejects.toThrow('CONNECT_BAD_DONE_BODY')
  })

  it('/secret without the header returns 401 and leaves a pending collect pending', async () => {
    const page = await serveConnectPage({ publishableKey: 'pk_test_1', host: '0.0.0.0', port: 0 })
    close = page.close
    const port = new URL(page.url).port

    const collected = page.collect('cs_1')
    let settled = false
    collected.then(
      () => (settled = true),
      () => (settled = true),
    )

    const response = await fetch(`http://127.0.0.1:${port}/secret`)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'UNAUTHORIZED' })
    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toBe(false)

    // Clean up the pending promise so afterEach's close() doesn't leak it.
    const token = new URL(page.url).searchParams.get('t') ?? ''
    await fetch(`http://127.0.0.1:${port}/done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-errands-token': token },
      body: JSON.stringify({ accountIds: ['fca_1'] }),
    })
    await collected
  })

  it('/done without the header returns 401 and leaves a pending collect pending', async () => {
    const page = await serveConnectPage({ publishableKey: 'pk_test_1', host: '0.0.0.0', port: 0 })
    close = page.close
    const port = new URL(page.url).port

    const collected = page.collect('cs_1')
    let settled = false
    collected.then(
      () => (settled = true),
      () => (settled = true),
    )

    const response = await fetch(`http://127.0.0.1:${port}/done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountIds: ['fca_attacker'] }),
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'UNAUTHORIZED' })
    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toBe(false)

    const token = new URL(page.url).searchParams.get('t') ?? ''
    await fetch(`http://127.0.0.1:${port}/done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-errands-token': token },
      body: JSON.stringify({ accountIds: ['fca_1'] }),
    })
    await collected
  })
})
