<script lang="ts">
  import CommandList from './components/CommandList.svelte'
  import InteractionList from './components/InteractionList.svelte'
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
  import { bottomNavVisible } from './stores/navigation'
  import { apiAuthStore } from './stores/apiAuth'

  let selectedMenu:
    | 'commands'
    | 'interactions'
    | 'help'
    | 'settings'
    | 'webhooks'
    | 'stats'
    | 'debugger' = 'commands'

  let leftPanelCollapsed = false

  onMount(async () => {
    await loadSettings()
    await loadBotStatus()
    // apply theme from the settings
    document.documentElement.setAttribute('data-theme', $settingsStore.theme)
    // check API auth status
    apiAuthStore.ipc.checkAuth()
  })
</script>

<TitleBar />

<div class="flex flex-row items-center justify-center h-[calc(100vh-40px)]">
  <div
    class={`${!leftPanelCollapsed ? 'basis-1/3 grow' : 'w-0'} h-full shrink-0 relative flex flex-col bg-base-200 transition-all duration-0 overflow-hidden`}
  >
    <div class="flex-grow overflow-y-auto">
      <Login />
    </div>
    <div class="w-full">
      <Console />
    </div>
  </div>
  <button
    class="h-full w-4 bg-base-300 hover:bg-primary transition-colors flex items-center justify-center group relative"
    on:click={() => (leftPanelCollapsed = !leftPanelCollapsed)}
    title={leftPanelCollapsed ? 'Show sidebar' : 'Hide sidebar'}
  >
    <span
      class="material-symbols-outlined text-base-content group-hover:text-primary-content text-xs absolute"
    >
      {leftPanelCollapsed ? 'chevron_right' : 'chevron_left'}
    </span>
  </button>
  <div class="basis-2/3 h-full overflow-y-auto flex flex-col shrink grow shadow-md">
    <div class="flex-grow">
      {#if selectedMenu === 'commands'}
        <CommandList />
      {:else if selectedMenu === 'interactions'}
        <InteractionList />
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
    {#if $bottomNavVisible}
      <div class="sticky bottom-0 z-10">
        <div class="btm-nav static bg-base-200">
          <button
            class={selectedMenu === 'commands' ? 'active bg-base-200' : ''}
            on:click={() => (selectedMenu = 'commands')}
          >
            <span class="material-symbols-outlined">chat</span>
          </button>
          <button
            class={selectedMenu === 'interactions' ? 'active bg-base-200' : ''}
            on:click={() => (selectedMenu = 'interactions')}
          >
            <span class="material-symbols-outlined">smart_button</span>
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
    {/if}
  </div>
</div>
