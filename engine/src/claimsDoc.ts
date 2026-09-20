import { z } from 'zod'
import { AUDIT_CONVENTIONS, ActionV0, CONVENTIONS, ClaimV0, MandateV0 } from './claims.ts'
import { BalanceClaim } from './erc20.ts'
import { VaultRateClaim } from './erc4626.ts'
import { ENGINE_VERSION, RULESET } from './receipt.ts'

type JsonSchema = {
  type?: string | string[]
  const?: unknown
  enum?: unknown[]
  pattern?: string
  minimum?: number
  maximum?: number
  minItems?: number
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  oneOf?: JsonSchema[]
  anyOf?: JsonSchema[]
}

const SAFE_MAX = Number.MAX_SAFE_INTEGER

function typeLabel(schema: JsonSchema): string {
  if (schema.const !== undefined) return `\`${JSON.stringify(schema.const)}\``
  if (schema.enum) return schema.enum.map((v) => `\`${JSON.stringify(v)}\``).join(' or ')
  const variants = schema.oneOf ?? schema.anyOf
  if (variants) return variants.map(typeLabel).join(' or ')
  const type = Array.isArray(schema.type) ? schema.type.join(' or ') : schema.type
  if (type === 'object' && schema.properties) {
    const fields = Object.entries(schema.properties).map(([k, v]) => `${k}: ${typeLabel(v)}`)
    return `{ ${fields.join(', ')} }`
  }
  if (type === 'array' && schema.items) {
    const min = schema.minItems ? `, at least ${schema.minItems}` : ''
    return `array of ${typeLabel(schema.items)}${min}`
  }
  const bounds: string[] = []
  if (schema.minimum !== undefined) bounds.push(`>= ${schema.minimum}`)
  if (schema.maximum !== undefined && schema.maximum < SAFE_MAX) bounds.push(`<= ${schema.maximum}`)
  const pattern = schema.pattern ? ` matching \`${schema.pattern}\`` : ''
  return `${type ?? 'any'}${bounds.length ? ` ${bounds.join(', ')}` : ''}${pattern}`
}

function fieldTable(schema: JsonSchema): string {
  const required = new Set(schema.required ?? [])
  const rows = Object.entries(schema.properties ?? {}).map(([name, field]) => {
    const req = required.has(name) ? 'yes' : 'no'
    const text = (field.description ?? '').replace(/\|/g, '\\|')
    return `| ${name} | ${typeLabel(field).replace(/\|/g, '\\|')} | ${req} | ${text} |`
  })
  return ['| Field | Type | Required | Meaning |', '| --- | --- | --- | --- |', ...rows].join('\n')
}

function variantsOf(schema: z.ZodType): JsonSchema[] {
  const json = z.toJSONSchema(schema) as JsonSchema
  return json.oneOf ?? json.anyOf ?? [json]
}

function discriminant(variant: JsonSchema, key: string): string {
  return String(variant.properties?.[key]?.const)
}

/** Render docs/CLAIMS.md from the zod schemas and declared conventions. */
export function renderClaimsMd(): string {
  const lines: string[] = [
    '# Proof of Reason claim schema',
    '',
    `Generated from engine/src/claims.ts by \`pnpm gen:claims\`. Do not edit by hand. Ruleset ${RULESET}, engine ${ENGINE_VERSION}.`,
    '',
    '## ClaimV0',
    '',
    'Every claim carries id, kind, and sourceSpan. Unknown fields are rejected. Claim ids are unique within a claim set.',
    '',
  ]
  for (const variant of variantsOf(ClaimV0)) {
    lines.push(`### kind ${discriminant(variant, 'kind')}`, '', fieldTable(variant), '')
  }
  lines.push(
    '## ActionV0',
    '',
    'The allocation the agent says it is making. The engine decodes the vault calldata and compares it field by field.',
    '',
  )
  for (const variant of variantsOf(ActionV0)) {
    lines.push(`### fn ${discriminant(variant, 'fn')}`, '', fieldTable(variant), '')
  }
  lines.push('## MandateV0', '', 'Set by the principal.', '', fieldTable(variantsOf(MandateV0)[0]!), '')
  lines.push('## Conventions', '')
  CONVENTIONS.forEach((text, i) => lines.push(`${i + 1}. ${text}`))
  lines.push('')
  lines.push(
    '## Audit-only claim kinds (shadow runner)',
    '',
    'Used by the shadow runner for read-only audits (docs/SHADOW.md). The validator worker, mandates, and ReasonGate accept ClaimV0 kinds only.',
    '',
  )
  for (const [label, schema] of [
    ['vault_rate', VaultRateClaim],
    ['balance', BalanceClaim],
  ] as const) {
    lines.push(`### kind ${label}`, '', fieldTable(variantsOf(schema)[0]!), '')
  }
  lines.push('### Audit conventions', '')
  AUDIT_CONVENTIONS.forEach((text, i) => lines.push(`${i + 1}. ${text}`))
  lines.push('')
  return lines.join('\n')
}
