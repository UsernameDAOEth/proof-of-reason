/**
 * The agent page, rendered on the server. No JavaScript reaches the browser: no script tag, no
 * inline handler, no fetch. Everything the page shows comes out of the indexer and is escaped on the
 * way in, because indexed data is whatever someone put on chain.
 */

export type AgentRecord = {
  id: string
  kind?: string | null
  validator?: string | null
  registryAgentId?: string | null
  passes: number
  waits: number
  overrides: number
  fails: number
  others: number
  samples: number
  wilsonLowerBound?: number | null
  boundStatus: string
  lastOutcome?: string | null
  lastBlock: string
}

export type VerdictRecord = {
  id: string
  outcome?: string | null
  source: string
  ownerOverride?: boolean | null
  receiptHash?: string | null
  requested?: boolean | null
  tag?: string | null
  lastBlock: string
}

export type PageData = {
  agent: AgentRecord
  verdicts: VerdictRecord[]
  /** Where the receipts behind these verdicts are served from. */
  receiptsBase: string
  /** Rendered into the footer so a reader knows how fresh the page is. */
  renderedAt: string
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * Every value from the indexer goes through this. A tag, a URI or an outcome string is whatever a
 * transaction put there, so it is text on this page and never markup.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character)
}

/** A hash, shortened for reading, with the whole value kept in the title attribute. */
function short(hash: string): string {
  const clean = escapeHtml(hash)
  if (clean.length <= 18) return clean
  return `${clean.slice(0, 10)}&hellip;${clean.slice(-6)}`
}

function outcomeLabel(outcome: string | null | undefined): string {
  if (outcome === null || outcome === undefined || outcome === '') return 'unscored'
  return escapeHtml(outcome)
}

/** The bound, or the reason there is not one. */
export function boundLine(agent: AgentRecord): string {
  if (agent.boundStatus !== 'OK' || agent.wilsonLowerBound === null || agent.wilsonLowerBound === undefined) {
    return `Not enough history: ${agent.samples} of 10 verdicts needed`
  }
  return agent.wilsonLowerBound.toFixed(4)
}

const STYLE = `:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;padding:2rem 1rem;font:16px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#fbfbfa;color:#11110f}
main{max-width:60rem;margin:0 auto}
h1{font-size:1.25rem;margin:0 0 .25rem;letter-spacing:.02em}
h2{font-size:1rem;margin:2rem 0 .5rem;text-transform:uppercase;letter-spacing:.08em;color:#55524c}
.addr{word-break:break-all;color:#55524c;font-size:.875rem}
.bound{font-size:2.5rem;margin:1rem 0 .25rem}
.note{color:#55524c;font-size:.8125rem;margin:.25rem 0}
table{border-collapse:collapse;width:100%;font-size:.8125rem}
th,td{text-align:left;padding:.4rem .5rem;border-bottom:1px solid #e3e0d8;vertical-align:top}
th{color:#55524c;font-weight:400;text-transform:uppercase;letter-spacing:.06em;font-size:.6875rem}
td.num{text-align:right}
footer{margin-top:2.5rem;color:#77736b;font-size:.75rem}
a{color:#11110f}
@media (prefers-color-scheme:dark){
body{background:#11110f;color:#fbfbfa}
h2,.addr,.note,th{color:#a8a39a}
th,td{border-bottom-color:#2b2924}
footer{color:#8d887f}
a{color:#fbfbfa}
}`

function counterRows(agent: AgentRecord): string {
  const rows: [string, number, string][] = [
    ['Passes', agent.passes, 'executed on a validator PASS'],
    ['Waits', agent.waits, 'executed on an owner override after a WAIT'],
    ['Overrides', agent.overrides, 'of those waits, signed by the owner'],
    ['Fails', agent.fails, 'refused: the gate reverted, so only the registry saw them'],
    ['Unscored', agent.others, 'registry responses outside 100, 50 and 0; left out of the bound'],
  ]
  return rows
    .map(
      ([label, value, note]) =>
        `<tr><th scope="row">${label}</th><td class="num">${value}</td><td>${note}</td></tr>`,
    )
    .join('')
}

function verdictRows(verdicts: readonly VerdictRecord[], receiptsBase: string): string {
  if (verdicts.length === 0) {
    return '<tr><td colspan="6">No verdicts indexed yet.</td></tr>'
  }
  return verdicts
    .map((verdict) => {
      const receipt =
        verdict.receiptHash === null || verdict.receiptHash === undefined
          ? '&mdash;'
          : `<a href="${escapeHtml(receiptsBase)}/${escapeHtml(verdict.id)}" title="${escapeHtml(verdict.receiptHash)}">${short(verdict.receiptHash)}</a>`
      return [
        '<tr>',
        `<td title="${escapeHtml(verdict.id)}">${short(verdict.id)}</td>`,
        `<td>${outcomeLabel(verdict.outcome)}</td>`,
        `<td>${escapeHtml(verdict.source)}</td>`,
        `<td>${verdict.ownerOverride === true ? 'yes' : 'no'}</td>`,
        `<td>${verdict.requested === true ? 'yes' : 'no'}</td>`,
        `<td>${receipt}</td>`,
        '</tr>',
      ].join('')
    })
    .join('')
}

/** The whole page, as one string. Pure: same data in, same bytes out. */
export function renderAgentPage(data: PageData): string {
  const { agent } = data
  const title = `Agent ${escapeHtml(agent.id)}`
  const bound = boundLine(agent)
  const scored = agent.boundStatus === 'OK'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} | Proof of Reason</title>
<meta name="description" content="Verdicts recorded for one gated agent: what passed, what waited, what was refused.">
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Proof of Reason &middot; gated agent</h1>
<p class="addr">${escapeHtml(agent.id)}${agent.kind === null || agent.kind === undefined ? '' : ` &middot; ${escapeHtml(agent.kind)}`}</p>

<h2>Pass rate, lower bound</h2>
<p class="bound">${bound}</p>
<p class="note">${
    scored
      ? `Wilson lower bound at 95 percent over ${agent.samples} verdicts. The smallest pass rate consistent with what was observed, so it rises only with evidence.`
      : 'A bound is published from the tenth verdict. Until then the counts stand on their own.'
  }</p>
<p class="note">Last outcome: ${outcomeLabel(agent.lastOutcome)}, at block ${escapeHtml(agent.lastBlock)}.</p>

<h2>Counts</h2>
<table>
<tbody>${counterRows(agent)}</tbody>
</table>
<p class="note">A gate emits an event only for what it executed, so passes, waits and overrides come from the gate. A refusal reverts, so the fails come from the validation registry. A verdict both recorded is counted once.</p>

<h2>Verdicts</h2>
<table>
<thead><tr><th>Intent</th><th>Outcome</th><th>Source</th><th>Override</th><th>Requested</th><th>Receipt</th></tr></thead>
<tbody>${verdictRows(data.verdicts, data.receiptsBase)}</tbody>
</table>

<footer>
<p>Validator: ${escapeHtml(agent.validator ?? 'not set')}${
    agent.registryAgentId === null || agent.registryAgentId === undefined
      ? ''
      : ` &middot; ERC-8004 agent ${escapeHtml(agent.registryAgentId)}`
  }</p>
<p>Rendered ${escapeHtml(data.renderedAt)}. Static page, no JavaScript. Receipts are served by the validator and sealed by hash.</p>
</footer>
</main>
</body>
</html>
`
}
