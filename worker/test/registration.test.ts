import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  API_ORIGIN,
  CONTACT_EMAIL,
  ENS_NAME,
  IDENTITY_REGISTRY,
  PREREG_SHA256,
  REGISTRATION_TYPE,
  SITE_ORIGIN,
  buildRegistration,
  preregSha256,
} from '../../scripts/gen-registration.ts'

const SCRIPT = fileURLToPath(new URL('../../scripts/gen-registration.ts', import.meta.url))

describe('agent-registration.json', () => {
  it('pins the published pre-registration hash, which docs/PREREG.md still matches', () => {
    expect(PREREG_SHA256).toBe('5f6a494f937dc6fc915ae154fe347728aea5816c08523204bb73dedf02c7c2d4')
    expect(preregSha256()).toBe(PREREG_SHA256)
  })

  it('uses the production hostnames, the one ENS name, and the contact address', () => {
    expect(API_ORIGIN).toBe('https://api.proofofreason.com')
    expect(SITE_ORIGIN).toBe('https://proofofreason.com')
    expect(ENS_NAME).toBe('username.dj-z-s.eth')
    expect(CONTACT_EMAIL).toBe('dj@proofofreason.com')
    const r = buildRegistration({ agentId: 7 })
    expect(r.type).toBe(REGISTRATION_TYPE)
    expect(r.name).toBe('Proof of Reason')
    expect(r.x402Support).toBe(true)
    expect(r.prereg_sha256).toBe(PREREG_SHA256)
    expect(r.services).toEqual([
      {
        name: 'x402',
        endpoint: 'https://api.proofofreason.com/check',
        version: '2',
        method: 'POST',
        scheme: 'exact',
        network: 'eip155:143',
        asset: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
        amount: '100000',
      },
      { name: 'receipts', endpoint: 'https://api.proofofreason.com/receipts/{intentHash}', method: 'GET' },
      { name: 'web', endpoint: 'https://proofofreason.com' },
      { name: 'ENS', endpoint: 'username.dj-z-s.eth', version: '1.0' },
    ])
    expect(r.metadata.contact).toBe('dj@proofofreason.com')
    expect(r.registrations).toEqual([{ agentId: 7, agentRegistry: `eip155:143:${IDENTITY_REGISTRY}` }])
    expect(IDENTITY_REGISTRY).toBe('0x8004A169FB4a3325136EB29fA0ceB6D2e539a432')
  })

  it('references no ENS name other than username.dj-z-s.eth', () => {
    const text = JSON.stringify(buildRegistration({ validator: `0x${'11'.repeat(20)}`, gate: `0x${'22'.repeat(20)}` }))
    expect(text.match(/[a-z0-9-]+(\.[a-z0-9-]+)*\.eth\b/gi)).toEqual(['username.dj-z-s.eth'])
    expect(text).not.toContain('workers.dev')
    expect(text).not.toContain(String.fromCodePoint(0x2014))
  })

  it('omits registrations until an agent id exists, and refuses malformed input', () => {
    expect('registrations' in buildRegistration()).toBe(false)
    expect(() => buildRegistration({ validator: '0x123' })).toThrow(/validator/)
    expect(() => buildRegistration({ agentId: -1 })).toThrow(/agent-id/)
  })

  it('the CLI writes the JSON and a data URI that decodes back to it; --url is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'registration-'))
    const out = join(dir, 'agent-registration.json')
    execFileSync(process.execPath, [SCRIPT, '--out', out], { stdio: 'pipe' })
    const written = JSON.parse(readFileSync(out, 'utf8'))
    expect(written.prereg_sha256).toBe(PREREG_SHA256)
    expect(written.services[0].endpoint).toBe('https://api.proofofreason.com/check')
    const uri = readFileSync(`${out}.datauri.txt`, 'utf8').trim()
    const decoded = JSON.parse(Buffer.from(uri.split(',', 2)[1]!, 'base64').toString('utf8'))
    expect(decoded).toEqual(written)
    expect(() =>
      execFileSync(process.execPath, [SCRIPT, '--url', 'https://elsewhere.test', '--out', out], { stdio: 'pipe' }),
    ).toThrow()
  })
})
