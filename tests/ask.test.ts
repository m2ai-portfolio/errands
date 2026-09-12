import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createAsk } from '../src/ask.js'

function io() {
  const input = new PassThrough()
  let written = ''
  const output = new PassThrough()
  output.on('data', (chunk) => (written += String(chunk)))
  return { input, output, text: () => written }
}

describe('createAsk', () => {
  it('reads a piped answer that arrived before the question was asked', async () => {
    const { input, output, text } = io()
    input.write('y\n')
    const ask = createAsk(input, output, {})
    expect(await ask('Spend $15?')).toBe(true)
    expect(text()).toContain('DECISION NEEDED: Spend $15? [y/N]')
  })

  it('treats anything but yes as no, including end of input', async () => {
    const { input, output } = io()
    const ask = createAsk(input, output, {})
    const pending = ask('Spend $15?')
    input.end('nope\n')
    expect(await pending).toBe(false)

    const closed = io()
    closed.input.end()
    expect(await createAsk(closed.input, closed.output, {})('Spend?')).toBe(false)
  })

  it('answers from ERRANDS_APPROVE without touching the terminal', async () => {
    const { input, output, text } = io()
    expect(await createAsk(input, output, { ERRANDS_APPROVE: 'yes' })('Spend?')).toBe(true)
    expect(await createAsk(input, output, { ERRANDS_APPROVE: 'no' })('Spend?')).toBe(false)
    expect(text()).toContain('(ERRANDS_APPROVE)')
  })
})
