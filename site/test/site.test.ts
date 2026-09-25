import { readFileSync, readdirSync, statSync } from 'node:fs'
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

  it('carries the demo agent id and the x402 terms', () => {
    expect(html).toContain('10258')
    expect(html).toContain('https://api.proofofreason.com')
    expect(html).toContain('x402, 0.10 USDC per check, exact scheme')
    expect(html).toContain('eip155:143')
  })

  it('carries the pre-registration hash, the three gate dates and the promise', () => {
    expect(html).toContain(PREREG_SHA256)
    expect(html).toContain('13 Oct')
    expect(html).toContain('3 Nov')
    expect(html).toContain('15 Dec')
    expect(html).toContain('Results publish whichever way they fall.')
  })

  it('carries the record links, including when the indexer lands', () => {
    expect(html).toContain('https://api.proofofreason.com/receipts/{intentHash}')
    expect(html).toContain('https://agents.proofofreason.com/agents/{gate}')
    expect(html).toContain('Indexer deploys 28 Sep.')
    expect(html).toContain('https://djzs.ai/ruleset')
    expect(html).toContain('How the issuer handles being wrong')
  })

  it('carries the footer, with the one ENS name and no other', () => {
    expect(html).toContain('Proof of Reason, by DJZS AI, LLC.')
    expect(html).toContain('dj@proofofreason.com')
    expect(html).toContain('Built for Monad Metropolis, Track 04.')
    expect(html).toContain('username.dj-z-s.eth')
    const ensNames = html.match(/[a-z0-9.-]+\.eth/g) ?? []
    expect([...new Set(ensNames)]).toEqual(['username.dj-z-s.eth'])
  })

  it('puts the seven blocks in the order the brief sets', () => {
    // Heading markup, not bare text: "Live on Monad" also appears in the meta description.
    const order = [
      '<h1>Proof of Reason</h1>',
      '<h2>Doctrine</h2>',
      '<h2>How it works</h2>',
      '<h2>Live on Monad</h2>',
      '<h2>Pre-registered, before any code</h2>',
      '<h2>Record</h2>',
      'Proof of Reason, by DJZS AI, LLC.',
    ].map((marker) => html.indexOf(marker))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
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
    expect((html.match(/<h2\b/g) ?? []).length).toBe(5)
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
