<script lang="ts">
  import { onMount } from 'svelte'
  import { saveSettings, settingsStore } from '../stores/settings'
  import { currentLanguage, t } from '../stores/localisation'
  import HeaderBar from './HeaderBar.svelte'

  let selectedTheme: string
  let showToken: boolean
  let selectedLanguage: string
  let openaiApiKey: string
  let openaiModel: 'gpt-4o' | 'gpt-4o-mini'

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

  function updateOpenAIKey(event) {
    openaiApiKey = event.target.value
    saveSettings({ ...$settingsStore, openaiApiKey })
  }

  function updateOpenAIModel(event) {
    openaiModel = event.target.value
    saveSettings({ ...$settingsStore, openaiModel })
  }

  onMount(() => {
    selectedTheme = $settingsStore.theme
    showToken = $settingsStore.showToken
    selectedLanguage = $settingsStore.language
    openaiApiKey = $settingsStore.openaiApiKey
    openaiModel = $settingsStore.openaiModel
  })
</script>

<HeaderBar>
  <h2 class="text-2xl font-bold">{$t('settings')}</h2>
</HeaderBar>

<div class="p-4">
  <h2 class="text-2xl font-bold mb-4">General</h2>
  <div class="form-control">
    <!-- svelte-ignore a11y-label-has-associated-control -->
    <label class="label">
      <span class="label-text">{$t('theme')}</span>
    </label>
    <select class="select select-bordered" value={selectedTheme} on:change={changeTheme}>
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
      <span class="label-text">{$t('show-token')}</span>
      <input type="checkbox" class="toggle" bind:checked={showToken} on:change={toggleShowToken} />
    </label>
  </div>

  <div class="form-control">
    <!-- svelte-ignore a11y-label-has-associated-control -->
    <label class="label">
      <span class="label-text">{$t('language')}</span>
      <!-- tooltip that notes that the language may be machine translated -->
      <span class="tooltip tooltip-primary tooltip-left" data-tip={$t('language-tooltip')}>
        <span class="material-symbols-outlined">info</span>
      </span>
    </label>
    <select class="select select-bordered" value={selectedLanguage} on:change={changeLanguage}>
      <option value="en">English</option>
      <option value="es">Español</option>
      <option value="ja">日本語</option>
      <option value="zh">简体中文</option>
      <option value="ko">한국어</option>
      <option value="ru">Русский</option>
    </select>
  </div>

  <div class="divider"></div>
  <h2 class="text-2xl font-bold mb-4">OpenAI</h2>

  <div class="form-control">
    <label class="label">
      <span class="label-text">OpenAI API Key</span>
    </label>
    <input
      type={showToken ? 'text' : 'password'}
      class="input input-bordered"
      value={openaiApiKey}
      on:input={updateOpenAIKey}
      placeholder="Enter your OpenAI API key"
    />
  </div>

  <div class="form-control">
    <label class="label">
      <span class="label-text">OpenAI Model</span>
    </label>
    <select class="select select-bordered" value={openaiModel} on:change={updateOpenAIModel}>
      <option value="gpt-4o">GPT-4o</option>
      <option value="gpt-4o-mini">GPT-4o Mini</option>
    </select>
  </div>

  <div class="divider"></div>
  <h2 class="text-2xl font-bold mb-4">{$t('about')}</h2>
  <p>Version: {$t('version-value')}</p>
  <p>Author: <a href="https://github.com/ayayaQ" class="link link-primary">ayayaQ</a></p>
  <p>
    Discord: <a href="https://discord.com/invite/mZp54sZ" class="link link-primary"
      >Bot Commander for Discord Official Server</a
    >
  </p>
</div>
