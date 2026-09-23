import { describe, expect, it } from 'vitest'
import { boundLine, escapeHtml, renderAgentPage } from '../src/page.ts'
import type { AgentRecord, PageData, VerdictRecord } from '../src/page.ts'

const GATE = '0x4e23fe7d8ed36ada7cac3645a7801c352d3daabc'

const agent: AgentRecord = {
  id: GATE,
  kind: 'ReasonGate',
  validator: '0x0376aac07ad725e01357b1725b5cec61ae10473c',
  registryAgentId: '42',
  passes: 8,
  waits: 1,
  overrides: 1,
  fails: 1,
  others: 2,
  samples: 10,
  wilsonLowerBound: 0.490157,
  boundStatus: 'OK',
  lastOutcome: 'FAIL',
  lastBlock: '106623517',
}

const verdicts: VerdictRecord[] = [
  {
    id: `0x${'a1'.repeat(32)}`,
    outcome: 'FAIL',
    source: 'registry',
    ownerOverride: null,
    receiptHash: `0x${'b2'.repeat(32)}`,
    requested: false,
    tag: 'REASON-R0',
    lastBlock: '106623517',
  },
  {
    id: `0x${'c3'.repeat(32)}`,
    outcome: 'WAIT',
    source: 'both',
    ownerOverride: true,
    receiptHash: `0x${'d4'.repeat(32)}`,
    requested: true,
    tag: 'REASON-R0',
    lastBlock: '106623400',
  },
]

const fixture: PageData = {
  agent,
  verdicts,
  receiptsBase: 'https://api.proofofreason.com/receipts',
  renderedAt: '2026-09-23 12:00:00 UTC',
}

function render(overrides: Partial<PageData> = {}): string {
  return renderAgentPage({ ...fixture, ...overrides })
}

describe('the agent page, from a fixture', () => {
  it('shows the bound, the counts, the verdicts and the receipts', () => {
    const html = render()
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('0.4902')
    expect(html).toContain(GATE)
    expect(html).toContain('ReasonGate')
    expect(html).toContain('ERC-8004 agent 42')
    // One row per verdict, with the receipt linked by intent hash.
    expect(html).toContain(`https://api.proofofreason.com/receipts/0x${'a1'.repeat(32)}`)
    expect(html).toContain('FAIL')
    expect(html).toContain('WAIT')
    expect(html).toContain('2026-09-23 12:00:00 UTC')
    // The counts, each with its own line.
    for (const label of ['Passes', 'Waits', 'Overrides', 'Fails', 'Unscored']) expect(html).toContain(label)
  })

  it('says what it does not know instead of showing a number', () => {
    const thin = render({ agent: { ...agent, samples: 4, passes: 4, fails: 0, boundStatus: 'INSUFFICIENT_HISTORY', wilsonLowerBound: null } })
    expect(thin).toContain('Not enough history: 4 of 10 verdicts needed')
    expect(thin).toContain('A bound is published from the tenth verdict')
    expect(thin).not.toContain('0.0000')
    expect(boundLine({ ...agent, boundStatus: 'INSUFFICIENT_HISTORY', wilsonLowerBound: null })).toBe(
      'Not enough history: 10 of 10 verdicts needed',
    )
    expect(boundLine(agent)).toBe('0.4902')
  })

  it('prints an unscored verdict as unscored, not as a pass', () => {
    const html = render({
      verdicts: [{ ...verdicts[0]!, outcome: null, receiptHash: null }],
    })
    expect(html).toContain('unscored')
    expect(html).not.toContain('>PASS<')
  })

  it('handles an agent with no verdicts and no optional fields', () => {
    const bare: AgentRecord = {
      id: GATE,
      passes: 0,
      waits: 0,
      overrides: 0,
      fails: 0,
      others: 0,
      samples: 0,
      boundStatus: 'INSUFFICIENT_HISTORY',
      lastBlock: '0',
    }
    const html = render({ agent: bare, verdicts: [] })
    expect(html).toContain('No verdicts indexed yet.')
    expect(html).toContain('Validator: not set')
    expect(html).not.toContain('undefined')
    expect(html).not.toContain('null')
  })
})

describe('no JavaScript reaches the browser', () => {
  it('renders no script tag, no inline handler and no javascript URL', () => {
    const html = render().toLowerCase()
    expect(html).not.toContain('<script')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('onload=')
    expect(html).not.toContain('onclick=')
    expect(html).not.toContain('onerror=')
    expect(html).not.toContain('addeventlistener')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('<object')
  })
})

describe('indexed data is text, never markup', () => {
  const attack = '<script>alert(1)</script>'

  it('escapes a script tag wherever the indexer hands one over', () => {
    const html = render({
      agent: {
        ...agent,
        kind: attack,
        validator: attack,
        registryAgentId: attack,
        lastOutcome: attack,
        lastBlock: attack,
        boundStatus: attack,
      },
      verdicts: [
        {
          id: attack,
          outcome: attack,
          source: attack,
          ownerOverride: null,
          receiptHash: attack,
          requested: null,
          tag: attack,
          lastBlock: attack,
        },
      ],
      receiptsBase: attack,
      renderedAt: attack,
    })
    expect(html).not.toContain('<script')
    expect(html).not.toContain('</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('escapes quotes, so a value cannot break out of an attribute', () => {
    const breakout = '" onmouseover="alert(1)'
    const html = render({ verdicts: [{ ...verdicts[0]!, id: breakout, receiptHash: breakout }] })
    // The breakout needs a live quote to close the attribute. It never gets one, so the handler
    // survives only as text: escaped, inert, and visible as itself.
    expect(html).not.toContain('" onmouseover="')
    expect(html).toContain('&quot; onmouseover=&quot;alert(1)')
  })

  it('escapes the five characters that matter, and leaves everything else alone', () => {
    expect(escapeHtml('<a href="x">&\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
    expect(escapeHtml('REASON-R0')).toBe('REASON-R0')
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(undefined)).toBe('')
    expect(escapeHtml(42)).toBe('42')
  })

  it('is deterministic: the same data renders the same bytes', () => {
    expect(render()).toBe(render())
  })
})
