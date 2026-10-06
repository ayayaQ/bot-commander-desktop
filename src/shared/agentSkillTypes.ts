import type { SkillSummary } from '@ayayaq/vivi/extensions/skills'

export interface AgentSkillDiagnostic {
  source: string
  message: string
}

export interface AgentSkillsStatus {
  saveSupport: { available: boolean; reason: string }
  ownedRoot: string
  externalRoots: string[]
  skills: SkillSummary[]
  diagnostics: AgentSkillDiagnostic[]
}

export interface AgentSkillReceipt {
  saved: true
  name: string
  revision: string
  destination: string
  available: 'next_turn'
  durability: 'confirmed' | 'unsupported' | 'uncertain'
}
