<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import { commandRepoStore } from '../stores/commandRepository'
  import { t } from '../stores/localisation'
  import type { BCFDCommand } from '../types/types'
  import Dialog from './Dialog.svelte'

  export let command: BCFDCommand | null = null
  export let dialog: HTMLDialogElement

  const dispatch = createEventDispatcher<{
    shared: void
  }>()

  let isSharing = false
  let shareError: string | null = null
  let shareSuccess = false

  // Form fields - pre-filled from command
  let commandName = ''
  let commandDescription = ''

  $: if (command) {
    commandName = command.command || 'Untitled Command'
    commandDescription = command.commandDescription || ''
  }

  async function handleShare() {
    if (!command) return

    isSharing = true
    shareError = null
    shareSuccess = false

    try {
      const result = await commandRepoStore.ipc.shareCommand(
        commandName,
        commandDescription,
        command
      )

      if (result.success) {
        shareSuccess = true
        setTimeout(() => {
          dialog.close()
          shareSuccess = false
          dispatch('shared')
        }, 1500)
      } else {
        shareError = result.error || 'Failed to share command'
      }
    } catch (error) {
      shareError = (error as Error).message || 'Failed to share command'
    } finally {
      isSharing = false
    }
  }

  function handleClose() {
    shareError = null
    shareSuccess = false
  }

  function getCommandTypeName(type: number) {
    switch (type) {
      case 0: return 'Message Command'
      case 1: return 'PM Command'
      case 2: return 'Join Event'
      case 3: return 'Leave Event'
      case 4: return 'Ban Event'
      case 5: return 'Reaction Event'
      default: return 'Command'
    }
  }
</script>

<Dialog bind:dialog on:close={handleClose}>
  <h3 class="font-bold text-lg mb-4">
    <span class="material-symbols-outlined align-middle mr-2">share</span>
    {$t('share-command') || 'Share Command'}
  </h3>

  {#if command}
    {#if shareSuccess}
      <div class="alert alert-success mb-4">
        <span class="material-symbols-outlined">check_circle</span>
        <span>{$t('command-shared-successfully') || 'Command shared successfully!'}</span>
      </div>
    {:else}
      <div class="space-y-4">
        <div class="form-control">
          <label class="label" for="share-name">
            <span class="label-text">{$t('command-name') || 'Command Name'}</span>
          </label>
          <input
            id="share-name"
            type="text"
            class="input w-full"
            bind:value={commandName}
            placeholder="Enter a name for your shared command"
          />
        </div>

        <div class="form-control">
          <label class="label" for="share-desc">
            <span class="label-text">{$t('description') || 'Description'}</span>
          </label>
          <textarea
            id="share-desc"
            class="textarea w-full"
            rows="3"
            bind:value={commandDescription}
            placeholder="Describe what this command does..."
          ></textarea>
        </div>

        <div class="bg-base-200 rounded-lg p-3">
          <p class="text-sm font-semibold mb-2">{$t('preview') || 'Preview'}</p>
          <div class="text-sm text-base-content/70">
            <p><strong>{$t('type') || 'Type'}:</strong> {getCommandTypeName(command.type)}</p>
            {#if command.command}
              <p><strong>{$t('trigger') || 'Trigger'}:</strong> {command.command}</p>
            {/if}
          </div>
        </div>

        {#if shareError}
          <div class="alert alert-error">
            <span class="material-symbols-outlined">error</span>
            <span>{shareError}</span>
          </div>
        {/if}

        <div class="alert alert-info">
          <span class="material-symbols-outlined">info</span>
          <span>{$t('share-info') || 'Your command will be publicly available in the repository for others to import.'}</span>
        </div>
      </div>

      <div class="modal-action">
        <form method="dialog">
          <button class="btn btn-ghost" disabled={isSharing}>
            {$t('cancel') || 'Cancel'}
          </button>
        </form>
        <button
          class="btn btn-primary"
          on:click={handleShare}
          disabled={isSharing || !commandName.trim()}
        >
          {#if isSharing}
            <span class="loading loading-spinner loading-sm"></span>
          {:else}
            <span class="material-symbols-outlined">share</span>
          {/if}
          {$t('share') || 'Share'}
        </button>
      </div>
    {/if}
  {:else}
    <p class="text-base-content/60">{$t('no-command-selected') || 'No command selected.'}</p>
    <div class="modal-action">
      <form method="dialog">
        <button class="btn btn-ghost">{$t('close') || 'Close'}</button>
      </form>
    </div>
  {/if}
</Dialog>
