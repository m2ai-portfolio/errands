import { readFileSync } from 'node:fs'
import { stdout, stderr } from 'node:process'
import { createErrandsAgent } from '../src/agent.js'
import { loadConfig } from '../src/config.js'
import { blurrErrand, type Shop } from '../src/errands/blurr.js'
import { dinnerErrand } from '../src/errands/dinner.js'
import { subscriptionsErrand } from '../src/errands/subscriptions.js'
import type { AskHuman } from '../src/gate-intervention.js'
import { createGate } from '../src/gate.js'
import { consoleStepUp, type StepUpChannel } from '../src/stepup.js'
import { FixtureBank } from '../src/tools/bank.js'
import type { DepositProcessor, DepositReceipt } from '../src/tools/deposit.js'
import type { CallResult, VoiceConfig } from '../src/tools/phone.js'
import type { Transaction } from '../src/tools/recurring.js'
import { FixtureRestaurantSearch, type Restaurant } from '../src/tools/restaurants.js'
import { FixtureTaskers } from '../src/tools/taskers.js'
import type { CallRunner } from '../src/errands/types.js'
import type { TaskerProfile } from '../src/trust.js'

// Offline end-to-end run of all three errands (dinner, subscriptions, Blurr)
// against the real Bedrock model, with every external side effect scripted:
// no phone calls, no Stripe charges, no bank connection. This is Task 18 of
// the trust-ladder-and-life-errands SDD: a transcript proving the trust ladder
// (search -> call -> confirm -> step-up -> handover) works end to end without
// spending real money or dialing a real line. The fourth sentence is the other
// half of the ladder: hiring the same driver a second time, now that she is
// proven, runs as a notify with no approval prompt at all. Run at most three
// times: Bedrock costs real money per invocation.

const DEFAULT_CALLER_VOICE: VoiceConfig = {
  provider: 'cartesia',
  model: 'sonic-3.5',
  voiceId: 'a167e0f3-df7e-4d52-a9c3-f949145efdab',
}

const SENTENCES = [
  'Book dinner for 2 tonight at 7 PM at Bella Cucina in Nashville. If they are full, find somewhere comparable between 6:30 and 8:00 PM.',
  "Find everything I'm paying for monthly and cancel Netflix.",
  'Get Blurr, my car, an oil change this week and have someone take it there and back.',
  'Book Blurr, my car, for a tire rotation at Nashville Lube and Tire next Tuesday at 9:00 AM, pay whatever they quote, and hire Maria R. (tasker maria-r) to take it there and back like last time.',
]

// Scripted call outcomes, keyed by the Vapi assistant name each errand module
// builds. The dinner reservation assistant is called twice in this run (the
// requested restaurant, then a fallback), so its outcome depends on how many
// times it has already been dialed; every other assistant name is scripted
// once and repeats that same outcome on every call.
function scriptedOutcome(
  assistantName: string,
  callCounts: Map<string, number>,
): { summary: string; structuredData: unknown } {
  const n = (callCounts.get(assistantName) ?? 0) + 1
  callCounts.set(assistantName, n)

  switch (assistantName) {
    case 'Errands reservation call':
      if (n === 1) {
        return {
          summary: 'Restaurant is fully booked for the requested time and window.',
          structuredData: {
            booked: false,
            confirmedTime: null,
            confirmationCode: null,
            depositRequiredCents: 0,
            notes: 'Fully booked tonight, no availability in the flexibility window.',
          },
        }
      }
      return {
        summary: 'Restaurant confirmed a table and quoted a deposit to hold it.',
        structuredData: {
          booked: true,
          confirmedTime: '7:00 PM',
          confirmationCode: 'TR-4821',
          depositRequiredCents: 1500,
          notes: '',
        },
      }
    case 'Errands cancellation call':
      return {
        summary: 'Merchant confirmed the cancellation.',
        structuredData: {
          cancelled: true,
          confirmation: 'CX-4471',
          effectiveDate: 'end of billing period',
          mustCallYourself: false,
          notes: '',
        },
      }
    case 'Errands service booking call':
      return {
        summary: 'Shop booked the oil change and quoted a price.',
        structuredData: {
          booked: true,
          slot: 'Tuesday 9:00 AM',
          quoteCents: 8900,
          confirmation: 'NL-77',
          notes: '',
        },
      }
    case 'Errands tasker screen call':
      return {
        summary: 'Tasker passed the phone screen.',
        structuredData: {
          available: true,
          answers: { manual: true, insurance: true, slot: true },
          notes: '',
        },
      }
    default:
      throw new Error(`OFFLINE_RUN_UNKNOWN_ASSISTANT: ${assistantName}`)
  }
}

function buildRunCall(): CallRunner {
  const callCounts = new Map<string, number>()
  let callSeq = 0
  return async ({ assistant }) => {
    callSeq += 1
    const name = (assistant as { name?: unknown }).name
    const assistantName = typeof name === 'string' ? name : 'unknown'
    const { summary, structuredData } = scriptedOutcome(assistantName, callCounts)
    const result: CallResult = {
      callId: `offline-${callSeq}`,
      endedReason: 'assistant-ended-call',
      summary,
      structuredData,
    }
    return result
  }
}

