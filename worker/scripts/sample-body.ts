// Prints a well-formed POST /check body for the deployed demo vault, for the 402 smoke test in
// docs/DEPLOY_RUNBOOK.md. The claim values are illustrative; a paid call would evaluate them.
// Usage: node scripts/sample-body.ts <vault address> <notAfterBlock>
import { encodeFunctionData, isAddress, maxUint256, parseAbi } from 'viem'

const [vault, notAfterBlock] = process.argv.slice(2)
if (vault === undefined || !isAddress(vault) || notAfterBlock === undefined || !/^[0-9]+$/.test(notAfterBlock)) {
  console.error('usage: node scripts/sample-body.ts <vault address> <notAfterBlock>')
  process.exit(1)
}

// docs/MONAD.md section 3.
const USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603'
const IRM = '0x09475a3D6eA8c314c592b1a3799bDE044E2F400F'
const A = {
  id: '0x9e8441e7af65860feac831ebc117473e3033321abf528ebc8fbde1eeaaa3a626',
  params: { loanToken: USDC, collateralToken: '0x7Cd231120a60F500887444a9bAF5e1BD753A5e59', oracle: '0x4af4f38164cD7F28653A66aa2255B249a23cFBec', irm: IRM, lltv: 770000000000000000n },
} as const
const B = {
  id: '0x093bd94086b08a013c96dc0776ebf663e9300e742a2c14479211cc35da6c3439',
  params: { loanToken: USDC, collateralToken: '0xa08A69aB9Dd3B04D0992BC7aFb2c0b907bbdc147', oracle: '0x597921a5b5aD74A0Bf573fD7B58F80c383DCdAB2', irm: IRM, lltv: 915000000000000000n },
} as const

const abi = parseAbi([
  'struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }',
  'struct MarketAllocation { MarketParams marketParams; uint256 assets; }',
  'function reallocate(MarketAllocation[] allocations)',
])
const data = encodeFunctionData({
  abi,
  functionName: 'reallocate',
  args: [[{ marketParams: A.params, assets: 6_000_000n }, { marketParams: B.params, assets: maxUint256 }]],
})

console.log(
  JSON.stringify({
    intent: { vault, data, nonce: '1', notAfterBlock },
    action: {
      fn: 'reallocate',
      allocations: [
        { market: A.id, assets: '6000000' },
        { market: B.id, assets: maxUint256.toString() },
      ],
    },
    claims: [
      { id: 'r1', kind: 'rate', sourceSpan: null, market: B.id, side: 'supply', valuePct: 5, basis: 'APY', compounding: 'continuous', window: { type: 'instant' }, tolerancePp: 0.5 },
      { id: 'l1', kind: 'liquidity', sourceSpan: null, market: A.id, minWithdrawable: '4000000' },
    ],
    mandateId: 'demo-usdc-v1',
  }),
)
