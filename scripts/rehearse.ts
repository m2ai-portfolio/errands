// Rehearsal driver for live errand runs (Task 20). Spawns `npx tsx src/cli.ts
// <sentence>`, merges stdout+stderr into one transcript in arrival order, and
// answers the CLI's stdin prompts by watching the merged stream: a plain
// "DECISION NEEDED" gets "y", and a "DECISION NEEDED" that arrives after a
// "[second channel] ... code NNNNNN" line gets that code instead. Every answer
// this script gives is logged into the transcript as "<< rehearse: <answer>".
//
// Usage: npx tsx scripts/rehearse.ts <transcript path> "<sentence>"
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { mkdirSync, createWriteStream } from 'node:fs'
import { dirname } from 'node:path'

function requireArg(value: string | undefined): string {
  if (!value) {
    console.error('Usage: npx tsx scripts/rehearse.ts <transcript path> "<sentence>"')
    process.exit(1)
    throw new Error('unreachable')
  }
  return value
}

const transcriptPath = requireArg(process.argv[2])
const sentence = requireArg(process.argv[3])

mkdirSync(dirname(transcriptPath), { recursive: true })
const out = createWriteStream(transcriptPath, { flags: 'w' })

const CODE_RE = /\[second channel\][^\n]*code (\d{6})/
const DECISION_RE = /DECISION NEEDED/

let pendingCode: string | null = null

function write(chunk: string): void {
  out.write(chunk)
  process.stdout.write(chunk)
}

async function main(): Promise<number> {
  const child: ChildProcessByStdio<Writable, Readable, Readable> = spawn(
    'npx',
    ['tsx', 'src/cli.ts', sentence],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )

  let buffer = ''

  const handleChunk = (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    write(text)
    buffer += text

    // A fresh step-up code can appear anywhere in the buffered text; capture
    // the most recent one seen so far.
    const codeMatch = buffer.match(CODE_RE)
    if (codeMatch) pendingCode = codeMatch[1] ?? pendingCode

    if (DECISION_RE.test(buffer)) {
      const answer = pendingCode ?? 'y'
      const line = `${answer}\n`
      child.stdin.write(line)
      const logLine = `<< rehearse: ${answer}\n`
      write(logLine)
      // Consume this decision so the next chunk starts fresh: a code is only
      // used once, and a repeated "DECISION NEEDED" match in old buffer text
      // must not re-trigger an extra answer.
      buffer = ''
      pendingCode = null
    }
  }

  child.stdout.on('data', handleChunk)
  child.stderr.on('data', handleChunk)

  return new Promise((resolve) => {
    child.on('close', (code) => resolve(code ?? 1))
  })
}

const exitCode = await main()
out.end()
process.exit(exitCode)
