/**
 * Which data source the indexer runs on, decided by environment, in code so it can be tested.
 * config.yaml carries the same rule as `${ENVIO_RPC_URL}` and `${ENVIO_RPC_FOR:-fallback}`, and
 * test/datasource.test.ts pins both strings so the two cannot drift apart.
 *
 *   ENVIO_RPC_URL unset        HyperSync. The default, and what a fresh clone does.
 *   ENVIO_RPC_URL set          that RPC behind HyperSync, used when HyperSync cannot serve a block.
 *   ENVIO_RPC_FOR=sync         that RPC as the only source. Slower, and it needs an archive node.
 *
 * Monad's Foundation RPC forbids JSON-RPC batch, so an RPC used for sync must be an archive endpoint
 * that allows the request rate the indexer needs (docs/MONAD.md section 8).
 */
export type RpcRole = 'sync' | 'fallback'

export type DataSource =
  | { kind: 'rpc'; url: string; role: RpcRole }
  | { kind: 'hypersync' }

export const RPC_ROLES: readonly RpcRole[] = ['sync', 'fallback']

/** The default when a URL is given without a role: help, not replace, HyperSync. */
export const DEFAULT_RPC_ROLE: RpcRole = 'fallback'

export class DataSourceError extends Error {
  constructor(message: string) {
    // Names the variable, never its value: an RPC URL can carry an access token.
    super(message)
    this.name = 'DataSourceError'
  }
}

function isRole(value: string): value is RpcRole {
  return (RPC_ROLES as readonly string[]).includes(value)
}

export function resolveDataSource(env: Record<string, string | undefined> = process.env): DataSource {
  const url = env.ENVIO_RPC_URL?.trim()
  const role = env.ENVIO_RPC_FOR?.trim()

  let requested: RpcRole | undefined
  if (role !== undefined && role.length > 0) {
    if (!isRole(role)) throw new DataSourceError(`ENVIO_RPC_FOR must be one of ${RPC_ROLES.join(', ')}`)
    requested = role
  }
  if (url === undefined || url.length === 0) {
    if (requested === 'sync') {
      throw new DataSourceError('ENVIO_RPC_FOR=sync needs ENVIO_RPC_URL: there is nothing to sync from')
    }
    return { kind: 'hypersync' }
  }
  if (!/^https?:\/\//.test(url) && !/^wss?:\/\//.test(url)) {
    throw new DataSourceError('ENVIO_RPC_URL must be an http, https, ws or wss URL')
  }
  return { kind: 'rpc', url, role: requested ?? DEFAULT_RPC_ROLE }
}

/** One line for a log or a page footer. Never prints the URL. */
export function describeDataSource(source: DataSource): string {
  return source.kind === 'hypersync'
    ? 'HyperSync'
    : source.role === 'sync'
      ? 'RPC only (ENVIO_RPC_URL)'
      : 'HyperSync, with ENVIO_RPC_URL as fallback'
}
