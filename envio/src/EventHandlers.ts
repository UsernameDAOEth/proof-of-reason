/**
 * Registration only. Every decision lives in src/handlers.ts, src/verdicts.ts, src/wilson.ts and
 * src/outcomes.ts, which are pure and tested without codegen; this file exists to hand envio's
 * generated context to them.
 *
 * `generated` comes from `pnpm envio codegen`, so this is the one file that needs codegen to have
 * run. envio/tsconfig.json leaves it out and tsconfig.handlers.json includes it: see docs/ENVIO.md.
 */
import { KuruGate, ReasonGate, ValidationRegistry } from 'generated'
import {
  handleAgentSet,
  handleExecuted,
  handleValidationRequest,
  handleValidationResponse,
  handleValidatorSet,
} from './handlers.ts'
import type { Loader } from './handlers.ts'

ReasonGate.Executed.handler(async ({ event, context }) => {
  await handleExecuted('ReasonGate', event as never, context as unknown as Loader)
})
KuruGate.Executed.handler(async ({ event, context }) => {
  await handleExecuted('KuruGate', event as never, context as unknown as Loader)
})
ReasonGate.ValidatorSet.handler(async ({ event, context }) => {
  await handleValidatorSet(event as never, context as unknown as Loader, 'ReasonGate')
})
KuruGate.ValidatorSet.handler(async ({ event, context }) => {
  await handleValidatorSet(event as never, context as unknown as Loader, 'KuruGate')
})
ReasonGate.AgentSet.handler(async ({ event, context }) => {
  await handleAgentSet(event as never, context as unknown as Loader, 'ReasonGate')
})
KuruGate.AgentSet.handler(async ({ event, context }) => {
  await handleAgentSet(event as never, context as unknown as Loader, 'KuruGate')
})
ValidationRegistry.ValidationRequest.handler(async ({ event, context }) => {
  await handleValidationRequest(event as never, context as unknown as Loader)
})
ValidationRegistry.ValidationResponse.handler(async ({ event, context }) => {
  await handleValidationResponse(event as never, context as unknown as Loader)
})
