<script lang="ts">
  import { onMount } from 'svelte'

  let isMaximized = $state(false)
  let hasUpdate = $state(false)
  let updateInfo: any = $state(null)
  let checkingUpdate = false
  let platform = $state('')
  let isMac = $derived(platform === 'darwin')

  onMount(async () => {
    platform = await window.electron.ipcRenderer.invoke('get-platform')

    isMaximized = await window.electron.ipcRenderer.invoke('is-window-maximized')
    ;window.electron.ipcRenderer.on(
      'window-state-changed',
      (_event: any, maximized: boolean) => {
        isMaximized = maximized
      }
    )

    checkForUpdates()
  })

  async function checkForUpdates() {
    if (checkingUpdate) return

    checkingUpdate = true
    try {
      updateInfo = await window.electron.ipcRenderer.invoke('check-for-updates')
      hasUpdate = updateInfo.hasUpdate
    } catch (error) {
      console.error('Failed to check for updates:', error)
    } finally {
      checkingUpdate = false
    }
  }

  function openReleaseUrl() {
    if (updateInfo?.releaseUrl) {
      ;window.electron.ipcRenderer.invoke('open-external-url', updateInfo.releaseUrl)
    }
  }

  function minimize() {
    ;window.electron.ipcRenderer.send('minimize-window')
  }

  function maximize() {
    ;window.electron.ipcRenderer.send('maximize-window')
  }

  function close() {
    ;window.electron.ipcRenderer.send('close-window')
  }
</script>

<div class="titlebar bg-base-300 text-base-content flex justify-between items-center h-10 px-4">
  {#if isMac}
    <div class="flex-1"></div>
  {/if}
  <div class="flex items-center gap-2" class:titlebar-center={isMac}>
    <span class="material-symbols-outlined icon-light fill">chat_bubble</span>
    <div class="titlebar-title font-semibold">BCFD</div>
  </div>
  <div class="flex-1 flex justify-end items-center gap-1">
    {#if hasUpdate && updateInfo}
      <div class="update-notification flex items-center gap-2 mr-2">
        <button
          class="btn btn-primary btn-sm flex items-center gap-1"
          onclick={openReleaseUrl}
          title="New version {updateInfo.latestVersion} available"
        >
          <span class="material-symbols-outlined icon-small">download</span>
          <span class="text-xs">Update Available</span>
        </button>
      </div>
    {/if}
    {#if !isMac}
      <div class="titlebar-buttons flex">
        <button class="btn btn-ghost btn-square btn-sm" onclick={minimize}>
          <span class="material-symbols-outlined icon-light">remove</span>
        </button>
        <button class="btn btn-ghost btn-square btn-sm" onclick={maximize}>
          <span class="material-symbols-outlined icon-light">
            {isMaximized ? 'select_window_2' : 'crop_square'}
          </span>
        </button>
        <button class="btn btn-ghost btn-square btn-sm" onclick={close}>
          <span class="material-symbols-outlined icon-light">close</span>
        </button>
      </div>
    {/if}
    {#if isMac}
      <div class="flex-1"></div>
    {/if}
  </div>
</div>

<style>
  .titlebar {
    -webkit-app-region: drag;
  }

  .titlebar-center {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
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
