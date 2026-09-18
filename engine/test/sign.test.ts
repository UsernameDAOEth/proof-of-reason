import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  encodeAbiParameters,
  encodeFunctionData,
  hexToBigInt,
  keccak256,
  parseAbiParameters,
  recoverTypedDataAddress,
  stringToBytes,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { vaultAbi } from '../src/action.ts'
import {
  DOMAIN_NAME,
  DOMAIN_VERSION,
  gateDomain,
  hashIntent,
  overrideDigest,
  signVerdict,
  verdictDigest,
  verdictTypes,
} from '../src/sign.ts'
import type { VerdictMessage } from '../src/sign.ts'
import { FIXTURE_PARAMS } from './fixtures.ts'

// Test-only key, the same value as validatorKey in ReasonGate.t.sol. Never a real key.
const TEST_VALIDATOR_KEY = `0x${(0xb0bn).toString(16).padStart(64, '0')}` as const
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n

// Golden vector shared with test_goldenVector_matchesEngine in contracts/test/ReasonGate.t.sol.
const VECTOR = {
  chainId: 31337,
  gate: '0x1111111111111111111111111111111111111111',
  vault: '0x2222222222222222222222222222222222222222',
  adapter: '0x3333333333333333333333333333333333333333',
  dataHash: '0x6bfe543c311e01a4e0ae47c86eb1296148673e5cffc81fcc561470328455401d',
  intentHash: '0xa94cccb12b3b6bdaaf945734156b0352809f8ddd1ff1de7da1f8acdedd64c2c3',
  verdictDigest: '0xbb4a5f0697e6e548c5896ca6e54b7565941de63815acd07df3cb5c30f8247892',
  overrideDigest: '0x53abfd98cc0d267e4310d13a977706dcd5568911ccc3f990888688b66eb813c4',
  signature:
    '0x520ff09bea6d20ee2f2d80b5c5e7275f1ac228ff72b0a427715b75f6e22eab113f6e5656c2d6e5e6809d62dc61edccf6bf2010ac6c93cc5e926f9cc557da51251c',
} as const

function vectorData() {
  return encodeFunctionData({
    abi: vaultAbi,
    functionName: 'allocate',
    args: [
      VECTOR.adapter,
      encodeAbiParameters(parseAbiParameters('(address,address,address,address,uint256)'), [
        [
          FIXTURE_PARAMS.loanToken,
          FIXTURE_PARAMS.collateralToken,
          FIXTURE_PARAMS.oracle,
          FIXTURE_PARAMS.irm,
          FIXTURE_PARAMS.lltv,
        ],
      ]),
      1_000_000_000n,
    ],
  })
}

function vectorVerdict(intentHash: `0x${string}`): VerdictMessage {
  return { intentHash, outcome: 1, checkedAtBlock: 999n, receiptHash: keccak256(stringToBytes('receipt')) }
}

describe('EIP-712 domain and golden vector', () => {
  const domain = gateDomain(VECTOR.chainId, VECTOR.gate)

  it('uses the Proof of Reason domain', () => {
    expect(DOMAIN_NAME).toBe('Proof of Reason')
    expect(DOMAIN_VERSION).toBe('1')
    expect(domain).toEqual({
      name: 'Proof of Reason',
      version: '1',
      chainId: 31337,
      verifyingContract: VECTOR.gate,
    })
  })

  it('reproduces the Solidity intentHash, verdict digest, override digest, and signature', async () => {
    const data = vectorData()
    expect(keccak256(data)).toBe(VECTOR.dataHash)
    const intentHash = hashIntent(domain, {
      vault: VECTOR.vault,
      dataHash: keccak256(data),
      claimsHash: keccak256(stringToBytes('claims')),
      nonce: 7n,
      notAfterBlock: 1_010n,
    })
    expect(intentHash).toBe(VECTOR.intentHash)
    expect(verdictDigest(domain, vectorVerdict(intentHash))).toBe(VECTOR.verdictDigest)
    expect(overrideDigest(domain, intentHash)).toBe(VECTOR.overrideDigest)

    const account = privateKeyToAccount(TEST_VALIDATOR_KEY)
    expect(await signVerdict(account, domain, vectorVerdict(intentHash))).toBe(VECTOR.signature)
  })
})

describe('signVerdict', () => {
  const account = privateKeyToAccount(TEST_VALIDATOR_KEY)
  const domain = gateDomain(VECTOR.chainId, VECTOR.gate)
  const verdict = vectorVerdict(VECTOR.intentHash)

  it('recovers to the signing account', async () => {
    const signature = await signVerdict(account, domain, verdict)
    const recovered = await recoverTypedDataAddress({
      domain,
      types: verdictTypes,
      primaryType: 'Verdict',
      message: verdict,
      signature,
    })
    expect(recovered).toBe(account.address)
  })

  it('produces a low-s signature', async () => {
    const signature = await signVerdict(account, domain, verdict)
    const s = hexToBigInt(`0x${signature.slice(66, 130)}`)
    expect(s <= SECP256K1_HALF_N).toBe(true)
  })

  it('binds the chain id and the gate', () => {
    const base = verdictDigest(domain, verdict)
    expect(verdictDigest(gateDomain(1, VECTOR.gate), verdict)).not.toBe(base)
    expect(verdictDigest(gateDomain(VECTOR.chainId, VECTOR.vault), verdict)).not.toBe(base)
  })

  it('never reads keys from disk or env', () => {
    const source = readFileSync(new URL('../src/sign.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/process\.env|node:fs|readFile|privateKeyToAccount|mnemonicToAccount/)
  })
})
