# Trust ladder and life errands: design

Date: 2026-09-12. Target: Agents for Humans Hackathon submission, deadline 2026-09-14 17:00 PT (19:00 CDT). Status: approved in conversation, awaiting Matthew's review of this file.

## Goal

Extend Errands from one errand (dinner) to three running errands and one trust model that governs both the AI's spending and the humans it hires on your behalf. The judge takeaway: the same ladder of trust applies to any agent acting for you, silicon or human, and every rung boundary is a human decision enforced in code.

## Non-goals

- Reading a consumer's Link (link.com) account. No public API exists. Bank data comes from Stripe Financial Connections with the user's consent.
- Live marketplace booking (TaskRabbit, Thumbtack). No verified booking API. Taskers come from a fixture marketplace.
- AgentCore deployment. Optional stretch, not in this spec.
- Live mode for Financial Connections (needs Stripe registration). Sandbox only.

## 1. Trust ledger and policy

### Counterparties and rungs

A counterparty is anyone acting for the user: the agent itself in a spend category, or a named human. Each counterparty has a rung:

| Rung       | Meaning                                                                                       | What passes without asking                                        |
| ---------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `unknown`  | No evidence                                                                                   | Nothing                                                           |
| `screened` | Passed the vetting policy (human) or category is on the allowlist (AI)                        | Nothing spends; every spend or hire asks (one tap)                |
| `proven`   | Track record: `promoteAfter` clean confirmed events, or one completed job with a good outcome | Spend under `notifyCapCents` proceeds with a notification, no tap |
| `trusted`  | Explicit grant in policy.json                                                                 | Same as proven, higher cap                                        |

Rules that never relax, regardless of rung:

1. Spend over `perTransactionCapCents`, or that breaches daily or weekly caps, is forbidden.
2. A first-time property handover (`handover: true` on a hire) always asks.
3. Any counterparty at `unknown` always asks, and a human at `unknown` cannot be hired at all.
4. Step-up: any confirm where `amountCents >= stepUpCents` (default 5000) delivers the approval code out of band, not in the same channel the agent is talking on.

### Request kinds

The gate evaluates three request kinds instead of one:

```ts
type GateRequest =
  | { kind: 'spend'; merchant: string; amountCents: number; category: string }
  | {
      kind: 'hire'
      counterpartyId: string
      amountCents: number
      taskClass: string
      handover: boolean
    }
  | { kind: 'handover'; counterpartyId: string; property: string }
```

`evaluate(request, at)` returns `allow | notify | confirm | forbid` plus a reason. `notify` is new: the tool runs, and the human is told afterwards. The intervention maps `notify` to proceed plus a message.

### Evidence, promotion, demotion

The ledger gains a `trustEvents` table: `{ counterpartyId, kind: 'clean' | 'incident', detail, at }`. Promotion and demotion are deterministic functions of the events:

- `screened -> proven`: `promoteAfter` consecutive `clean` events for an AI category (default 3), or `promoteHumanAfter` consecutive `clean` events for a human (default 1, i.e. one completed job).
- Any `incident` (dispute, no-show, quoted amount mismatch, human declined after vetting) drops the counterparty one rung and resets the clean count.
- `trusted` is only set by hand in policy.json and is never granted by promotion.

### Vetting policy for humans

```json
"vetting": {
  "minRating": 4.7,
  "minJobs": 50,
  "requireBackgroundCheck": true,
  "requireInsuredFor": { "vehicle": true }
}
```

`vet(profile, policy)` returns `{ passed, failures[] }`. A profile that passes the policy and a phone screen with `available: true` and all screen questions answered `yes` moves the human from `unknown` to `screened`. The screen result is attached to the hire request so the human sees the evidence in the approval prompt.

### Step-up channel

`src/stepup.ts` exposes `deliverCode(code, summary)`. Two implementations: `telegram` (Bot API `sendMessage` with `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` from the environment) and `console` (prints to stderr prefixed `[second channel]`, used in demo mode and by judges). The summary always states merchant or counterparty, amount, category, and what the agent tried first.

### policy.json shape

