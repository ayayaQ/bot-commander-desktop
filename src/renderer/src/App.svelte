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
  import { onboardingStore } from './stores/onboarding'
  import Stats from './components/Stats.svelte'
  import StateViewer from './components/StateViewer.svelte'
  import TitleBar from './components/TitleBar.svelte'
  import { bottomNavVisible } from './stores/navigation'
  import { apiAuthStore } from './stores/apiAuth'
  import AgentPanel from './components/AgentPanel.svelte'
  import {
    agentNavigationStatus,
    destroyAgentListeners,
    initializeAgentSessions,
    selectAgentSession,
    setAgentViewActive
  } from './stores/agent'

  let selectedMenu:
    | 'commands'
    | 'interactions'
    | 'help'
    | 'settings'
    | 'webhooks'
    | 'stats'
    | 'debugger'
    | 'agent' = $state('commands')

  let leftPanelCollapsed = $state(false)
  let windowFocused = $state(true)

  function selectTab(tab: string) {
    selectedMenu = tab as typeof selectedMenu
  }

  $effect(() => {
    setAgentViewActive(selectedMenu === 'agent' && windowFocused)
  })

  onMount(() => {
    const handleFocus = () => (windowFocused = true)
    const handleBlur = () => (windowFocused = false)
    const handleAgentNavigation = async (_event: unknown, sessionId: string) => {
      await initializeAgentSessions()
      selectedMenu = 'agent'
      await selectAgentSession(sessionId)
    }

    windowFocused = document.hasFocus()
    window.addEventListener('focus', handleFocus)
    window.addEventListener('blur', handleBlur)
    window.electron.ipcRenderer.on('agent:navigate', handleAgentNavigation)
    void initializeAgentSessions()
    void (async () => {
      await loadSettings()
      await loadBotStatus()
      await onboardingStore.load()
      // apply theme from the settings
      document.documentElement.setAttribute('data-theme', $settingsStore.theme)
      // check API auth status
      apiAuthStore.ipc.checkAuth()
    })()

    return () => {
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('blur', handleBlur)
      window.electron.ipcRenderer.removeListener('agent:navigate', handleAgentNavigation)
      destroyAgentListeners()
    }
  })
</script>

<TitleBar />

<div class="flex flex-row items-center justify-center h-[calc(100vh-40px)]">
  <div
    class={`${!leftPanelCollapsed ? 'basis-1/3 grow' : 'w-0'} h-full shrink-0 relative flex flex-col bg-base-200 transition-all duration-0 overflow-hidden`}
  >
    <div class="grow overflow-y-auto">
      <Login onSelectTab={selectTab} />
    </div>
    <div class="w-full">
      <Console />
    </div>
  </div>
  <button
    class="h-full w-4 bg-base-300 hover:bg-primary transition-colors flex items-center justify-center group relative"
    onclick={() => (leftPanelCollapsed = !leftPanelCollapsed)}
    title={leftPanelCollapsed ? 'Show sidebar' : 'Hide sidebar'}
  >
    <span
      class="material-symbols-outlined text-base-content group-hover:text-primary-content text-xs absolute"
    >
      {leftPanelCollapsed ? 'chevron_right' : 'chevron_left'}
    </span>
  </button>
  <div class="basis-2/3 h-full overflow-hidden flex flex-col shrink grow shadow-md">
    <div class="grow min-h-0 overflow-y-auto">
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
      {:else if selectedMenu === 'agent'}
        <AgentPanel />
      {/if}
    </div>
    {#if $bottomNavVisible}
      <div class="sticky bottom-0 z-10">
        <div class="dock dock-bottom static bg-base-200">
          <button
            class={selectedMenu === 'commands' ? 'dock-active' : ''}
            onclick={() => (selectedMenu = 'commands')}
          >
            <span class="material-symbols-outlined">chat</span>
          </button>
          <button
            class={selectedMenu === 'interactions' ? 'dock-active' : ''}
            onclick={() => (selectedMenu = 'interactions')}
          >
            <span class="material-symbols-outlined">smart_button</span>
          </button>
          <button
            class={selectedMenu === 'webhooks' ? 'dock-active' : ''}
            onclick={() => (selectedMenu = 'webhooks')}
          >
            <span class="material-symbols-outlined">webhook</span>
          </button>
          <button
            class={selectedMenu === 'stats' ? 'dock-active' : ''}
            onclick={() => (selectedMenu = 'stats')}
          >
            <span class="material-symbols-outlined">bar_chart</span>
          </button>
          <button
            class={selectedMenu === 'debugger' ? 'dock-active' : ''}
            onclick={() => (selectedMenu = 'debugger')}
          >
            <span class="material-symbols-outlined">bug_report</span>
          </button>
          <button
            class="relative {selectedMenu === 'agent' ? 'dock-active' : ''}"
            onclick={() => (selectedMenu = 'agent')}
            title={$agentNavigationStatus.label}
            aria-label={$agentNavigationStatus.label}
          >
            <span class="material-symbols-outlined">terminal</span>
            {#if $agentNavigationStatus.kind === 'approval'}
              <span
                class="badge badge-warning badge-sm absolute right-2 top-1 min-w-5 px-1"
                aria-hidden="true">{$agentNavigationStatus.count}</span
              >
            {:else if $agentNavigationStatus.kind === 'running'}
              <span
                class="absolute right-3 top-2 size-2 rounded-full bg-info animate-pulse"
                aria-hidden="true"
              ></span>
            {:else if $agentNavigationStatus.kind === 'error'}
              <span class="absolute right-3 top-2 size-2 rounded-full bg-error" aria-hidden="true"
              ></span>
            {:else if $agentNavigationStatus.kind === 'completed'}
              <span class="absolute right-3 top-2 size-2 rounded-full bg-success" aria-hidden="true"
              ></span>
            {/if}
          </button>
          <button
            class={selectedMenu === 'help' ? 'dock-active' : ''}
            onclick={() => (selectedMenu = 'help')}
          >
            <span class="material-symbols-outlined">help</span>
          </button>
          <button
            class={selectedMenu === 'settings' ? 'dock-active' : ''}
            onclick={() => (selectedMenu = 'settings')}
          >
            <span class="material-symbols-outlined">settings</span>
          </button>
        </div>
      </div>
    {/if}
  </div>
</div>
