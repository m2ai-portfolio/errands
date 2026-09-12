import { readFileSync } from 'node:fs'
import { stdin, stdout } from 'node:process'
import { createErrandsAgent } from './agent.js'
import { createAsk } from './ask.js'
import { loadConfig } from './config.js'
import { dinnerErrand } from './errands/dinner.js'
import { createGate } from './gate.js'
import { consoleStepUp, telegramStepUp } from './stepup.js'
import { StripeTestDeposits } from './tools/deposit.js'
import { placeCall, VapiClient, type VoiceConfig } from './tools/phone.js'
import {
  FixtureRestaurantSearch,
  GooglePlacesRestaurantSearch,
  type Restaurant,
} from './tools/restaurants.js'

// Usage: npm start -- "Dinner for 2 tonight at 7 at Bella Cucina in Nashville, or somewhere comparable"

const DEFAULT_REQUEST =
  'Book dinner for 2 tonight at 7 PM at Bella Cucina in Nashville. If they are full, find somewhere comparable between 6:30 and 8:00 PM.'

const DEFAULT_CALLER_VOICE: VoiceConfig = {
  provider: 'cartesia',
  model: 'sonic-3.5',
  voiceId: 'a167e0f3-df7e-4d52-a9c3-f949145efdab',
}

async function main() {
  const config = loadConfig()
  const request = process.argv.slice(2).join(' ').trim() || DEFAULT_REQUEST
  const log = (line: string) => stdout.write(`  · ${line}\n`)

  const fixtures = JSON.parse(
    readFileSync(new URL('../fixtures/restaurants.json', import.meta.url), 'utf8'),
  ) as Restaurant[]
  const search =
    config.searchSource === 'google-places' && config.googleApiKey
      ? new GooglePlacesRestaurantSearch(config.googleApiKey)
      : new FixtureRestaurantSearch(fixtures)

  const vapi = new VapiClient(config.vapiApiKey)
  const voice: VoiceConfig = process.env.ERRANDS_CALLER_VOICE
    ? (JSON.parse(process.env.ERRANDS_CALLER_VOICE) as VoiceConfig)
    : DEFAULT_CALLER_VOICE

  const stepUp =
    config.stepUpChannel === 'telegram'
      ? telegramStepUp(process.env.TELEGRAM_BOT_TOKEN ?? '', process.env.TELEGRAM_CHAT_ID ?? '')
      : consoleStepUp((l) => process.stderr.write(l + '\n'))

  const gate = createGate(config.policy)
  const runCall = ({ to, assistant }: { to: string; assistant: object }) =>
    placeCall({ client: vapi, phoneNumberId: config.outboundPhoneNumberId, to, assistant })
  const dinner = dinnerErrand({
    config,
    gate,
    search,
    runCall,
    deposits: new StripeTestDeposits(process.env.STRIPE_SECRET_KEY ?? ''),
    voice,
    log,
  })

  const agent = createErrandsAgent(
    {
      modules: [dinner],
      gate,
      askHuman: createAsk(stdin, stdout),
      stepUp,
      notify: log,
      customerName: config.customerName,
    },
    config.bedrock,
  )

  stdout.write(`Errands (${config.mode} mode, search: ${search.source})\nRequest: ${request}\n\n`)
  // The SDK's default printer streams the agent's text and tool markers to stdout.
  await agent.invoke(request)
  stdout.write('\n')
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
