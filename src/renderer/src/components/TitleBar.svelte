<script lang="ts">
  import { onMount } from 'svelte'

  let isMaximized = false
  let hasUpdate = false
  let updateInfo: any = null
  let checkingUpdate = false

  onMount(async () => {
    // Initial state - need to await the invoke call
    isMaximized = await (window as any).electron.ipcRenderer.invoke('is-window-maximized')

    // Listen for window state changes
    ;(window as any).electron.ipcRenderer.on(
      'window-state-changed',
      (_event: any, maximized: boolean) => {
        console.log('Window state changed:', maximized)
        isMaximized = maximized
      }
    )

    // Check for updates on mount
    checkForUpdates()
  })

  async function checkForUpdates() {
    if (checkingUpdate) return

    checkingUpdate = true
    try {
      updateInfo = await (window as any).electron.ipcRenderer.invoke('check-for-updates')
      hasUpdate = updateInfo.hasUpdate
    } catch (error) {
      console.error('Failed to check for updates:', error)
    } finally {
      checkingUpdate = false
    }
  }

  function openReleaseUrl() {
    if (updateInfo?.releaseUrl) {
      ;(window as any).electron.ipcRenderer.invoke('open-external-url', updateInfo.releaseUrl)
    }
  }

  function minimize() {
    ;(window as any).electron.ipcRenderer.send('minimize-window')
  }

  function maximize() {
    ;(window as any).electron.ipcRenderer.send('maximize-window')
  }

  function close() {
    ;(window as any).electron.ipcRenderer.send('close-window')
  }
</script>

<div class="titlebar bg-base-300 text-base-content flex justify-between items-center h-10 px-4">
  <div class="flex items-center gap-2">
    <span class="material-symbols-outlined icon-light fill">chat_bubble</span>
    <div class="titlebar-title font-semibold">BCFD</div>
  </div>
  <div class="flex items-center gap-1">
    {#if hasUpdate && updateInfo}
      <div class="update-notification flex items-center gap-2 mr-2">
        <button
          class="btn btn-primary btn-sm flex items-center gap-1"
          on:click={openReleaseUrl}
          title="New version {updateInfo.latestVersion} available"
        >
          <span class="material-symbols-outlined icon-small">download</span>
          <span class="text-xs">Update Available</span>
        </button>
      </div>
    {/if}
    <div class="titlebar-buttons flex">
      <button class="btn btn-ghost btn-square btn-sm" on:click={minimize}>
        <span class="material-symbols-outlined icon-light">remove</span>
      </button>
      <button class="btn btn-ghost btn-square btn-sm" on:click={maximize}>
        <span class="material-symbols-outlined icon-light">
          {isMaximized ? 'select_window_2' : 'crop_square'}
        </span>
      </button>
      <button class="btn btn-ghost btn-square btn-sm" on:click={close}>
        <span class="material-symbols-outlined icon-light">close</span>
      </button>
    </div>
  </div>
</div>

<style>
  .titlebar {
    -webkit-app-region: drag;
  }

  .titlebar-buttons {
    -webkit-app-region: no-drag;
  }

  .update-notification {
    -webkit-app-region: no-drag;
  }

  .icon-light {
    font-variation-settings:
      'FILL' 0,
      'wght' 200,
      'GRAD' 0,
      'opsz' 24;
  }

  .icon-light.fill {
    font-variation-settings:
      'FILL' 1,
      'wght' 200,
      'GRAD' 0,
      'opsz' 24;
  }

  .icon-small {
    font-size: 16px;
    font-variation-settings:
      'FILL' 0,
      'wght' 300,
      'GRAD' 0,
      'opsz' 20;
  }
</style>
