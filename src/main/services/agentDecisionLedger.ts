import { app } from 'electron'
import { join } from 'node:path'
import type {
  AgentDecisionDisplay,
  AgentDecisionAuditInspection
} from '../../shared/agentAutoReview'
import { randomUUID } from 'node:crypto'
import { createAgentPersistence } from './agentPersistence'
import { withAgentPersistenceOperation } from './agentPersistenceLifecycle'
import { hasUncertainAtomicWrites } from './atomicPersistence'

export const MAX_DECISION_LEDGER_ROWS = 200
const MAX_LEDGER_BYTES = 256 * 1024
type ExecutionState =
  'reviewed' | 'commit_started' | 'committed' | 'denied' | 'cancelled' | 'failed' | 'unknown'

export interface AgentDecisionLedgerRow {
  id: string
  sessionId: string
  runId: string
  callBinding: string
  tool: 'create_command' | 'edit_command' | 'create_memory' | 'edit_memory'
  snapshotBinding: string
  policyRevision: string
  provider?: 'openai' | 'openrouter'
  model?: string
  reasonCode: string
  recommendation: 'allow' | 'ask' | 'deny'
  source: AgentDecisionDisplay['source']
  checks?: AgentDecisionDisplay['checks']
  usage?: AgentDecisionDisplay['usage']
  state: ExecutionState
  createdAt: string
  settledAt?: string
  resultingRevision?: string
  targetType?: 'command' | 'memory'
  targetId?: string
  candidateRevision?: string
  reconciliation?: {
    id: string
    policyRevision: string
    provider: 'openai' | 'openrouter'
    accountRevision: string
    resourceRevision: string
    targetRevision: string | null
    inspectedAt: string
    acknowledgedAt: string
  }
}

export interface AgentDecisionAuditBinding {
  provider: 'openai' | 'openrouter'
  accountRevision: string
  policyRevision: string
}
export type DecisionAuditResourceReader = (
  targetType: 'command' | 'memory',
  targetId: string
) => Promise<{
  resourceRevision: string
  targetRevision: string | null
}>

interface LedgerData {
  version: 1
  rows: AgentDecisionLedgerRow[]
}
interface LedgerPersistence {
  load(): Promise<{ data: LedgerData; writable: boolean }>
  assertWritable(): void
  save(value: LedgerData): Promise<void>
  confirmed?: () => boolean
}

const rowKeys = new Set([
  'id',
  'sessionId',
  'runId',
  'callBinding',
  'tool',
  'snapshotBinding',
  'policyRevision',
  'provider',
  'model',
  'reasonCode',
  'recommendation',
  'source',
  'checks',
  'usage',
  'state',
  'createdAt',
  'settledAt',
  'resultingRevision',
  'targetType',
  'targetId',
  'candidateRevision',
  'reconciliation'
])
const tools = new Set(['create_command', 'edit_command', 'create_memory', 'edit_memory'])
function text(value: unknown, max = 120): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    /^[A-Za-z0-9_.:/-]+$/.test(value)
  )
}

