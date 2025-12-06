<script lang="ts">
  import CommandList from './components/CommandList.svelte'
  import Help from './components/Help.svelte'
  import Login from './components/Login.svelte'
  import Settings from './components/Settings.svelte'
  import Webhooks from './components/Webhooks.svelte'
  import Console from './components/Console.svelte'
  import { onMount } from 'svelte'
  import { loadSettings, settingsStore } from './stores/settings'
  import { loadBotStatus } from './stores/status'
  import Stats from './components/Stats.svelte'
  import StateViewer from './components/StateViewer.svelte'
  import TitleBar from './components/TitleBar.svelte'

  let selectedMenu: 'commands' | 'help' | 'settings' | 'webhooks' | 'stats' | 'debugger' =
    'commands'

  onMount(async () => {
    await loadSettings()
    await loadBotStatus()
    // apply theme from the settings
    document.documentElement.setAttribute('data-theme', $settingsStore.theme)
  })
</script>

<TitleBar />

<div class="flex flex-row items-center justify-center h-[calc(100vh-40px)]">
  <div class="basis-1/3 h-full shrink-0 grow relative flex flex-col bg-base-200">
    <div class="flex-grow overflow-y-auto">
      <Login />
    </div>
    <div class="w-full">
      <Console />
    </div>
  </div>
  <div class="basis-2/3 h-full overflow-y-auto flex flex-col shrink grow shadow-md">
    <div class="flex-grow">
      {#if selectedMenu === 'commands'}
        <CommandList />
      {:else if selectedMenu === 'help'}
        <Help />
      {:else if selectedMenu === 'settings'}
        <Settings />
      {:else if selectedMenu === 'webhooks'}
        <Webhooks />
      {:else if selectedMenu === 'stats'}
        <Stats />
      {:else if selectedMenu === 'debugger'}
        <StateViewer />
      {/if}
    </div>
    <div class="sticky bottom-0">
      <div class="btm-nav static bg-base-200">
        <button
          class={selectedMenu === 'commands' ? 'active bg-base-200' : ''}
          on:click={() => (selectedMenu = 'commands')}
        >
          <span class="material-symbols-outlined">home</span>
        </button>
        <button
          class={selectedMenu === 'webhooks' ? 'active bg-base-200' : ''}
          on:click={() => (selectedMenu = 'webhooks')}
        >
          <span class="material-symbols-outlined">webhook</span>
        </button>
        <button
          class={selectedMenu === 'stats' ? 'active bg-base-200' : ''}
          on:click={() => (selectedMenu = 'stats')}
        >
          <span class="material-symbols-outlined">bar_chart</span>
        </button>
        <button
          class={selectedMenu === 'debugger' ? 'active bg-base-200' : ''}
          on:click={() => (selectedMenu = 'debugger')}
        >
          <span class="material-symbols-outlined">bug_report</span>
        </button>
        <button
          class={selectedMenu === 'help' ? 'active bg-base-200' : ''}
          on:click={() => (selectedMenu = 'help')}
        >
          <span class="material-symbols-outlined">help</span>
        </button>
        <button
          class={selectedMenu === 'settings' ? 'active bg-base-200' : ''}
          on:click={() => (selectedMenu = 'settings')}
        >
          <span class="material-symbols-outlined">settings</span>
        </button>
      </div>
    </div>
  </div>
</div>
