import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const siteDir = new URL('..', import.meta.url).pathname
const publicDir = join(siteDir, 'public')

const html = readFileSync(join(publicDir, 'index.html'), 'utf8')
const css = readFileSync(join(publicDir, 'style.css'), 'utf8')
const favicon = readFileSync(join(publicDir, 'favicon.svg'), 'utf8')
const wrangler = readFileSync(join(siteDir, 'wrangler.toml'), 'utf8')
const siteDoc = readFileSync(join(siteDir, '..', 'docs', 'SITE.md'), 'utf8')

const EM_DASH = String.fromCodePoint(0x2014)

/** Every address the page states, exactly as it must appear. */
const ADDRESSES = {
  vault: '0x28900B0B2DDA5d2d61cDF17BE8b7091206a04Bf9',
  gate: '0x8fF582f268aB8E2148B548Aa061c5273bC383120',
  registry: '0x8e2b835d43bB93cE46CcA9994f41596dB162007C',
  validator: '0xEC37691732204714DDfd024B67F1B7abfcF3FC9E',
  identity: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
} as const

const PREREG_SHA256 = '5f6a494f937dc6fc915ae154fe347728aea5816c08523204bb73dedf02c7c2d4'

/** The first receipt the page leads the record with, and the two transactions that followed it. */
const FIRST = {
  intentHash: '0x45ab90694af77667d82c0b3047611c4ac707b3e3f94cda5cd67aad63735298e3',
  registryTx: '0x4eb4422544c1120c5133653d06469ab7ef44574eeaf0ecd4bcf1134311740240',
  executionTx: '0xfcc50dadc9635a268ab55c5065ad7d4226b4d222180280e604f6834d72e6d3af',
  block: '107991649',
} as const

/** The published receipt itself, when the video kit is checked out beside the site. */
const receiptPath = join(siteDir, '..', 'vid', 'receipts', 'pass.json')
const hasReceipt = existsSync(receiptPath)

/** Everything above this heading is written for someone who does not work in this field. */
const DEVELOPER_LINE = '<h2>For developers</h2>'

/**
 * Jargon the plain half may not use. Each of these has a plain replacement in use above the line:
 * validator to "the check", mandate to "the rules the owner set", registry to "the filing on the
 * chain", verdict to "yes" and "no", premise to "reason", vault to "pool".
 */
const JARGON = [
  'validator',
  'allocator',
  'mandate',
  'registry',
  'receipt hash',
  'premise',
  'verdict',
  'ERC-8004',
  'x402',
  'Morpho',
  'vault',
  'calldata',
  'EIP-712',
]

/** The two terms in JARGON that this page has never used, above the line or below it. */
const NEVER_ON_THIS_PAGE = ['receipt hash', 'EIP-712']

/** The body above the divider, and the same again with the tags taken out. */
function plainHalf(): { markup: string; text: string } {
  const start = html.indexOf('<body>')
  const end = html.indexOf(DEVELOPER_LINE)
  const markup = html.slice(start, end)
  const text = markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  return { markup, text }
}

/** The documented body limit in docs/SITE.md, which this suite holds the page to. */
const BODY_LIMIT = 16000

/** The token block copied from https://djzs.ai/style.css. */
const TOKENS = {
  canvas: '#0A0A0A',
  panel: '#0D0D0D',
  rule: '#1C1C1C',
  text: '#E6E6E6',
  muted: '#8A8A8A',
  pass: '#3DFF88',
  wait: '#FFB000',
  fail: '#FF4D4D',
  link: '#3DFF88',
} as const

function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? allFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  )
}

function isGrey(hex: string): boolean {
  const value = hex.replace('#', '')
  const [r, g, b] = [value.slice(0, 2), value.slice(2, 4), value.slice(4, 6)]
  return r === g && g === b
}

describe('zero JavaScript', () => {
  it('ships no script tag, no inline handler and no javascript URL', () => {
    for (const [name, source] of [
      ['index.html', html],
      ['style.css', css],
      ['favicon.svg', favicon],
    ] as const) {
      const lower = source.toLowerCase()
      expect(lower, name).not.toContain('<script')
      expect(lower, name).not.toContain('javascript:')
      expect(lower, name).not.toContain('onload=')
      expect(lower, name).not.toContain('onclick=')
      expect(lower, name).not.toContain('onerror=')
      expect(lower, name).not.toContain('onmouseover=')
      expect(lower, name).not.toMatch(/<(iframe|object|embed|noscript)\b/)
    }
  })

  it('has no worker script at all: the Worker serves assets only', () => {
    expect(wrangler).not.toMatch(/^\s*main\s*=/m)
    expect(wrangler).toContain('[assets]')
    expect(wrangler).toContain('directory = "./public"')
  })
})

