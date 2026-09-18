import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderClaimsMd } from '../src/claimsDoc.ts'

const target = fileURLToPath(new URL('../../docs/CLAIMS.md', import.meta.url))
writeFileSync(target, renderClaimsMd())
console.log(`wrote ${target}`)
