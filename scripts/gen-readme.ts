/**
 * Generate the README's Live on Monad table from scripts/facts.json.
 *
 *   node scripts/gen-readme.ts          rewrite the block in README.md
 *   node scripts/gen-readme.ts --check  exit 1 if the block is stale, write nothing
 *
 * The same facts appear on site/public/index.html. That page is hand written apart from the regions
 * scripts/gen-site.ts renders from this file; it is held against this file by
 * scripts/test/readme.test.ts. One source, two readers, and a test that fails if either drifts.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(new URL('..', import.meta.url).pathname)
const FACTS_PATH = join(root, 'scripts', 'facts.json')
const README_PATH = join(root, 'README.md')

export const BEGIN = '<!-- BEGIN GENERATED live: node scripts/gen-readme.ts -->'
export const END = '<!-- END GENERATED live -->'

export type Facts = {
  repo: string
  chain: { name: string; id: number; caip2: string; explorer: string }
  contracts: { what: string; address: string }[]
  agents: { validator: string; demo: string }
  api: { url: string; terms: string }
  firstReceipt: {
    date: string
    outcome: string
    block: string
    intentHash: string
    receiptHash: string
    registryTx: string
    executionTx: string
    /** Unix seconds of `block`, and the block the execution landed in with its unix seconds. */
    blockTimestamp: number
    blockTime: string
    executionBlock: string
    executionTimestamp: number
    executionTime: string
  }
  prereg: {
    sha256: string
    gates: { date: string; what: string }[]
    /** The root commit of the repository, which adds docs/PREREG.md; the date is git's author date. */
    firstCommit: { hash: string; date: string }
    /** Where the sha256 was first posted publicly. */
    publicPost: { url: string; date: string }
  }
  /** The reported failures the site describes; every figure is quoted in docs/SOURCES.md. */
  failures: {
    months: number
    to: string
    atLeast: number
    usual: { when: string; hardSetUsd: string; floorUsd: string }
    stream: { when: string; atRiskMillionsLow: number; atRiskMillionsHigh: number; otherOutletFactor: number }
    moonwell: { when: string; failures: number; badDebtOverMillions: number }
    resolv: { when: string; markedUsd: string; tradedUsd: string; badDebtOverMillions: number }
  }
}

export function loadFacts(path: string = FACTS_PATH): Facts {
  return JSON.parse(readFileSync(path, 'utf8')) as Facts
}

/** The table, and the first receipt under it. Markdown, the same rows the site's table carries. */
export function liveBlock(facts: Facts): string {
  const { chain, contracts, agents, api, firstReceipt: first } = facts
  const address = (a: string) => `[\`${a}\`](${chain.explorer}/address/${a})`
  const tx = (h: string) => `${chain.explorer}/tx/${h}`

  const rows = [
    ...contracts.map((entry) => `| ${entry.what} | ${address(entry.address)} |`),
    `| Validator agent | ERC-8004 id \`${agents.validator}\` on the identity registry above, its registration file carrying the pre-registration sha256 below |`,
    `| Demo agent | ERC-8004 id \`${agents.demo}\` on the identity registry above |`,
    `| API | [\`${api.url}\`](${api.url}), ${api.terms}, \`${chain.caip2}\` |`,
  ]

  return [
    BEGIN,
    '',
    `${chain.name}, chain ${chain.id}. Addresses link to Monad Vision.`,
    '',
    '| What | Address |',
    '| --- | --- |',
    ...rows,
    '',
    `First receipt, ${first.date}: [${first.outcome} at block ${first.block}](${api.url}/receipts/${first.intentHash}).`,
    `Then the [registry write](${tx(first.registryTx)}), then the [execution](${tx(first.executionTx)}).`,
    '',
    END,
  ].join('\n')
}

export function rewrite(readme: string, block: string): string {
  const start = readme.indexOf(BEGIN)
  const end = readme.indexOf(END)
  if (start < 0 || end < 0) throw new Error(`README.md is missing the ${BEGIN} / ${END} markers`)
  return readme.slice(0, start) + block + readme.slice(end + END.length)
}

function main(argv: string[]): number {
  const facts = loadFacts()
  const readme = readFileSync(README_PATH, 'utf8')
  const next = rewrite(readme, liveBlock(facts))
  if (argv.includes('--check')) {
    if (next === readme) {
      console.log('README.md is in sync with scripts/facts.json')
      return 0
    }
    console.error('README.md is stale. Run: node scripts/gen-readme.ts')
    return 1
  }
  if (next === readme) {
    console.log('README.md already in sync with scripts/facts.json')
    return 0
  }
  writeFileSync(README_PATH, next)
  console.log('rewrote the Live on Monad block in README.md from scripts/facts.json')
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)))
