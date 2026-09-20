import { mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { safeError } from './run.ts'
import { createZerionClient } from './zerion.ts'

/**
 * Writes the live Zerion chain catalog to shadow/evidence/zerion-chains.json and says whether
 * Monad (chain id 143) is supported. The file holds Zerion's response only; the key never
 * appears in it. docs/MONAD.md section 9 records the answer from this file.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ;(async () => {
    const chains = await createZerionClient().listChains()
    const monad = chains.find((c) => c.chainId === 143) ?? null
    mkdirSync('evidence', { recursive: true })
    const evidence = { fetched_at: new Date().toISOString(), monad_supported: monad !== null, monad_entry: monad, chains }
    writeFileSync('evidence/zerion-chains.json', `${JSON.stringify(evidence, null, 2)}\n`)
    console.log(`Monad (143) in the Zerion chain catalog: ${monad !== null ? `yes, id "${monad.id}"` : 'no'}`)
    console.log(`${chains.length} chains written to evidence/zerion-chains.json`)
  })().catch((error: unknown) => {
    console.error(safeError(error))
    process.exitCode = 1
  })
}
