/**
 * Render the generated regions of site/public/index.html: the first check's five lines from
 * vid/receipts/pass.json, and the execution delay, the pre-registration dates and the reported
 * failures from scripts/facts.json and docs/PREREG.md.
 *
 *   node scripts/gen-site.ts          rewrite the regions in the page
 *   node scripts/gen-site.ts --check  exit 1 if any region is stale, write nothing
 *
 * The page says what the receipt and the chain say, in plain words, and nobody types the numbers.
 * The delay is not in the receipt, because a receipt is sealed before the money moves, so it is
 * derived from the two block numbers and the two block timestamps stored in facts.json.
 *
 * scripts/test/readme.test.ts fails if the page and its sources disagree.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { loadFacts } from './gen-readme.ts'
import type { Facts } from './gen-readme.ts'

const root = join(new URL('..', import.meta.url).pathname)
const PAGE_PATH = join(root, 'site', 'public', 'index.html')
const RECEIPT_PATH = join(root, 'vid', 'receipts', 'pass.json')
const PREREG_PATH = join(root, 'docs', 'PREREG.md')

/** The markers around one generated region of the page. */
export function region(name: string): { begin: string; end: string } {
  return { begin: `<!-- BEGIN GENERATED ${name}: node scripts/gen-site.ts -->`, end: `<!-- END GENERATED ${name} -->` }
}

export const BEGIN = region('first-check').begin
export const END = region('first-check').end

/** USDC is six decimals. Grouped for reading, every digit kept. */
function dollars(base: string): string {
  const units = base.padStart(7, '0')
  const whole = units.slice(0, -6).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${whole}.${units.slice(-6)}`
}

/** Small counts read as words on this half of the page. */
const WORDS = ['no', 'one', 'both', 'three', 'four', 'five', 'six']
function count(n: number): string {
  return WORDS[n] ?? String(n)
}

/** Counts of seconds read as words on the plain half; larger counts stay digits. */
export const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty',
]
export function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n)
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
/** 2026-09-18 or 2026-09-18T10:25:26-07:00 reads as 18 September 2026, the date as written. */
export function longDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (match === null) throw new Error(`not an ISO date: ${iso}`)
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}`
}

/** From the check's block to the execution's block, by block number and by block timestamp. */
export function executionDelay(facts: Facts): { seconds: number; blocks: bigint } {
  const first = facts.firstReceipt
  const seconds = first.executionTimestamp - first.blockTimestamp
  const blocks = BigInt(first.executionBlock) - BigInt(first.block)
  if (seconds < 0 || blocks <= 0n) throw new Error('facts.json has the execution before the check')
  return { seconds, blocks }
}

const plural = (n: number | bigint, word: string) => `${word}${n === 1 || n === 1n ? '' : 's'}`

/** The plain half's sentence. */
export function delaySentence(facts: Facts): string {
  const { seconds, blocks } = executionDelay(facts)
  return `The money moved ${numberWord(seconds)} ${plural(seconds, 'second')} later, ${blocks} ${plural(blocks, 'block')} on the chain.`
}

/** The developer half's sentence, the same gap in chain terms. */
export function chainDelaySentence(facts: Facts): string {
  const { seconds, blocks } = executionDelay(facts)
  return `The first check to execution took ${blocks} ${plural(blocks, 'block')}, ${seconds} ${plural(seconds, 'second')} by block timestamps.`
}

/** The date docs/PREREG.md states for itself, if it states one. */
export function preregStatedDate(prereg: string): string | null {
  return /^Registered: (\d{4}-\d{2}-\d{2})/m.exec(prereg)?.[1] ?? null
}

/**
 * When the pre-registration was written and when it was first public, each from its own source:
 * the file's own date, git's date for the commit that added it, and the post that carried its hash.
 */
