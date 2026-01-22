<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount, untrack } from 'svelte'
  import { type BCFDInteractionCommand, createDefaultInteractionCommand } from '../types/types'
  import { t, type TranslationKey } from '../stores/localisation'
  import HeaderBar from './HeaderBar.svelte'
  import InteractionActionEditor from './InteractionActionEditor.svelte'
  import { bottomNavVisible } from '../stores/navigation'

  interface Props {
    mode?: 'edit' | 'add';
    interaction?: BCFDInteractionCommand | null;
    index?: number | null;
  }

  let { mode = 'add', interaction = null, index = null }: Props = $props();

  const dispatch = createEventDispatcher()

  onMount(() => {
    bottomNavVisible.hide()
  })

  onDestroy(() => {
    bottomNavVisible.show()
  })

  // Create a working copy of the interaction (intentionally captures initial value)
  let editedInteraction: BCFDInteractionCommand = $state(untrack(() =>
    interaction
      ? JSON.parse(JSON.stringify(interaction))
      : createDefaultInteractionCommand()
  ))

  // Store original values for registration comparison (intentionally captures initial values)
  const originalName = untrack(() => interaction?.commandName)
  const originalDescription = untrack(() => interaction?.commandDescription)
  const originalOptions = untrack(() => interaction?.options ? JSON.stringify(interaction.options) : '')

  const nameRegex = /^[-_'\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u

  let actionErrors = $state(false)

  function validateName(name: string): TranslationKey | '' {
    if (!name.trim()) {
      return 'name-is-required'
    }
    if (!nameRegex.test(name)) {
      return 'name-invalid-format'
    }
    return ''
  }

  function validateDescription(description: string): TranslationKey | '' {
    if (!description.trim()) {
      return 'description-required'
    }
    if (description.length > 100) {
      return 'description-too-long'
    }
    return ''
  }

  function getDuplicateOptionNames(): Set<string> {
    const duplicates = new Set<string>()
    const seen = new Map<string, number>()
    editedInteraction.options.forEach((option, idx) => {
      const name = option.name.toLowerCase()
      if (seen.has(name)) {
        duplicates.add(name)
        duplicates.add(editedInteraction.options[seen.get(name)!].name)
      }
      seen.set(name, idx)
    })
    return duplicates
  }

  let commandNameError = $derived(validateName(editedInteraction.commandName))
  let commandDescriptionError = $derived(validateDescription(editedInteraction.commandDescription))
  let optionErrors = $derived.by(() => {
    const duplicates = getDuplicateOptionNames()
    const errors: Record<number, { nameError: TranslationKey | ''; descriptionError: TranslationKey | '' }> = {}
    editedInteraction.options.forEach((option, idx) => {
      const isDuplicate = duplicates.has(option.name)
      errors[idx] = {
        nameError: isDuplicate ? 'duplicate-option-name' : validateName(option.name),
        descriptionError: validateDescription(option.description)
      }
    })
    return errors
  })

  let hasErrors =
    $derived(commandNameError !== '' ||
    commandDescriptionError !== '' ||
    Object.values(optionErrors).some((e) => e.nameError !== '' || e.descriptionError !== '') ||
    actionErrors)

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
    if (hasErrors) {
      alert('Please fix validation errors before saving')
      return
    }

    // Mark as not registered only if registration-affecting fields changed
    const nameChanged = originalName !== editedInteraction.commandName
    const descriptionChanged = originalDescription !== editedInteraction.commandDescription
    const optionsChanged = originalOptions !== JSON.stringify(editedInteraction.options)

    if (nameChanged || descriptionChanged || optionsChanged) {
      editedInteraction.isRegistered = false
    }

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
        <span
          class="tooltip tooltip-primary tooltip-bottom"
          data-tip={hasErrors
            ? $t('fix-errors-to-save')
            : $t(mode === 'edit' ? 'update-command' : 'add-command')}
        >
          <button type="submit" disabled={hasErrors} class="btn btn-primary" onclick={handleSave}
            ><span class="material-symbols-outlined">save</span></button
          >
        </span>
        <button type="button" class="btn btn-secondary" onclick={handleCancel}
          ><span class="material-symbols-outlined">close</span></button
        >
      </div>
    </div>
  </div>
</HeaderBar>

<div class="p-4 overflow-y-auto" style="height: calc(100vh - 124px);">
  <!-- Command Details -->
  <div class="card bg-base-100 shadow-sm mb-4">
    <div class="card-body">
      <h3 class="card-title text-lg">{$t('command-details')}</h3>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="form-control">
          <!-- svelte-ignore a11y_label_has_associated_control -->
          <label class="label">
            <span class="label-text">{$t('command-name')}</span>
          </label>
          <div class="input-group flex gap-1">
            <span
              class="bg-base-200 px-2 text-3xl flex items-center rounded-xl font-bold opacity-80"
              >/</span
            >
            <input
              type="text"
              class:border-error={commandNameError}
              class="input flex-1"
              bind:value={editedInteraction.commandName}
              placeholder="greet"
            />
          </div>
          {#if commandNameError}
            <!-- svelte-ignore a11y_label_has_associated_control -->
            <label class="label">
              <span class="label-text-alt text-error">{commandNameError}</span>
            </label>
          {:else}
            <!-- svelte-ignore a11y_label_has_associated_control -->
            <label class="label">
              <span class="label-text-alt text-base-content/50">
                {$t('command-name-hint')}
              </span>
            </label>
          {/if}
        </div>

        <div class="form-control">
          <!-- svelte-ignore a11y_label_has_associated_control -->
          <label class="label">
            <span class="label-text">{$t('command-description')}</span>
          </label>
          <input
            type="text"
            class:border-error={commandDescriptionError}
            class="input w-full"
            bind:value={editedInteraction.commandDescription}
            placeholder="A friendly greeting command"
          />
          {#if commandDescriptionError}
            <!-- svelte-ignore a11y_label_has_associated_control -->
            <label class="label">
              <span class="label-text-alt text-error">{commandDescriptionError}</span>
            </label>
          {/if}
        </div>
      </div>
    </div>
  </div>

  <!-- Command Options -->
  <div class="card bg-base-100 shadow-sm mb-4">
    <div class="card-body">
      <div class="flex justify-between items-center">
        <h3 class="card-title text-lg">{$t('command-options')}</h3>
        <button class="btn btn-sm btn-outline" onclick={addOption} type="button">
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
                  class="btn btn-sm btn-circle btn-primary"
                  onclick={() => removeOption(idx)}
                >
                  <span class="material-symbols-outlined">close</span>
                </button>
              </div>

              <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div class="form-control">
                  <!-- svelte-ignore a11y_label_has_associated_control -->
                  <label class="label py-1">
                    <span class="label-text text-sm">{$t('option-name')}</span>
                  </label>
                  <input
                    type="text"
                    class:border-error={optionErrors[idx]?.nameError}
                    class="input input-sm"
                    bind:value={option.name}
                    placeholder="username"
                  />
                  {#if optionErrors[idx]?.nameError}
                    <!-- svelte-ignore a11y_label_has_associated_control -->
                    <label class="label py-0">
                      <span class="label-text-alt text-error text-xs"
                        >{optionErrors[idx]?.nameError}</span
                      >
                    </label>
                  {/if}
                </div>

                <div class="form-control">
                  <!-- svelte-ignore a11y_label_has_associated_control -->
                  <label class="label py-1">
                    <span class="label-text text-sm">{$t('option-type')}</span>
                  </label>
                  <select class="select select-sm" bind:value={option.type}>
                    {#each optionTypes as type}
                      <option value={type.value}>{type.label}</option>
                    {/each}
                  </select>
                </div>

                <div class="form-control">
                  <!-- svelte-ignore a11y_label_has_associated_control -->
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
                  <!-- svelte-ignore a11y_label_has_associated_control -->
                  <label class="label py-1">
                    <span class="label-text text-sm">{$t('option-description')}</span>
                  </label>
                  <input
                    type="text"
                    class:border-error={optionErrors[idx]?.descriptionError}
                    class="input input-sm"
                    bind:value={option.description}
                    placeholder="The user to greet"
                  />
                  {#if optionErrors[idx]?.descriptionError}
                    <!-- svelte-ignore a11y_label_has_associated_control -->
                    <label class="label py-0">
                      <span class="label-text-alt text-error text-xs"
                        >{optionErrors[idx]?.descriptionError}</span
                      >
                    </label>
                  {/if}
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
        bind:action={editedInteraction.rootAction}
        showEphemeral={true}
        showDefer={true}
        bind:errors={actionErrors}
      />
    </div>
  </div>
</div>
