# Proof of Reason market-fit pre-registration v1.0
Registered: 2026-09-17, before any product code.
Append-only. Amendments are appended with date and reason. Text above an amendment is never edited.

## Product under test
Proof of Reason checks the reason an automated allocator gives before a vault moves money: premises against chain state (TRUE), the action against the principal's mandate (ALLOWED), required fields present (COMPLETE). The gate holds a veto only.

## Hypothesis
Curated-vault operators and allocator teams will pay for, or require, an independent pre-execution premise check, because it lets them evidence each reallocation to depositors and distributors.

## Assumptions, tests, thresholds
A1 Premise failures happen often enough to matter.
Test: read-only audits of public agent reasoning against the state it cites, plus any operator logs shared with us.
Pass: at least 1 action in 20 carries a false premise at the time it was made.
Kill: fewer than 1 in 100 across at least 200 audited actions.

A2 Operators feel trust or liability pain.
Test: 20 discovery calls, no pitch in the first half of any call.
Pass: at least 5 of 20 raise evidencing, depositor trust, or agent-action liability unprompted.
Kill: at least 12 of 20 answer that caps and allowlists already cover it.

A3 Someone will require it.
Test: ask every allocator, curator, insurer, and listing platform contacted whether they would make it a condition.
Pass: 1 written commitment by 2026-11-03.
Kill: zero after all asks.

A4 Operators accept integration.
Test: paid pilot offer inside their existing stack (allocator role, Safe guard, or vault micro-manager).
Pass: 2 paid pilots by 2026-12-15.
Kill: every refusal is "we will build our own".

A5 Error rates are livable.
Test: demo and pilot telemetry.
Pass: WAIT rate under 20 percent and zero false FAILs after convention fixes, over at least 100 checks.
Kill: any pilot principal disables the gate over false FAILs.

## Gates
2026-10-13: hackathon submission; first read of A1 and A2.
2026-11-03: A3 read.
2026-12-15: fit gate. Pass requires A1 pass, 2 paid pilots, and 1 written requirer. A miss means no hosted validator is built; the code stays open source as consulting collateral.

## Counting rules
- DJ, DJZS AI, LLC, and any wallet or account DJ controls never count as a user, pilot, or requirer.
- A paid pilot is money received, any amount above zero, invoiced by DJZS AI, LLC.
- A discovery call counts only if it lasts at least 20 minutes and the person holds budget or execution authority over allocation.
- Every call gets a dated note within 24 hours: who, role, what they raised unprompted, what they asked for.

## Disclosure
Results publish at each gate date whichever way they fall, including a kill.
