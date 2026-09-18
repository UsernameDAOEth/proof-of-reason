import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderClaimsMd } from '../src/claimsDoc.ts'

describe('docs/CLAIMS.md', () => {
  const onDisk = readFileSync(new URL('../../docs/CLAIMS.md', import.meta.url), 'utf8')

  it('is exactly what the schema generates (run pnpm gen:claims after schema changes)', () => {
    expect(onDisk).toBe(renderClaimsMd())
  })

  it('documents the APR and APY conventions', () => {
    expect(onDisk).toContain('APR = ratePerSecond * 31536000')
    expect(onDisk).toContain('APY = exp(APR) - 1')
  })

  it('contains no em dash', () => {
    expect(onDisk).not.toContain(String.fromCodePoint(0x2014))
  })
})
