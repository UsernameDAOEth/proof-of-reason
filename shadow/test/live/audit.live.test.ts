import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHAINS } from 'proof-of-reason-engine/chains'
import { viemReaders } from '../../src/chain.ts'
import { locate } from '../../src/locate.ts'
import { auditRecord, recordJson, verifySeal } from '../../src/run.ts'
import { createZerionClient } from '../../src/zerion.ts'

// Opt-in: runs with LIVE=1 and skips unless ZERION_API_KEY and MONAD_RPC_URL are set. MONAD_RPC_URL
// must hold state at block 106277363: Monad has no separate archive tier, rpc.monad.xyz kept about
// 5.6 days of state on 2026-09-30, and https://rpc-mainnet.monadinfra.com served that block then.
// It audits one real public wallet on Monad. The wallet and transaction were found on chain on
// 2026-09-19 through rpc.monad.xyz: the EOA sent tx 0xe06d...e3c3 at block 106277363 (block time
// 1789851181) to 0xdb9B...7dB3, selector 0xcef6d209, which supplied to Morpho market 0x71ca...dec7.
// The claims below are written by this test, not by the wallet, so the output goes to a temp
// directory and never into shadow/records or the A1 count.
const enabled = Boolean(process.env.ZERION_API_KEY) && Boolean(process.env.MONAD_RPC_URL)

const TX = '0xe06d5044d053cd90bf5352c345e498dbc185d87767eb20163194b8f02265e3c3'
const MARKET = '0x71cad28b047d94c5a57c947619f9790b06b121536f975e03fdf241e9316edec7'

const record = {
  id: 'live-smoke-monad',
  agent: { name: 'public wallet (live smoke test)', wallet: '0xB42F812A44c22cc6b861478900401ee759EbEAD6' },
  chain: 'monad',
  source_url: `https://monadscan.com/tx/${TX}`,
  source_text: 'Live pipeline smoke test. The claims are test-authored, not the wallet\'s own words.',
  posted_at: '2026-09-19T20:52:01Z',
  claims: [
    {
      id: 'i1',
      kind: 'identity',
      sourceSpan: null,
      market: MARKET,
      loanToken: '0xacA92E438df0B2401fF60dA7E4337B687a2435DA',
      collateralToken: '0x9FC74f8Ed616B5BaF52a170caa97d6d3898602d1',
      oracle: '0x436CA3263B1AAA57d286823a42E35d8c228e85a2',
      irm: '0x09475a3D6eA8c314c592b1a3799bDE044E2F400F',
      lltv: '915000000000000000',
    },
    { id: 'l1', kind: 'liquidity', sourceSpan: null, market: MARKET, minWithdrawable: '1' },
  ],
  target: { contract: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3', method: '0xcef6d209' },
}

describe.skipIf(!enabled)('live shadow audit of one public Monad wallet', () => {
  it('reports Monad support in the Zerion catalog, then locates, observes, and seals', async () => {
    const zerion = createZerionClient()
    const monad = (await zerion.listChains()).find((c) => c.chainId === 143)
    console.log(`[live] Monad (143) in the Zerion chain catalog: ${monad ? `yes, id "${monad.id}"` : 'no'}`)

    const readers = viemReaders(CHAINS.monad)
    const result = await auditRecord(record, {
      readers,
      chainId: 143,
      locateFn: (r) => locate(r, { zerion, tx: readers.tx, chainId: 143 }),
    })
    const dir = mkdtempSync(join(tmpdir(), 'shadow-live-'))
    writeFileSync(join(dir, `${result.record.id}.json`), recordJson(result))
    console.log(`[live] status ${result.status}, located ${JSON.stringify(result.located, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`)
    expect(verifySeal(JSON.parse(recordJson(result)))).toBe(true)

    if (monad === undefined) {
      expect(result.status).toBe('UNLOCATED')
      return
    }
    expect(result.located).toMatchObject({ status: 'LOCATED', txHash: TX, blockNumber: 106277363n })
    expect(result.results.map((r) => [r.id, r.status])).toEqual([
      ['i1', 'TRUE'],
      ['l1', 'TRUE'],
    ])
  })
})
