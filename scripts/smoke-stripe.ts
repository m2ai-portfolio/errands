// Live smoke test of the deposit path against Stripe TEST MODE.
// Usage: npx tsx scripts/smoke-stripe.ts [amountCents]
import { StripeTestDeposits } from '../src/tools/deposit.js'

const amountCents = Number(process.argv[2] ?? 1500)
const deposits = new StripeTestDeposits(process.env.STRIPE_SECRET_KEY ?? '')
const receipt = await deposits.charge({
  amountCents,
  description: 'Errands smoke test (test mode)',
  idempotencyKey: `errands-smoke-${Date.now()}`,
})
console.log(JSON.stringify(receipt))
