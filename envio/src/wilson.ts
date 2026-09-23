/**
 * The Wilson score interval, lower bound. Pure: no entities, no chain, no clock.
 *
 * Why a lower bound and not a pass rate: a pass rate of 1.0 from two verdicts says nothing, and a
 * page that shows it next to a pass rate of 0.95 from four hundred is lying by arithmetic. The Wilson
 * lower bound at 95 percent is the smallest pass rate consistent with what was observed, so it starts
 * low and rises only with evidence. Under MIN_SAMPLES verdicts it is not reported at all: the answer
 * is INSUFFICIENT_HISTORY, never a number.
 *
 * lower = (p + z^2/2n - z * sqrt(p(1-p)/n + z^2/4n^2)) / (1 + z^2/n)
 */

/** 95 percent, two sided. */
export const DEFAULT_Z = 1.96

/** Below this many samples there is no bound, only INSUFFICIENT_HISTORY. */
export const MIN_SAMPLES = 10

export type WilsonResult =
  | { status: 'OK'; lowerBound: number; samples: number; successes: number }
  | { status: 'INSUFFICIENT_HISTORY'; samples: number; successes: number }

function check(successes: number, samples: number, z: number): void {
  for (const [name, value] of [
    ['successes', successes],
    ['samples', samples],
    ['z', z],
  ] as const) {
    if (!Number.isFinite(value)) throw new TypeError(`${name} must be a finite number`)
  }
  if (!Number.isInteger(successes) || !Number.isInteger(samples)) {
    throw new TypeError('successes and samples must be integers')
  }
  if (successes < 0 || samples < 0) throw new RangeError('successes and samples cannot be negative')
  if (successes > samples) throw new RangeError(`successes ${successes} exceeds samples ${samples}`)
  if (z <= 0) throw new RangeError('z must be positive')
}

/**
 * The bound itself, for any sample size. Callers that report to a person should use `wilson`, which
 * refuses to answer under MIN_SAMPLES.
 */
export function wilsonLowerBound(successes: number, samples: number, z: number = DEFAULT_Z): number {
  check(successes, samples, z)
  if (samples === 0) return 0
  const p = successes / samples
  const z2 = z * z
  const denominator = 1 + z2 / samples
  const centre = p + z2 / (2 * samples)
  const margin = z * Math.sqrt((p * (1 - p)) / samples + z2 / (4 * samples * samples))
  const lower = (centre - margin) / denominator
  // Arithmetic, not clamping for its own sake: the formula can return a hair below zero at p = 0.
  return Math.min(1, Math.max(0, lower))
}

/** The bound, or INSUFFICIENT_HISTORY under MIN_SAMPLES samples. */
export function wilson(successes: number, samples: number, z: number = DEFAULT_Z): WilsonResult {
  check(successes, samples, z)
  if (samples < MIN_SAMPLES) return { status: 'INSUFFICIENT_HISTORY', samples, successes }
  return { status: 'OK', lowerBound: wilsonLowerBound(successes, samples, z), samples, successes }
}

/** Four decimal places, the way the page prints it. */
export function formatBound(lowerBound: number): string {
  return lowerBound.toFixed(4)
}
