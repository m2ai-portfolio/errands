// Out-of-band delivery of an approval code. Rule 4 of the trust ladder: at or
// above stepUpCents the code must not travel on the channel the agent talks on.

export interface StepUpSummary {
  who: string
  amountCents: number
  category: string
  triedFirst: string
}

export type StepUpChannel = (code: string, summary: StepUpSummary) => Promise<void>

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`

export function formatStepUp(code: string, summary: StepUpSummary): string {
  return `Errands approval code ${code}: ${dollars(summary.amountCents)} (${summary.category}) to ${summary.who}. First it ${summary.triedFirst}. Reply in the Errands terminal with this code to approve, or ignore to decline.`
}

export function consoleStepUp(write: (line: string) => void): StepUpChannel {
  return async (code, summary) => {
    write(`[second channel] ${formatStepUp(code, summary)}`)
  }
}

export function telegramStepUp(
  token: string,
  chatId: string,
  fetchFn: typeof fetch = fetch,
): StepUpChannel {
  return async (code, summary) => {
    const response = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: formatStepUp(code, summary),
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`STEPUP_TELEGRAM_${response.status}`)
  }
}