describe('no em dashes', () => {
  it('in any site file, or in the deploy doc', () => {
    for (const file of [...allFiles(publicDir), join(siteDir, 'wrangler.toml')]) {
      expect(readFileSync(file, 'utf8'), file).not.toContain(EM_DASH)
    }
    expect(siteDoc).not.toContain(EM_DASH)
  })
})

describe('every fact is on the page, verbatim', () => {
  it('states the name and the one line under it', () => {
    expect(html).toContain('<h1>Proof of Reason</h1>')
    expect(html).toContain(
      "The vault only moves when the agent's stated reason is true on-chain, in mandate, and complete.",
    )
  })

  it('states who it is for, and that the validator is not paid to say yes', () => {
    expect(html).toContain('<h2>Who it is for and what it costs</h2>')
    expect(html).toContain('For principals who have to answer for an automated allocator:')
    expect(html).toContain('vault curators evidencing reallocations to depositors')
    expect(html).toContain('insurers pricing an AI-allocated vault')
    expect(html).toContain('platforms deciding what to list.')
    expect(html).toContain('The agent pays 0.10 USDC per check over x402.')
    // The verdict trio is marked up here as it is everywhere else, so the sentence spans them.
    expect(html).toContain('The validator earns the same on')
    expect(html).toContain('so it is never paid to say yes.')
  })

  it('states the two failures it catches, with the amounts', () => {
    expect(html).toContain('<h2>What it catches</h2>')
    expect(html).toContain(
      'A false premise. Stream Finance, November 2025: a hardcoded $1.00 oracle against a $0.26 market, $285M exposed.',
    )
    expect(html).toContain('The TRUE check reads the price at the block.')
    expect(html).toContain(
      'A disallowed action. Grok/Bankr, May 2026: a prompt-injected permission grant, $174k out.',
    )
    expect(html).toContain('The ALLOWED check holds the mandate.')
    expect(html).toContain('Most agent gates check permissions. Proof of Reason checks premises.')
  })

  it('states why the block time matters, with every timing it claims', () => {
    expect(html).toContain('<h2>Why Monad</h2>')
    expect(html).toContain('A verdict is only useful if execution follows before the state it checked moves.')
    expect(html).toContain("The gate accepts a verdict for 60 blocks, about 18 seconds at Monad's 0.30 s block time.")
    // Rendered from facts.json by scripts/gen-site.ts; scripts/test/readme.test.ts holds the numbers.
    expect(html).toContain('The first check to execution took 20 blocks, 7 seconds by block timestamps.')
    expect(html).not.toContain('11 blocks, 3.3 seconds')
    expect(html).toContain('The same 60-block bound on Ethereum L1 is 12 minutes.')
  })

  it('states the known limits', () => {
    expect(html).toContain('<h2>Known limits</h2>')
    expect(html).toContain(
      'One validator key today; every verdict is on the registry and re-checkable by anyone, and a second validator is the roadmap.',
    )
    expect(html).toContain('The check judges premises and mandate, not whether the decision is wise.')
    expect(html).toContain("The registry is interim until Monad's canonical ERC-8004 validation registry ships.")
    expect(html).toContain(
      'The 30-day audit reads MetaMorpho V1 vaults today. Morpho Vault V2, used by some curators, is not supported yet.',
    )
    // Below the line, where the developer names belong.
    expect(html.indexOf('The 30-day audit reads MetaMorpho V1 vaults today.')).toBeGreaterThan(html.indexOf(DEVELOPER_LINE))
  })

  it('states the doctrine and the principle', () => {
    expect(html).toContain('The LLM reads. The chain testifies. TypeScript decides.')
    expect(html).toContain('Hold the veto, never the keys.')
  })

  it('states the four steps and what it does not do', () => {
    expect(html).toContain('The agent states its reason as typed claims.')
    expect(html).toContain('The validator reads chain state at a pinned block and checks every premise.')
    expect(html).toContain('ERC-8004 validation registry')
    expect(html).toContain('The gate executes only on')
    expect(html).toContain('asks the owner on')
    expect(html).toContain('reverts on')
    expect(html).toContain(
      'it does not judge whether a decision is wise, only whether its premises are true and allowed',
    )
  })

  it('carries every address, and links each one to Monad Vision', () => {
    for (const [name, address] of Object.entries(ADDRESSES)) {
      expect(html, name).toContain(address)
      expect(html, name).toContain(`https://monadvision.com/address/${address}`)
    }
    expect(html).toContain('Monad mainnet, chain 143')
  })

  it('carries both agent ids and the x402 terms', () => {
    // 10258 is the agent being gated; 10259 is the validator's own ERC-8004 identity.
    expect(html).toContain('10258')
    expect(html).toContain('10259')
    expect(html).toContain('https://api.proofofreason.com')
    expect(html).toContain('x402, 0.10 USDC per check, exact scheme')
    expect(html).toContain('eip155:143')
  })

  it('carries the pre-registration hash, the three gate dates and the promise', () => {
    expect(html).toContain(PREREG_SHA256)
    expect(html).toContain('13 Oct')
    expect(html).toContain('3 Nov')
    expect(html).toContain('15 Dec')
    // The promise is stated once, quoted from the file; the paraphrase that repeated it is gone.
    expect(html.match(/whichever way they fall/g)).toHaveLength(1)
    expect(html).not.toContain('<p>Results publish whichever way they fall.</p>')
  })

  it('does not claim the pre-registration was published on the day it was written', () => {
    expect(html).not.toContain('published on 17 September')
    expect(html).toContain('was posted publicly on 25 September 2026: <a href="https://x.com/Djzs_ai/status/2103540228128694716">the post</a>.')
    expect(html).toContain('https://github.com/UsernameDAOEth/proof-of-reason/commit/073cceb968c63e94b575326a85d65e1f84f6de4f')
  })

  it('carries the record links, including when the indexer lands', () => {
    expect(html).toContain('https://api.proofofreason.com/receipts/{intentHash}')
    expect(html).toContain('https://agents.proofofreason.com/agents/{gate}')
    expect(html).toContain('Indexer deploys 28 Sep.')
    expect(html).toContain('https://djzs.ai/ruleset')
    expect(html).toContain('How the issuer handles being wrong')
  })

  it('leads the record with the first receipt, linked, and the two transactions after it', () => {
    expect(html).toContain(`<a href="https://api.proofofreason.com/receipts/${FIRST.intentHash}">`)
    expect(html).toContain('First receipt, 25 Sep 2026:')
    expect(html).toContain(`<span class="pass">PASS</span> at block ${FIRST.block}.`)
    expect(html).toContain(`<a href="https://monadvision.com/tx/${FIRST.registryTx}">registry write</a>`)
    expect(html).toContain(`<a href="https://monadvision.com/tx/${FIRST.executionTx}">execution</a>`)
    expect(FIRST.registryTx).not.toBe(FIRST.executionTx)
  })

  it('leaves the compliance page as plain text, spaced, until the indexer deploys', () => {
    // docs/SITE.md says this one is published as a pattern, not a live link. Now it is.
    expect(html).not.toContain('<a href="https://agents.proofofreason.com')
    // And the space before "Indexer" is in the source, not left to a collapsing newline.
    expect(html).toContain(
      '<code>https://agents.proofofreason.com/agents/{gate}</code>. <span class="muted">Indexer deploys 28 Sep.</span>',
    )
  })

  // When the video kit is checked out beside the site, the page's first-receipt claim is held
  // against the receipt that was actually published, so the two cannot drift apart.
  it.skipIf(!hasReceipt)('leads with the receipt that was really published', () => {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    expect(receipt.intent.intentHash).toBe(FIRST.intentHash)
    expect(String(receipt.verdict.checkedAtBlock)).toBe(FIRST.block)
    expect(receipt.registry.tx).toBe(FIRST.registryTx)
    expect(receipt.verdict.outcome).toBe('PASS')
    expect(receipt.provenance.url).toBe(`https://api.proofofreason.com/receipts/${FIRST.intentHash}`)
  })

  it('carries the footer, with the one ENS name and no other', () => {
    expect(html).toContain('Running an allocator? Write a mandate with us:')
    expect(html).toContain('Proof of Reason, by DJZS AI, LLC.')
    expect(html).toContain('dj@proofofreason.com')
    expect(html).toContain('Built for Monad Metropolis, Track 04.')
    expect(html).toContain('username.dj-z-s.eth')
    const ensNames = html.match(/[a-z0-9.-]+\.eth/g) ?? []
    expect([...new Set(ensNames)]).toEqual(['username.dj-z-s.eth'])
  })

  it('puts every block in the order the brief sets', () => {
    // Heading markup, not bare text: "Live on Monad" also appears in the meta description.
    const order = [
      '<h1>Proof of Reason</h1>',
      '<h2>What it is</h2>',
      '<h2>Why a manager wants it</h2>',
      '<h2>Why a customer or an insurer wants it</h2>',
      '<h2>What it checks, every time</h2>',
      '<h2>What it does not do</h2>',
      '<h2>The first check, 25 September 2026</h2>',
      '<h2>The failure it is built for</h2>',
      '<h2>Anyone can build the check. Nobody can be their own witness.</h2>',
      '<h2>Who it is for and what it costs</h2>',
      '<h2>Pre-registered, before any code</h2>',
      '<h2>Contact</h2>',
      DEVELOPER_LINE,
      '<h2>Doctrine</h2>',
      '<h2>How it works</h2>',
      '<h2>What it catches</h2>',
      '<h2>Live on Monad</h2>',
      '<h2>Why Monad</h2>',
      '<h2>Record</h2>',
      '<h2>Known limits</h2>',
      'Running an allocator? Write a mandate with us:',
      'Proof of Reason, by DJZS AI, LLC.',
    ].map((marker) => html.indexOf(marker))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })
})

