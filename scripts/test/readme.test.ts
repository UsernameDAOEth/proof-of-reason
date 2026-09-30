/**
 * The README, the site and the receipt say the same thing, or the suite fails.
 *
 * scripts/facts.json is the one source. The README's Live on Monad table is generated from it;
 * site/public/index.html is hand written and held against it here. The first receipt is held
 * against vid/receipts/pass.json, the document api.proofofreason.com actually serves, so the
 * published claim cannot drift from the published receipt either.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { hashCanonical, RECEIPT_UNSEALED_KEYS } from 'proof-of-reason-engine/receipt'

import { BEGIN, END, liveBlock, loadFacts } from '../gen-readme.ts'
import {
  BEGIN as FIRST_BEGIN,
  END as FIRST_END,
  firstCheckBlock,
  firstCheckLines,
  render,
} from '../gen-site.ts'

const root = join(new URL('../..', import.meta.url).pathname)
const readme = readFileSync(join(root, 'README.md'), 'utf8')
const license = readFileSync(join(root, 'LICENSE'), 'utf8')
const site = readFileSync(join(root, 'site', 'public', 'index.html'), 'utf8')
const gitignore = readFileSync(join(root, '.gitignore'), 'utf8')
const facts = loadFacts(join(root, 'scripts', 'facts.json'))

const EM_DASH = String.fromCodePoint(0x2014)
const receiptPath = join(root, 'vid', 'receipts', 'pass.json')

describe('the README is generated from scripts/facts.json', () => {
  it('carries the generated block, and it is not stale', () => {
    expect(readme).toContain(BEGIN)
    expect(readme).toContain(END)
    const block = readme.slice(readme.indexOf(BEGIN), readme.indexOf(END) + END.length)
    expect(block, 'run: node scripts/gen-readme.ts').toBe(liveBlock(facts))
  })
})

describe('the README and the site state the same facts', () => {
  it('every address, in both, linked to the same explorer in both', () => {
    for (const { what, address } of facts.contracts) {
      const link = `${facts.chain.explorer}/address/${address}`
      expect(readme, `${what} in README`).toContain(address)
      expect(readme, `${what} link in README`).toContain(link)
      expect(site, `${what} on the site`).toContain(address)
      expect(site, `${what} link on the site`).toContain(link)
    }
    expect(facts.contracts).toHaveLength(5)
  })

  it('both agent ids, in both', () => {
    for (const id of [facts.agents.validator, facts.agents.demo]) {
      expect(readme, `agent ${id} in README`).toContain(`ERC-8004 id \`${id}\``)
      expect(site, `agent ${id} on the site`).toContain(`ERC-8004 id <code>${id}</code>`)
    }
    expect(facts.agents.validator).not.toBe(facts.agents.demo)
  })

  it('the chain, the API and the x402 terms, in both', () => {
    expect(readme).toContain(`chain ${facts.chain.id}`)
    expect(site).toContain(`chain ${facts.chain.id}`)
    for (const text of [facts.api.url, facts.api.terms, facts.chain.caip2]) {
      expect(readme, text).toContain(text)
      expect(site, text).toContain(text)
    }
  })

  it('the first receipt, its registry write and its execution, in both', () => {
    const { intentHash, registryTx, executionTx, block, outcome, date } = facts.firstReceipt
    const receiptUrl = `${facts.api.url}/receipts/${intentHash}`
    for (const source of [readme, site]) {
      expect(source).toContain(receiptUrl)
      expect(source).toContain(`${facts.chain.explorer}/tx/${registryTx}`)
      expect(source).toContain(`${facts.chain.explorer}/tx/${executionTx}`)
      expect(source).toContain(`First receipt, ${date}:`)
      expect(source).toContain(outcome)
      expect(source).toContain(block)
    }
    expect(registryTx).not.toBe(executionTx)
  })

  it('the pre-registration hash and the three gate dates, in both', () => {
    expect(readme).toContain(facts.prereg.sha256)
    expect(site).toContain(facts.prereg.sha256)
    for (const gate of facts.prereg.gates) {
      expect(readme, gate.date).toContain(gate.date)
      expect(site, gate.date).toContain(gate.date)
    }
  })

  it('the same three known limits, word for word', () => {
    const limits = [
      'One validator key today; every verdict is on the registry and re-checkable by anyone, and a second validator is the roadmap.',
      'The check judges premises and mandate, not whether the decision is wise.',
      "The registry is interim until Monad's canonical ERC-8004 validation registry ships.",
    ]
    for (const limit of limits) {
      // The README wraps its list items, so compare on collapsed whitespace.
      expect(readme.replace(/\s+/g, ' '), limit).toContain(limit)
      expect(site, limit).toContain(limit)
    }
  })
})

describe('the first check on the page is the receipt, not a retelling of it', () => {
  it.skipIf(!existsSync(receiptPath))('the page block is rendered, and it is not stale', () => {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    expect(site).toContain(FIRST_BEGIN)
    expect(site).toContain(FIRST_END)
    const block = site.slice(site.indexOf(FIRST_BEGIN), site.indexOf(FIRST_END) + FIRST_END.length)
    expect(block, 'run: node scripts/gen-site.ts').toBe(firstCheckBlock(receipt, facts))
  })

  it.skipIf(!existsSync(receiptPath))('every number in those lines comes out of the receipt', () => {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    const lines = firstCheckLines(receipt, facts).join(' ')

    // The claimed values, as the agent stated them.
    expect(lines).toContain(String(receipt.claims[0].valuePct))
    expect(lines).toContain('1,639,330.385558')
    expect(receipt.claims[1].minWithdrawable).toBe('1639330385558')
    // The values the chain read back.
    expect(lines).toContain('1,821,478.206176')
    expect(receipt.results[1].observed).toBe('1821478206176')
    // The block the check was pinned to.
    expect(lines).toContain(String(receipt.verdict.checkedAtBlock))
    // Three yeses, because the receipt says all three questions were answered yes.
    expect(receipt.results.every((r: any) => r.status === 'TRUE')).toBe(true)
    expect(receipt.verdict.failing).toEqual([])
    expect(receipt.verdict.missingKinds).toEqual([])
    expect(lines).toContain('three yeses')
  })

  it.skipIf(!existsSync(receiptPath))('refuses to render a plain line for a claim it has no words for', () => {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    const odd = JSON.parse(JSON.stringify(receipt))
    odd.claims[0].kind = 'utilization'
    expect(() => firstCheckLines(odd, facts)).toThrow(/no plain wording/)
  })

  it('states the execution delay the block timestamps in facts.json give, in both halves', () => {
    // A receipt is sealed before the money moves, so the gap cannot be inside it. It is derived
    // from the two blocks and their timestamps, read from the chain into facts.json.
    const first = facts.firstReceipt
    const seconds = first.executionTimestamp - first.blockTimestamp
    const blocks = Number(BigInt(first.executionBlock) - BigInt(first.block))
    expect(new Date(first.blockTimestamp * 1000).toISOString().replace('.000', '')).toBe(first.blockTime)
    expect(new Date(first.executionTimestamp * 1000).toISOString().replace('.000', '')).toBe(first.executionTime)

    // The plain half spells the seconds out. Read the word back, independently of gen-site.ts.
    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
    const plain = [...site.matchAll(/The money moved (\w+) seconds? later, (\d+) blocks? on the chain\./g)]
    expect(plain.length, 'the sentence appears in the story and in the result line').toBe(2)
    for (const [, word, onChain] of plain) {
      expect(words.indexOf(word!), `"${word}" seconds`).toBe(seconds)
      expect(Number(onChain)).toBe(blocks)
    }
    const chain = /The first check to execution took (\d+) blocks?, (\d+) seconds? by block timestamps\./.exec(site)
    expect(chain).not.toBeNull()
    expect(Number(chain![1])).toBe(blocks)
    expect(Number(chain![2])).toBe(seconds)
    expect(site).not.toMatch(/eleven seconds|3\.3 seconds/)
  })

  it('names the first commit as git records it, and it is the commit that adds docs/PREREG.md', () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
    const { firstCommit } = facts.prereg
    expect(git('rev-list', '--max-parents=0', 'HEAD')).toBe(firstCommit.hash)
    expect(git('show', '-s', '--format=%aI', firstCommit.hash)).toBe(firstCommit.date)
    expect(git('show', '--name-only', '--format=', firstCommit.hash).split('\n')).toContain('docs/PREREG.md')
  })

  it('takes every failure figure from a line quoted verbatim in docs/SOURCES.md', () => {
    const sources = readFileSync(join(root, 'docs', 'SOURCES.md'), 'utf8')
    const { months, atLeast, usual, stream, moonwell, resolv } = facts.failures
    const quoted = [
      `"This has occurred at least four times in the past ${months} months."`,
      `"Over the past ${months} months, this situation has occurred at least four times."`,
      `hardcoded to $${usual.hardSetUsd} by curator MEV Capital`,
      `redemption floor price to $${usual.floorUsd} without any warning`,
      `an estimated $${stream.atRiskMillionsLow} million to $${stream.atRiskMillionsHigh} million in assets`,
      // The other outlet's range is the same range times the factor, in billions.
      `an estimated $${(stream.atRiskMillionsLow * stream.otherOutletFactor) / 1000} billion to $${(stream.atRiskMillionsHigh * stream.otherOutletFactor) / 1000} billion`,
      `resulting in over $${moonwell.badDebtOverMillions} million in bad debt.`,
      `two consecutive oracle failures in ${moonwell.when}`,
      `wstUSR was marked at $${resolv.markedUsd}, while its secondary market trading price was around $${resolv.tradedUsd}.`,
      `absorbed over $${resolv.badDebtOverMillions} million in bad debt in a single day`,
    ]
    expect(atLeast).toBe(4)
    expect(moonwell.failures).toBe(2)
    for (const line of quoted) expect(sources, line).toContain(line)
  })

  it.skipIf(!existsSync(receiptPath))('every generated region of the page is in sync with its sources', () => {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    const prereg = readFileSync(join(root, 'docs', 'PREREG.md'), 'utf8')
    expect(render(site, receipt, facts, prereg)).toBe(site)
  })
})

describe('the facts are the published receipt', () => {
  it.skipIf(!existsSync(receiptPath))('every field matches vid/receipts/pass.json', () => {
    const stored = JSON.parse(readFileSync(receiptPath, 'utf8'))
    const { intentHash, registryTx, block, outcome } = facts.firstReceipt
    expect(stored.intent.intentHash).toBe(intentHash)
    expect(String(stored.verdict.checkedAtBlock)).toBe(block)
    expect(stored.verdict.outcome).toBe(outcome)
    expect(stored.registry.tx).toBe(registryTx)
    expect(stored.provenance.url).toBe(`${facts.api.url}/receipts/${intentHash}`)
  })

  it.skipIf(!existsSync(receiptPath))('the hash the README tells you to recompute is the one you get', () => {
    // Exactly the three steps the README's verify section gives: drop the unsealed key, hash the
    // rest. provenance is the vid kit's own annotation and is not part of the served document.
    const stored = JSON.parse(readFileSync(receiptPath, 'utf8'))
    delete stored.provenance
    expect(RECEIPT_UNSEALED_KEYS).toEqual(['registry'])
    const { registry, ...sealed } = stored
    expect(registry.tx).toBe(facts.firstReceipt.registryTx)
    expect(hashCanonical(sealed)).toBe(facts.firstReceipt.receiptHash)
    expect(readme).toContain(facts.firstReceipt.receiptHash)
  })
})

describe('the repo surface itself', () => {
  it('is MIT, to DJZS AI, LLC, 2026, and keeps the upstream notice separate', () => {
    expect(license).toContain('MIT License')
    expect(license).toContain('Copyright (c) 2026 DJZS AI, LLC')
    expect(license).toContain('Copyright (c) 2026')
    expect(license).toContain('Jarrod Watts')
    expect(license).toContain('examples/jev-trader-gated/upstream/')
    expect(readme).toContain('MIT. See [LICENSE](LICENSE).')
  })

  it('leaves the upstream MIT licence file in place, untouched', () => {
    const upstream = join(root, 'examples', 'jev-trader-gated', 'upstream', 'LICENSE')
    expect(existsSync(upstream), 'run: git submodule update --init --recursive').toBe(true)
    const text = readFileSync(upstream, 'utf8')
    expect(text).toContain('MIT License')
    expect(text).toContain('Copyright (c) 2026 Jarrod Watts')
  })

  it('gives the clone URL the repository actually has', () => {
    expect(readme).toContain(`git clone --recurse-submodules ${facts.repo}`)
  })

  it('keeps docs/private out of git', () => {
    expect(gitignore).toContain('docs/private/')
  })

  it('names the contact and the build, and uses no em dashes', () => {
    expect(readme).toContain('dj@proofofreason.com')
    expect(readme).toContain('Claude Code')
    expect(readme).toContain('No DJZS v1 code is reused here.')
    expect(readme).not.toContain(EM_DASH)
    expect(license).not.toContain(EM_DASH)
  })
})
