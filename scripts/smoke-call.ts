// Live smoke test of one reservation call to a DEMO line (never a real business).
// Usage: npx tsx scripts/smoke-call.ts [full|open]
import { loadConfig } from '../src/config.js'
import {
  buildReservationAssistant,
  placeCall,
  VapiClient,
  type VoiceConfig,
} from '../src/tools/phone.js'

const role = process.argv[2] === 'open' ? 1 : 0
const config = loadConfig()
const to = config.demoLines[role]
if (!to) throw new Error(`No demo line for role index ${role}`)

const voice: VoiceConfig = process.env.ERRANDS_CALLER_VOICE
  ? (JSON.parse(process.env.ERRANDS_CALLER_VOICE) as VoiceConfig)
  : { provider: 'vapi', voiceId: 'Elliot', version: '2' }

const started = Date.now()
const result = await placeCall({
  client: new VapiClient(config.vapiApiKey),
  phoneNumberId: config.outboundPhoneNumberId,
  to,
  assistant: buildReservationAssistant(
    {
      restaurantName: role === 0 ? 'Bella Cucina' : 'Trattoria Roma',
      customerName: config.customerName,
      partySize: 2,
      time: '7:00 PM tonight',
      flexibility: '6:30 to 8:00 PM',
    },
    voice,
  ),
})
console.log(
  JSON.stringify({ seconds: Math.round((Date.now() - started) / 1000), ...result }, null, 1),
)