describe('plain words above the line', () => {
  it('divides the page once, and the plain half comes first', () => {
    expect((html.match(new RegExp(DEVELOPER_LINE, 'g')) ?? []).length).toBe(1)
    expect(html.indexOf(DEVELOPER_LINE)).toBeGreaterThan(html.indexOf('<h1>Proof of Reason</h1>'))
    expect(html.indexOf(DEVELOPER_LINE)).toBeLessThan(html.indexOf('<h2>Doctrine</h2>'))
  })

  it('uses none of the jargon above it, in the text or in the markup', () => {
    const { markup, text } = plainHalf()
    expect(text.length).toBeGreaterThan(1000)
    for (const word of JARGON) {
      expect(text.toLowerCase(), `"${word}" in the plain text`).not.toContain(word.toLowerCase())
      expect(markup.toLowerCase(), `"${word}" in the plain markup`).not.toContain(word.toLowerCase())
    }
  })

  it('still names the jargon below it, so nothing was lost by avoiding it', () => {
    const developerHalf = html.slice(html.indexOf(DEVELOPER_LINE))
    // Eleven of the thirteen are terms this page really does use: they moved below the line, they
    // did not go away. The other two this page has never used in either half, so requiring them
    // below would be requiring something that was never here. Both live in README.md instead,
    // where the verify steps need them.
    for (const word of JARGON.filter((w) => !NEVER_ON_THIS_PAGE.includes(w))) {
      expect(developerHalf.toLowerCase(), word).toContain(word.toLowerCase())
    }
    for (const word of NEVER_ON_THIS_PAGE) {
      expect(html.toLowerCase(), word).not.toContain(word.toLowerCase())
    }
  })

  it('leads with the subtitle, not the developer line', () => {
    expect(html).toContain('Reserves prove the money is there. Reason proves why it moved.')
    expect(html).toContain(
      '<meta name="description" content="Reserves prove the money is there. Reason proves why it moved. Live on Monad mainnet.">',
    )
  })

  it('carries each plain block, word for word', () => {
    const { text } = plainHalf()
    const blocks = [
      'Some companies manage other people\'s money in shared pools, and they are starting to let AI decide where that money goes.',
      'Because AI gets things wrong, gets tricked, and cannot be cross-examined.',
      'A bank publishes proof that deposits exist. This proves why deposits moved.',
      'Three yeses, the money moves. One no, it does not, and the refusal is on the record too.',
      'It does not judge whether the move was a good idea.',
      'Our own test AI asked to move 5 dollars between two lending markets.',
      'This was our own AI and does not count as a customer.',
      'In the fourteen months to March 2026, reporting counts at least four cases of the same failure: a lending market trusted a price that was hard-set or had stopped updating, while the real market price had moved. Usual, January 2025: a token hard-set at one dollar; when its redemption floor was cut to 87 cents, lenders were locked in. Stream, November 2025: the price stopped updating as its token collapsed, and an estimated 285 to 700 million dollars was at risk; another outlet reported ten times that. Moonwell, October and November 2025: two price failures, over 5 million dollars of bad debt. Resolv, March 2026: a token marked at 1.13 dollars while it traded near 0.63; one lender absorbed over 10 million dollars of bad debt in a single day.',
      'Today the check reads rates and the cash available to withdraw. Reading the price a lender uses for its collateral is not built yet.',
      'Anyone can build the check. Nobody can be their own witness.',
      'The check earns the same whether the answer is yes or no, so it is never paid to say yes.',
      'Managing pooled money with an AI? Write to dj@proofofreason.com',
    ]
    for (const block of blocks) expect(text, block).toContain(block)
    // Unverified, and a permissions failure rather than a false reason: kept in docs/SOURCES.md
    // under "not used on the page", never on the page.
    expect(html).not.toContain('In May 2026')
    // Claims the sources do not carry, removed with the old paragraph.
    for (const gone of ['every move was allowed', 'the one-dollar price underneath them', 'managed pools', 'lost money', 'What this would have caught']) {
      expect(html, gone).not.toContain(gone)
    }
    expect(html).not.toContain('174 thousand')
    expect(plainHalf().markup).toContain('<a href="mailto:dj@proofofreason.com">')
  })

  it('cites the two editions it quotes, the original they translate, and the file that holds the lines', () => {
    for (const host of ['kucoin.com', 'thedefiant.io', 'theblockbeats.news']) {
      expect(html, host).toContain(host)
    }
    // AMBCrypto carries neither page figure for Moonwell, so the page does not cite it.
    expect(html).not.toContain('ambcrypto.com')
    expect(html).toContain('docs/SOURCES.md')
    expect(existsSync(join(siteDir, '..', 'docs', 'SOURCES.md'))).toBe(true)
  })
})

