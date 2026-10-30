<script lang="ts">
  import { onMount } from 'svelte'
  import { connectionStore } from '../stores/connection'
  import Status from './Status.svelte'
  import { botStatusStore } from '../stores/status'
  import type { BotStatus } from '../types/types'
  import { settingsStore, patchSettings } from '../stores/settings'
  import { t } from '../stores/localisation'
  import { onboardingStore, getCurrentStep } from '../stores/onboarding'
  import OnboardingStepper from './OnboardingStepper.svelte'
  import {
    DISCORD_DEVELOPER_PORTAL_URL,
    isDiscordIntentSetupError
  } from '../../../shared/discordSetup'

  let {
    onSelectTab
  }: {
    onSelectTab?: (tab: string) => void
  } = $props()

  let username = $derived($connectionStore.username)
  let avatar = $derived($connectionStore.avatar)
  let hasCommands = $state(false)

  let token = $state('')
  let loginError = $state('')
  let savingSpamProtection = $state(false)
  let spamSettingsError = $state(false)
  let setupDialog: HTMLDialogElement = $state()

  async function toggleSpamProtection(event: Event) {
    // Keep the control on its saved value until persistence succeeds.
    const input = event.currentTarget as HTMLInputElement
    input.checked = $settingsStore.spamProtectionEnabled === true
    savingSpamProtection = true
    spamSettingsError = false
    try {
      const saved = await patchSettings({
        spamProtectionEnabled: !$settingsStore.spamProtectionEnabled
      })
      spamSettingsError = !saved
    } catch {
      spamSettingsError = true
    } finally {
      savingSpamProtection = false
    }
  }

  $effect(() => {
    const error = $connectionStore.error
    loginError = error
    // Intent setup takes longer than a toast timeout. Keep the instructions until
    // dismissed, a new login attempt starts, or the connection succeeds.
    if (!error || isDiscordIntentSetupError(error)) return undefined
    const timeout = setTimeout(() => {
      loginError = ''
    }, 5000)

    return () => clearTimeout(timeout)
  })

  function handleLogin() {
    connectionStore.ipc.connect(token)
  }

  function handleLogout() {
    connectionStore.ipc.disconnect()
  }

  function openDiscordDeveloperPortal() {
    window.electron.ipcRenderer.invoke('open-external-url', DISCORD_DEVELOPER_PORTAL_URL)
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

  let currentStep = $derived(
    getCurrentStep($onboardingStore, token, hasCommands, $connectionStore.connected)
  )

  // Mark bot hosted once when connected
  $effect(() => {
    if ($connectionStore.connected) {
      onboardingStore.markBotHostedOnce()
    }
  })

  function handleStepperAction() {
    if (currentStep === 'ENTER_TOKEN') {
      openDiscordDeveloperPortal()
    } else if (currentStep === 'CREATE_COMMAND') {
      onSelectTab?.('commands')
    }
  }

  onMount(async () => {
    token = await connectionStore.ipc.getToken()
    // Check if commands exist for stepper
    try {
      const result = await window.electron.ipcRenderer.invoke('get-commands')
      hasCommands = result.bcfdCommands && result.bcfdCommands.length > 0
    } catch {
      hasCommands = false
    }
  })
</script>

<div class="flex flex-col items-center justify-center bg-base-200 p-4 min-h-full">
  <div class="card w-96 max-w-full bg-base-100 shadow-xl">
    {#if !$connectionStore.connected}
      <div class="flex justify-end px-3 pt-3">
        <button
          type="button"
          class="btn btn-ghost btn-circle btn-sm text-base-content/60"
          aria-label={$t('discord-bot-setup')}
          aria-haspopup="dialog"
          onclick={() => setupDialog.showModal()}
        >
          <span class="material-symbols-outlined" aria-hidden="true">help</span>
        </button>
      </div>
    {/if}
    <div class="card-body items-center text-center" class:pt-0={!$connectionStore.connected}>
      {#if currentStep !== 'COMPLETE'}
        <OnboardingStepper
          {currentStep}
          onDismiss={() => onboardingStore.dismissStepper()}
          onAction={handleStepperAction}
        />
      {:else if avatar}
        <div class="avatar placeholder">
          <div
            class={`rounded-full ${$botStatusStore.status === 'Online' ? 'outline-2 outline-green-500' : $botStatusStore.status === 'Do Not Disturb' ? 'outline outline-red-500' : $botStatusStore.status === 'Invisible' ? 'outline outline-gray-500' : 'outline outline-yellow-500'}`}
          >
            <img src={avatar} alt="Avatar" />
          </div>
        </div>
      {:else}
        <div class="avatar placeholder mb-6">
          <div
            class="bg-neutral text-neutral-content w-24 rounded-full flex items-center justify-center"
          >
            <span class="text-3xl select-none">{$t('bot')}</span>
          </div>
        </div>
      {/if}

      {#if !$connectionStore.connected}
        <div class="w-full">
          {#if $settingsStore.showToken}
            <input type="text" placeholder={$t('token')} class="input w-full" bind:value={token} />
          {:else}
            <input
              type="password"
              placeholder={$t('token')}
              class="input w-full"
              bind:value={token}
            />
          {/if}
          {#if currentStep === 'ENTER_TOKEN'}
            <p class="text-xs opacity-50 mt-1 ml-1">
              From Discord Developer Portal &gt; Bot &gt; Token
            </p>
          {/if}
        </div>
      {:else}
        <h2 class="card-title">{username}</h2>
        <div class="text-sm">
          <span>{$botStatusStore.activity}{getActivityPreposition($botStatusStore)}</span><span
            class="font-medium">&nbsp;{$botStatusStore.activityDetails}</span
          >
        </div>
        <input
          type={$settingsStore.showToken ? 'text' : 'password'}
          placeholder={$t('token')}
          disabled
          class="input w-full"
          value={$connectionStore.token}
        />
      {/if}
      {#if !$connectionStore.connected}
        <button
          class="btn btn-primary w-full"
          onclick={handleLogin}
          disabled={$connectionStore.isConnecting}
          ><span class="material-symbols-outlined">login</span>{$t('login')}
          {#if $connectionStore.isConnecting}
            <span class="loading loading-spinner"></span>
          {/if}
        </button>
      {:else}
        <button class="btn btn-primary w-full" onclick={handleLogout}
          ><span class="material-symbols-outlined">logout</span>{$t('logout')}</button
        >
        <button class="btn btn-primary w-full" onclick={generateInvite}
          ><span class="material-symbols-outlined">mail</span>{$t('invite')}</button
        >
      {/if}
      <div class="w-full rounded-box bg-base-200 p-3 text-left">
        <div class="tooltip tooltip-top w-full">
          <div
            id="spam-protection-help"
            role="tooltip"
            class="tooltip-content w-72 max-w-[calc(100vw-4rem)] p-3 text-left text-xs leading-relaxed"
          >
            {$t('spam-protection-help')}
          </div>
          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-1">
              <label for="spam-protection-enabled" class="font-medium">
                {$t('spam-protection')}
              </label>
              <button
                type="button"
                class="btn btn-ghost btn-circle btn-xs text-base-content/60"
                aria-label={$t('spam-protection')}
                aria-describedby="spam-protection-help"
              >
                <span class="material-symbols-outlined text-base" aria-hidden="true">info</span>
              </button>
            </div>
            <input
              id="spam-protection-enabled"
              type="checkbox"
              class="toggle toggle-primary"
              aria-describedby="spam-protection-help"
              checked={$settingsStore.spamProtectionEnabled === true}
              disabled={savingSpamProtection ||
                (!$settingsStore.spamProtectionEnabled && !$settingsStore.openrouterApiKey?.trim())}
              onchange={toggleSpamProtection}
            />
          </div>
        </div>
        {#if !$settingsStore.openrouterApiKey?.trim()}
          <p class="text-xs mt-2">{$t('spam-protection-key-required')}</p>
          <button class="btn btn-link btn-xs px-0" onclick={() => onSelectTab?.('settings')}
            >{$t('settings')}</button
          >
        {/if}
        {#if spamSettingsError}
          <p class="text-error text-xs mt-2" role="alert">{$t('spam-protection-save-failed')}</p>
        {/if}
      </div>
      <div class="collapse bg-base-200">
        <input type="checkbox" />
        <div class="collapse-title text-xl font-medium px-0">
          <div class="flex items-center justify-center gap-2">
            <span class="material-symbols-outlined">settings</span><span>{$t('status')}</span>
          </div>
        </div>
        <div class="collapse-content">
          <Status />
        </div>
      </div>
    </div>
  </div>
</div>

<dialog class="modal" bind:this={setupDialog} aria-labelledby="discord-setup-title">
  <div class="modal-box max-w-lg">
    <div class="flex items-center justify-between gap-4 mb-4">
      <h2 id="discord-setup-title" class="text-lg font-semibold">{$t('discord-bot-setup')}</h2>
      <form method="dialog">
        <button class="btn btn-ghost btn-sm btn-circle" aria-label={$t('close')}>
          <span class="material-symbols-outlined" aria-hidden="true">close</span>
        </button>
      </form>
    </div>
    <div class="space-y-4 text-sm leading-relaxed">
      <p>{$t('discord-privileged-intents-setup')}</p>
      <p>{$t('discord-ban-events-setup')}</p>
    </div>
    <div class="modal-action">
      <button class="btn btn-primary" onclick={openDiscordDeveloperPortal}>
        {$t('onboarding-open-portal')}
        <span class="material-symbols-outlined text-base" aria-hidden="true">open_in_new</span>
      </button>
    </div>
  </div>
  <form method="dialog" class="modal-backdrop">
    <button aria-label={$t('close')}>{$t('close')}</button>
  </form>
</dialog>

{#if loginError}
  <div class="toast toast-end toast-bottom z-50 max-w-full">
    <div class="alert alert-error max-w-lg" role="alert">
      <span class="material-symbols-outlined">error</span>
      <span>{loginError}</span>
      <button
        class="btn btn-ghost btn-sm btn-circle"
        onclick={() => (loginError = '')}
        aria-label="Dismiss"
      >
        <span class="material-symbols-outlined">close</span>
      </button>
    </div>
  </div>
{/if}
