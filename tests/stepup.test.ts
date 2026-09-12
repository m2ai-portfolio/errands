import { describe, expect, it, vi } from 'vitest'
import { consoleStepUp, formatStepUp, telegramStepUp } from '../src/stepup.js'

const summary = {
  who: 'Nashville Lube',
  amountCents: 8900,
  category: 'service_booking',
  triedFirst: 'asked for a quote by phone',
}

describe('step-up', () => {
  it('formats the message with who, amount, category and what was tried first', () => {
    const text = formatStepUp('123456', summary)
    expect(text).toContain('Nashville Lube')
    expect(text).toContain('$89.00')
    expect(text).toContain('service_booking')
    expect(text).toContain('asked for a quote by phone')
    expect(text).toContain('123456')
  })
  it('console channel writes one labelled line', async () => {
    const lines: string[] = []
    await consoleStepUp((l) => lines.push(l))('123456', summary)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\[second channel\] /)
  })
  it('telegram channel posts sendMessage with the chat id and text', async () => {
    const fetchFn = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    await telegramStepUp('tok', '42', fetchFn as unknown as typeof fetch)('123456', summary)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.telegram.org/bottok/sendMessage')
    expect(JSON.parse(init.body as string)).toMatchObject({ chat_id: '42' })
  })
  it('telegram channel throws on a non-2xx response', async () => {
    const fetchFn = vi.fn(async () => new Response('nope', { status: 401 }))
    await expect(
      telegramStepUp('tok', '42', fetchFn as unknown as typeof fetch)('1', summary),
    ).rejects.toThrow('STEPUP_TELEGRAM_401')
  })
})
