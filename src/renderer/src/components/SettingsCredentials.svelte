<script lang="ts">
  import type { LegacyCredentialProvider } from '../../../shared/settingsCredentials'

  let {
    provider,
    configured = false,
    revision,
    disabled = false,
    update
  }: {
    provider: LegacyCredentialProvider
    configured?: boolean
    revision?: string
    disabled?: boolean
    update: (change: { action: 'replace'; value: string } | { action: 'remove' }) => Promise<void>
  } = $props()
  let input = $state('')
  let busy = $state(false)
  let error = $state('')
  $effect(() => {
    revision
    input = ''
    error = ''
  })

  async function submit(action: 'replace' | 'remove') {
    if (busy || disabled || !revision || (action === 'replace' && !input.trim())) return
    busy = true
    error = ''
    try {
      await update(action === 'replace' ? { action, value: input } : { action })
    } catch {
      error = 'Could not confirm the key update. Reload settings before retrying.'
    } finally {
      input = ''
      busy = false
    }
  }
</script>

<div class="form-control">
  <label class="label" for={`${provider}-key`}>
    <span class="label-text">{provider === 'openai' ? 'OpenAI' : 'OpenRouter'} API Key</span>
  </label>
  <input
    id={`${provider}-key`}
    type="password"
    class="input w-full"
    bind:value={input}
    disabled={disabled || busy}
    placeholder="Enter a new key to replace the saved key"
    autocomplete="off"
  />
  <div class="flex items-center gap-2 mt-2">
    <span class="text-xs opacity-70">{configured ? 'Key configured' : 'No key configured'}</span>
    <button
      class="btn btn-sm"
      disabled={disabled || busy || !revision || !input.trim()}
      onclick={() => submit('replace')}>Replace key</button
    >
    <button
      class="btn btn-sm btn-ghost"
      disabled={disabled || busy || !revision || !configured}
      onclick={() => submit('remove')}>Remove key</button
    >
    <button
      class="btn btn-sm btn-ghost"
      disabled={busy || !input}
      onclick={() => {
        input = ''
        error = ''
      }}>Cancel</button
    >
  </div>
  <p class="text-xs opacity-70 mt-2">
    Leave blank to keep the saved key. Changes use Replace or Remove.
  </p>
  {#if error}<p class="text-xs text-error mt-2" role="alert">{error}</p>{/if}
</div>
