<script lang="ts">
  import type { BCFDInteractionAction } from '../types/types'
  import { createDefaultInteractionButton } from '../types/types'
  import { t, type TranslationKey } from '../stores/localisation'
  import CodeEditor from './CodeEditor.svelte'
  import InteractionButtonEditor from './InteractionButtonEditor.svelte'


  const MAX_NESTING_DEPTH = 3 // Maximum levels of nested buttons

  type ActionType = {
    id: string
    name: TranslationKey
    field: keyof BCFDInteractionAction
  }

  const actionTypes: ActionType[] = [
    { id: 'sendMessage', name: 'send-channel-message', field: 'sendChannelMessage' },
    { id: 'sendPrivateMessage', name: 'send-private-message', field: 'sendPrivateMessage' },
    { id: 'sendChannelEmbed', name: 'send-channel-embed', field: 'sendChannelEmbed' },
    { id: 'sendPrivateEmbed', name: 'send-private-embed', field: 'sendPrivateEmbed' },
    { id: 'roleAssigner', name: 'role-assigner', field: 'isRoleAssigner' }
  ]

  let dropdownOpen = $state(false)


  function toggleAction(actionId: string) {
    const actionType = actionTypes.find((a) => a.id === actionId)
    if (!actionType) return

    const field = actionType.field
    ;(action as any)[field] = !(action as any)[field]
    dropdownOpen = false
  }

  function removeAction(actionId: string) {
    const actionType = actionTypes.find((a) => a.id === actionId)
    if (!actionType) return

    const field = actionType.field
    ;(action as any)[field] = false
  }

  function getAvailableActions(): ActionType[] {
    return actionTypes.filter((a) => !activeActions.includes(a.id))
  }

  // Nested button management
  function addNestedButton() {
    if (!action.buttons) {
      action.buttons = []
    }
    action.buttons = [...action.buttons, createDefaultInteractionButton()]
  }

  function removeNestedButton(idx: number) {
    action.buttons = action.buttons.filter((_, i) => i !== idx)
  }


  function isEmbedValid(embed: any): boolean {
    if (!embed) return false
    return !!(
      embed.title?.trim() ||
      embed.hexColor?.trim() ||
      embed.description?.trim() ||
      embed.imageURL?.trim() ||
      embed.thumbnailURL?.trim() ||
      embed.footer?.trim()
    )
  }



  interface Props {
    action: BCFDInteractionAction;
    showEphemeral?: boolean;
    showDefer?: boolean;
    showButtons?: boolean;
    nestingDepth?: number; // Track nesting level to prevent infinite nesting
    title?: string;
    errors?: boolean;
  }

  let {
    action = $bindable(),
    showEphemeral = true,
    showDefer = true,
    showButtons = true,
    nestingDepth = 0,
    title = '',
    errors = $bindable(false)
  }: Props = $props();
  // Derive active actions from the action object
  let activeActions = $derived.by(() => {
    const actions: string[] = []
    if (action.sendChannelMessage) actions.push('sendMessage')
    if (action.sendPrivateMessage) actions.push('sendPrivateMessage')
    if (action.sendChannelEmbed) actions.push('sendChannelEmbed')
    if (action.sendPrivateEmbed) actions.push('sendPrivateEmbed')
    if (action.isRoleAssigner) actions.push('roleAssigner')
    return actions
  })

  // Check if we can add more nested buttons
  let canAddNestedButtons =
    $derived(showButtons && nestingDepth < MAX_NESTING_DEPTH && (action.buttons?.length ?? 0) < 5)

  // Validation errors (derived from action state)
  let channelMessageError: TranslationKey | '' = $derived(
    action.sendChannelMessage && !action.channelMessage?.trim() ? 'message-is-required' : ''
  )
  let privateMessageError: TranslationKey | '' = $derived(
    action.sendPrivateMessage && !action.privateMessage?.trim() ? 'message-is-required' : ''
  )
  let channelEmbedError: TranslationKey | '' = $derived(
    action.sendChannelEmbed && !isEmbedValid(action.channelEmbed) ? 'embed-field-required' : ''
  )
  let privateEmbedError: TranslationKey | '' = $derived(
    action.sendPrivateEmbed && !isEmbedValid(action.privateEmbed) ? 'embed-field-required' : ''
  )
  let roleToAssignError: TranslationKey | '' = $derived(
    action.isRoleAssigner && !action.roleToAssign?.trim() ? 'role-id-is-required' : ''
  )
  let hasErrors = $derived(
    channelMessageError !== '' ||
    privateMessageError !== '' ||
    channelEmbedError !== '' ||
    privateEmbedError !== '' ||
    roleToAssignError !== '' ||
    (!action.sendChannelMessage &&
      !action.sendPrivateMessage &&
      !action.sendChannelEmbed &&
      !action.sendPrivateEmbed &&
      !action.isRoleAssigner)
  )

  // Sync errors to parent via bindable prop
  $effect(() => {
    if (errors !== hasErrors) {
      errors = hasErrors
    }
  })
</script>