// A fake DepositProcessor: no Stripe call, just a deterministic receipt.
function buildDeposits(): DepositProcessor {
  let seq = 0
  return {
    async charge({ amountCents }): Promise<DepositReceipt> {
      seq += 1
      return { id: `pi_offline_${seq}`, status: 'succeeded', amountCents }
    },
  }
}

// The script owns both ends of the second channel: it stores the code
// delivered on the "second channel" (printed to stderr, same as the real
// consoleStepUp) and answers step-up questions with that stored code, so a
// wrong code would decline. This replaces ERRANDS_APPROVE, which cannot
// approve a step-up by design.
function buildDecisionMakers(): { askHuman: AskHuman; stepUp: StepUpChannel } {
  let lastStepUpCode: string | null = null
  const writeStepUp = consoleStepUp((line) => stderr.write(line + '\n'))

  const stepUp: StepUpChannel = async (code, summary) => {
    lastStepUpCode = code
    await writeStepUp(code, summary)
  }

  const askHuman: AskHuman = async (prompt, options) => {
    stdout.write(`\n>>> DECISION NEEDED: ${prompt}\n`)
    if (options?.expectCode) {
      const approved = lastStepUpCode !== null && lastStepUpCode === options.expectCode
      stdout.write(`${approved ? lastStepUpCode : '(declined)'}  (offline runner)\n`)
      return approved
    }
    stdout.write('y  (offline runner)\n')
    return true
  }

  return { askHuman, stepUp }
}

async function main() {
  const config = loadConfig()
  const log = (line: string) => stdout.write(`  · ${line}\n`)

  const restaurantFixtures = JSON.parse(
    readFileSync(new URL('../fixtures/restaurants.json', import.meta.url), 'utf8'),
  ) as Restaurant[]
  const taskerFixtures = JSON.parse(
    readFileSync(new URL('../fixtures/taskers.json', import.meta.url), 'utf8'),
  ) as TaskerProfile[]
  const shopFixtures = JSON.parse(
    readFileSync(new URL('../fixtures/shops.json', import.meta.url), 'utf8'),
  ) as Shop[]
  const transactionFixtures = JSON.parse(
    readFileSync(new URL('../fixtures/transactions.json', import.meta.url), 'utf8'),
  ) as Transaction[]

  const search = new FixtureRestaurantSearch(restaurantFixtures)
  const bank = new FixtureBank(transactionFixtures)
  const taskers = new FixtureTaskers(taskerFixtures)
  // One call runner for the whole run, shared by every sentence's fresh
  // errand modules: it is what tracks how many times each scripted assistant
  // name has been dialed (the dinner reservation call's second-attempt
  // fallback depends on this), so it must not be rebuilt per sentence.
  const runCall = buildRunCall()
  const deposits = buildDeposits()
  const voice = DEFAULT_CALLER_VOICE
  const { askHuman, stepUp } = buildDecisionMakers()

  // One gate for the whole run: the ledger and trust events must carry across
  // all three errands so the Blurr hire (a first handover) shows the ladder
  // built up by the earlier, smaller spends.
  const gate = createGate(config.policy)

  // Each sentence gets brand-new errand modules and a brand-new agent. A
  // module instance's per-errand counters (Blurr's call budget, its booked
  // and paid state) are meant to reset with every CLI process in production,
  // which this run simulates by rebuilding them per sentence; the gate and
  // the call runner are the two things that must persist across sentences,
  // so they alone are built once above and threaded into every rebuild.
  function buildModulesForSentence() {
    const dinner = dinnerErrand({ config, gate, search, runCall, deposits, voice, log })
    const subscriptions = subscriptionsErrand({ config, gate, bank, runCall, voice, log })
    const blurr = blurrErrand({
      config,
      gate,
      taskers,
      shops: shopFixtures,
      runCall,
      deposits,
      voice,
      vetting: config.policy.vetting,
      log,
    })
    return [dinner, subscriptions, blurr]
  }

  stdout.write(`Errands offline run (${config.mode} mode, search: ${search.source})\n\n`)

  for (const [i, sentence] of SENTENCES.entries()) {
    stdout.write(`\n=== Errand ${i + 1}/${SENTENCES.length} ===\nRequest: ${sentence}\n\n`)
    const agent = createErrandsAgent(
      {
        modules: buildModulesForSentence(),
        gate,
        askHuman,
        stepUp,
        notify: log,
        customerName: config.customerName,
      },
      config.bedrock,
    )
    await agent.invoke(sentence)
    stdout.write('\n')
  }

  stdout.write('\n=== Ledger ===\n')
  stdout.write(JSON.stringify(gate.ledger()) + '\n')
  stdout.write('\n=== Trust events ===\n')
  stdout.write(JSON.stringify(gate.events()) + '\n')
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
