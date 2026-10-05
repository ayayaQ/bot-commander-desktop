import {
  reasoningSelectionSupport,
  type ModelCapabilities,
  type ReasoningEffort,
  type ReasoningSelection
} from '@ayayaq/vivi/providers/models'
import type { DesktopReasoningEffort } from './aiModelTypes'

export function reasoningSelection(value: DesktopReasoningEffort): ReasoningSelection {
  if (value === 'none') return { mode: 'default' }
  if (value === 'disabled') return { mode: 'disabled' }
  return { mode: 'effort', effort: value }
}

export interface ReasoningChoice {
  value: DesktopReasoningEffort
  label: string
}

const labels: Record<DesktopReasoningEffort, string> = {
  none: 'Provider default (may reason)',
  disabled: 'Disabled',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
}

export function reasoningChoices(
  capabilities?: ModelCapabilities,
  allowDisable = true
): ReasoningChoice[] {
  const choices: ReasoningChoice[] = [{ value: 'none', label: labels.none }]
  if (!capabilities) return choices
  if (
    allowDisable &&
    reasoningSelectionSupport(capabilities, { mode: 'disabled' }) === 'supported'
  ) {
    choices.push({ value: 'disabled', label: labels.disabled })
  }
  for (const effort of capabilities.reasoning.efforts) {
    if (
      effort !== 'none' &&
      reasoningSelectionSupport(capabilities, { mode: 'effort', effort }) === 'supported'
    ) {
      choices.push({ value: effort, label: labels[effort] })
    }
  }
  return choices
}

/** Explicit choices fail closed. The saved selection is never rewritten. */
export function reasoningConfigurationError(
  capabilities: ModelCapabilities | undefined,
  value: DesktopReasoningEffort
): string | null {
  if (value === 'none') return null
  const support = capabilities
    ? reasoningSelectionSupport(capabilities, reasoningSelection(value))
    : 'unknown'
  if (support === 'supported') return null
  return `${labels[value] || 'Saved reasoning choice'} is ${support === 'unknown' ? 'unverified' : 'unsupported'} for this model and API. Choose Provider default or a documented reasoning choice.`
}

/** Core factories need the disable sentinel even when no effort selector exists. */
export function providerReasoningEfforts(capabilities: ModelCapabilities): ReasoningEffort[] {
  const efforts =
    capabilities.reasoning.effortSelection === 'supported'
      ? capabilities.reasoning.efforts.filter((effort) => effort !== 'none')
      : []
  if (capabilities.reasoning.disable === 'supported') return ['none', ...efforts]
  return efforts
}

export function reasoningCapabilityLabel(capabilities?: ModelCapabilities): string {
  if (!capabilities || capabilities.reasoning.support === 'unknown')
    return 'Reasoning capability unknown'
  if (capabilities.reasoning.support === 'unsupported') return 'Reasoning unsupported'
  if (capabilities.reasoning.requirement === 'required') return 'Reasoning required; cannot disable'
  if (capabilities.reasoning.effortSelection !== 'supported')
    return 'Reasoning supported; no verified effort choices'
  return 'Documented reasoning choices'
}