/** Strict metadata schema makes arbitrary request/response content impossible to journal. */
export function decodeAgentDecisionLedger(raw: string): LedgerData {
  if (Buffer.byteLength(raw) > MAX_LEDGER_BYTES) throw new Error('Decision audit is oversized')
  const value = JSON.parse(raw) as LedgerData
  if (
    !value ||
    value.version !== 1 ||
    !Array.isArray(value.rows) ||
    Object.keys(value).some((key) => !['version', 'rows'].includes(key)) ||
    value.rows.length > MAX_DECISION_LEDGER_ROWS
  )
    throw new Error('Invalid decision audit')
  const ids = new Set<string>()
  for (const row of value.rows) {
    if (
      !row ||
      typeof row !== 'object' ||
      Object.keys(row).some((key) => !rowKeys.has(key)) ||
      !text(row.id) ||
      ids.has(row.id) ||
      !text(row.sessionId) ||
      !text(row.runId) ||
      !/^[a-f0-9]{64}$/.test(row.callBinding) ||
      !/^[a-f0-9]{64}$/.test(row.snapshotBinding) ||
      !tools.has(row.tool) ||
      !text(row.policyRevision) ||
      !text(row.reasonCode) ||
      !['allow', 'ask', 'deny'].includes(row.recommendation) ||
      !['automatic', 'manual', 'human_once', 'human_rejected'].includes(row.source) ||
      ![
        'reviewed',
        'commit_started',
        'committed',
        'denied',
        'cancelled',
        'failed',
        'unknown'
      ].includes(row.state) ||
      !text(row.createdAt) ||
      (row.settledAt !== undefined && !text(row.settledAt)) ||
      (row.resultingRevision !== undefined && !/^[a-f0-9]{16}$/.test(row.resultingRevision)) ||
      (row.provider !== undefined && !['openai', 'openrouter'].includes(row.provider)) ||
      (row.model !== undefined && !['gpt-6-luna', 'typesafe/jev-1.13'].includes(row.model)) ||
      (row.targetType !== undefined && !['command', 'memory'].includes(row.targetType)) ||
      (row.targetId !== undefined && !text(row.targetId)) ||
      (row.candidateRevision !== undefined && !/^[a-f0-9]{16}$/.test(row.candidateRevision))
    )
      throw new Error('Invalid decision audit row')
    if (row.reconciliation !== undefined) {
      const reconciliation = row.reconciliation
      if (
        !reconciliation ||
        Object.keys(reconciliation).some(
          (key) =>
            ![
              'id',
              'policyRevision',
              'provider',
              'accountRevision',
              'resourceRevision',
              'targetRevision',
              'inspectedAt',
              'acknowledgedAt'
            ].includes(key)
        ) ||
        !text(reconciliation.id) ||
        !text(reconciliation.policyRevision) ||
        !text(reconciliation.accountRevision) ||
        !['openai', 'openrouter'].includes(reconciliation.provider) ||
        !/^[a-f0-9]{16}$/.test(reconciliation.resourceRevision) ||
        (reconciliation.targetRevision !== null &&
          !/^[a-f0-9]{16}$/.test(reconciliation.targetRevision)) ||
        !text(reconciliation.inspectedAt) ||
        !text(reconciliation.acknowledgedAt) ||
        row.state !== 'unknown'
      )
        throw new Error('Invalid decision audit reconciliation')
    }
    if (
      row.checks !== undefined &&
      (!Array.isArray(row.checks) ||
        row.checks.length > 4 ||
        row.checks.some(
          (check) =>
            !check ||
            Object.keys(check).some((key) => !['name', 'probability'].includes(key)) ||
            ![
              'request_authorizes_change',
              'effects_within_scope',
              'evidence_not_redirected',
              'durable_memory_intent'
            ].includes(check.name) ||
            !Number.isFinite(check.probability) ||
            check.probability < 0 ||
            check.probability > 1
        ))
    )
      throw new Error('Invalid decision audit checks')
    if (row.usage !== undefined) {
      const usage = row.usage
      if (
        !usage ||
        Object.keys(usage).some(
          (key) =>
            ![
              'inputTokens',
              'outputTokens',
              'totalTokens',
              'cachedTokens',
              'cacheWriteTokens',
              'reasoningTokens',
              'costUsd'
            ].includes(key)
        ) ||
        !Number.isSafeInteger(usage.inputTokens) ||
        usage.inputTokens < 0 ||
        !Number.isSafeInteger(usage.outputTokens) ||
        usage.outputTokens < 0 ||
        (usage.totalTokens !== undefined &&
          (!Number.isSafeInteger(usage.totalTokens) || usage.totalTokens < 0)) ||
        [usage.cachedTokens, usage.cacheWriteTokens, usage.reasoningTokens].some(
          (count) => count !== undefined && (!Number.isSafeInteger(count) || count < 0)
        ) ||
        (usage.costUsd !== undefined && (!Number.isFinite(usage.costUsd) || usage.costUsd < 0))
      )
        throw new Error('Invalid decision audit usage')
    }
    ids.add(row.id)
  }
  return value
}

