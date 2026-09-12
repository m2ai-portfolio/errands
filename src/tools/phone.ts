import { z } from 'zod'

// Outbound phone calls through Vapi. The Strands agent decides WHEN to call;
// this module decides WHERE a call may go. In demo mode every call is routed to
// test lines we control, so a real business is never dialed. In live mode
// only numbers on an explicit allowlist can be called.

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export const VAPI_BASE = 'https://api.vapi.ai'

export type DestinationPolicy =
  { mode: 'demo'; lines: readonly string[] } | { mode: 'live'; allowlist: readonly string[] }

export class PhoneError extends Error {
  constructor(readonly code: string) {
    super(`Phone call refused: ${code}`)
    this.name = 'PhoneError'
  }
}

export function toE164(phone: string): string | null {
  const digits = phone.replace(/[^\d+]/g, '')
  if (/^\+[1-9]\d{7,14}$/.test(digits)) return digits
  const bare = digits.replace(/^\+/, '')
  if (/^\d{10}$/.test(bare)) return `+1${bare}`
  if (/^1\d{10}$/.test(bare)) return `+${bare}`
  return null
}

// attempt is 0 for the first restaurant tried, 1 for the fallback, and so on.
export function resolveDestination(
  restaurantPhone: string | null,
  attempt: number,
  policy: DestinationPolicy,
): string {
  if (policy.mode === 'demo') {
    const line = policy.lines[Math.min(attempt, policy.lines.length - 1)]
    if (!line) throw new PhoneError('NO_DEMO_LINES')
    return line
  }
  const e164 = restaurantPhone ? toE164(restaurantPhone) : null
  if (!e164) throw new PhoneError('NO_VALID_NUMBER')
  if (!policy.allowlist.includes(e164)) throw new PhoneError('DESTINATION_NOT_ALLOWED')
  return e164
}

// For a caller that targets one specific demo line (the switchboard) rather
// than the attempt-indexed rotation resolveDestination uses.
export function demoLine(policy: DestinationPolicy, number: string | null): string {
  if (policy.mode === 'demo') {
    if (!number) throw new PhoneError('NO_DEMO_LINES')
    return number
  }
  const e164 = number ? toE164(number) : null
  if (!e164) throw new PhoneError('NO_VALID_NUMBER')
  if (!policy.allowlist.includes(e164)) throw new PhoneError('DESTINATION_NOT_ALLOWED')
  return e164
}

export interface ReservationRequest {
  restaurantName: string
  customerName: string
  partySize: number
  time: string
  flexibility: string
}

// Vapi omits structured-data fields it has no value for (a "fully booked" call
// returns no confirmedTime at all), so missing and null mean the same thing.
// Only `booked` is required: without it the outcome is genuinely unknown.
export const CallOutcomeSchema = z.object({
  booked: z.boolean(),
  confirmedTime: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  confirmationCode: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  depositRequiredCents: z
    .number()
    .int()
    .min(0)
    .nullish()
    .transform((v) => v ?? 0),
  notes: z
    .string()
    .nullish()
    .transform((v) => v ?? ''),
})
export type CallOutcome = z.infer<typeof CallOutcomeSchema>

// safeParse wrapper: callers own the schema for their own call type, this
// module never has to know what shape a given script expects back.
export function parseOutcome<T>(schema: z.ZodType<T>, data: unknown): T | null {
  const parsed = schema.safeParse(data)
  return parsed.success ? parsed.data : null
}

const outcomeJsonSchema = {
  type: 'object',
  properties: {
    booked: { type: 'boolean', description: 'True only if the restaurant confirmed a table.' },
    confirmedTime: { type: ['string', 'null'], description: 'Confirmed time, e.g. 7:30 PM.' },
    confirmationCode: {
      type: ['string', 'null'],
      description: 'Confirmation number or the name the booking is under.',
    },
    depositRequiredCents: {
      type: 'integer',
      description: 'Deposit the restaurant requires, in cents. 0 if none.',
    },
    notes: { type: 'string', description: 'One sentence on anything the customer must know.' },
  },
  required: ['booked', 'confirmedTime', 'confirmationCode', 'depositRequiredCents', 'notes'],
}

