<script lang="ts">
  import { onMount } from 'svelte'
  import { connectionStore } from '../stores/connection'

  $: username = $connectionStore.username
  $: avatar = $connectionStore.avatar

  let token = '';
  function handleLogin() {
    connectionStore.ipc.connect(token)
  }

  function handleLogout() {
    connectionStore.ipc.disconnect()
  }

  async function generateInvite() {
    // open the given link in the default browser
    let invite = await connectionStore.ipc.generateInvite()
    console.log(invite)
    window.open(invite, '_blank')
  }

  onMount(async () => {
    token = await connectionStore.ipc.getToken()
    console.log(token)
  })
</script>

<div class="flex flex-col items-center justify-center min-h-screen bg-base-200">
  <div class="card w-96 bg-base-100 shadow-xl">
    <div class="card-body items-center text-center">
      {#if avatar}
        <div class="avatar placeholder mb-4">
          <div class="rounded-full">
            <img src={avatar} alt="Avatar" />
          </div>
        </div>
      {:else}
        <div class="avatar placeholder">
          <div class="bg-neutral text-neutral-content w-24 rounded-full">
            <span class="text-3xl select-none">Bot</span>
          </div>
        </div>
      {/if}

      <h2 class="card-title mb-4">{username}</h2>
      {#if !$connectionStore.connected}
        <input
          type="password"
          placeholder="Token"
          class="input input-bordered w-full max-w-xs mb-4"
          bind:value={token}
        />
      {:else}
        <input
          type="password"
          placeholder="Token"
          disabled
          class="input input-bordered w-full max-w-xs mb-4"
          value={$connectionStore.token}
        />
      {/if}
      {#if !$connectionStore.connected}
        <button class="btn btn-primary w-full" on:click={handleLogin}>Login</button>
      {:else}
        <button class="btn btn-primary w-full" on:click={handleLogout}>Logout</button>
        <button class="btn btn-primary w-full" on:click={generateInvite}>Invite to Server</button>
      {/if}
    </div>
  </div>
</div>
