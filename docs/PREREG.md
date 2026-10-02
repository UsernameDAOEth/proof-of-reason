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

## Amendment 1 (2026-10-01): how A1 is counted
Reason: A1's pass set a rate with no minimum sample, so one false premise in the first audited action would have met it. The text also left open which records count, how many may come from one agent, which agents are chosen and when, which transaction a statement refers to, at which block its premises are read, and what a read short of a threshold says. Written before any record was added to shadow/records: at commit fe4c32d it holds none and shadow/LEDGER.md reads 0 audited. Revised before it was published; every version is in the git history.

Who is listed. An agent's actions can count only if the agent is listed in shadow/AGENTS.md. An agent may be listed if it moves funds on chain from a wallet it controls, on a chain the shadow runner reads, and publicly states the reasons for its actions, citing chain state that a claim kind in docs/CLAIMS.md can check. An agent is never listed if DJ or DJZS AI, LLC operates it, funds it, or is paid by its operator. Each row states the agent's type (vault allocator, trader, or other), and every read reports its counts by type. An agent is listed before any of its actions is audited, and an agent with an action audited before its listing never counts. Rows are never edited or removed; a mistake is fixed by a new row, which counts from its own listing time.

When it counts. Each row gives a listing time in UTC. The hash of the commit that adds the row is posted publicly, with a visible time, before that listing time, and the commit is public on GitHub by the next read. An action counts only if both the transaction and the statement explaining it came after the agent's listing time. From then on, the agent's publicly explained actions are audited in the order they were posted, none skipped, until 20 of them are counted. Earlier actions may be audited and shown, never counted. Operator logs shared with us count under the same rules, except that the period a log covers is listed in shadow/AGENTS.md before the log is read, and every action in that period is audited.

Which transaction. If the statement gives exactly one transaction hash, that transaction is the action, provided it was sent from the agent's wallet and succeeded. Otherwise the action is the only successful transaction from the agent's wallet within 3,600 seconds either side of the post that matches every contract and function the statement names. If there is none, or more than one, the record is unlocated. A counted record uses no other window.

Which state. Each premise is read at the block before the action's block, so the reading includes nothing the action itself changed. A reading that spans several blocks ends at that block.

Which claims. Claims are typed from the statement's own words, before any chain read for that record. Every premise that a claim kind can express is typed, and nothing the statement does not say is added.

What counts. A counted action is a located shadow record in which at least one claim was decided TRUE or FALSE. Records where no claim could be decided, and unlocated records, stay in the ledger and are not counted. Within a counted action, a claim that could not be decided counts as not false.
Pass: at least 60 counted actions, at least 1 in 20 of them with a false premise at the time it was made.
Kill: fewer than 1 in 100 across at least 200 counted actions.
No agent supplies more than 6 of the actions counted toward a pass, or 20 toward a kill. An agent's earliest actions are the ones counted.
At a read, a threshold whose minimum is not met is reported with the counts and the words "no read". It is neither a pass nor a kill.
The fit gate reads A1 on its own date, from every action counted by then. A pass at an earlier read does not carry forward.

Disclosed because it favours the hypothesis: docs/SHADOW.md counted every located record. Counting fewer raises the rate and makes the kill's 200 slower to reach. The reason for it: an action whose premises could not be checked was not audited against the state it cites, which is what A1's test asks for. One rule works the other way: reading the block before the action removes FALSE results that the action's own effect would have caused.
