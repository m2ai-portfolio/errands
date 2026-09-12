The problem

Booking a table tonight eats 20 minutes: call, hear they are full, find something comparable, call again, hand over a card for a deposit. Cancelling a subscription is worse, since the merchant makes you phone in. Getting the car serviced while you are at work needs a shop, a slot, a payment, and someone you trust with your keys. An app does not help when the business takes only calls.

Who it is for

Busy people who would happily hand the whole errand to an assistant if they could trust it: parents coordinating a night out, professionals who cannot make calls during the day, anyone who has said "can you just book something nice for 7?"

Why it matters

An assistant that can spend your money, cancel your services, or hand your keys to a stranger has to be trustworthy by construction, not by prompt. Errands makes the safe calls itself and surfaces only for decisions a human should own, enforced in code.

What it does

One command line, three errands. The agent routes by intent; there is no errand switch.

Dinner: search_restaurants finds the restaurant and comparable options. call_restaurant phones the first choice, fully booked, then search runs again and phones the closest match, which holds a table and quotes a deposit. The decision: pay the deposit at the restaurant that had a table.

Subscriptions: connect_bank links an account via Stripe Financial Connections, and list_recurring groups transactions by merchant with amounts and cadence. The agent asks which to cancel, then cancel_subscription phones each merchant and reports confirmations. The decision: which subscriptions die.

Blurr: find_shops and book_service get a slot and a quote, and pay_service stops at the gate for that amount. find_taskers ranks candidates, vet_tasker checks one on paper before phone-screening, and hire_tasker refuses anyone who failed it. The decision: pay the shop, and hand your keys to a named, vetted tasker.

The trust ladder

A counterparty is anyone acting on your behalf: the agent in a spend category, or a human it wants to hire. Unknown has no evidence; nothing passes without asking. Screened has passed vetting or is a known category, and still asks every time. Proven has a track record, so spend at or under the notify cap proceeds, and you are told after. Trusted is granted by hand in policy.json. Four rules never relax:

- Caps are absolute: over $100 per transaction, or breaching the $200 rolling 24-hour or $250 rolling 7-day cap, is refused outright.
- A first handover of your property always asks, even if trusted.
- Unknown always asks, and an unknown human cannot be hired.
- At or above $50, the code arrives on a second channel and you type it back.

A human is promoted after one clean job, the agent after three; an incident drops a rung.

How we built it with Strands Agents

Strands Agents SDK (TypeScript) runs the agent loop on Claude Sonnet 4.6 via Amazon Bedrock. Each errand contributes its own tools: dinner has search_restaurants, call_restaurant, pay_deposit; subscriptions has connect_bank, list_recurring, cancel_subscription; Blurr has find_shops, book_service, pay_service, find_taskers, vet_tasker, hire_tasker.

The gate is enforced twice. A Strands intervention is the point of intent: before every tool call it denies forbidden spend, lets notify spend through with a later notice, and pauses confirm spend for a human decision, injecting the code after you say yes. gate.commit() in the tool is the point of action: it re-runs the policy, validates the code against the merchant, amount, category, counterparty, and handover flag it was bound to, then writes the ledger and trust event.

The phone calls, including the vet_tasker screen, are real outbound AI voice calls through Vapi. Payments run on Stripe test mode; connect_bank opens a Financial Connections session in the sandbox. The project ships 202 offline tests across 19 files, including an offline end-to-end run of all three errands.

Safety in demo mode

No real business is called: dinner calls route to two test lines, one fully booked, one quoting a deposit; subscription and Blurr calls route to a switchboard playing whichever business is named. Live mode only dials an explicit allowlist. No real bank is connected: Financial Connections runs against Stripe's test institution, defaulting to a fixture bank, and taskers and shops are fixtures too. No real money moves: everything uses Stripe test mode; a live key is refused.

What's next

The same three pieces, a phone call, a gated spend, a vetted human, cover more of ordinary life than the three shipped errands. The gate and tools already support four more shapes: a recipe turned into a grocery order, a party of 20 with dry cleaning and milk, a movie showing with five seats together, and a make-good night of flowers, a car detail, and a couples massage.

Prior work disclosure

This repository was created and written during the hackathon Submission Period (from September 11, 2026). Before that, the author prototyped an "errands" skill for his personal assistant agent (a private, differently licensed codebase built on a different agent framework): a spending-gate command-line tool, a phone-call helper, and seven example errands mapped on paper. None of that code is included here. The design lessons carried over, and the weaknesses found in that prototype (the gate was not enforced in code, approval codes were too short and not bound to a category, the ledger was self-reported) are what this rebuild fixes.
