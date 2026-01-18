<script lang="ts">
  import { apiAuthStore } from '../stores/apiAuth'
  import { t } from '../stores/localisation'

  let username = ''
  let password = ''
  let mode: 'login' | 'register' = 'login'

  $: isAuthenticated = $apiAuthStore.authenticated
  $: isLoading = $apiAuthStore.isLoading
  $: error = $apiAuthStore.error
  $: storedUsername = $apiAuthStore.username

  async function handleSubmit() {
    if (!username.trim() || !password.trim()) return

    if (mode === 'register') {
      await apiAuthStore.ipc.register(username.trim(), password)
    } else {
      await apiAuthStore.ipc.login(username.trim(), password)
    }
  }

  async function handleLogout() {
    await apiAuthStore.ipc.logout()
    username = ''
    password = ''
  }

  function toggleMode() {
    mode = mode === 'login' ? 'register' : 'login'
    apiAuthStore.clearError()
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      handleSubmit()
    }
  }
</script>

<div class="form-control w-full">
  {#if isAuthenticated}
    <!-- Authenticated state -->
    <div class="flex items-center justify-between bg-base-200 rounded-lg p-3">
      <div class="flex items-center gap-2">
        <span class="material-symbols-outlined text-success">check_circle</span>
        <div>
          <span class="text-sm text-base-content/70">{$t('signed-in-as')}</span>
          <span class="font-medium">{storedUsername}</span>
        </div>
      </div>
      <button class="btn btn-ghost btn-sm" on:click={handleLogout}>
        <span class="material-symbols-outlined">logout</span>
        {$t('sign-out')}
      </button>
    </div>
  {:else}
    <!-- Login/Register form -->
    <div class="space-y-3">
      <div class="flex gap-2">
        <input
          type="text"
          placeholder={$t('username')}
          class="input input-bordered flex-1"
          class:input-error={error}
          bind:value={username}
          on:keydown={handleKeydown}
          disabled={isLoading}
          autocomplete="username"
        />
      </div>

      <div class="flex gap-2">
        <input
          type="password"
          placeholder={$t('password')}
          class="input input-bordered flex-1"
          class:input-error={error}
          bind:value={password}
          on:keydown={handleKeydown}
          disabled={isLoading}
          autocomplete={mode === 'register' ? 'new-password' : 'current-password'}
        />
        <button
          class="btn btn-primary"
          on:click={handleSubmit}
          disabled={isLoading || !username.trim() || !password.trim()}
        >
          {#if isLoading}
            <span class="loading loading-spinner loading-sm"></span>
          {:else}
            <span class="material-symbols-outlined">
              {mode === 'register' ? 'person_add' : 'login'}
            </span>
          {/if}
          {mode === 'register' ? $t('register') : $t('login')}
        </button>
      </div>

      {#if error}
        <div class="text-error text-sm">{error}</div>
      {/if}

      <div class="text-sm">
        <button class="link link-primary" on:click={toggleMode} disabled={isLoading}>
          {mode === 'login' ? $t('need-account') : $t('have-account')}
        </button>
      </div>
    </div>
  {/if}
</div>
