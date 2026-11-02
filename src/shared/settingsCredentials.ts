/** Renderer-visible credential metadata contains no saved credential values. */
export interface ProviderCredentialState {
  openaiKeyConfigured?: boolean
  openrouterKeyConfigured?: boolean
  openaiAccountRevision?: string
  openrouterAccountRevision?: string
}

export type LegacyCredentialProvider = 'openai' | 'openrouter'
export type SaveProviderKeyRequest = {
  provider: LegacyCredentialProvider
  expectedRevision: string
} & ({ action: 'replace'; value: string } | { action: 'remove' })
