import { createInterface } from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'
import type { AskHuman } from './gate-intervention.js'

// The human decision surface. Interactive: a y/N question on the terminal.
// Non-interactive (judges' test runs, CI): ERRANDS_APPROVE=yes|no answers
// every question without a terminal. Anything else means "no".

export function createAsk(
  input: Readable & { isTTY?: boolean },
  output: Writable,
  env: NodeJS.ProcessEnv = process.env,
): AskHuman {
  const preset = env.ERRANDS_APPROVE?.trim().toLowerCase()
  return async (prompt) => {
    output.write(`\n>>> DECISION NEEDED: ${prompt} [y/N] `)
    if (preset !== undefined) {
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
      return line !== null && /^y(es)?$/i.test(line.trim())
    } finally {
      rl.close()
    }
  }
}
