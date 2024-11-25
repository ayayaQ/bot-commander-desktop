<script lang="ts">
  import { onMount } from 'svelte'
  import { connectionStore } from '../stores/connection'
  import Status from './Status.svelte'
  import { botStatusStore } from '../stores/status'
  import type { BotStatus } from '../types/types'
  import { settingsStore } from '../stores/settings'

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

  function getActivityPreposition(status: BotStatus) {
    if (status.activity === 'Listening') {
      return ' to'
    } else if (status.activity === 'Competing') {
      return ' in'
    }

    return ''
  }

  onMount(async () => {
    token = await connectionStore.ipc.getToken()
  })
</script>

<div class="flex flex-col items-center justify-center min-h-[calc(100vh-40px)] bg-base-200 p-4">
  <div class="card w-96 bg-base-100 shadow-xl">
    <div class="card-body items-center text-center">
      {#if avatar}
        <div class="avatar placeholder">
          <div class={`rounded-full ${$botStatusStore.status === 'Online' ? 'outline outline-2 outline-green-500' : $botStatusStore.status === 'Do Not Disturb' ? 'outline outline-2 outline-red-500' : $botStatusStore.status === 'Invisible' ? 'outline outline-2 outline-gray-500' : 'outline outline-2 outline-yellow-500'}`}>
            <img src={avatar} alt="Avatar" />
          </div>
        </div>
      {:else}
        <div class="avatar placeholder mb-14">
          <div class="bg-neutral text-neutral-content w-24 rounded-full">
            <span class="text-3xl select-none">Bot</span>
          </div>
        </div>
      {/if}

      
      {#if !$connectionStore.connected}
        {#if $settingsStore.showToken}
          <input
            type="text"
            placeholder="Token"
            class="input input-bordered w-full max-w-xs"
            bind:value={token}
          />
        {:else}
          <input
            type="password"
          placeholder="Token"
            class="input input-bordered w-full max-w-xs"
            bind:value={token}
          />
        {/if}
      {:else}
        <h2 class="card-title">{username}</h2>
      <div class="text-sm"><span>{$botStatusStore.activity}{getActivityPreposition($botStatusStore)}</span><span class='font-medium'>&nbsp;{$botStatusStore.activityDetails}</span></div>
        <input
          type={$settingsStore.showToken ? "text" : "password"}
          placeholder="Token"
          disabled
          class="input input-bordered w-full max-w-xs"
          value={$connectionStore.token}
        />
      {/if}
      {#if !$connectionStore.connected}
        <button class="btn btn-primary w-full" on:click={handleLogin}><span class="material-symbols-outlined">login</span>Login</button>
      {:else}
        <button class="btn btn-primary w-full" on:click={handleLogout}><span class="material-symbols-outlined">logout</span>Logout</button>
        <button class="btn btn-primary w-full" on:click={generateInvite}><span class="material-symbols-outlined">mail</span>Invite</button>
      {/if}
      <div class="collapse bg-base-200">
        <input type="checkbox" />
        <div class="collapse-title text-xl font-medium px-0"><div class="flex items-center justify-center gap-2"><span class="material-symbols-outlined">settings</span><span>Status</span></div></div>
        <div class="collapse-content">
          <Status />
        </div>
      </div>
    </div>
  </div>
</div>