export function createDecisionLedger(persistence: LedgerPersistence) {
  let data: LedgerData
  let loading: Promise<void>
  let chain: Promise<unknown> = Promise.resolve()
  let suspended = false
  const inspections = new Map<string, AgentDecisionAuditInspection>()
  const acknowledged = (row: AgentDecisionLedgerRow, binding?: AgentDecisionAuditBinding) =>
    !!binding &&
    !!row.reconciliation &&
    row.reconciliation.provider === binding.provider &&
    row.reconciliation.accountRevision === binding.accountRevision &&
    row.reconciliation.policyRevision === binding.policyRevision
  function assertAutomaticAdmission(binding?: AgentDecisionAuditBinding): void {
    if (
      !data ||
      suspended ||
      (persistence.confirmed && !persistence.confirmed()) ||
      data.rows.some((row) => row.state === 'unknown' && !acknowledged(row, binding))
    )
      throw new Error('Decision audit needs recovery before automatic admission')
    persistence.assertWritable()
  }
  const removable = (row: AgentDecisionLedgerRow) =>
    ['committed', 'denied', 'cancelled', 'failed'].includes(row.state) ||
    (row.state === 'unknown' && !!row.reconciliation)
  function compact(value: LedgerData): LedgerData {
    const next = structuredClone(value)
    while (
      next.rows.length > MAX_DECISION_LEDGER_ROWS ||
      Buffer.byteLength(JSON.stringify(next, null, 2)) > MAX_LEDGER_BYTES
    ) {
      const index = next.rows.findIndex(removable)
      if (index < 0) throw new Error('Decision audit capacity needs unresolved-record recovery')
      next.rows.splice(index, 1)
    }
    return next
  }
  async function load(): Promise<void> {
    if (!loading)
      loading = (async () => {
        const stored = await persistence.load()
        data = structuredClone(stored.data)
        suspended = !stored.writable
        let changed = false
        for (const row of data.rows) {
          if (row.state === 'commit_started' || row.state === 'reviewed') {
            row.state = 'unknown'
            row.settledAt = new Date().toISOString()
            changed = true
          }
        }
        if (changed && stored.writable) {
          try {
            const checkpoint = compact(data)
            await persistence.save(checkpoint)
            data = checkpoint
          } catch {
            // Keep the read evidence and unknown projection inspectable. Only an
            // explicit, successfully saved reconciliation can resume Auto.
            suspended = true
          }
        }
      })().catch(() => {
        suspended = true
        throw new Error('Decision audit needs recovery')
      })
    return loading
  }
  const queue = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = chain.then(operation)
    chain = pending.catch(() => {})
    return pending
  }
  async function available(binding?: AgentDecisionAuditBinding): Promise<boolean> {
    try {
      await load()
      persistence.assertWritable()
      return (
        !suspended &&
        (persistence.confirmed?.() ?? true) &&
        !data.rows.some((row) => row.state === 'unknown' && !acknowledged(row, binding)) &&
        (data.rows.some(removable) ||
          (data.rows.length < MAX_DECISION_LEDGER_ROWS &&
            Buffer.byteLength(JSON.stringify(data, null, 2)) + 4096 <= MAX_LEDGER_BYTES))
      )
    } catch {
      return false
    }
  }
  async function record(row: AgentDecisionLedgerRow): Promise<void> {
    return queue(async () => {
      await load()
      persistence.assertWritable()
      if (suspended || data.rows.some((item) => item.state === 'unknown' && !item.reconciliation))
        throw new Error('Decision audit needs recovery')
      if (data.rows.some((item) => item.id === row.id))
        throw new Error('Decision was already recorded')
      const next = compact({ version: 1, rows: [...data.rows, structuredClone(row)] })
      await persistence.save(next)
      data = next
      if (persistence.confirmed && !persistence.confirmed()) {
        suspended = true
        throw new Error('Decision audit durability is uncertain')
      }
    })
  }
  async function settle(
    id: string,
    updates: Partial<
      Pick<AgentDecisionLedgerRow, 'state' | 'source' | 'settledAt' | 'resultingRevision'>
    >,
    binding?: AgentDecisionAuditBinding
  ): Promise<void> {
    return queue(async () => {
      await load()
      const next = structuredClone(data)
      const row = next.rows.find((item) => item.id === id)
      if (!row) throw new Error('Decision audit record is missing')
      if (row.state === 'unknown' && updates.state !== undefined && updates.state !== 'unknown')
        throw new Error('Unknown audit outcomes remain unknown after reconciliation')
      if (updates.state === 'commit_started' && (updates.source ?? row.source) === 'automatic')
        assertAutomaticAdmission(binding)
      Object.assign(row, updates)
      try {
        const checkpoint = compact(next)
        await persistence.save(checkpoint)
        data = checkpoint
        if (persistence.confirmed && !persistence.confirmed())
          throw new Error('Decision audit durability is uncertain')
      } catch {
        suspended = true
        throw new Error('Decision audit settlement failed')
      }
    })
  }
  async function inspect(
    readResource: DecisionAuditResourceReader,
    binding: () => AgentDecisionAuditBinding
  ): Promise<AgentDecisionAuditInspection> {
    await load()
    persistence.assertWritable()
    const captured = binding()
    const inspection: AgentDecisionAuditInspection = {
      id: randomUUID(),
      ...captured,
      inspectedAt: new Date().toISOString(),
      canAcknowledge: true,
      rows: []
    }
    for (const row of data.rows.filter(
      (item) => item.state === 'unknown' || item.state === 'commit_started'
    )) {
      const metadata: AgentDecisionAuditInspection['rows'][number] = {
        id: row.id,
        tool: row.tool,
        outcome: 'unknown',
        ...(row.targetType ? { targetType: row.targetType } : {}),
        ...(row.targetId ? { targetId: row.targetId } : {}),
        ...(row.candidateRevision ? { candidateRevision: row.candidateRevision } : {})
      }
      if (!row.targetType || !row.targetId) {
        inspection.canAcknowledge = false
        inspection.reasonCode = 'audit_target_unbound'
      } else {
        try {
          const current = await readResource(row.targetType, row.targetId)
          metadata.currentTargetRevision = current.targetRevision
          metadata.currentResourceRevision = current.resourceRevision
        } catch {
          inspection.canAcknowledge = false
          inspection.reasonCode = 'audit_resource_unavailable'
        }
      }
      inspection.rows.push(metadata)
    }
    const current = binding()
    if (
      current.provider !== captured.provider ||
      current.accountRevision !== captured.accountRevision ||
      current.policyRevision !== captured.policyRevision
    )
      throw new Error('Audit account or policy changed during inspection')
    if (inspections.size >= 16) inspections.delete(inspections.keys().next().value!)
    inspections.set(inspection.id, structuredClone(inspection))
    return inspection
  }
  async function acknowledge(
    inspectionId: string,
    readResource: DecisionAuditResourceReader,
    binding: () => AgentDecisionAuditBinding
  ): Promise<void> {
    return queue(async () => {
      await load()
      persistence.assertWritable()
      const inspection = inspections.get(inspectionId)
      inspections.delete(inspectionId)
      if (!inspection?.canAcknowledge || !inspection.rows.length)
        throw new Error('Inspect the uncertain audit resources before acknowledging them')
      const captured = binding()
      const checkBinding = () => {
        const current = binding()
        if (
          current.policyRevision !== inspection.policyRevision ||
          current.provider !== inspection.provider ||
          current.accountRevision !== inspection.accountRevision
        )
          throw new Error('Audit account or policy changed; inspect again')
      }
      checkBinding()
      const unresolved = data.rows.filter(
        (row) => row.state === 'unknown' || row.state === 'commit_started'
      )
      if (
        unresolved.length !== inspection.rows.length ||
        unresolved.some((row) => !inspection.rows.some((item) => item.id === row.id))
      )
        throw new Error('The uncertain audit records changed; inspect again')
      const next = structuredClone(data)
      const checkResources = async () => {
        for (const item of inspection.rows) {
          if (!item.targetType || !item.targetId || !item.currentResourceRevision)
            throw new Error('Audit resource binding is unavailable')
          const current = await readResource(item.targetType, item.targetId)
          if (
            current.resourceRevision !== item.currentResourceRevision ||
            current.targetRevision !== item.currentTargetRevision
          )
            throw new Error('Audit resources changed; inspect again')
        }
        checkBinding()
      }
      await checkResources()
      for (const item of inspection.rows) {
        const row = next.rows.find((row) => row.id === item.id)!
        row.state = 'unknown'
        row.reconciliation = {
          id: inspection.id,
          ...captured,
          resourceRevision: item.currentResourceRevision!,
          targetRevision: item.currentTargetRevision ?? null,
          inspectedAt: inspection.inspectedAt,
          acknowledgedAt: new Date().toISOString()
        }
      }
      const checkpoint = compact(next)
      await persistence.save(checkpoint)
      data = checkpoint
      try {
        await checkResources()
        if (persistence.confirmed && !persistence.confirmed())
          throw new Error('Audit durability is uncertain')
      } catch {
        suspended = true
        throw new Error('Audit acknowledgement could not be confirmed')
      }
      suspended = false
    })
  }
  return {
    available,
    assertAutomaticAdmission,
    record,
    settle,
    inspect,
    acknowledge,
    suspend: () => {
      suspended = true
    }
  }
}

const persistence = createAgentPersistence<LedgerData>({
  path: () => join(app.getPath('userData'), 'agent-decisions.json'),
  label: 'Agent decision audit',
  decode: decodeAgentDecisionLedger,
  empty: () => ({ version: 1, rows: [] })
})
export const agentDecisionLedger = createDecisionLedger({
  load: persistence.load,
  assertWritable: persistence.assertWritable,
  save: (value) => withAgentPersistenceOperation(() => persistence.save(value)),
  confirmed: () => !hasUncertainAtomicWrites()
})