```json
{
  "enabled": true,
  "perTransactionCapCents": 10000,
  "dailyCapCents": 20000,
  "weeklyCapCents": 25000,
  "approvalTtlMinutes": 30,
  "stepUpCents": 5000,
  "promoteAfter": 3,
  "promoteHumanAfter": 1,
  "categories": {
    "call": "allow",
    "restaurant_deposit": "confirm",
    "service_booking": "confirm",
    "hire": "confirm",
    "cancellation": "confirm",
    "gift": "forbid"
  },
  "notifyCapCents": { "restaurant_deposit": 2500, "service_booking": 4500 },
  "vetting": { "...": "as above" },
  "counterparties": {
    "maria-r": { "rung": "trusted", "note": "picked up Blurr twice" }
  }
}
```

Every notify cap must be below `stepUpCents`; the config loader rejects a policy where it is not. Caps rise from the current $20 because the demo spends up to $38 (Tasker) and a $50+ step-up must be reachable.

### Files

- `src/gate.ts`: extend `evaluate`, `requestApproval`, `commit` for the three kinds. Existing spend behavior unchanged for callers that pass `kind: 'spend'` (a shim keeps the old signature working until the two errands land).
- `src/trust.ts` (new): rungs, promotion, demotion, `vet`.
- `src/stepup.ts` (new).
- `src/gate-intervention.ts`: handle `notify`, call step-up when the threshold is met, include vetting evidence in the prompt for hires.
- `policy.json`, `src/config.ts`: schema and loading.

### Tests

Rung transitions in both directions; `notify` only at proven or trusted and under the cap; step-up fires at exactly `stepUpCents`; first handover always asks even for `trusted`; unknown human cannot be hired; incident resets the clean count; `vet` fails on each policy field independently.

## 2. Subscription errand

Sentence: "Find everything I'm paying for monthly and cancel what I don't use."

### Tools

- `connect_bank()`: creates a Financial Connections session (`account_holder` = the demo customer, `permissions: ['transactions']`, `prefetch: ['transactions']`), starts a small local page on the LAN (`http://10.0.0.46:<port>/connect`, never localhost) that runs Stripe.js `collectFinancialConnectionsAccounts` with the session's `client_secret`, and waits until an account is collected. Returns `{ accountId, institution, last4 }`. In fixture mode, returns a fixture account immediately.
- `list_recurring(accountId)`: refreshes transactions if needed, lists up to 180 days, normalizes merchant strings, groups by merchant, detects cadence (weekly, monthly, yearly) from interval regularity and amount stability, and returns `[{ merchant, amountCents, cadence, lastChargedAt, count }]`. Fixture mode reads `fixtures/transactions.json`.
- `cancel_subscription({ merchant })`: a Vapi call with a cancellation script. The caller identifies itself as an AI assistant acting for the customer, asks to cancel, records `{ cancelled: boolean, confirmation?: string, mustCallYourself?: boolean, effectiveDate?: string }`. In demo mode it dials the switchboard line (section 4).

### Gate interaction

`cancel_subscription` is a `spend` of 0 cents in category `cancellation` set to `confirm`: cancelling is a commitment the human makes, not the agent. The human picks the merchants from the recurring list in one prompt; each cancel call then passes the gate with that approval.

### Files

`src/tools/bank.ts`, `src/tools/recurring.ts` (pure grouping logic, fully unit tested), `src/tools/cancel.ts` (extends the phone module with a second assistant builder), `src/connect-page.ts` (the LAN page), `fixtures/transactions.json`, `docs/live-run-subscriptions.txt` after the rehearsal.

### Tests

Grouping on the fixture yields the expected recurring set and rejects one-off charges; cadence detection tolerates 2-day jitter; merchant normalization collapses `NETFLIX.COM 866-579-7172` and `Netflix` into one; the cancel outcome schema treats missing fields as null (same fix as the reservation outcome); an offline end-to-end run in the Strands loop order.

## 3. Blurr errand with vetting

Sentence: "Get Blurr an oil change this week and have someone take it there and back."

### Tools

