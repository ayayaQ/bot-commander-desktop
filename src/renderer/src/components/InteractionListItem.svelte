<script lang="ts">
  import type { BCFDInteractionCommand } from '../types/types'
  import { t } from '../stores/localisation'
  import {
    interactionPublication,
    publicationRequestPending
  } from '../stores/interactionPublication'
  import { connectionStore } from '../stores/connection'

  interface Props {
    interaction: BCFDInteractionCommand
    editInteraction: (interaction: BCFDInteractionCommand) => void
    deleteInteraction: (interaction: BCFDInteractionCommand) => void
    registerCommand: (interaction: BCFDInteractionCommand) => void
    unregisterCommand: (interaction: BCFDInteractionCommand) => void
  }

  let {
    interaction,
    editInteraction,
    deleteInteraction,
    registerCommand,
    unregisterCommand
  }: Props = $props()

  let showDeleteDialog = $state(false)
  let busy = $derived($interactionPublication.busy || $publicationRequestPending)
  let isRegistering = $derived($interactionPublication.pendingIds.includes(interaction.id))
  let failed = $derived($interactionPublication.failedIds.includes(interaction.id))
  let stale = $derived($interactionPublication.staleIds.includes(interaction.id))

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
    if (busy) return
    if (interaction.isRegistered) await unregisterCommand(interaction)
    else await registerCommand(interaction)
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
            {#if isRegistering}
              <span class="badge badge-ghost badge-sm">{$t('sync-in-progress')}</span>
            {:else if failed}
              <span class="badge badge-warning badge-sm">{$t('sync-failed')}</span>
            {:else if stale}
              <span class="badge badge-warning badge-sm">{$t('sync-needs-sync')}</span>
            {:else if interaction.isRegistered}
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
                <span class="badge badge-dash badge-sm">
                  {option.name}{option.required ? '*' : ''}
                </span>
              {/each}
            </div>
          {/if}
        </div>
      </div>

      <div class="flex gap-2">
        <span class="tooltip tooltip-primary tooltip-bottom" data-tip={$t('edit')}>
          <button
            class="btn btn-sm btn-ghost"
            onclick={() => editInteraction(interaction)}
            disabled={busy}
            aria-label={$t('edit')}
          >
            <span class="material-symbols-outlined">edit</span>
          </button>
        </span>
        <span
          class="tooltip tooltip-primary tooltip-bottom"
          data-tip={interaction.isRegistered
            ? $t('sync-unregister-command')
            : $t('sync-register-command')}
        >
          <button
            class="btn btn-sm btn-ghost"
            onclick={handleRegister}
            disabled={busy || !$connectionStore.connected}
            aria-label={interaction.isRegistered
              ? $t('sync-unregister-command')
              : $t('sync-register-command')}
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
          <button
            class="btn btn-sm btn-ghost text-error"
            onclick={handleDelete}
            disabled={busy}
            aria-label={$t('delete')}
          >
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
        <button class="btn" onclick={() => (showDeleteDialog = false)}>{$t('cancel')}</button>
        <button class="btn btn-error" onclick={confirmDelete} disabled={busy}>{$t('delete')}</button
        >
      </div>
    </div>
    <form method="dialog" class="modal-backdrop">
      <button onclick={() => (showDeleteDialog = false)}>close</button>
    </form>
  </dialog>
{/if}
