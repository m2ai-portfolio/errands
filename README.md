# Errands

**An AI agent, built with the [Strands Agents SDK](https://strandsagents.com), that runs real-world errands end to end and only interrupts you when a decision needs a human: money, keys, or a stranger.**

Entry for the [Agents for Humans Hackathon](https://agentsforhumans.devpost.com), Everyday Agents track.

## The problem

Booking a table tonight is a small errand that eats 20 minutes: look up the place, call, get told they are full, find something comparable, call again, hand over a card for a deposit. Cancelling the subscriptions you stopped using is worse, because the merchant makes you phone in. Getting the car serviced while you are at work needs a shop, a slot, a payment, and a person you trust with your keys. Every step is easy. Together they are exactly the kind of busywork people put off, and "just use an app" does not help when the business only takes phone calls.

## Who it is for

Busy people who would happily hand the whole errand to an assistant if they could trust it: parents coordinating a night out, professionals who cannot make calls during the day, anyone who has ever said "can you just book something nice for 7?"

## Why it matters

An assistant that can spend your money, cancel your services, or hand your car keys to a stranger has to be trustworthy by construction, not by prompt. Errands runs in the background, makes the safe calls on its own, and surfaces for exactly the decisions a human should own. Those decisions are enforced in code, not left to the model.

## The trust ladder

A counterparty is anyone acting on your behalf: the agent itself in a spend category, or a named human it wants to hire. Each one sits on a rung.

| Rung       | Meaning                                                                         | What passes without asking                                                      |
| ---------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `unknown`  | No evidence                                                                     | Nothing                                                                         |
| `screened` | Passed the vetting policy (a human), or the category is a known one (the agent) | Nothing spends. Every spend or hire asks, once                                  |
| `proven`   | Has a track record                                                              | Spend at or under the category notify cap proceeds, and you are told afterwards |
| `trusted`  | Granted by hand in `policy.json`                                                | Same as proven                                                                  |

Four rules never relax, whatever the rung:

1. **Caps are absolute.** Spend over the per-transaction cap of $100, or that would breach the rolling 24-hour cap of $200 or the rolling 7-day cap of $250, is refused outright. There is no approval that overrides a cap.
2. **A first handover of your property always asks.** The first time a person would hold your keys, the agent stops and asks you, even if that person is marked `trusted`.
3. **Nothing spends off an `unknown` counterparty.** For a named human the gate refuses outright: a hire whose counterparty is still on the `unknown` rung never reaches you as a question. For the agent itself in a spend category, `unknown` means every spend stops and asks you first; it never proceeds on its own.
4. **At or above $50, the code arrives on a second channel.** The approval code is delivered out of band (Telegram, or stderr in the console demo) and you have to type it back. The model never sees the code, and any code it tries to supply is thrown away.

Evidence, not vibes, moves a counterparty up. A human is promoted after one clean job. The agent is promoted after three clean approvals in a category. Any incident drops the counterparty one rung and resets the clean count. `trusted` is never earned; it is only ever granted by hand in `policy.json`.

The notify caps are $25 for restaurant deposits and $45 for service bookings and hires. Every notify cap has to sit below the $50 step-up threshold, and the config loader refuses to start on a policy where it does not.

## Three errands

One command line, three errands. The agent routes by intent; there is no errand switch to set.

### Dinner

> "Book dinner for 2 tonight at 7 at Bella Cucina in Nashville. If they're full, find somewhere comparable between 6:30 and 8."

1. `search_restaurants` finds the named restaurant and comparable options.
2. `call_restaurant` phones the first choice. It is fully booked.
3. `search_restaurants` runs again, excluding everyone already called, and picks the closest match.
4. `call_restaurant` phones the second choice. It holds the table and quotes a deposit.
5. `pay_deposit` stops at the gate. You approve $15.00.

At most three calls in an errand.

**The decision you make:** whether to pay the deposit at the restaurant that actually had a table. The amount has to match what the restaurant quoted on the call, so you are never asked to approve a number the agent made up.

A real run is recorded in `docs/live-run-2026-09-11.txt`.

```
>>> DECISION NEEDED: Errands wants to spend $15.00 (restaurant deposit)
    at Trattoria Roma. Approve? [y/N] y
  · deposit succeeded: Trattoria Roma
```

### Subscriptions

> "Find everything I'm paying for monthly and cancel what I don't use."

1. `connect_bank` links a bank account through Stripe Financial Connections. You click through the consent page in your own browser.
2. `list_recurring` reads the transactions, groups them by merchant, works out each cadence, and shows you the whole list: Netflix $15.49 monthly, Planet Fitness $24.99 monthly, Spotify $11.99 monthly, CloudDrive Plus $9.99 monthly.
3. The agent asks, in one message, which of those to cancel, and stops there. It never guesses.
4. `cancel_subscription` phones one merchant at a time, at most five in an errand, and only merchants that came back in step 2.
5. It reports what was cancelled, the confirmation numbers, the effective dates, and anything you have to phone yourself.

**The decision you make:** which subscriptions die. Cancelling is a $0 spend in a category the policy marks `confirm`, so each merchant needs your approval before its call is placed. Money is not the only thing worth a human decision.

A real run is recorded in `docs/live-run-subscriptions.txt`.

### Blurr

> "Get Blurr an oil change this week and have someone take it there and back."

1. `find_shops` lists shops that do the work.
2. `book_service` phones the first shop for a slot and a quote.
3. `pay_service` stops at the gate for exactly the amount the shop quoted. If the quote is $50 or more, the approval code comes to your second channel and you type it back.
4. `find_taskers` lists the people on the task marketplace who take vehicle jobs, best first.
5. `vet_tasker` checks a candidate on paper (4.7 stars, 50 jobs, a background check, insured for vehicles) and only then phone-screens them: are they available for the slot, can they drive a manual, are they insured to drive someone else's car. A candidate who fails on paper is never phoned.
6. `hire_tasker` stops at the gate. Only the person whose screen passed can be hired, and because this is the first time they would hold your keys, you are asked no matter what.

At most three calls in total across `book_service` and `vet_tasker`.

**The decision you make:** paying the shop, and handing your car keys to a named person. The approval prompt shows the evidence: rating, jobs, background check, insurance, and the fact that they passed a phone screen. In the fixture marketplace that is Maria R., 4.9 stars, 212 jobs, $38.00.

A real run is recorded in `docs/live-run-blurr.txt`.

## Other errands it is built for

The same three pieces (a phone call, a gated spend, a vetted human) cover a lot of ordinary life. These are shapes the gate and tools already support rather than shipped commands.

- **Groceries from a recipe.** Errands turns a recipe into a list, checks what a store has, and phones ahead for anything that needs reserving. You decide the total before the order is paid for.
- **A party of 20, plus dry cleaning and milk.** Errands phones caterers for a headcount and a quote, phones the cleaner for a same-day slot, and folds the small pickup into the same trip. You decide the catering spend, which is the one number that matters.
- **Movie night for five.** Errands finds a showing that works, checks that five seats are together, and holds them. You decide whether to pay for the seats it found.
- **A make-good night: flowers, a car detail, a couples massage.** Errands phones the florist, the detailer and the spa, and lines all three up on the same evening. You decide each spend, and the massage booking is a handover of your time and your address, so the first booking with a new provider asks even after the first two are routine.

## How it works

**Strands Agents SDK (TypeScript)** runs the agent loop on **Claude Sonnet 4.6 via Amazon Bedrock**. Each errand is a module that contributes its own tools and its own numbered workflow to the system prompt.

Dinner:

- `search_restaurants`: Google Places (New) Text Search, or a fixture list offline. Returns ids, never phone numbers.
- `call_restaurant`: places a real outbound AI phone call through [Vapi](https://vapi.ai). The caller says it is an AI assistant, asks for the table and any deposit, and never gives out payment details.
- `pay_deposit`: charges the deposit the restaurant quoted (Stripe, test mode only).

Subscriptions:

- `connect_bank`: opens a Stripe Financial Connections session and serves a small page on your LAN that runs the consent flow in your browser. Offline it returns a fixture account.
- `list_recurring`: normalizes merchant strings, groups charges, and detects weekly, monthly and yearly cadences from the intervals.
- `cancel_subscription`: an AI voice call that asks the merchant to cancel and records the confirmation, the effective date, and whether you have to call yourself. Only merchants from the last `list_recurring` can be dialed.

Blurr:

- `find_shops`: shops that do the work the car needs.
- `book_service`: an AI voice call for a slot and a quote.
- `pay_service`: pays exactly the quoted amount, once per shop.
- `find_taskers`: the marketplace profiles for a task class, ranked.
- `vet_tasker`: the paper check, then the phone screen. A passed screen is what lifts a stranger off `unknown`.
- `hire_tasker`: refuses anyone without a passed screen.

**The gate is enforced in two places** (`src/gate.ts`, `src/gate-intervention.ts`):

1. A Strands **intervention** runs before every tool call. Forbidden spend is denied and never reaches the tool. `notify` spend proceeds and tells you afterwards. `confirm` spend pauses for you, with the six-digit single-use code delivered out of band at or above $50, and injected by the intervention after you say yes. Whatever the model put in `approvalCode` is discarded on every path.
2. The tool itself calls `gate.commit()`, the point of action, which re-runs the whole policy (the caps may have been used up since the code was issued), validates the code against the merchant, amount, category, counterparty and handover flag it was bound to, marks it used, and only then writes the ledger row and the trust event.

The agent runs tools one at a time, never concurrently, so an approval decided by the intervention is never racing another tool for the same gate state.

**Deterministic guardrails around the model.** The model passes ids, never phone numbers. A payment has to equal the amount quoted on a booked call, checked before you are asked. A tasker who has not passed a screen cannot be hired. Call counts are capped per errand and checked both before the human is asked and again in the tool. Search results, bank rows and call transcripts are marked as data, never instructions.

The rules live in `policy.json`, checked in so anyone can read them:

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
  "notifyCapCents": { "restaurant_deposit": 2500, "service_booking": 4500, "hire": 4500 },
  "vetting": {
    "minRating": 4.7,
    "minJobs": 50,
    "requireBackgroundCheck": true,
    "requireInsuredFor": { "vehicle": true }
  },
  "counterparties": {},
  "categories": {
    "call": "allow",
    "restaurant_deposit": "confirm",
    "service_booking": "confirm",
    "hire": "confirm",
    "cancellation": "confirm",
    "gift": "forbid"
  }
}
```

`enabled: false` is the kill switch: every request is refused. There is no `phoneScreenRequired` knob: the phone screen is not optional, it is enforced by the Blurr module itself, which refuses to hire anyone with no stored passing screen.

## Safety in demo mode

Judges can run this, so everything public runs sandboxed:

- **No real business is ever called.** In demo mode, dinner calls route to two test lines we control: the first plays a restaurant that is fully booked, the second one that has a table and requires a deposit. Subscription cancellations and Blurr calls route to a third test line, a switchboard whose assistant plays whichever business the caller names in its opening sentence. Search still returns real restaurants so you can see the agent choose. Live mode only dials numbers on an explicit allowlist.
- **No real bank is connected.** Stripe Financial Connections runs in the sandbox against Stripe's test institution, and the default is the fixture bank in `fixtures/transactions.json`. Taskers and shops are fixtures too, not a live marketplace.
- **No real money moves.** Deposits, service payments and hires use Stripe **test mode**; the code refuses to start with a live key.

## Limitations we know about

- **The quote comes from the call.** The amount you are asked to approve is extracted from the call's structured analysis, so a bad extraction could put a wrong number in front of you. That is why a human sees it before anything is paid, and why the payment tool refuses any amount that does not equal the extracted quote.
- **The bank consent page is a manual browser step.** You open the page and click through Stripe's flow yourself. The page's own server and token logic are unit-tested in `tests/connect-page.test.ts`; what is not covered is the live Stripe click-through itself, which needs a real browser against Stripe's test institution.
- **Live bank data is not available.** Financial Connections in live mode needs Stripe registration we do not have, so bank access is sandbox only.
- **Telegram step-up needs setup.** The second channel is Telegram, which needs a bot token and a chat id. Without them the code falls back to the console channel, which prints to stderr.

## Run it

Requirements: Node.js 22+, an AWS account with Bedrock access to Claude Sonnet 4.6, a Vapi account with an outbound number and the demo lines, a Stripe test key, and optionally a Google Maps key with Places API (New).

```bash
git clone https://github.com/m2ai-portfolio/errands && cd errands
npm install
npm test                                   # 216 offline tests in 19 files, no keys needed
```

| Variable                   | What it does                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `VAPI_API_KEY`             | Required. Places the outbound calls.                                                                                     |
| `STRIPE_SECRET_KEY`        | A test key (`sk_test_` or `rk_test_`). A live key is refused.                                                            |
| `STRIPE_PUBLISHABLE_KEY`   | Needed only for the real Financial Connections page.                                                                     |
| `AWS_REGION`               | Bedrock region. Default `us-east-1`.                                                                                     |
| `AWS_BEARER_TOKEN_BEDROCK` | A Bedrock API key. An IAM key pair works instead.                                                                        |
| `BEDROCK_MODEL_ID`         | Default `global.anthropic.claude-sonnet-4-6`.                                                                            |
| `ERRANDS_MODE`             | `demo` (default) or `live`. Live mode dials only `ERRANDS_LIVE_ALLOWLIST`.                                               |
| `ERRANDS_SEARCH`           | `fixture` forces the fixture restaurant list. Without `GOOGLE_API_KEY` it is fixtures anyway.                            |
| `ERRANDS_BANK`             | `stripe` uses Financial Connections. Anything else uses the fixture bank.                                                |
| `ERRANDS_STEPUP`           | `telegram` sends the code to Telegram. Anything else prints it to stderr.                                                |
| `ERRANDS_LAN_HOST`         | Host the bank consent page is served on. Default `10.0.0.46`, never localhost.                                           |
| `ERRANDS_APPROVE`          | `yes` or `no` answers every prompt without a terminal. It cannot approve a $50 or larger step-up: by design it declines. |
| `ERRANDS_CUSTOMER_NAME`    | The name the AI caller gives. Default `Alex`.                                                                            |
| `ERRANDS_CALLER_VOICE`     | A JSON `VoiceConfig` overriding the AI caller's voice. Default is the built-in Cartesia voice.                           |
| `ERRANDS_STRIPE_CUSTOMER`  | Reuse an existing test-mode Stripe customer instead of making a new one.                                                 |
| `TELEGRAM_BOT_TOKEN`       | With `TELEGRAM_CHAT_ID`, the second channel for step-up codes.                                                           |
| `TELEGRAM_CHAT_ID`         | The chat the step-up code is sent to.                                                                                    |

`GOOGLE_API_KEY` is optional; without it search uses `fixtures/`. `ERRANDS_POLICY` and `ERRANDS_DEMO_CONFIG` override the two config file paths.

The demo phone lines live outside the repo:

```bash
mkdir -p ~/.config/errands && cp demo.example.json ~/.config/errands/demo.json
# then fill in your Vapi phone number ids for the full, open and switchboard lines
```

Then run any of the three sentences:

```bash
npm start -- "Book dinner for 2 tonight at 7 at Bella Cucina in Nashville, or somewhere comparable"
npm start -- "Find everything I'm paying for monthly and cancel what I don't use"
npm start -- "Get Blurr an oil change this week and have someone take it there and back"
```

**Judges without Stripe or Vapi keys:** run `npx tsx scripts/offline-run.ts`. It scripts every phone call and every payment, so all three errands run end to end with only Bedrock credentials.

## Prior work disclosure

This repository was created and written during the hackathon Submission Period (from September 11, 2026). Before that, the author prototyped an "errands" skill for his personal assistant agent (a private, differently licensed codebase built on a different agent framework): a spending-gate command-line tool, a phone-call helper, and seven example errands mapped on paper. None of that code is included here. The design lessons carried over, and the weaknesses found in that prototype (the gate was not enforced in code, approval codes were too short and not bound to a category, the ledger was self-reported) are what this rebuild fixes.

## Layout

| Path                           | What it is                                                                |
| ------------------------------ | ------------------------------------------------------------------------- |
| `src/agent.ts`                 | Strands Agent: system prompt, merged tools, the intervention              |
| `src/cli.ts`                   | Entry point, wiring, fixture or live sources                              |
| `src/gate.ts`                  | Policy, caps, kill switch, approval codes, ledger, trust events           |
| `src/trust.ts`                 | Rungs, promotion and demotion, the vetting check                          |
| `src/stepup.ts`                | Out-of-band delivery of the approval code (Telegram or console)           |
| `src/gate-intervention.ts`     | Runs before every tool call and forces spend through the gate             |
| `src/ask.ts`                   | The human decision prompt, and the non-interactive `ERRANDS_APPROVE` path |
| `src/config.ts`                | Environment, `policy.json` and `demo.json` loading and validation         |
| `src/connect-page.ts`          | The token-gated LAN page that runs the bank consent flow                  |
| `src/errands/dinner.ts`        | Dinner: search, call, deposit                                             |
| `src/errands/subscriptions.ts` | Subscriptions: connect, list, cancel                                      |
| `src/errands/blurr.ts`         | Blurr: shops, booking, payment, taskers, vetting, hire                    |
| `src/tools/phone.ts`           | Vapi calls, demo-line routing, the reservation call script                |
| `src/tools/restaurants.ts`     | Google Places and fixture search                                          |
| `src/tools/bank.ts`            | Stripe Financial Connections and the fixture bank                         |
| `src/tools/recurring.ts`       | Merchant normalization, grouping, cadence detection                       |
| `src/tools/cancel.ts`          | The cancellation call script and its outcome schema                       |
| `src/tools/service.ts`         | The service-booking and phone-screen call scripts                         |
| `src/tools/taskers.ts`         | Tasker lookup and ranking                                                 |
| `src/tools/deposit.ts`         | Stripe test-mode payments                                                 |
| `policy.json`                  | The spending and vetting rules, checked in                                |
| `fixtures/`                    | Restaurants, shops, taskers, bank transactions                            |
| `scripts/offline-run.ts`       | Scripted end-to-end run for anyone without Vapi or Stripe keys            |
| `tests/`                       | 216 offline tests across 19 files                                         |

## License

Apache License 2.0. See [LICENSE](LICENSE).