export function preregParagraph(facts: Facts, prereg: string): string {
  const { firstCommit, publicPost } = facts.prereg
  const stated = preregStatedDate(prereg)
  const commit = `<a href="${facts.repo}/commit/${firstCommit.hash}"><code>${firstCommit.hash.slice(0, 7)}</code></a>`
  const written = stated !== null
    ? `The file says it was registered on ${longDate(stated)}, and it is the first commit in the repository, ${commit}, dated ${longDate(firstCommit.date)}.`
    : `It is the first commit in the repository, ${commit}, dated ${longDate(firstCommit.date)}.`
  return (
    '<p>The questions, the numbers that would count as a pass, and the numbers that would kill it were all written down before any code. ' +
    `${written} Its fingerprint, the sha256 below, was posted publicly on ${longDate(publicPost.date)}: ` +
    `<a href="${publicPost.url}">the post</a>.</p>`
  )
}

/**
 * The paragraph under "The failure it is built for", from facts.json. The wording is fixed; every
 * number and date in it is a value there, and each value is quoted from its source in
 * docs/SOURCES.md.
 */
export function failuresParagraph(facts: Facts): string {
  const { months, to, atLeast, usual, stream, moonwell, resolv } = facts.failures
  const hardSet = Number(usual.hardSetUsd)
  const floorCents = Math.round(Number(usual.floorUsd) * 100)
  return (
    `In the ${numberWord(months)} months to ${to}, reporting counts at least ${numberWord(atLeast)} cases of the same failure: ` +
    'a lending market trusted a price that was hard-set or had stopped updating, while the real market price had moved. ' +
    `Usual, ${usual.when}: a token hard-set at ${numberWord(hardSet)} ${plural(hardSet, 'dollar')}; ` +
    `when its redemption floor was cut to ${floorCents} cents, lenders were locked in. ` +
    `Stream, ${stream.when}: the price stopped updating as its token collapsed, and an estimated ` +
    `${stream.atRiskMillionsLow} to ${stream.atRiskMillionsHigh} million dollars was at risk; ` +
    `another outlet reported ${numberWord(stream.otherOutletFactor)} times that. ` +
    `Moonwell, ${moonwell.when}: ${numberWord(moonwell.failures)} price failures, over ${moonwell.badDebtOverMillions} million dollars of bad debt. ` +
    `Resolv, ${resolv.when}: a token marked at ${resolv.markedUsd} dollars while it traded near ${resolv.tradedUsd}; ` +
    `one lender absorbed over ${resolv.badDebtOverMillions} million dollars of bad debt in a single day.`
  )
}

/** The read value at the precision the claim itself was stated to, never more. */
function atClaimPrecision(claimed: number, observed: number): string {
  const decimals = (String(claimed).split('.')[1] ?? '').length
  return observed.toFixed(decimals)
}

export function firstCheckLines(receipt: any, facts: Facts): string[] {
  const results = new Map(receipt.results.map((r: any) => [r.id, r]))
  const lines: string[] = []

  for (const claim of receipt.claims) {
    const result: any = results.get(claim.id)
    const yes = result.status === 'TRUE' ? 'True.' : `${result.status}.`
    if (claim.kind === 'rate') {
      lines.push(
        `It said this market pays ${claim.valuePct} percent. ` +
          `The market read ${atClaimPrecision(claim.valuePct, result.observed)} percent. ${yes}`,
      )
    } else if (claim.kind === 'liquidity') {
      lines.push(
        `It said at least ${dollars(claim.minWithdrawable)} dollars could be taken out on demand. ` +
          `The market read ${dollars(String(result.observed))} dollars. ${yes}`,
      )
    } else {
      throw new Error(`no plain wording for a ${claim.kind} claim yet`)
    }
  }

  const touched = new Set(receipt.action.allocations.map((a: any) => a.market))
  const allowed = [...touched].every((m) => receipt.mandate.allowedMarkets.includes(m))
  if (!allowed) throw new Error('the receipt says the move went outside the list; rewrite this line')
  lines.push(
    `Allowed: ${count(touched.size)} markets it touched were on the list the owner had approved.`,
  )

  const missing = receipt.verdict.missingKinds.length
  if (missing > 0) throw new Error('the receipt is missing a required kind; rewrite this line')
  lines.push(
    `Complete: ${count(receipt.mandate.requiredKinds.length)} kinds of reason it was required to give were there.`,
  )

  // The three questions the page asks, in the order it asks them: true, allowed, complete.
  const answers = [
    receipt.results.length > 0 && receipt.results.every((r: any) => r.status === 'TRUE'),
    allowed && receipt.verdict.failing.length === 0,
    missing === 0,
  ]
  const yeses = answers.filter(Boolean).length
  if (String(receipt.verdict.checkedAtBlock) !== facts.firstReceipt.block) {
    throw new Error('facts.json times a different block from the one the receipt was checked at')
  }
  lines.push(`Result: ${count(yeses)} yeses, at block ${receipt.verdict.checkedAtBlock}. ${delaySentence(facts)}`)
  return lines
}

