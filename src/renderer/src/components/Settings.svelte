<script lang="ts">
  import type { ModelCapabilities } from '@ayayaq/vivi/providers/models'
  import { onMount } from 'svelte'
  import {
    getSelectedModelForProvider,
    loadSettings,
    saveSettings,
    patchSettings,
    retrySettingsSave,
    settingsDraftStore,
    settingsStore,
    settingsSaveStatus,
    withSelectedModelForProvider
  } from '../stores/settings'
  import { t } from '../stores/localisation'
  import HeaderBar from './HeaderBar.svelte'
  import ApiAuth from './ApiAuth.svelte'
  import ModelPicker from './ModelPicker.svelte'
  import MemoryManagerModal from './MemoryManagerModal.svelte'
  import McpSettingsCard from './McpSettingsCard.svelte'
  import {
    currentSelectedCapabilities,
    reasoningChoices,
    reasoningConfigurationError,
    reasoningCapabilityLabel,
    ModelCatalogRequestGate,
    catalogSettingsMatch,
    canRefreshModelCatalog,
    modelCapabilitySnapshotMatches,
    type ReasoningEffort
  } from '../utils/aiModelCapabilities'
  import type { AiModelInfo, SelectedModelCapabilitySnapshot } from '../../../shared/aiModelTypes'
  import type { AppSettings } from '../types/types'
  import type { ResourceChangedEvent } from '../../../shared/mcpTypes'

  let selectedTheme: string = $state()
  let showToken: boolean = $state()
  let selectedLanguage: string = $state()
  let aiProvider: 'openai' | 'openrouter' = $state('openai')
  let openaiApiKey: string = $state()
  let openrouterApiKey: string = $state('')
  let selectedAiModel: string = $state('gpt-5.4-nano')
  let aiReasoningEffort: ReasoningEffort = $state('none')
  let developerPrompt: string = $state()
  let useCustomApi: boolean = $state()
  let useGlobalEvalScope: boolean = $state()
  let hideOutput: boolean = $state()
  let agentNotificationsEnabled: boolean = $state(true)
  let aiModels: AiModelInfo[] = $state([])
  const catalogGate = new ModelCatalogRequestGate()
  const selectedGate = new ModelCatalogRequestGate()
  let selectedCapabilities: ModelCapabilities | undefined = $state()
  let selectedCapabilityError = $state('')
  let selectedExpiresAt: number | undefined = $state()
  let capabilityExpiryTimer: ReturnType<typeof setTimeout> | undefined
  let catalogExpiryTimer: ReturnType<typeof setTimeout> | undefined
  let isLoadingModels = $state(false)
  let modelFetchError = $state('')
  let memoryDialog: HTMLDialogElement = $state()

  function syncLocalSettings(settings: AppSettings) {
    const provider = settings.aiProvider || 'openai'
    if (
      aiProvider !== provider ||
      openaiApiKey !== settings.openaiApiKey ||
      openrouterApiKey !== (settings.openrouterApiKey || '')
    ) {
      catalogGate.invalidate()
      selectedGate.invalidate()
      selectedCapabilities = undefined
      aiModels = []
      isLoadingModels = false
      modelFetchError = 'Provider settings changed. Refresh the model catalog.'
    }
    selectedTheme = settings.theme
    showToken = settings.showToken
    selectedLanguage = settings.language
    aiProvider = settings.aiProvider || 'openai'
    openaiApiKey = settings.openaiApiKey
    openrouterApiKey = settings.openrouterApiKey || ''
    selectedAiModel = getSelectedModelForProvider(settings, aiProvider)
    aiReasoningEffort = settings.aiReasoningEffort || 'none'
    developerPrompt = settings.developerPrompt
    useCustomApi = settings.useCustomApi
    useGlobalEvalScope = settings.useLegacyInterpreter
    hideOutput = settings.hideOutput
    agentNotificationsEnabled = settings.agentNotificationsEnabled
  }

  async function handleResourceChanged(event: ResourceChangedEvent) {
    if (event.kind !== 'settings' || event.source === 'renderer') return
    try {
      await loadSettings()
    } catch (error) {
      modelFetchError = error instanceof Error ? error.message : 'Could not refresh settings'
    }
  }

  function changeTheme(event) {
    selectedTheme = event.target.value
    void patchSettings({ theme: selectedTheme })
  }

  function changeLanguage(event) {
    selectedLanguage = event.target.value
    void patchSettings({ language: selectedLanguage })
  }

  function toggleShowToken() {
    void patchSettings({ showToken })
  }

  function toggleHideOutput() {
    void patchSettings({ hideOutput })
  }

  function toggleAgentNotifications() {
    void patchSettings({ agentNotificationsEnabled })
  }

  function updateOpenAIKey(event) {
    catalogGate.invalidate()
    selectedGate.invalidate()
    selectedCapabilities = undefined
    aiModels = []
    isLoadingModels = false
    modelFetchError = 'Provider key changed. Refresh the model catalog.'
    openaiApiKey = event.target.value
    void patchSettings({ openaiApiKey })
  }

  function updateOpenRouterKey(event) {
    catalogGate.invalidate()
    selectedGate.invalidate()
    selectedCapabilities = undefined
    aiModels = []
    isLoadingModels = false
    modelFetchError = 'Provider key changed. Refresh the model catalog.'
    openrouterApiKey = event.target.value
    void patchSettings({ openrouterApiKey })
  }

  async function updateAiProvider(event) {
    catalogGate.invalidate()
    selectedGate.invalidate()
    selectedCapabilities = undefined
    aiModels = []
    isLoadingModels = false
    aiProvider = event.target.value
    selectedAiModel = getSelectedModelForProvider($settingsDraftStore, aiProvider)
    if (await patchSettings({ aiProvider, selectedAiModel })) await refreshAiModels()
  }

  function updateModelValue(model: string) {
    if (!model) return
    selectedAiModel = model
    const next = withSelectedModelForProvider($settingsDraftStore, aiProvider, selectedAiModel)
    void saveSettings({ ...next, aiReasoningEffort })
  }

  function updateReasoningEffort(event) {
    const value = event.target.value as ReasoningEffort
    const current = currentSelectedCapabilities(
      selectedCapabilities,
      aiProvider,
      'chat-completions',
      selectedAiModel,
      selectedExpiresAt
    )
    const error = reasoningConfigurationError(current, value)
    if (error) {
      selectedCapabilityError = error
      void refreshSelectedCapabilities(
        selectedAiModel,
        { aiProvider, openaiApiKey, openrouterApiKey },
        $settingsStore
      )
      return
    }
    aiReasoningEffort = value
    void patchSettings({ aiReasoningEffort })
  }

  function scheduleCatalogExpiry(result: AiModelInfo[], request: number) {
    clearTimeout(catalogExpiryTimer)
    const expiries = result
      .map((model) => model.capabilityExpiresAt)
      .filter((at): at is number => Number.isFinite(at))
    if (!expiries.length) return
    catalogExpiryTimer = setTimeout(
      () => {
        if (!catalogGate.current(request)) return
        catalogGate.invalidate()
        aiModels = []
        isLoadingModels = false
        modelFetchError = 'Provider catalog metadata expired. Refresh the model catalog.'
        selectedGate.invalidate()
        selectedCapabilities = undefined
        void refreshSelectedCapabilities(
          selectedAiModel,
          { aiProvider, openaiApiKey, openrouterApiKey },
          $settingsStore
        )
      },
      Math.max(0, Math.min(...expiries) - Date.now())
    )
  }

  async function refreshAiModels() {
    const request = catalogGate.begin()
    clearTimeout(catalogExpiryTimer)
    aiModels = []
    const local = { aiProvider, openaiApiKey, openrouterApiKey }
    const committed = $settingsStore
    if (!canRefreshModelCatalog(local, committed, $settingsSaveStatus)) {
      isLoadingModels = false
      modelFetchError =
        'Save provider settings before refreshing the model catalog. Retry any failed settings save first.'
      return
    }
    if (aiProvider === 'openai' && !openaiApiKey) {
      isLoadingModels = false
      modelFetchError =
        'Add an OpenAI API key to fetch OpenAI models. You can still enter a custom model ID.'
      return
    }
    isLoadingModels = true
    modelFetchError = ''
    try {
      const result = await window.electron.ipcRenderer.invoke('fetch-ai-models')
      if (
        catalogGate.current(request) &&
        canRefreshModelCatalog(
          { aiProvider, openaiApiKey, openrouterApiKey },
          $settingsStore,
          $settingsSaveStatus
        ) &&
        catalogSettingsMatch(committed, $settingsStore)
      ) {
        aiModels = result
        scheduleCatalogExpiry(result, request)
      }
    } catch (error) {
      if (catalogGate.current(request))
        modelFetchError = error instanceof Error ? error.message : 'Failed to fetch models'
    } finally {
      if (catalogGate.current(request)) isLoadingModels = false
    }
  }

  function updateDeveloperPrompt(event) {
    developerPrompt = event.target.value
    void patchSettings({ developerPrompt })
  }

  function toggleCustomApi() {
    void patchSettings({ useCustomApi })
  }

  function toggleGlobalEvalScope() {
    void patchSettings({ useLegacyInterpreter: useGlobalEvalScope })
  }

  function openExternalLink(event) {
    event.preventDefault()
    const url = event.target.href
    window.electron.ipcRenderer.invoke('open-external-url', url)
  }

  const capabilities = $derived(
    currentSelectedCapabilities(
      selectedCapabilities,
      aiProvider,
      'chat-completions',
      selectedAiModel,
      selectedExpiresAt
    )
  )
  $effect(() => {
    const local = { aiProvider, openaiApiKey, openrouterApiKey }
    const committed = $settingsStore
    const model = selectedAiModel
    const status = $settingsSaveStatus
    aiModels
    if (model && canRefreshModelCatalog(local, committed, status)) {
      void refreshSelectedCapabilities(model, local, committed)
    } else {
      selectedGate.invalidate()
      clearTimeout(capabilityExpiryTimer)
      selectedCapabilities = undefined
    }
  })

  async function refreshSelectedCapabilities(
    model: string,
    local: { aiProvider: 'openai' | 'openrouter'; openaiApiKey: string; openrouterApiKey: string },
    committed: AppSettings
  ) {
    if (!canRefreshModelCatalog(local, committed, $settingsSaveStatus)) {
      selectedGate.invalidate()
      clearTimeout(capabilityExpiryTimer)
      selectedCapabilities = undefined
      return
    }
    const request = selectedGate.begin()
    clearTimeout(capabilityExpiryTimer)
    selectedCapabilities = undefined
    selectedExpiresAt = undefined
    selectedCapabilityError = ''
    try {
      const result = (await window.electron.ipcRenderer.invoke('get-ai-model-capabilities', {
        model,
        provider: local.aiProvider,
        purpose: 'chat'
      })) as SelectedModelCapabilitySnapshot
      if (
        selectedGate.current(request) &&
        selectedAiModel === model &&
        canRefreshModelCatalog(
          { aiProvider, openaiApiKey, openrouterApiKey },
          $settingsStore,
          $settingsSaveStatus
        ) &&
        catalogSettingsMatch(committed, $settingsStore) &&
        modelCapabilitySnapshotMatches(
          result.capabilities,
          local.aiProvider,
          'chat-completions',
          model
        )
      ) {
        selectedCapabilities = result.capabilities
        selectedExpiresAt = result.expiresAt
        if (result.expiresAt !== undefined && Number.isFinite(result.expiresAt))
          capabilityExpiryTimer = setTimeout(
            () => {
              if (!(
                selectedGate.current(request) &&
                selectedAiModel === model &&
                catalogSettingsMatch(committed, $settingsStore)
              ))
                return
              selectedGate.invalidate()
              selectedCapabilities = undefined
              aiModels = []
              void refreshSelectedCapabilities(
                model,
                { aiProvider, openaiApiKey, openrouterApiKey },
                $settingsStore
              )
            },
            Math.max(0, result.expiresAt - Date.now())
          )
      }
    } catch (error) {
      if (selectedGate.current(request))
        selectedCapabilityError =
          error instanceof Error ? error.message : 'Selected model capabilities unavailable'
    }
  }

  const choices = $derived(reasoningChoices(capabilities, false))
  const reasoningError = $derived(reasoningConfigurationError(capabilities, aiReasoningEffort))

  onMount(() => {
    const unsubscribeDraft = settingsDraftStore.subscribe(syncLocalSettings)
    let previousCommitted = $settingsStore
    const unsubscribeCommitted = settingsStore.subscribe((settings) => {
      if (!catalogSettingsMatch(previousCommitted, settings)) {
        catalogGate.invalidate()
        selectedGate.invalidate()
        selectedCapabilities = undefined
        aiModels = []
        isLoadingModels = false
        modelFetchError = 'Provider settings changed. Refresh the model catalog.'
      }
      previousCommitted = settings
    })
    void refreshAiModels()
    window.electron.ipcRenderer.on('resource:changed', handleResourceChanged)
    return () => {
      catalogGate.invalidate()
      selectedGate.invalidate()
      selectedCapabilities = undefined
      clearTimeout(capabilityExpiryTimer)
      clearTimeout(catalogExpiryTimer)
      unsubscribeDraft()
      unsubscribeCommitted()
      window.electron.ipcRenderer.removeListener('resource:changed', handleResourceChanged)
    }
  })
