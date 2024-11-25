<script lang="ts">
  import { onMount } from 'svelte'
  import { saveSettings, settingsStore } from '../stores/settings'

  let selectedTheme: string
  let showToken: boolean

  function changeTheme(event) {
    let theme = event.target.value
    document.documentElement.setAttribute('data-theme', theme)
    saveSettings({ ...$settingsStore, theme: theme })
  }

  function toggleShowToken() {
    saveSettings({ ...$settingsStore, showToken: showToken })
  }

  onMount(() => {
    selectedTheme = $settingsStore.theme
    showToken = $settingsStore.showToken
  })
</script>

<div class="p-4">
  <h2 class="text-2xl font-bold mb-4">Settings</h2>
  <div class="form-control">
    <!-- svelte-ignore a11y-label-has-associated-control -->
    <label class="label">
      <span class="label-text">Theme</span>
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
      <span class="label-text">Show Token</span>
      <input 
        type="checkbox" 
        class="toggle" 
        bind:checked={showToken}
        on:change={toggleShowToken}
      />
    </label>
  </div>

  <div class="divider"></div>
  <h2 class="text-2xl font-bold mb-4">About</h2>
  <p>Version: 1.0.0</p>
  <p>Author: <a href="https://github.com/ayayaQ" class="link link-primary">ayayaQ</a></p>
  <p>Discord: <a href="https://discord.com/invite/mZp54sZ" class="link link-primary">Bot Commander for Discord Official Server</a></p>
</div>