- `book_service({ shopId, service, window })`: a call to the shop for a slot and a quote. Outcome `{ booked, slot, quoteCents, confirmation }`. Category `service_booking`; passes the gate as a spend of `quoteCents` at confirm time, and the human is asked before the deposit or payment, same as dinner.
- `find_taskers({ taskClass: 'vehicle', window })`: reads `fixtures/taskers.json` and returns profiles: `{ id, name, rating, jobs, backgroundCheck, insuredFor[], yearsActive, rateCents }`.
- `vet_tasker({ taskerId })`: runs `vet(profile, policy)`; if it passes, places a phone screen call to the switchboard line: availability for the slot, has driven a manual transmission, confirms insurance. Returns `{ passed, failures, screen: { available, answers } }`.
- `hire_tasker({ taskerId, amountCents, handover: true })`: a `hire` request through the gate. Always asks on a first handover. The prompt shows the vetting evidence: "Hire Maria R., 4.9 stars, 212 jobs, background checked, insured for vehicles, screened by phone, $38.00, keys to Blurr Tuesday 9:00 AM. Approve?" Since $38 is under `stepUpCents`, this is a one-tap confirm; the shop quote ($89 in the fixture) is over it and triggers the out-of-band code, so the demo shows both.

### Files

`src/tools/service.ts`, `src/tools/taskers.ts`, `fixtures/taskers.json` (five profiles, two that fail vetting for different reasons, one at `trusted`), `docs/live-run-blurr.txt` after the rehearsal.

### Tests

The best-scored candidate is chosen and the failing ones are excluded with the reason named; the hire is denied without a phone screen; the hire asks even when the counterparty is `trusted` if it is the first handover; the second hire of the same person after a clean event runs as notify.

## 4. Demo, README, video, submission

### Demo lines

The two existing lines (full, open) stay. One new inbound line, role `switchboard`: its assistant plays whichever business the caller announces in the opening sentence (an oil change shop, a subscription's support desk, or a Tasker), with scripted answers for each. This avoids three new phone numbers. `demo.json` gains the third line; `demo.example.json` documents it.

### CLI

`errands "<sentence>"` stays the single entry. The agent's system prompt lists the three errand shapes and routes by intent; no hardcoded errand switch.

### README

New sections: "The trust ladder" (the rung table, the four rules that never relax, the step-up), "Three errands" with the three transcripts, "Other errands it is built for" with the four described scenarios (groceries from a recipe, party plus dry cleaning and milk, movie night, make-good night, dinner forks folded into groceries), and updated "Run it" and testing instructions including `ERRANDS_STEPUP=console` and fixture mode for judges without Stripe or Vapi.

### Video

Re-cut under 5 minutes, three acts: dinner (existing footage where still accurate), subscriptions, Blurr. The ladder is the through-line: each act ends on the decision the human made and the rung it moved. The pitch covers problem, who it is for, why it matters, and names Strands and Bedrock on screen. Produced in the existing HyperFrames project.

### Submission

Update the Devpost description, testing instructions, and the architecture diagram (add the trust ledger and the two new tool groups). Submit only on Matthew's explicit word. Submitter type per his team decision.

## 5. Build orchestration

Fable (this session) is the orchestrator. Lanes:

1. **Trust core** (`src/gate.ts`, `src/trust.ts`, `src/stepup.ts`, intervention, policy, config). Blocks lanes 2 and 3; built first on its test contract.
2. **Subscription errand** and 3. **Blurr errand**: parallel, each in its own git worktree, Sonnet-tier implementers on a test contract written by the orchestrator, file-first output contract, 5-minute stall kill.
3. **Docs and video** once 2 and 3 pass.

Each lane gets an independent Opus-tier review of the actual diff and a Codex adversarial pass through the self-healing loop. Merge order: 1, then 2 and 3, then 4. Fixture mode for every test; live Vapi and Stripe only in one rehearsal per errand (about $0.45 per dinner run; similar per new errand). Demo assistants and numbers are deleted after judging ends on 2026-10-08.

## Open items

- Telegram step-up in live mode needs a bot token and chat id in `~/.env.shared`; the demo uses console. Wire Telegram only if time remains after the three errands pass.
- The Financial Connections consent page is a manual browser click in the demo and is not automated in tests, per Stripe's guidance.