<div class="space-y-4">
  {#if title}
    <h4 class="font-semibold text-base">{title}</h4>
  {/if}

  <!-- Action toggles -->
  {#if showEphemeral || showDefer}
    <div class="flex flex-wrap gap-4">
      {#if showEphemeral}
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" class="checkbox checkbox-sm" bind:checked={action.ephemeral} />
          <span class="text-sm">{$t('ephemeral')}</span>
        </label>
      {/if}
      {#if showDefer}
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" class="checkbox checkbox-sm" bind:checked={action.deferReply} />
          <span class="text-sm">{$t('defer-reply')}</span>
        </label>
      {/if}
    </div>
  {/if}

  <!-- Add Action Dropdown -->
  <div class="dropdown" class:dropdown-open={dropdownOpen}>
    <button
      class="btn btn-sm btn-outline"
      onclick={() => (dropdownOpen = !dropdownOpen)}
      type="button"
    >
      <span class="material-symbols-outlined text-sm">add</span>
      {$t('add-action')}
    </button>
    {#if dropdownOpen}
      <ul class="dropdown-content z-10 menu p-2 shadow bg-base-200 rounded-box w-52">
        {#each getAvailableActions() as actionType}
          <li>
            <button onclick={() => toggleAction(actionType.id)} type="button">
              {$t(actionType.name)}
            </button>
          </li>
        {/each}
        {#if getAvailableActions().length === 0}
          <li class="text-base-content/50 p-2 text-sm">{$t('all-actions-added')}</li>
        {/if}
      </ul>
    {/if}
  </div>

  <!-- Active Actions -->
  <div class="space-y-4">
    {#if !action.sendChannelMessage && !action.sendPrivateMessage && !action.sendChannelEmbed && !action.sendPrivateEmbed && !action.isRoleAssigner}
      <p class="text-error text-xs mt-2">{$t('no-actions-added-hint')}</p>
    {/if}

    {#if action.sendChannelMessage}
      <div class="card bg-base-200 p-4">
        <div class="flex justify-between items-center mb-2">
          <span class="font-medium">{$t('send-channel-message')}</span>
          <button
            class="btn btn-sm btn-circle btn-primary"
            onclick={() => removeAction('sendMessage')}
          >
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>
        <div class={channelMessageError ? 'ring-2 ring-error rounded' : ''}>
          <CodeEditor bind:value={action.channelMessage} minHeight="80px" mode="bcfd" />
        </div>
        {#if channelMessageError}
          <p class="text-error text-xs mt-2">{$t(channelMessageError)}</p>
        {/if}
      </div>
    {/if}

    {#if action.sendPrivateMessage}
      <div class="card bg-base-200 p-4">
        <div class="flex justify-between items-center mb-2">
          <span class="font-medium">{$t('send-private-message')}</span>
          <button
            class="btn btn-sm btn-circle btn-primary"
            onclick={() => removeAction('sendPrivateMessage')}
          >
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>
        <div class={privateMessageError ? 'ring-2 ring-error rounded' : ''}>
          <CodeEditor bind:value={action.privateMessage} minHeight="80px" mode="bcfd" />
        </div>
        {#if privateMessageError}
          <p class="text-error text-xs mt-2">{$t(privateMessageError)}</p>
        {/if}
      </div>
    {/if}

    {#if action.sendChannelEmbed}
      <div class="card bg-base-200 p-4">
        <div class="flex justify-between items-center mb-2">
          <span class="font-medium">{$t('send-channel-embed')}</span>
          <button
            class="btn btn-sm btn-circle btn-primary"
            onclick={() => removeAction('sendChannelEmbed')}
          >
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>
        <div class={channelEmbedError ? 'ring-2 ring-error rounded p-4 -m-4' : ''}>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <!-- svelte-ignore a11y_label_has_associated_control -->
              <label class="label"><span class="label-text">{$t('embed-title')}</span></label>
              <CodeEditor bind:value={action.channelEmbed.title} minHeight="40px" mode="bcfd" />
            </div>
            <div>
              <!-- svelte-ignore a11y_label_has_associated_control -->
              <label class="label"><span class="label-text">{$t('embed-color')}</span></label>
              <CodeEditor bind:value={action.channelEmbed.hexColor} minHeight="40px" mode="bcfd" />
            </div>
            <div class="md:col-span-2">
              <!-- svelte-ignore a11y_label_has_associated_control -->
              <label class="label"><span class="label-text">{$t('embed-description')}</span></label>
              <CodeEditor
                bind:value={action.channelEmbed.description}
                minHeight="80px"
                mode="bcfd"
              />
            </div>
            <div>
              <!-- svelte-ignore a11y_label_has_associated_control -->
              <label class="label"><span class="label-text">{$t('embed-image')}</span></label>
              <CodeEditor bind:value={action.channelEmbed.imageURL} minHeight="40px" mode="bcfd" />
            </div>
            <div>
              <!-- svelte-ignore a11y_label_has_associated_control -->
              <label class="label"><span class="label-text">{$t('embed-thumbnail')}</span></label>
              <CodeEditor
                bind:value={action.channelEmbed.thumbnailURL}
                minHeight="40px"
                mode="bcfd"
              />
            </div>
            <div class="md:col-span-2">
              <!-- svelte-ignore a11y_label_has_associated_control -->
              <label class="label"><span class="label-text">{$t('embed-footer')}</span></label>
              <CodeEditor bind:value={action.channelEmbed.footer} minHeight="40px" mode="bcfd" />
            </div>
          </div>
        </div>
        {#if channelEmbedError}
          <p class="text-error text-xs mt-2">{$t(channelEmbedError)}</p>
        {/if}
      </div>
    {/if}

    {#if action.sendPrivateEmbed}
      <div class="card bg-base-200 p-4">
        <div class="flex justify-between items-center mb-2">
          <span class="font-medium">{$t('send-private-embed')}</span>
          <button
            class="btn btn-sm btn-circle btn-primary"
            onclick={() => removeAction('sendPrivateEmbed')}
          >
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>
        <div class={privateEmbedError ? 'ring-2 ring-error rounded p-4 -m-4' : ''}>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <!-- svelte-ignore a11y_label_has_associated_control -->
              <label class="label"><span class="label-text">{$t('embed-title')}</span></label>
              <CodeEditor bind:value={action.privateEmbed.title} minHeight="40px" mode="bcfd" />
            </div>
            <div>
              <!-- svelte-ignore a11y_label_has_associated_control -->
              <label class="label"><span class="label-text">{$t('embed-color')}</span></label>
              <CodeEditor bind:value={action.privateEmbed.hexColor} minHeight="40px" mode="bcfd" />
            </div>
            <div class="md:col-span-2">
              <!-- svelte-ignore a11y_label_has_associated_control -->
              <label class="label"><span class="label-text">{$t('embed-description')}</span></label>
              <CodeEditor
                bind:value={action.privateEmbed.description}
                minHeight="80px"
                mode="bcfd"
              />
            </div>
            <div>
              <!-- svelte-ignore a11y_label_has_associated_control -->
              <label class="label"><span class="label-text">{$t('embed-image')}</span></label>
              <CodeEditor bind:value={action.privateEmbed.imageURL} minHeight="40px" mode="bcfd" />
            </div>
            <div>
              <!-- svelte-ignore a11y_label_has_associated_control -->
              <label class="label"><span class="label-text">{$t('embed-thumbnail')}</span></label>
              <CodeEditor
                bind:value={action.privateEmbed.thumbnailURL}
                minHeight="40px"
                mode="bcfd"
              />
            </div>
            <div class="md:col-span-2">
              <!-- svelte-ignore a11y_label_has_associated_control -->
              <label class="label"><span class="label-text">{$t('embed-footer')}</span></label>
              <CodeEditor bind:value={action.privateEmbed.footer} minHeight="40px" mode="bcfd" />
            </div>
          </div>
        </div>
        {#if privateEmbedError}
          <p class="text-error text-xs mt-2">{$t(privateEmbedError)}</p>
        {/if}
      </div>
    {/if}

    {#if action.isRoleAssigner}
      <div class="card bg-base-200 p-4">
        <div class="flex justify-between items-center mb-2">
          <span class="font-medium">{$t('role-assigner')}</span>
          <button
            class="btn btn-sm btn-circle btn-primary"
            onclick={() => removeAction('roleAssigner')}
          >
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>
        <div class={roleToAssignError ? 'ring-2 ring-error rounded' : ''}>
          <!-- svelte-ignore a11y_label_has_associated_control -->
          <label class="label"><span class="label-text">{$t('role-id')}</span></label>
          <CodeEditor bind:value={action.roleToAssign} minHeight="40px" mode="bcfd" />
        </div>
        {#if roleToAssignError}
          <p class="text-error text-xs mt-2">{$t(roleToAssignError)}</p>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Nested Buttons Section -->
  {#if showButtons && nestingDepth < MAX_NESTING_DEPTH}
    <div class="mt-4">
      <div class="flex justify-between items-center mb-2">
        <span class="font-medium text-sm flex items-center gap-2">
          <span class="material-symbols-outlined text-sm">smart_button</span>
          {$t('response-buttons')}
          {#if nestingDepth > 0}
            <span class="badge badge-sm badge-ghost">{$t('nesting-level')} {nestingDepth}</span>
          {/if}
        </span>
        <button
          class="btn btn-xs btn-outline"
          onclick={addNestedButton}
          type="button"
          disabled={!canAddNestedButtons}
        >
          <span class="material-symbols-outlined text-sm">add</span>
          {$t('add-button')}
        </button>
      </div>

      {#if action.buttons && action.buttons.length > 0}
        <div class="space-y-2">
          {#each action.buttons as _button, idx}
            <InteractionButtonEditor
              bind:button={action.buttons[idx]}
              onDelete={() => removeNestedButton(idx)}
              {nestingDepth}
            />
          {/each}
        </div>
      {:else}
        <p class="text-base-content/50 text-xs">{$t('no-response-buttons-hint')}</p>
      {/if}

      {#if action.buttons && action.buttons.length >= 5}
        <p class="text-warning text-xs mt-1">{$t('max-buttons-warning')}</p>
      {/if}
    </div>
  {/if}
</div>
