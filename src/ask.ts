import { createInterface } from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'
import type { AskHuman } from './gate-intervention.js'

// The human decision surface. Interactive: a y/N question on the terminal, or
// (when a step-up code is required) a prompt that only accepts the code that
// was delivered on the second channel. Non-interactive (judges' test runs,
// CI): ERRANDS_APPROVE=yes|no answers every question without a terminal.
// Anything else means "no".

export function createAsk(
  input: Readable & { isTTY?: boolean },
  output: Writable,
  env: NodeJS.ProcessEnv = process.env,
): AskHuman {
  const raw = env.ERRANDS_APPROVE?.trim().toLowerCase()
  const preset = raw ? raw : undefined
  return async (prompt, options) => {
    const expectCode = options?.expectCode
    output.write(
      expectCode
        ? `\n>>> DECISION NEEDED: ${prompt}\n    A code was sent on your second channel. Type it to approve, or press Enter to decline: `
        : `\n>>> DECISION NEEDED: ${prompt} [y/N] `,
    )
    if (preset !== undefined) {
      if (expectCode) {
        output.write('(ERRANDS_APPROVE cannot approve a step-up; declined)\n')
        return false
      }
      const approved = preset === 'yes' || preset === 'y'
      output.write(`${approved ? 'y' : 'n'}  (ERRANDS_APPROVE)\n`)
      return approved
    }
    // The reader is created per question so buffered piped input is not
    // consumed before anyone is listening for it.
    const rl = createInterface({ input, output, terminal: input.isTTY === true })
    try {
      const line = await new Promise<string | null>((resolve) => {
        rl.once('line', (l) => resolve(l))
        rl.once('close', () => resolve(null))
      })
      if (line === null) return false
      return expectCode ? line.trim() === expectCode : /^y(es)?$/i.test(line.trim())
    } finally {
      rl.close()
    }
  }
}
