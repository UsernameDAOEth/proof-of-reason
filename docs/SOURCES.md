# Sources

Every outside claim on proofofreason.com is listed here with the source it came from and the exact
figure that source gives. First read on 2026-09-27; the quoted lines re-read from the articles on 2026-09-29. Where two sources disagree, both numbers are recorded
and the page uses the one the majority of reporting supports.

## The failure it is built for, January 2025 to March 2026

Every quoted line below was copied from the article itself on 2026-09-29, not from a summary. Both
articles are translations of the same original, Camila Russo's "DeFi Has Seen Resolv's $25M USR
Exploit Many Times Before" in The Defiant
(https://thedefiant.io/news/hacks/defi-has-seen-resolv-s-usd25m-usr-exploit-many-times-before),
which refused a direct fetch (HTTP 403), so it is named as the original and quoted through them.
KuCoin's edition (TechFlow, released 2026/03/24): https://www.kucoin.com/news/flash/defi-hardcoded-oracle-vulnerability-repeats-for-fourth-time-in-14-months
BlockBeats' edition (DeepFlow Tech): https://en.theblockbeats.news/news/61670

| Page sentence | Source | Verbatim line |
| --- | --- | --- |
| "In the fourteen months to March 2026, reporting counts at least four cases of the same failure: a lending market trusted a price that was hard-set or had stopped updating, while the real market price had moved." | KuCoin | "This has occurred at least four times in the past 14 months." and "hardcoded oracles pricing a depegged stablecoin at $1" |
| (same) | BlockBeats | "Over the past 14 months, this situation has occurred at least four times." |
| "Usual, January 2025: a token hard-set at one dollar; when its redemption floor was cut to 87 cents, lenders were locked in." | KuCoin | "USD0++ was hardcoded to $1 by curator MEV Capital in the Morpho vault. Usual then suddenly adjusted the redemption floor price to $0.87 without any warning, locking lenders in the MEV Capital vault" (the sentence opens "In January 2025, Usual Protocol") |
| "Stream, November 2025: the price stopped updating as its token collapsed, and an estimated 285 to 700 million dollars was at risk; another outlet reported ten times that." | KuCoin | "when its oracle refused to update, an estimated $285 million to $700 million in assets on Morpho, Euler, and Silo were at risk." (the sentence opens "In November 2025, Stream Finance", and says xUSD "collapsed") |
| (ten times that) | BlockBeats | "When its oracle refused to update, assets worth an estimated $2.85 billion to $7 billion on Morpho, Euler, and Silo faced risk." |
| "Moonwell, October and November 2025: two price failures, over 5 million dollars of bad debt." | KuCoin | "Moonwell suffered two consecutive oracle failures in October and November 2025, resulting in over $5 million in bad debt." |
| (same) | BlockBeats | "In October and November 2025, Moonwell experienced two consecutive oracle failures, resulting in over $5 million in defaults." |
| "Resolv, March 2026: a token marked at 1.13 dollars while it traded near 0.63; one lender absorbed over 10 million dollars of bad debt in a single day." | BlockBeats | "wstUSR was marked at $1.13, while its secondary market trading price was around $0.63." and, in the paragraph on the Resolv USR exploit's spread, "Fluid/Instadapp absorbed over $10 million in bad debt in a single day" |
| (same) | KuCoin | "wstUSR is marked at $1.13, while trading at approximately $0.63 on the secondary market." and "The most recent attack targeted Resolv" (released 2026/03/24) |

No sentence on the page was cut for want of a quoted line.

AMBCrypto, [Chainlink oracle glitch costs Moonwell $1M as DeFi suffers another exploit](https://ambcrypto.com/chainlink-oracle-glitch-costs-moonwell-1m-as-defi-suffers-another-exploit/),
reports one of the two Moonwell failures, on 4 November 2025, at about 1 million dollars. It does not
carry the 5 million total, so the page does not cite it.

### A discrepancy, recorded rather than hidden

For Stream, BlockBeats gives "$2.85 billion to $7 billion" and KuCoin gives "$285 million to $700
million", both translating the same sentence. The ten-times difference reads as a unit error in one
translation. The page states the KuCoin range and says that another outlet reported ten times that.

### Dates

Usual was January 2025 and the Resolv exploit was March 2026, reported on 2026/03/24. That is the
fourteen month window the page describes, and it is why the page says "to March 2026".

## What is not from an outside source

"Today the check reads rates and the cash available to withdraw. Reading the price a lender uses for
its collateral is not built yet." is a statement about this product, checked against the engine: for a lending market it reads rate,
utilization, liquidity and the market's identity (which oracle it names, among its parameters), and no
claim kind reads the price that oracle reports.

The first check on 25 September 2026 is our own. Its numbers are rendered from
`vid/receipts/pass.json`, the document `api.proofofreason.com` serves, and never typed by hand:
`scripts/gen-site.ts` renders them and `scripts/test/readme.test.ts` fails if the page and the
receipt disagree. It was our own test AI and it does not count as a customer under the
counting rules in `docs/PREREG.md`.

## Not used on the page

Recorded so the removal is visible. None of this appears on proofofreason.com.

### The prompt-injected wallet, May 2026

The page used to say: in May 2026 an AI wallet was tricked by a hidden instruction into handing over
174 thousand dollars, most of it later returned, and that the move was outside its owner's rules.
It was removed on 2026-09-29: the figures are not independently verified, and the incident is a
permissions failure, not a false premise, so it is not an example of what this check catches.

| # | Source | What it supports |
| --- | --- | --- |
| 5 | OECD.AI incident record, [AI Prompt Injection Exploit Drains Grok-Linked Crypto Wallet](https://oecd.ai/en/incidents/2026-05-04-4a73) | The incident and its date, 4 May 2026. |
| 6 | The Bit Journal, [Grok Bankr Wallet Exploit Shows How a Free NFT Triggered a $174K Loss](https://thebitjournal.com/grok-bankr-wallet-exploit-shows-how-a-free-nft-triggered-a-174k-ai-crypto-loss/) | The 174 thousand dollar figure. |
| 7 | BeInCrypto, [How AI Was Used to Steal $150K From the Grok Wallet](https://beincrypto.com/grok-wallet-bankr-drb-prompt-injection/) | The method, a hidden instruction the wallet obeyed, and the return of most of the funds. |

The target was the Bankr wallet auto-provisioned for a Grok account. Reported values for the same
3 billion DRB range from 150 to 175 thousand dollars depending on the moment of pricing; the page
used **174 thousand**, the figure source 6 gives. About 80 percent was returned after the token
community identified the attacker, which is why the page said most of it was later returned.