describe('the pre-registration block quotes the file it names', () => {
  const prereg = readFileSync(join(siteDir, '..', 'docs', 'PREREG.md'), 'utf8')

  it('quotes the terms verbatim from docs/PREREG.md', () => {
    const terms = 'Results publish at each gate date whichever way they fall, including a kill.'
    expect(prereg, 'the quoted terms are no longer in PREREG.md').toContain(terms)
    expect(html, 'the page no longer quotes them').toContain(terms)
  })

  it('quotes the 15 December fit gate verbatim below the line, and says it plainly above it', () => {
    const line = prereg.split('\n').find((l) => l.startsWith('2026-12-15: fit gate.'))
    expect(line, 'the fit gate line is no longer in PREREG.md').toBeDefined()
    expect(html).toContain(`<q>${line}</q>`)
    expect(html.indexOf(line!), 'the technical quote belongs under For developers').toBeGreaterThan(html.indexOf(DEVELOPER_LINE))
    const plain =
      '<dd>In plain words: by 15 December 2026, at least 1 in 20 of the moves we audit must have rested on a reason that was false when it was made, two trials must have been paid for, any amount above zero, and one manager, insurer or listing platform must have committed in writing to require the check. If any of that is missing, the hosted check is not built, and the code stays public.</dd>'
    expect(html).toContain(plain)
    expect(html.indexOf(plain)).toBeGreaterThan(html.indexOf('<li>15 Dec 2026.</li>'))
    expect(html.indexOf(plain)).toBeLessThan(html.indexOf(DEVELOPER_LINE))
    // Each clause stands on a line of the file: A1's pass threshold, what a paid pilot is, and
    // what the written requirer is asked to commit to.
    expect(prereg).toContain('Pass: at least 1 action in 20 carries a false premise at the time it was made.')
    expect(prereg).toContain('- A paid pilot is money received, any amount above zero, invoiced by DJZS AI, LLC.')
    expect(prereg).toContain('Test: ask every allocator, curator, insurer, and listing platform contacted whether they would make it a condition.')
  })

  it('states the same three gate dates the file sets', () => {
    const gates = prereg.slice(prereg.indexOf('## Gates'), prereg.indexOf('## Counting rules'))
    const iso = [...gates.matchAll(/^(\d{4}-\d{2}-\d{2}):/gm)].map((m) => m[1]!)
    expect(iso).toEqual(['2026-10-13', '2026-11-03', '2026-12-15'])
    for (const onPage of ['13 Oct 2026', '3 Nov 2026', '15 Dec 2026']) {
      expect(html, onPage).toContain(onPage)
    }
  })

  it('carries the hash of the file it quotes', () => {
    expect(html).toContain(PREREG_SHA256)
  })
})