export interface VoiceConfig {
  provider: string
  voiceId: string
  [key: string]: unknown
}

// Shared Vapi assistant body. Every call script (reservations today, others
// later) builds its own system prompt and structured-data schema, then hands
// both to this function so the Vapi client itself never needs to change when
// a new call script is added.
export function assistantBase<S extends object>(
  name: string,
  system: string,
  voice: VoiceConfig,
  schema: S,
) {
  return {
    name,
    firstMessageMode: 'assistant-waits-for-user' as const,
    maxDurationSeconds: 240,
    model: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'system', content: system }],
    },
    voice,
    endCallPhrases: ['goodbye', 'have a great night', 'have a good night'],
    analysisPlan: {
      structuredDataPlan: { enabled: true, schema },
      successEvaluationPlan: { enabled: true, rubric: 'PassFail' },
    },
  }
}

export function buildReservationAssistant(req: ReservationRequest, voice: VoiceConfig) {
  const system = [
    `You are Errands, an AI assistant phoning ${req.restaurantName} on behalf of ${req.customerName}.`,
    'At the very start, say you are an AI assistant calling to make a dinner reservation.',
    `Ask for a table for ${req.partySize} at ${req.time}. Acceptable flexibility: ${req.flexibility}.`,
    'If that time is unavailable, ask for the closest time within the flexibility. If nothing works, thank them and end the call politely.',
    'If they require a deposit or card to hold the table, ask the amount, say your client will confirm and pay through a link, and do NOT agree to pay.',
    'Never give out any card, account or personal details beyond the name for the booking.',
    'Before ending, repeat back the time, party size and confirmation number or name. Keep the call under two minutes.',
  ].join('\n')
  return assistantBase('Errands reservation call', system, voice, outcomeJsonSchema)
}

interface VapiCall {
  id: string
  status: string
  endedReason?: string | null
  analysis?: { summary?: string; structuredData?: unknown; successEvaluation?: unknown }
}

export class VapiClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: FetchLike = fetch,
  ) {
    if (!apiKey) throw new Error('VAPI_API_KEY is required')
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchFn(`${VAPI_BASE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(20_000),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`VAPI_HTTP_${response.status}: ${text.slice(0, 200)}`)
    return JSON.parse(text) as T
  }

  createCall(body: object): Promise<VapiCall> {
    return this.request<VapiCall>('/call', { method: 'POST', body: JSON.stringify(body) })
  }

  getCall(id: string): Promise<VapiCall> {
    return this.request<VapiCall>(`/call/${encodeURIComponent(id)}`)
  }
}

export interface CallResult {
  callId: string
  endedReason: string | null
  summary: string | null
  structuredData: unknown
}

export interface PlaceCallOptions {
  client: VapiClient
  phoneNumberId: string
  to: string
  assistant: object
  pollMs?: number
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function placeCall(options: PlaceCallOptions): Promise<CallResult> {
  const { client, phoneNumberId, to, assistant } = options
  const pollMs = options.pollMs ?? 5_000
  const timeoutMs = options.timeoutMs ?? 300_000
  const sleep = options.sleep ?? defaultSleep
  const created = await client.createCall({ phoneNumberId, customer: { number: to }, assistant })
  for (let waited = 0; waited <= timeoutMs; waited += pollMs) {
    const call = await client.getCall(created.id)
    if (call.status === 'ended') {
      return {
        callId: created.id,
        endedReason: call.endedReason ?? null,
        summary: call.analysis?.summary ?? null,
        structuredData: call.analysis?.structuredData ?? null,
      }
    }
    await sleep(pollMs)
  }
  throw new PhoneError('CALL_TIMEOUT')
}
