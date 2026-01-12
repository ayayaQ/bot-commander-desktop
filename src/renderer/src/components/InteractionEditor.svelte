<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import { type BCFDInteractionCommand, createDefaultInteractionCommand } from '../types/types'
  import { t } from '../stores/localisation'
  import HeaderBar from './HeaderBar.svelte'
  import InteractionActionEditor from './InteractionActionEditor.svelte'

  export let mode: 'edit' | 'add' = 'add'
  export let interaction: BCFDInteractionCommand | null = null
  export let index: number | null = null

  const dispatch = createEventDispatcher()

  // Create a working copy of the interaction
  let editedInteraction: BCFDInteractionCommand = interaction
    ? JSON.parse(JSON.stringify(interaction))
    : createDefaultInteractionCommand()

  const optionTypes = [
    { value: 3, label: 'String' },
    { value: 4, label: 'Integer' },
    { value: 5, label: 'Boolean' },
    { value: 6, label: 'User' },
    { value: 7, label: 'Channel' },
    { value: 8, label: 'Role' },
    { value: 10, label: 'Number' }
  ]

  function addOption() {
    editedInteraction.options = [
      ...editedInteraction.options,
      {
        name: '',
        description: '',
        type: 3, // String
        required: false
      }
    ]
  }

  function removeOption(idx: number) {
    editedInteraction.options = editedInteraction.options.filter((_, i) => i !== idx)
  }

  function handleSave() {
    // Validate command name
    if (!editedInteraction.commandName.trim()) {
      alert('Command name is required')
      return
    }

    // Validate command name format (lowercase, no spaces, alphanumeric and hyphens only)
    const nameRegex = /^[\w-]{1,32}$/
    if (!nameRegex.test(editedInteraction.commandName)) {
      alert(
        'Command name must be 1-32 characters, lowercase, and contain only letters, numbers, hyphens, and underscores'
      )
      return
    }

    // Validate description
    if (!editedInteraction.commandDescription.trim()) {
      alert('Command description is required')
      return
    }

    // Mark as not registered since we changed it
    editedInteraction.isRegistered = false

    if (mode === 'add') {
      dispatch('add', editedInteraction)
    } else {
      dispatch('update', { interaction: editedInteraction, index })
    }
  }

  function handleCancel() {
    dispatch('cancel')
  }
</script>

<HeaderBar>
  <div class="basis-full">
    <div class="flex justify-between items-center">
      <h2 class="text-2xl font-bold">
        {mode === 'add' ? $t('add-interaction') : $t('edit-interaction')}
      </h2>
      <div class="flex gap-2">
        <button class="btn btn-ghost" on:click={handleCancel}>
          <span class="material-symbols-outlined">close</span>
          {$t('cancel')}
        </button>
        <button class="btn btn-primary" on:click={handleSave}>
          <span class="material-symbols-outlined">save</span>
          {$t('save')}
        </button>
      </div>
    </div>
  </div>
</HeaderBar>

<div class="p-4 overflow-y-auto" style="height: calc(100vh - 184px);">
  <!-- Command Details -->
  <div class="card bg-base-100 shadow-sm mb-4">
    <div class="card-body">
      <h3 class="card-title text-lg">{$t('command-details')}</h3>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="form-control">
          <!-- svelte-ignore a11y-label-has-associated-control -->
          <label class="label">
            <span class="label-text">{$t('command-name')}</span>
          </label>
          <div class="input-group">
            <span class="bg-base-200 px-3 flex items-center">/</span>
            <input
              type="text"
              class="input input-bordered flex-1"
              bind:value={editedInteraction.commandName}
              placeholder="greet"
            />
          </div>
          <!-- svelte-ignore a11y-label-has-associated-control -->
          <label class="label">
            <span class="label-text-alt text-base-content/50">
              {$t('command-name-hint')}
            </span>
          </label>
        </div>

        <div class="form-control">
          <!-- svelte-ignore a11y-label-has-associated-control -->
          <label class="label">
            <span class="label-text">{$t('command-description')}</span>
          </label>
          <input
            type="text"
            class="input input-bordered"
            bind:value={editedInteraction.commandDescription}
            placeholder="A friendly greeting command"
          />
        </div>
      </div>
    </div>
  </div>

  <!-- Command Options -->
  <div class="card bg-base-100 shadow-sm mb-4">
    <div class="card-body">
      <div class="flex justify-between items-center">
        <h3 class="card-title text-lg">{$t('command-options')}</h3>
        <button class="btn btn-sm btn-outline" on:click={addOption} type="button">
          <span class="material-symbols-outlined text-sm">add</span>
          {$t('add-option')}
        </button>
      </div>

      {#if editedInteraction.options.length === 0}
        <p class="text-base-content/50 text-sm">{$t('no-options-hint')}</p>
      {:else}
        <div class="space-y-4 mt-4">
          {#each editedInteraction.options as option, idx}
            <div class="card bg-base-200 p-4">
              <div class="flex justify-between items-start mb-3">
                <span class="badge badge-neutral">Option {idx + 1}</span>
                <button
                  class="btn btn-xs btn-ghost text-error"
                  on:click={() => removeOption(idx)}
                  type="button"
                >
                  <span class="material-symbols-outlined text-sm">close</span>
                </button>
              </div>

              <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div class="form-control">
                  <!-- svelte-ignore a11y-label-has-associated-control -->
                  <label class="label py-1">
                    <span class="label-text text-sm">{$t('option-name')}</span>
                  </label>
                  <input
                    type="text"
                    class="input input-bordered input-sm"
                    bind:value={option.name}
                    placeholder="username"
                  />
                </div>

                <div class="form-control">
                  <!-- svelte-ignore a11y-label-has-associated-control -->
                  <label class="label py-1">
                    <span class="label-text text-sm">{$t('option-type')}</span>
                  </label>
                  <select class="select select-bordered select-sm" bind:value={option.type}>
                    {#each optionTypes as type}
                      <option value={type.value}>{type.label}</option>
                    {/each}
                  </select>
                </div>

                <div class="form-control">
                  <!-- svelte-ignore a11y-label-has-associated-control -->
                  <label class="label py-1">
                    <span class="label-text text-sm">{$t('option-required')}</span>
                  </label>
                  <label class="flex items-center gap-2 cursor-pointer h-8">
                    <input
                      type="checkbox"
                      class="checkbox checkbox-sm"
                      bind:checked={option.required}
                    />
                    <span class="text-sm">{$t('required')}</span>
                  </label>
                </div>

                <div class="form-control md:col-span-3">
                  <!-- svelte-ignore a11y-label-has-associated-control -->
                  <label class="label py-1">
                    <span class="label-text text-sm">{$t('option-description')}</span>
                  </label>
                  <input
                    type="text"
                    class="input input-bordered input-sm"
                    bind:value={option.description}
                    placeholder="The user to greet"
                  />
                </div>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <!-- Root Action -->
  <div class="card bg-base-100 shadow-sm mb-4">
    <div class="card-body">
      <h3 class="card-title text-lg">{$t('root-action')}</h3>
      <p class="text-base-content/50 text-sm mb-4">{$t('root-action-hint')}</p>

      <InteractionActionEditor
        action={editedInteraction.rootAction}
        showEphemeral={true}
        showDefer={true}
      />
    </div>
  </div>
</div>
