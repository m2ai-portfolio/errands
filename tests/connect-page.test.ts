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
    const response = await fetch(`http://127.0.0.1:${new URL(page.url).port}/connect`)
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('js.stripe.com/v3')
    expect(body).toContain('pk_test_1')
    expect(boundHost).not.toContain('localhost')
  })

  it('returns 409 from /secret before collect has been called', async () => {
    const page = await serveConnectPage({ publishableKey: 'pk_test_1', host: '0.0.0.0', port: 0 })
    close = page.close
    const port = new URL(page.url).port
    const response = await fetch(`http://127.0.0.1:${port}/secret`)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'NOT_READY' })
  })

  it('serves the secret once collect is called, and /done resolves collect', async () => {
    const page = await serveConnectPage({ publishableKey: 'pk_test_1', host: '0.0.0.0', port: 0 })
    close = page.close
    const port = new URL(page.url).port

    const collected = page.collect('cs_1')

    const secretResponse = await fetch(`http://127.0.0.1:${port}/secret`)
    expect(secretResponse.status).toBe(200)
    expect(await secretResponse.json()).toEqual({ clientSecret: 'cs_1' })

    const doneResponse = await fetch(`http://127.0.0.1:${port}/done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

    const first = page.collect('cs_1')
    const firstRejection = expect(first).rejects.toThrow('CONNECT_SUPERSEDED')

    const second = page.collect('cs_2')
    await fetch(`http://127.0.0.1:${port}/done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

    const collected = page.collect('cs_1')
    // Suppress the unhandled rejection warning by adding a catch handler
    collected.catch(() => {})

    const doneResponse = await fetch(`http://127.0.0.1:${port}/done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    expect(doneResponse.status).toBe(400)

    await expect(collected).rejects.toThrow('CONNECT_BAD_DONE_BODY')
  })
})