</script>

<HeaderBar>
  <h2 class="text-2xl font-bold">{$t('settings')}</h2>
</HeaderBar>

<div class="p-4">
  {#if $settingsSaveStatus.error}
    <div class="alert alert-error mb-4" role="alert">
      <span
        >Could not confirm the settings save. Your changes are still here. {$settingsSaveStatus.error}</span
      >
      <button
        class="btn btn-sm"
        disabled={$settingsSaveStatus.saving}
        onclick={() => retrySettingsSave()}>Retry save</button
      >
    </div>
  {:else if $settingsSaveStatus.saving}
    <p class="mb-4 text-sm" role="status">Saving settings…</p>
  {/if}
  <h2 class="text-2xl font-bold mb-4">{$t('account')}</h2>
  <ApiAuth />

  <div class="divider"></div>
  <h2 class="text-2xl font-bold mb-4">{$t('general')}</h2>
  <div class="form-control">
    <!-- svelte-ignore a11y_label_has_associated_control -->
    <label class="label">
      <span class="label-text">{$t('theme')}</span>
    </label>
    <select class="select" value={selectedTheme} onchange={changeTheme}>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
      <option value="cupcake">Cupcake</option>
      <option value="bumblebee">Bumblebee</option>
      <option value="emerald">Emerald</option>
      <option value="corporate">Corporate</option>
      <option value="synthwave">Synthwave</option>
      <option value="retro">Retro</option>
      <option value="cyberpunk">Cyberpunk</option>
      <option value="valentine">Valentine</option>
      <option value="halloween">Halloween</option>
      <option value="garden">Garden</option>
      <option value="forest">Forest</option>
      <option value="aqua">Aqua</option>
      <option value="lofi">Lo-fi</option>
      <option value="pastel">Pastel</option>
      <option value="fantasy">Fantasy</option>
      <option value="wireframe">Wireframe</option>
      <option value="black">Black</option>
      <option value="luxury">Luxury</option>
      <option value="dracula">Dracula</option>
      <option value="cmyk">CMYK</option>
      <option value="autumn">Autumn</option>
      <option value="business">Business</option>
      <option value="acid">Acid</option>
      <option value="lemonade">Lemonade</option>
      <option value="night">Night</option>
      <option value="coffee">Coffee</option>
      <option value="winter">Winter</option>
    </select>
  </div>

  <div class="form-control">
    <label class="label cursor-pointer">
      <div class="flex flex-col">
        <span class="label-text">{$t('show-token')}</span>
        <span class="label-text text-xs opacity-60">{$t('show-token-description')}</span>
      </div>
      <input type="checkbox" class="toggle" bind:checked={showToken} onchange={toggleShowToken} />
    </label>
  </div>

  <div class="form-control mt-2">
    <div class="flex items-center justify-between gap-4 py-2">
      <div class="flex flex-col">
        <span class="label-text">{$t('memories')}</span>
        <span class="label-text text-xs opacity-60">{$t('memories-description')}</span>
      </div>
      <button class="btn btn-sm btn-outline" onclick={() => memoryDialog.showModal()}>
        {$t('manage-memories')}
      </button>
    </div>
  </div>

  <div class="form-control">
    <label class="label cursor-pointer">
      <div class="flex flex-col">
        <span class="label-text">{$t('hide-output')}</span>
        <span class="label-text text-xs opacity-60">{$t('hide-output-description')}</span>
      </div>
      <input type="checkbox" class="toggle" bind:checked={hideOutput} onchange={toggleHideOutput} />
    </label>
  </div>

  <div class="form-control">
    <label class="label cursor-pointer">
      <div class="flex flex-col">
        <span class="label-text">{$t('agent-notifications')}</span>
        <span class="label-text text-xs opacity-60">{$t('agent-notifications-description')}</span>
      </div>
      <input
        type="checkbox"
        class="toggle"
        bind:checked={agentNotificationsEnabled}
        onchange={toggleAgentNotifications}
      />
    </label>
  </div>

  <div class="form-control">
    <!-- svelte-ignore a11y_label_has_associated_control -->
    <label class="label">
      <span class="label-text">{$t('language')}</span>
      <!-- tooltip that notes that the language may be machine translated -->
      <span class="tooltip tooltip-primary tooltip-left" data-tip={$t('language-tooltip')}>
        <span class="material-symbols-outlined">info</span>
      </span>
    </label>
    <select class="select" value={selectedLanguage} onchange={changeLanguage}>
      <option value="en">English</option>
      <option value="es">Español</option>
      <option value="ja">日本語</option>
      <option value="zh">简体中文</option>
      <option value="ko">한국어</option>
      <option value="ru">Русский</option>
    </select>
  </div>

  <div class="divider"></div>
  <h2 class="text-2xl font-bold mb-4">Agent integrations</h2>
  <McpSettingsCard />

  <div class="divider"></div>
  <h2 class="text-2xl font-bold mb-4">AI Provider</h2>

  <div class="form-control">
    <!-- svelte-ignore a11y_label_has_associated_control -->
    <label class="label">
      <span class="label-text">Provider</span>
    </label>
    <select class="select" value={aiProvider} onchange={updateAiProvider}>
      <option value="openai">OpenAI</option>
      <option value="openrouter">OpenRouter</option>
    </select>
  </div>

  <div class="form-control">
    <!-- svelte-ignore a11y_label_has_associated_control -->
    <label class="label">
      <span class="label-text">{$t('openai-api-key')}</span>
      {#if aiProvider === 'openrouter'}
        <span class="label-text-alt">Required for AI response moderation</span>
      {/if}
    </label>
    <input
      type={showToken ? 'text' : 'password'}
      class="input w-full"
      value={openaiApiKey}
      oninput={updateOpenAIKey}
      placeholder={$t('enter-your-openai-api-key')}
    />
  </div>

  <div class="form-control">
    <!-- svelte-ignore a11y_label_has_associated_control -->
    <label class="label">
      <span class="label-text">OpenRouter API Key</span>
    </label>
    <input
      type={showToken ? 'text' : 'password'}
      class="input w-full"
      value={openrouterApiKey}
      oninput={updateOpenRouterKey}
      placeholder="Enter your OpenRouter API key..."
    />
  </div>

  <div class="form-control">
    <!-- svelte-ignore a11y_label_has_associated_control -->
    <label class="label">
      <span class="label-text">Model</span>
    </label>
    <ModelPicker
      value={selectedAiModel}
      models={aiModels}
      provider={aiProvider}
      title="Select $chat model"
      placeholder={aiProvider === 'openrouter' ? 'openai/gpt-5.4-nano' : 'gpt-5.4-nano'}
      error={modelFetchError}
      isLoading={isLoadingModels}
      onRefresh={refreshAiModels}
      onChange={updateModelValue}
    />
    {#if selectedCapabilityError}<p class="text-xs text-warning mt-2">
        {selectedCapabilityError}
      </p>{/if}
    {#if !aiModels.some((model) => model.id === selectedAiModel)}
      <p class="text-xs opacity-70 mt-2">
        Capabilities describe the API; catalog membership and account access are unverified.
      </p>
    {/if}
    {#if capabilities?.chat === 'unsupported'}
      <p class="text-sm text-warning mt-2">
        Text conversation is unsupported through this model API. Choose another model.
      </p>
    {/if}
    {#if !capabilities || capabilities.chat === 'unknown'}
      <p class="text-xs opacity-70 mt-2">
        Text conversation capability unknown for this endpoint. Unverified IDs remain usable with
        provider-default reasoning.
      </p>
    {/if}
  </div>

  <div class="form-control">
    <!-- svelte-ignore a11y_label_has_associated_control -->
    <label class="label">
      <span class="label-text">Reasoning for $chat</span>
      <span class="label-text-alt">{reasoningCapabilityLabel(capabilities)}</span>
    </label>
    <select class="select" value={aiReasoningEffort} onchange={updateReasoningEffort}>
      {#if reasoningError}
        <option value={aiReasoningEffort}>Saved choice (unavailable)</option>
      {/if}
      {#each choices as choice}
        <option value={choice.value}>{choice.label}</option>
      {/each}
    </select>
    {#if reasoningError}<p class="text-sm text-warning mt-2">{reasoningError}</p>{/if}
  </div>

  <div class="form-control">
    <!-- svelte-ignore a11y_label_has_associated_control -->
    <label class="label">
      <span class="label-text">{$t('developer-prompt')}</span>
    </label>
    <textarea
      class="textarea w-full"
      value={developerPrompt}
      oninput={updateDeveloperPrompt}
      placeholder={$t('enter-your-custom-developer-prompt')}
      rows="4"></textarea>
  </div>

  {#if false}
    <div class="divider"></div>
    <h2 class="text-2xl font-bold mb-4">ayayaQ API (Optional)</h2>

    <div class="form-control">
      <label class="label cursor-pointer">
        <span class="label-text">Use ayayaQ API instead of OpenAI</span>
        <input
          type="checkbox"
          class="toggle toggle-primary"
          bind:checked={useCustomApi}
          onchange={toggleCustomApi}
        />
      </label>
    </div>
  {/if}

  <div class="divider"></div>
  <h2 class="text-2xl font-bold mb-4">{$t('advanced')}</h2>

  <div class="form-control">
    <label class="label cursor-pointer">
      <div class="flex flex-col">
        <span class="label-text">{$t('use-global-eval-scope')}</span>
        <span class="label-text text-xs opacity-60">{$t('use-global-eval-scope-description')}</span>
      </div>
      <input
        type="checkbox"
        class="toggle"
        bind:checked={useGlobalEvalScope}
        onchange={toggleGlobalEvalScope}
      />
    </label>
  </div>

  <div class="divider"></div>
  <h2 class="text-2xl font-bold mb-4">{$t('about')}</h2>
  <p>Version: {$t('version-value')}</p>
  <p>
    Author: <a href="https://github.com/ayayaQ" class="link link-primary" onclick={openExternalLink}
      >ayayaQ</a
    >
  </p>
  <p>
    Discord: <a
      href="https://discord.com/invite/mZp54sZ"
      class="link link-primary"
      onclick={openExternalLink}>Bot Commander for Discord Official Server</a
    >
  </p>
</div>

<MemoryManagerModal bind:dialog={memoryDialog} />
