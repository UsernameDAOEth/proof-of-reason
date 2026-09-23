import { describe, expect, it } from 'vitest'
import { DEFAULT_Z, MIN_SAMPLES, formatBound, wilson, wilsonLowerBound } from '../src/wilson.ts'

describe('the Wilson lower bound', () => {
  it('gives 0.4902 for 8 of 10 at z 1.96', () => {
    // (0.8 + 1.96^2/20 - 1.96 * sqrt(0.16/10 + 1.96^2/400)) / (1 + 1.96^2/10)
    expect(wilsonLowerBound(8, 10, 1.96)).toBeCloseTo(0.4902, 4)
    expect(formatBound(wilsonLowerBound(8, 10))).toBe('0.4902')
    expect(DEFAULT_Z).toBe(1.96)
  })

  it('is not the pass rate: a perfect record still starts below 1', () => {
    expect(wilsonLowerBound(10, 10)).toBeCloseTo(0.7225, 4)
    expect(wilsonLowerBound(100, 100)).toBeCloseTo(0.9630, 4)
    expect(wilsonLowerBound(1000, 1000)).toBeCloseTo(0.9962, 4)
  })

  it('rises with evidence at the same pass rate', () => {
    const bounds = [10, 50, 200, 1000].map((n) => wilsonLowerBound(n * 0.8, n))
    for (let i = 1; i < bounds.length; i++) expect(bounds[i]!).toBeGreaterThan(bounds[i - 1]!)
    for (const bound of bounds) expect(bound).toBeLessThan(0.8)
  })

  it('bottoms out at zero and never goes negative', () => {
    expect(wilsonLowerBound(0, 10)).toBe(0)
    expect(wilsonLowerBound(0, 1000)).toBe(0)
    expect(wilsonLowerBound(0, 0)).toBe(0)
  })

  it('widens the interval for a higher z', () => {
    expect(wilsonLowerBound(8, 10, 2.576)).toBeLessThan(wilsonLowerBound(8, 10, 1.96))
    expect(wilsonLowerBound(8, 10, 1.0)).toBeGreaterThan(wilsonLowerBound(8, 10, 1.96))
  })

  it('refuses impossible or nonsense input rather than returning a number', () => {
    expect(() => wilsonLowerBound(11, 10)).toThrow(/exceeds samples/)
    expect(() => wilsonLowerBound(-1, 10)).toThrow(/negative/)
    expect(() => wilsonLowerBound(1, -10)).toThrow(/negative/)
    expect(() => wilsonLowerBound(1.5, 10)).toThrow(/integers/)
    expect(() => wilsonLowerBound(1, 10, 0)).toThrow(/z must be positive/)
    expect(() => wilsonLowerBound(Number.NaN, 10)).toThrow(/finite/)
    expect(() => wilsonLowerBound(1, Number.POSITIVE_INFINITY)).toThrow(/finite/)
  })
})

describe('under ten samples there is no number', () => {
  it('answers INSUFFICIENT_HISTORY below MIN_SAMPLES, and a bound at it', () => {
    expect(MIN_SAMPLES).toBe(10)
    for (let n = 0; n < MIN_SAMPLES; n++) {
      const result = wilson(n, n)
      expect(result.status).toBe('INSUFFICIENT_HISTORY')
      expect(result).not.toHaveProperty('lowerBound')
      expect(result.samples).toBe(n)
    }
    const ten = wilson(8, 10)
    expect(ten.status).toBe('OK')
    expect(ten.status === 'OK' && ten.lowerBound).toBeCloseTo(0.4902, 4)
  })

  it('carries the counts either way, so a page can say how little it knows', () => {
    expect(wilson(9, 9)).toEqual({ status: 'INSUFFICIENT_HISTORY', samples: 9, successes: 9 })
    expect(wilson(0, 0)).toEqual({ status: 'INSUFFICIENT_HISTORY', samples: 0, successes: 0 })
  })
})
