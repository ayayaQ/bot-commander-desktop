<script lang="ts">
  interface ModelOption {
    id: string
    name?: string
    description?: string
    contextLength?: number
    supportsStructuredOutputs?: boolean
    pricing?: {
      prompt?: string
      completion?: string
      request?: string
      image?: string
      webSearch?: string
      internalReasoning?: string
      inputCacheRead?: string
      inputCacheWrite?: string
    }
  }

  interface Props {
    value: string
    models?: ModelOption[]
    placeholder?: string
    disabled?: boolean
    provider?: 'openai' | 'openrouter'
    buttonClass?: string
    title?: string
    error?: string
    isLoading?: boolean
    onRefresh?: () => void | Promise<void>
    onChange: (value: string) => void
  }

  let {
    value,
    models = [],
    placeholder = 'Model ID',
    disabled = false,
    provider = 'openai',
    buttonClass = 'btn btn-outline justify-between w-full',
    title = 'Select model',
    error = '',
    isLoading = false,
    onRefresh,
    onChange
  }: Props = $props()

  let isOpen = $state(false)
  let query = $state('')
  let customModel = $state('')

  let selectedModel = $derived(models.find((model) => model.id === value))
  let filteredModels = $derived(
    models.filter((model) => {
      const q = query.trim().toLowerCase()
      if (!q) return true
      return (
        model.id.toLowerCase().includes(q) ||
        (model.name || '').toLowerCase().includes(q) ||
        (model.description || '').toLowerCase().includes(q)
      )
    })
  )

  function openModal() {
    if (disabled) return
    customModel = value
    query = ''
    isOpen = true
  }

  function closeModal() {
    isOpen = false
  }

  function chooseModel(modelId: string) {
    onChange(modelId)
    closeModal()
  }

  function chooseCustomModel() {
    const modelId = customModel.trim()
    if (!modelId) return
    chooseModel(modelId)
  }

  function handleCustomKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault()
      chooseCustomModel()
    }
  }

  function displayName(model: ModelOption | undefined, fallback: string): string {
    return model?.name || fallback
  }

  function secondaryLabel(model: ModelOption): string {
    const details = [model.id]
    if (model.contextLength) details.push(`${model.contextLength.toLocaleString()} ctx`)
    return details.join(' · ')
  }

  function formatPerMillion(value: string | undefined): string | null {
    if (value == null || value === '') return null
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) return null
    return `$${(numeric * 1_000_000).toLocaleString(undefined, {
      minimumFractionDigits: numeric === 0 ? 0 : 2,
      maximumFractionDigits: 2
    })}/1M`
  }

  function pricingLabel(model: ModelOption): string | null {
    if (!model.pricing) return null
    const input = formatPerMillion(model.pricing.prompt)
    const output = formatPerMillion(model.pricing.completion)
    const reasoning = formatPerMillion(model.pricing.internalReasoning)
    const parts = []
    if (input) parts.push(`${input} input`)
    if (output) parts.push(`${output} output`)
    if (reasoning) parts.push(`${reasoning} reasoning`)
    return parts.length > 0 ? parts.join(' · ') : null
  }
</script>

<button type="button" class={buttonClass} onclick={openModal} {disabled}>
  <span class="truncate">{displayName(selectedModel, value || placeholder)}</span>
  <span class="material-symbols-outlined text-base opacity-70">expand_more</span>
</button>

{#if isOpen}
  <div class="modal modal-open">
    <div class="modal-box max-w-3xl p-0">
      <div class="p-4 border-b border-base-300 flex items-center justify-between gap-3">
        <div class="min-w-0">
          <h3 class="font-bold text-lg">{title}</h3>
          <p class="text-xs opacity-70 truncate">{provider === 'openrouter' ? 'OpenRouter' : 'OpenAI'} · Current: {value || 'None'}</p>
        </div>
        <div class="flex items-center gap-2">
          {#if onRefresh}
            <button type="button" class="btn btn-sm" onclick={onRefresh} disabled={isLoading}>
              <span class="material-symbols-outlined text-base">sync</span>
              <span>{isLoading ? 'Refreshing...' : 'Refresh'}</span>
            </button>
          {/if}
          <button type="button" class="btn btn-ghost btn-sm btn-circle" onclick={closeModal}>
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>
      </div>

      <div class="p-4 space-y-3">
        <input
          class="input input-bordered w-full"
          bind:value={query}
          placeholder="Search models..."
        />

        {#if error}
          <div class="alert alert-warning text-sm">
            <span class="material-symbols-outlined">warning</span>
            <span>{error}</span>
          </div>
        {/if}

        <div class="max-h-80 overflow-y-auto border border-base-300 rounded-box">
          {#if filteredModels.length === 0}
            <div class="p-4 text-sm opacity-70">No matching models.</div>
          {:else}
            {#each filteredModels as model}
              <button
                type="button"
                class="w-full text-left px-4 py-3 border-b border-base-300 last:border-b-0"
                class:hover:bg-base-200={model.id !== value}
                class:bg-primary={model.id === value}
                class:text-primary-content={model.id === value}
                onclick={() => chooseModel(model.id)}
              >
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div
                      class="font-medium truncate"
                      class:text-primary-content={model.id === value}
                    >
                      {displayName(model, model.id)}
                    </div>
                    <div
                      class="text-xs truncate"
                      class:opacity-70={model.id !== value}
                      class:text-primary-content={model.id === value}
                    >
                      {secondaryLabel(model)}
                    </div>
                    {#if pricingLabel(model)}
                      <div
                        class="text-xs truncate mt-1"
                        class:opacity-80={model.id !== value}
                        class:text-primary-content={model.id === value}
                      >
                        {pricingLabel(model)}
                      </div>
                    {/if}
                    {#if model.description}
                      <div
                        class="text-xs line-clamp-2 mt-1"
                        class:opacity-60={model.id !== value}
                        class:text-primary-content={model.id === value}
                      >
                        {model.description}
                      </div>
                    {/if}
                  </div>
                  {#if provider === 'openrouter' && model.supportsStructuredOutputs === false}
                    <span class="badge badge-warning badge-sm shrink-0">JSON?</span>
                  {/if}
                </div>
              </button>
            {/each}
          {/if}
        </div>

        <div class="divider my-1">Custom</div>
        <div class="flex gap-2">
          <input
            class="input input-bordered flex-1"
            bind:value={customModel}
            placeholder={placeholder}
            onkeydown={handleCustomKeydown}
          />
          <button type="button" class="btn btn-primary" onclick={chooseCustomModel}>
            Use
          </button>
        </div>
      </div>
    </div>
    <button type="button" class="modal-backdrop" onclick={closeModal}>Close</button>
  </div>
{/if}
