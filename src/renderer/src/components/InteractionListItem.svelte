<script lang="ts">
  import type { BCFDInteractionCommand } from '../types/types'
  import { t } from '../stores/localisation'
  import { connectionStore } from '../stores/connection'

  export let interaction: BCFDInteractionCommand
  export let editInteraction: (interaction: BCFDInteractionCommand) => void
  export let deleteInteraction: (interaction: BCFDInteractionCommand) => void
  export let registerCommand: (interaction: BCFDInteractionCommand) => void
  export let unregisterCommand: (interaction: BCFDInteractionCommand) => void

  let showDeleteDialog = false
  let isRegistering = false

  function handleDelete(event: MouseEvent) {
    if (event.shiftKey) {
      deleteInteraction(interaction)
    } else {
      showDeleteDialog = true
    }
  }

  function confirmDelete() {
    deleteInteraction(interaction)
    showDeleteDialog = false
  }

  async function handleRegister() {
    isRegistering = true
    try {
      if (interaction.isRegistered) {
        await unregisterCommand(interaction)
      } else {
        await registerCommand(interaction)
      }
    } finally {
      isRegistering = false
    }
  }
</script>

<li class="card bg-base-200 hover:bg-base-300 transition-colors duration-200">
  <div class="card-body p-4">
    <div class="flex items-start justify-between">
      <div class="flex items-start gap-3">
        <div class="flex items-center justify-center">
          <span class="material-symbols-outlined" style="font-size: 3rem;">terminal</span>
        </div>
        <div class="flex-1">
          <div class="flex items-center gap-2">
            <h3 class="text-lg font-semibold">/{interaction.commandName || 'Unnamed'}</h3>
            {#if interaction.isRegistered}
              <span class="badge badge-success badge-sm">{$t('registered')}</span>
            {:else}
              <span class="badge badge-warning badge-sm">{$t('not-registered')}</span>
            {/if}
          </div>
          <p class="text-sm text-base-content/70">
            {interaction.commandDescription || 'No description'}
          </p>

          <!-- Options preview -->
          {#if interaction.options.length > 0}
            <div class="mt-2 flex flex-wrap gap-1">
              <span class="text-xs text-base-content/50">{$t('options')}:</span>
              {#each interaction.options as option}
                <span class="badge badge-outline badge-sm">
                  {option.name}{option.required ? '*' : ''}
                </span>
              {/each}
            </div>
          {/if}
        </div>
      </div>

      <div class="flex gap-2">
        <span class="tooltip tooltip-primary tooltip-bottom" data-tip={$t('edit')}>
          <button class="btn btn-sm btn-ghost" on:click={() => editInteraction(interaction)}>
            <span class="material-symbols-outlined">edit</span>
          </button>
        </span>
        <span
          class="tooltip tooltip-primary tooltip-bottom"
          data-tip={interaction.isRegistered ? $t('unregister') : $t('register')}
        >
          <button
            class="btn btn-sm btn-ghost"
            on:click={handleRegister}
            disabled={isRegistering || !$connectionStore.connected}
          >
            {#if isRegistering}
              <span class="loading loading-spinner loading-xs"></span>
            {:else}
              <span class="material-symbols-outlined">
                {interaction.isRegistered ? 'cloud_off' : 'cloud_upload'}
              </span>
            {/if}
          </button>
        </span>
        <span class="tooltip tooltip-error tooltip-bottom" data-tip={$t('delete')}>
          <button class="btn btn-sm btn-ghost text-error" on:click={handleDelete}>
            <span class="material-symbols-outlined">delete</span>
          </button>
        </span>
      </div>
    </div>
  </div>
</li>

<!-- Delete confirmation dialog -->
{#if showDeleteDialog}
  <dialog class="modal modal-open">
    <div class="modal-box">
      <h3 class="font-bold text-lg">{$t('confirm-delete')}</h3>
      <p class="py-4">
        {$t('delete-interaction-confirm')} "/{interaction.commandName}"?
      </p>
      <div class="modal-action">
        <button class="btn" on:click={() => (showDeleteDialog = false)}>{$t('cancel')}</button>
        <button class="btn btn-error" on:click={confirmDelete}>{$t('delete')}</button>
      </div>
    </div>
    <form method="dialog" class="modal-backdrop">
      <button on:click={() => (showDeleteDialog = false)}>close</button>
    </form>
  </dialog>
{/if}