describe('brand law', () => {
  it('copies the djzs.ai tokens, with the source named', () => {
    expect(css).toContain('https://djzs.ai/style.css')
    for (const [name, value] of Object.entries(TOKENS)) {
      expect(css, name).toContain(`--${name}: ${value};`)
    }
  })

  it('uses JetBrains Mono with a real fallback stack, and nothing else', () => {
    expect(css).toContain("'JetBrains Mono', ui-monospace")
    expect(css).toMatch(/monospace;/)
    expect(html).toContain('family=JetBrains+Mono')
    // No second family anywhere: no serif, no sans, no system-ui body font.
    expect(css).not.toMatch(/font-family:[^;]*(serif|sans-serif|Inter|Helvetica|Arial)/)
    const families = [...css.matchAll(/font-family:\s*([^;]+);/g)].map((match) => match[1]!.trim())
    for (const family of families) expect(family).toBe('var(--mono)')
  })

  it('leaves the verdict trio as the only saturated colors', () => {
    const trio: string[] = [TOKENS.pass, TOKENS.wait, TOKENS.fail]
    for (const source of [css, favicon]) {
      const hexes = source.match(/#[0-9a-fA-F]{6}/g) ?? []
      expect(hexes.length).toBeGreaterThan(0)
      for (const hex of hexes) {
        const saturated = !isGrey(hex)
        expect(saturated ? trio.includes(hex) : true, `${hex} is saturated and not the trio`).toBe(true)
      }
    }
    // And each of the three is actually used as a verdict, by name.
    for (const name of ['pass', 'wait', 'fail']) expect(css).toContain(`.${name} {`)
    expect(html).toContain('<span class="pass">PASS</span>')
    expect(html).toContain('<span class="wait">WAIT</span>')
    expect(html).toContain('<span class="fail">FAIL</span>')
  })

  it('has square corners, everywhere', () => {
    expect(css).toContain('border-radius: 0;')
    const radii = [...css.matchAll(/border-radius:\s*([^;]+);/g)].map((match) => match[1]!.trim())
    expect([...new Set(radii)]).toEqual(['0'])
  })
})

describe('readable with CSS disabled', () => {
  it('is one document outline, not a layout', () => {
    expect((html.match(/<h1\b/g) ?? []).length).toBe(1)
    expect((html.match(/<h2\b/g) ?? []).length).toBe(19)
    // The table is a table, with headers a screen reader can use.
    expect(html).toContain('<caption>')
    expect(html).toContain('<thead>')
    expect(html).toMatch(/<th scope="col">/)
    expect(html).toMatch(/<th scope="row">/)
    // Steps are an ordered list, so their order survives without CSS.
    expect(html).toContain('<ol class="steps">')
    expect(html).toContain('lang="en"')
  })

  it('puts no text in CSS: nothing meaningful is generated content', () => {
    expect(css).not.toMatch(/content:\s*['"][^'"]+['"]/)
  })

  it('needs no colour to tell the three outcomes apart: each is spelled out', () => {
    for (const word of ['PASS', 'WAIT', 'FAIL']) expect(html).toContain(word)
  })
})

describe('weight', () => {
  it('keeps index.html under the body limit docs/SITE.md documents', () => {
    const size = statSync(join(publicDir, 'index.html')).size
    expect(size, `index.html is ${size} bytes`).toBeLessThan(BODY_LIMIT)
    // The number in the doc and the number here are the same number, on purpose.
    expect(siteDoc, 'docs/SITE.md documents a different limit').toContain(`under ${BODY_LIMIT}`)
  })

  it('serves the whole site in well under 30 KB', () => {
    const files = allFiles(publicDir)
    const total = files.reduce((sum, file) => sum + statSync(file).size, 0)
    const report = files.map((file) => `${file.split('/').pop()} ${statSync(file).size}`).join(', ')
    expect(total, `total ${total} bytes: ${report}`).toBeLessThan(30 * 1024)
    // One page, one stylesheet, one icon: nothing else is being shipped.
    expect(files.map((file) => file.split('/').pop()).sort()).toEqual(['favicon.svg', 'index.html', 'style.css'])
  })
})

describe('the deployment is the production hostname only', () => {
  it('names the zone, the account and no secret', () => {
    expect(wrangler).toContain('account_id = "b4223803d1bd8d0ffb0136a064a0fb16"')
    expect(wrangler).toContain('workers_dev = false')
    expect(wrangler).toContain('pattern = "proofofreason.com", custom_domain = true')
    // Nothing is assigned that could be a secret: no key, no token, no vars block at all.
    expect(wrangler).not.toMatch(/^\s*\[vars\]/m)
    expect(wrangler).not.toMatch(/^\s*[A-Z_]*(KEY|TOKEN|SECRET)[A-Z_]*\s*=/m)
  })
})
