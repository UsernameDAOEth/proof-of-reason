// Writes agent-registration.json for the ERC-8004 Identity Registry on Monad.
// Usage: node scripts/gen-registration.ts [--validator 0x..] [--gate 0x..] [--agent-id N]
//        [--out agent-registration.json]
// The endpoint, site, ENS name, and contact are fixed production values (docs/MONAD.md section 7).
// Format: type "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", as written by
// agent0-sdk 1.7.1 dist/utils/registration-json.js (docs/MONAD.md section 5).
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'
export const CHAIN_ID = 143
/** sha256 of docs/PREREG.md v1.0 as committed in 073cceb and published. */
export const PREREG_SHA256 = '5f6a494f937dc6fc915ae154fe347728aea5816c08523204bb73dedf02c7c2d4'
/**
 * Byte length of docs/PREREG.md v1.0. The file is append-only: amendments are appended after
 * these bytes and never edit them, so the published hash is always the hash of this prefix.
 */
export const PREREG_V1_BYTES = 2770
/** Every amendment opens after a blank line with this heading. */
export const AMENDMENT_HEADING = '\n## Amendment '
export const REGISTRATION_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1'
export const API_ORIGIN = 'https://api.proofofreason.com'
export const SITE_ORIGIN = 'https://proofofreason.com'
/** The only ENS name any Proof of Reason registration may reference. */
export const ENS_NAME = 'username.dj-z-s.eth'
export const CONTACT_EMAIL = 'dj@proofofreason.com'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const ENS_LIKE = /[a-z0-9-]+(\.[a-z0-9-]+)*\.eth\b/gi

export type RegistrationOptions = {
  validator?: string
  gate?: string
  agentId?: number
}

const PREREG_PATH = fileURLToPath(new URL('../docs/PREREG.md', import.meta.url))

/** sha256 of the v1.0 text, which is the first PREREG_V1_BYTES bytes of docs/PREREG.md. */
export function preregSha256(path = PREREG_PATH): string {
  return createHash('sha256').update(readFileSync(path).subarray(0, PREREG_V1_BYTES)).digest('hex')
}

/** The amendments appended after v1.0. Refuses a shorter file or anything else after v1.0. */
export function preregAmendments(path = PREREG_PATH): string {
  const bytes = readFileSync(path)
  if (bytes.length < PREREG_V1_BYTES) {
    throw new Error(`docs/PREREG.md is shorter than its published v1.0 (${PREREG_V1_BYTES} bytes)`)
  }
  const tail = bytes.subarray(PREREG_V1_BYTES).toString('utf8')
  if (tail !== '' && !tail.startsWith(AMENDMENT_HEADING)) {
    throw new Error('docs/PREREG.md: text after v1.0 must be amendments, each opening with "## Amendment" after a blank line')
  }
  return tail
}

export function buildRegistration(options: RegistrationOptions = {}) {
  for (const [flag, value] of [['--validator', options.validator], ['--gate', options.gate]] as const) {
    if (value !== undefined && !ADDRESS.test(value)) throw new Error(`${flag} must be a 20-byte hex address`)
  }
  if (options.agentId !== undefined && (!Number.isSafeInteger(options.agentId) || options.agentId < 0)) {
    throw new Error('--agent-id must be a non-negative integer')
  }

  const registration = {
    type: REGISTRATION_TYPE,
    name: 'Proof of Reason',
    description:
      'A premise check on automated allocation, issued by DJZS AI, LLC. Before a vault moves money, Proof of Reason checks the reason its allocator gives: premises against chain state, the action against the principal\'s mandate, required fields present. It returns a signed verdict that an on-chain gate enforces. The gate holds the veto, never the keys.',
    services: [
      {
        name: 'x402',
        endpoint: `${API_ORIGIN}/check`,
        version: '2',
        method: 'POST',
        scheme: 'exact',
        network: `eip155:${CHAIN_ID}`,
        asset: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
        amount: '100000',
      },
      { name: 'receipts', endpoint: `${API_ORIGIN}/receipts/{intentHash}`, method: 'GET' },
      { name: 'web', endpoint: SITE_ORIGIN },
      // agent0-sdk 1.7.1 writes ENS entries as { name: "ENS", endpoint, version: "1.0" }.
      { name: 'ENS', endpoint: ENS_NAME, version: '1.0' },
    ],
    ...(options.agentId !== undefined && {
      registrations: [{ agentId: options.agentId, agentRegistry: `eip155:${CHAIN_ID}:${IDENTITY_REGISTRY}` }],
    }),
    active: true,
    x402Support: true,
    prereg_sha256: PREREG_SHA256,
    metadata: {
      chainId: CHAIN_ID,
      ruleset: 'REASON-R0',
      contact: CONTACT_EMAIL,
      ...(options.validator !== undefined && { validator: options.validator }),
      ...(options.gate !== undefined && { gate: options.gate }),
    },
  }

  const ensNames = new Set((JSON.stringify(registration).match(ENS_LIKE) ?? []).map((n) => n.toLowerCase()))
  if (ensNames.size !== 1 || !ensNames.has(ENS_NAME)) {
    throw new Error(`registration may reference only ${ENS_NAME}; found ${[...ensNames].join(', ')}`)
  }
  return registration
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

function main(args: string[]) {
  const actual = preregSha256()
  if (actual !== PREREG_SHA256) {
    throw new Error(
      `the first ${PREREG_V1_BYTES} bytes of docs/PREREG.md hash to ${actual}, not the published ${PREREG_SHA256}; refusing to write`,
    )
  }
  preregAmendments()
  if (args.includes('--url')) throw new Error(`--url was removed; the endpoint is always ${API_ORIGIN}`)
  const agentId = argValue(args, '--agent-id')
  const registration = buildRegistration({
    validator: argValue(args, '--validator'),
    gate: argValue(args, '--gate'),
    agentId: agentId === undefined ? undefined : Number(agentId),
  })
  const out = argValue(args, '--out') ?? 'agent-registration.json'
  const json = `${JSON.stringify(registration, null, 2)}\n`
  writeFileSync(out, json)
  const dataUri = `data:application/json;base64,${Buffer.from(JSON.stringify(registration)).toString('base64')}`
  writeFileSync(`${out}.datauri.txt`, `${dataUri}\n`)
  console.log(`wrote ${out} and ${out}.datauri.txt (${dataUri.length} characters); prereg_sha256 verified`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
