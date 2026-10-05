import { describe, expect, it } from 'vitest'
import { parseClaimRecord } from '../src/record.ts'
import { claimRecord, hash } from './helpers.ts'

const TX = hash(0xabcdef)

describe('claim record tx_hash', () => {
  it('accepts a tx_hash that appears in source_text, ignoring case', () => {
    const lower = parseClaimRecord(claimRecord({ tx_hash: TX, source_text: `Moved to market B in ${TX}.` }))
    expect(lower.tx_hash).toBe(TX)
    const upper = parseClaimRecord(claimRecord({ tx_hash: TX, source_text: `Moved to market B in 0x${TX.slice(2).toUpperCase()}.` }))
    expect(upper.tx_hash).toBe(TX)
  })

  it('refuses a tx_hash missing from source_text', () => {
    expect(() => parseClaimRecord(claimRecord({ tx_hash: TX, source_text: 'Moved to market B.' }))).toThrow(
      expect.objectContaining({ issues: ['tx_hash: tx_hash does not appear in source_text'] }),
    )
  })

  it('refuses a tx_hash that is not 0x plus 64 hex characters', () => {
    for (const bad of [TX.slice(0, 65), `${TX}0`, `0x${'g'.repeat(64)}`, TX.slice(2)]) {
      expect(() => parseClaimRecord(claimRecord({ tx_hash: bad, source_text: `see ${bad}` }))).toThrow('invalid claim record')
    }
  })

  it('leaves tx_hash optional', () => {
    expect(parseClaimRecord(claimRecord()).tx_hash).toBeUndefined()
  })
})
