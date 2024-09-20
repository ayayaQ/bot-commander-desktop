<script lang="ts">
  import CommandList from "./components/CommandList.svelte"
  import Help from "./components/Help.svelte"
  import Login from "./components/Login.svelte"

  let selectedMenu: 'commands' | 'help' | 'settings' = 'commands'
</script>


<div class="flex flex-row items-center justify-center h-screen">
  <div class='basis-1/3'>
    <Login />
  </div>
  <div class='basis-2/3 h-full overflow-y-auto flex flex-col'>
    <div class="flex-grow">
    {#if selectedMenu === 'commands'}
      <CommandList />
    {:else if selectedMenu === 'help'}
      <Help />
    {:else if selectedMenu === 'settings'}
      <h1>Settings</h1>
    {/if}
    </div>
    <div class="sticky bottom-0">
      <div class="btm-nav static bg-base-200">
        <button class={selectedMenu === 'commands' ? 'active bg-base-200' : ''} on:click={() => selectedMenu = 'commands'}>
          <span class="material-symbols-outlined">home</span>
        </button>
        <button class={selectedMenu === 'help' ? 'active bg-base-200' : ''} on:click={() => selectedMenu = 'help'}>
          <span class="material-symbols-outlined">help</span>
        </button>
        <button class={selectedMenu === 'settings' ? 'active bg-base-200' : ''} on:click={() => selectedMenu = 'settings'}>
          <span class="material-symbols-outlined">settings</span>
        </button>
      </div>
    </div>
  </div>
</div>