import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { DEFAULT_RPC_ROLE, DataSourceError, describeDataSource, resolveDataSource } from '../src/datasource.ts'

const RPC = 'https://monad.example.quiknode.pro/0123456789abcdef/'
const configText = readFileSync(new URL('../config.yaml', import.meta.url), 'utf8')

describe('the data source is chosen by environment', () => {
  it('runs on HyperSync when no RPC URL is given', () => {
    expect(resolveDataSource({})).toEqual({ kind: 'hypersync' })
    expect(resolveDataSource({ ENVIO_RPC_URL: '' })).toEqual({ kind: 'hypersync' })
    expect(resolveDataSource({ ENVIO_RPC_URL: '   ' })).toEqual({ kind: 'hypersync' })
    expect(describeDataSource(resolveDataSource({}))).toBe('HyperSync')
  })

  it('uses the RPC as a fallback when a URL is given and no role is', () => {
    expect(resolveDataSource({ ENVIO_RPC_URL: RPC })).toEqual({ kind: 'rpc', url: RPC, role: 'fallback' })
    expect(DEFAULT_RPC_ROLE).toBe('fallback')
    expect(describeDataSource(resolveDataSource({ ENVIO_RPC_URL: RPC }))).toBe(
      'HyperSync, with ENVIO_RPC_URL as fallback',
    )
  })

  it('uses the RPC as the only source when the role is sync', () => {
    expect(resolveDataSource({ ENVIO_RPC_URL: RPC, ENVIO_RPC_FOR: 'sync' })).toEqual({
      kind: 'rpc',
      url: RPC,
      role: 'sync',
    })
    expect(describeDataSource(resolveDataSource({ ENVIO_RPC_URL: RPC, ENVIO_RPC_FOR: 'sync' }))).toBe(
      'RPC only (ENVIO_RPC_URL)',
    )
  })

  it('accepts fallback spelled out, and trims what it is given', () => {
    expect(resolveDataSource({ ENVIO_RPC_URL: ` ${RPC} `, ENVIO_RPC_FOR: ' sync ' })).toEqual({
      kind: 'rpc',
      url: RPC,
      role: 'sync',
    })
    expect(resolveDataSource({ ENVIO_RPC_URL: RPC, ENVIO_RPC_FOR: 'fallback' }).kind).toBe('rpc')
    expect(resolveDataSource({ ENVIO_RPC_URL: RPC, ENVIO_RPC_FOR: '' })).toEqual({
      kind: 'rpc',
      url: RPC,
      role: 'fallback',
    })
  })

  it('refuses an invalid role rather than guessing one', () => {
    for (const role of ['realtime', 'SYNC', 'primary', 'true', '1']) {
      expect(() => resolveDataSource({ ENVIO_RPC_URL: RPC, ENVIO_RPC_FOR: role })).toThrow(DataSourceError)
      expect(() => resolveDataSource({ ENVIO_RPC_URL: RPC, ENVIO_RPC_FOR: role })).toThrow(
        /ENVIO_RPC_FOR must be one of sync, fallback/,
      )
    }
  })

  it('refuses sync with nothing to sync from, and refuses a URL that is not one', () => {
    expect(() => resolveDataSource({ ENVIO_RPC_FOR: 'sync' })).toThrow(/needs ENVIO_RPC_URL/)
    expect(() => resolveDataSource({ ENVIO_RPC_URL: 'rpc.monad.xyz' })).toThrow(/must be an http/)
    expect(() => resolveDataSource({ ENVIO_RPC_URL: 'file:///etc/passwd' })).toThrow(/must be an http/)
    expect(resolveDataSource({ ENVIO_RPC_URL: 'wss://monad.example/ws' }).kind).toBe('rpc')
  })

  it('never puts the URL in an error, because it carries an access token', () => {
    let message = ''
    try {
      resolveDataSource({ ENVIO_RPC_URL: RPC, ENVIO_RPC_FOR: 'nonsense' })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).not.toContain('quiknode')
    expect(message).not.toContain('0123456789abcdef')
  })
})

describe('config.yaml carries the same rule', () => {
  it('reads the two variables the resolver reads, with fallback as the default', () => {
    expect(configText).toContain('url: ${ENVIO_RPC_URL}')
    expect(configText).toContain('for: ${ENVIO_RPC_FOR:-fallback}')
  })

  it('indexes the three contracts on Monad, each address quoted', () => {
    const config = parse(configText) as {
      name: string
      contracts: { name: string; handler: string; abi_file_path: string; events: { event: string }[] }[]
      networks: { id: number; start_block: number; contracts: { name: string; address: string }[] }[]
    }
    expect(config.name).toBe('proof-of-reason')
    expect(config.contracts.map((c) => c.name)).toEqual(['ValidationRegistry', 'ReasonGate', 'KuruGate'])
    for (const contract of config.contracts) {
      expect(contract.handler).toBe('src/EventHandlers.ts')
      expect(contract.abi_file_path).toBe(`./abis/${contract.name}.json`)
      expect(contract.events.length).toBeGreaterThan(0)
    }
    const network = config.networks[0]!
    expect(network.id).toBe(143)
    expect(network.contracts.map((c) => c.name)).toEqual(['ValidationRegistry', 'ReasonGate', 'KuruGate'])
    // Quoted, so YAML reads each address as a string rather than as a hex integer, which envio
    // rejects. The values themselves change as the deployment lands, so this pins the shape, not
    // one deployment's addresses.
    for (const contract of network.contracts) {
      expect(typeof contract.address, contract.name).toBe('string')
      expect(contract.address, contract.name).toMatch(/^0x[0-9a-fA-F]{40}$/)
    }
  })

  it('lists the events the handlers actually register', () => {
    const config = parse(configText) as { contracts: { name: string; events: { event: string }[] }[] }
    const events = Object.fromEntries(
      config.contracts.map((c) => [c.name, c.events.map((e) => e.event.split('(')[0])]),
    )
    expect(events.ValidationRegistry).toEqual(['ValidationRequest', 'ValidationResponse'])
    expect(events.ReasonGate).toEqual(['Executed', 'ValidatorSet', 'AgentSet'])
    expect(events.KuruGate).toEqual(['Executed', 'ValidatorSet', 'AgentSet'])
  })
})
