<script lang="ts">
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
    <img src="src/assets/app_icon.png" alt="BCFD Icon" class="w-6 h-6 rounded-full" />
  <div class="titlebar-title font-semibold">BCFD</div>
</div>
  <div class="titlebar-buttons flex">
    <button class="btn btn-ghost btn-square btn-sm" on:click={minimize}>
      <span class="material-symbols-outlined icon-light">remove</span>
    </button>
    <button class="btn btn-ghost btn-square btn-sm" on:click={maximize}>
      <span class="material-symbols-outlined icon-light">select_window_2</span>
    </button>
    <button class="btn btn-ghost btn-square btn-sm" on:click={close}>
      <span class="material-symbols-outlined icon-light">close</span>
    </button>
  </div>
</div>

<style>
  .titlebar {
    -webkit-app-region: drag;
  }

  .titlebar-buttons {
    -webkit-app-region: no-drag;
  }

  .icon-light {
    font-variation-settings: 'FILL' 0, 'wght' 200, 'GRAD' 0, 'opsz' 24;
  }
</style>