/**
 * The three links under the summary, in the order the thing happened. Plain labels: this half of
 * the page names no machinery, so "the filing on the chain" rather than the registry, and "the
 * money moving" rather than the execution. The developer half names both properly.
 */
export function firstCheckLinks(facts: Facts): string {
  const { intentHash, registryTx, executionTx } = facts.firstReceipt
  const tx = (h: string) => `${facts.chain.explorer}/tx/${h}`
  return (
    `<p>See it yourself: <a href="${facts.api.url}/receipts/${intentHash}">the public record</a>, ` +
    `<a href="${tx(registryTx)}">the filing on the chain</a>, ` +
    `<a href="${tx(executionTx)}">the money moving</a>.</p>`
  )
}

export function firstCheckBlock(receipt: any, facts: Facts): string {
  const items = firstCheckLines(receipt, facts).map((line) => `<li>${line}</li>`)
  return [BEGIN, '<ul class="plain">', ...items, '</ul>', firstCheckLinks(facts), END].join('\n')
}

/** Replace one region, markers included. `block` must carry the region's own markers. */
export function rewrite(page: string, block: string, name = 'first-check'): string {
  const { begin, end: finish } = region(name)
  const start = page.indexOf(begin)
  const end = page.indexOf(finish)
  if (start < 0 || end < 0) throw new Error(`index.html is missing the ${begin} / ${finish} markers`)
  return page.slice(0, start) + block + page.slice(end + finish.length)
}

/** An inline region: the markers and the text between them, no newlines, so it sits inside a paragraph. */
function inline(name: string, text: string): string {
  const { begin, end } = region(name)
  return `${begin}${text}${end}`
}

/** Every generated region of the page, rendered from its sources. */
export function render(page: string, receipt: any, facts: Facts, prereg: string): string {
  let next = rewrite(page, firstCheckBlock(receipt, facts))
  next = rewrite(next, inline('delay', delaySentence(facts)), 'delay')
  next = rewrite(next, inline('delay-chain', chainDelaySentence(facts)), 'delay-chain')
  next = rewrite(next, inline('prereg', preregParagraph(facts, prereg)), 'prereg')
  next = rewrite(next, inline('failures', failuresParagraph(facts)), 'failures')
  return next
}

function main(argv: string[]): number {
  const facts = loadFacts()
  const receipt = JSON.parse(readFileSync(RECEIPT_PATH, 'utf8'))
  const page = readFileSync(PAGE_PATH, 'utf8')
  const next = render(page, receipt, facts, readFileSync(PREREG_PATH, 'utf8'))
  if (argv.includes('--check')) {
    if (next === page) {
      console.log('index.html is in sync with vid/receipts/pass.json, scripts/facts.json and docs/PREREG.md')
      return 0
    }
    console.error('index.html is stale. Run: node scripts/gen-site.ts')
    return 1
  }
  if (next === page) {
    console.log('index.html already in sync with its sources')
    return 0
  }
  writeFileSync(PAGE_PATH, next)
  console.log('rewrote the generated regions in index.html from their sources')
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)))
