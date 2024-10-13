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
  <div class="titlebar-title font-semibold">BCFD</div>
  <div class="titlebar-buttons flex">
    <button class="btn btn-ghost btn-square btn-sm" on:click={minimize}>
      <span class="material-symbols-outlined">remove</span>
    </button>
    <button class="btn btn-ghost btn-square btn-sm" on:click={maximize}>
      <span class="material-symbols-outlined">crop_square</span>
    </button>
    <button class="btn btn-ghost btn-square btn-sm" on:click={close}>
      <span class="material-symbols-outlined">close</span>
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
</style>
