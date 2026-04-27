<script lang="ts">
  import { onMount } from 'svelte'
  import {
    getSelectedModelForProvider,
    saveSettings,
    settingsStore,
    withSelectedModelForProvider
  } from '../stores/settings'
  import { currentLanguage, t } from '../stores/localisation'
  import HeaderBar from './HeaderBar.svelte'
  import ApiAuth from './ApiAuth.svelte'
  import ModelPicker from './ModelPicker.svelte'

  let selectedTheme: string = $state()
  let showToken: boolean = $state()
  let selectedLanguage: string = $state()
  let aiProvider: 'openai' | 'openrouter' = $state('openai')
  let openaiApiKey: string = $state()
  let openrouterApiKey: string = $state('')
  let selectedAiModel: string = $state('gpt-4.1-nano')
  let aiReasoningEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' = $state('none')
  let developerPrompt: string = $state()
  let useCustomApi: boolean = $state()
  let useLegacyInterpreter: boolean = $state()
  let hideOutput: boolean = $state()
  let disableReasoningApi: boolean = $state()
  let aiModels: Array<{ id: string; name: string; supportsStructuredOutputs?: boolean }> = $state(
    []
  )
  let isLoadingModels = $state(false)
  let modelFetchError = $state('')

  function changeTheme(event) {
    let theme = event.target.value
    document.documentElement.setAttribute('data-theme', theme)
    saveSettings({ ...$settingsStore, theme: theme })
  }

  function changeLanguage(event) {
    let language = event.target.value
    saveSettings({ ...$settingsStore, language: language })

    // update localisation
    currentLanguage.set(language)
  }

  function toggleShowToken() {
    saveSettings({ ...$settingsStore, showToken: showToken })
  }

  function toggleHideOutput() {
    saveSettings({ ...$settingsStore, hideOutput })
  }

  function updateOpenAIKey(event) {
    openaiApiKey = event.target.value
    saveSettings({ ...$settingsStore, openaiApiKey })
  }

  function updateOpenRouterKey(event) {
    openrouterApiKey = event.target.value
    saveSettings({ ...$settingsStore, openrouterApiKey })
  }

  async function updateAiProvider(event) {
    aiProvider = event.target.value
    selectedAiModel = getSelectedModelForProvider($settingsStore, aiProvider)
    await saveSettings({ ...$settingsStore, aiProvider, selectedAiModel })
    await refreshAiModels()
  }

  function updateModelValue(model: string) {
    if (!model) return
    selectedAiModel = model
    saveSettings(withSelectedModelForProvider($settingsStore, aiProvider, selectedAiModel))
  }

  function updateReasoningEffort(event) {
    aiReasoningEffort = event.target.value
    saveSettings({ ...$settingsStore, aiReasoningEffort })
  }

  async function refreshAiModels() {
    if (aiProvider === 'openai' && !openaiApiKey) {
      aiModels = []
      modelFetchError =
        'Add an OpenAI API key to fetch OpenAI models. You can still enter a custom model ID.'
      return
    }
    isLoadingModels = true
    modelFetchError = ''
    try {
      aiModels = await window.electron.ipcRenderer.invoke('fetch-ai-models')
    } catch (error) {
      modelFetchError = error instanceof Error ? error.message : 'Failed to fetch models'
    } finally {
      isLoadingModels = false
    }
  }

  function updateDeveloperPrompt(event) {
    developerPrompt = event.target.value
    saveSettings({ ...$settingsStore, developerPrompt })
  }

  function toggleCustomApi() {
    saveSettings({ ...$settingsStore, useCustomApi })
  }

  function toggleLegacyInterpreter() {
    saveSettings({ ...$settingsStore, useLegacyInterpreter })
  }

  function toggleDisableReasoningApi() {
    saveSettings({ ...$settingsStore, disableReasoningApi })
  }

  function openExternalLink(event) {
    event.preventDefault()
    const url = event.target.href
    window.electron.ipcRenderer.invoke('open-external-url', url)
  }

  onMount(() => {
    selectedTheme = $settingsStore.theme
    showToken = $settingsStore.showToken
    selectedLanguage = $settingsStore.language
    aiProvider = $settingsStore.aiProvider || 'openai'
    openaiApiKey = $settingsStore.openaiApiKey
    openrouterApiKey = $settingsStore.openrouterApiKey || ''
    selectedAiModel = getSelectedModelForProvider($settingsStore, aiProvider)
    aiReasoningEffort = $settingsStore.aiReasoningEffort || 'none'
    developerPrompt = $settingsStore.developerPrompt
    useCustomApi = $settingsStore.useCustomApi
    useLegacyInterpreter = $settingsStore.useLegacyInterpreter
    hideOutput = $settingsStore.hideOutput
    disableReasoningApi = $settingsStore.disableReasoningApi
    refreshAiModels()
  })
</script>

<HeaderBar>
  <h2 class="text-2xl font-bold">{$t('settings')}</h2>
</HeaderBar>

<div class="p-4">
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
        <span class="label-text-alt">Required for moderation</span>
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

  {#if aiProvider === 'openrouter'}
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
  {/if}

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
      placeholder={aiProvider === 'openrouter' ? 'openai/gpt-5.2' : 'gpt-4.1-nano'}
      error={modelFetchError}
      isLoading={isLoadingModels}
      onRefresh={refreshAiModels}
      onChange={updateModelValue}
    />
  </div>

  <div class="form-control">
    <!-- svelte-ignore a11y_label_has_associated_control -->
    <label class="label">
      <span class="label-text">Reasoning for $chat</span>
    </label>
    <select class="select" value={aiReasoningEffort} onchange={updateReasoningEffort}>
      <option value="none">None</option>
      <option value="minimal">Minimal</option>
      <option value="low">Low</option>
      <option value="medium">Medium</option>
      <option value="high">High</option>
      <option value="xhigh">Extra high</option>
    </select>
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
      rows="4"
    ></textarea>
  </div>

  <div class="form-control mt-4">
    <label class="label cursor-pointer">
      <div class="flex flex-col">
        <span class="label-text">{$t('disable-reasoning-api')}</span>
        <span class="label-text text-xs opacity-60">{$t('disable-reasoning-api-description')}</span>
      </div>
      <input
        type="checkbox"
        class="toggle"
        bind:checked={disableReasoningApi}
        onchange={toggleDisableReasoningApi}
      />
    </label>
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
        <span class="label-text">{$t('use-legacy-interpreter')}</span>
        <span class="label-text text-xs opacity-60">{$t('use-legacy-interpreter-description')}</span
        >
      </div>
      <input
        type="checkbox"
        class="toggle"
        bind:checked={useLegacyInterpreter}
        onchange={toggleLegacyInterpreter}
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
