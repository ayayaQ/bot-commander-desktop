<script lang="ts">
  import { t, type TranslationKey } from '../stores/localisation'
  import { validateBCFDCommand, type BCFDCommand } from '../types/types'
  import { createEventDispatcher, onDestroy, onMount } from 'svelte'
  import HeaderBar from './HeaderBar.svelte'
  import Dialog from './Dialog.svelte'
  import CodeEditor from './CodeEditor.svelte'
  import AIChat from './AIChat.svelte'
  import { aiPanelOpen, clearChat } from '../stores/aiChat'
  import { bottomNavVisible } from '../stores/navigation'

  interface Props {
    mode?: 'edit' | 'add';
    command?: BCFDCommand | null;
    index?: number | null;
    allCommands?: BCFDCommand[];
  }

  let {
    mode = 'add',
    command = null,
    index = null,
    allCommands = []
  }: Props = $props();

  const TYPE_MESSAGE_RECEIVED = 0
  const TYPE_PM_RECEIVED = 1
  const TYPE_MEMBER_JOIN = 2
  const TYPE_MEMBER_LEAVE = 3
  const TYPE_MEMBER_BAN = 4
  const TYPE_REACTION = 5

  onMount(() => {
    bottomNavVisible.hide()
  })

  onDestroy(() => {
    bottomNavVisible.show()
  })

  const dispatch = createEventDispatcher()
  let dialog: HTMLDialogElement = $state()
  let importText: string = $state('')
  let showImportError = $state(false)

  let dropdownOpen = $state(false)

  let activeActions: Array<{ type: string; name: string }> = $state([])
  let triggerDropdown = $state(0)

  function toggleAiPanel() {
    aiPanelOpen.update((v) => !v)
    if (!$aiPanelOpen) {
      // Clear chat when closing
      clearChat()
    }
  }

  function cloneValue<T>(value: T): T {
    // Avoid sharing object references between AI output and local editor state.
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return structuredClone(value)
    } catch {
      return JSON.parse(JSON.stringify(value)) as T
    }
  }

  function ensureActionArr(cmd: BCFDCommand) {
    if (!Array.isArray(cmd.actionArr)) cmd.actionArr = [false, false]
    if (cmd.actionArr.length < 2) cmd.actionArr = [!!cmd.actionArr[0], !!cmd.actionArr[1]]
  }

  function applyAiCommandUpdate(updatedCommand: BCFDCommand) {
    // Apply field-by-field so we can run extra logic per property.
    for (const [key, value] of Object.entries(updatedCommand) as Array<
      [keyof BCFDCommand, BCFDCommand[keyof BCFDCommand]]
    >) {
      // Keep the existing id stable for this editor session.
      if (key === 'id') continue
      ;(editedCommand as any)[key] = cloneValue(value)
    }

    // Special operations / derived flags.
    ensureActionArr(editedCommand)

    if (updatedCommand.channelMessage?.trim()) {
      editedCommand.actionArr[0] = true
    }
    if (updatedCommand.privateMessage?.trim()) {
      editedCommand.actionArr[1] = true
    }
    if (updatedCommand.channelEmbed && isEmbedValid(updatedCommand.channelEmbed)) {
      editedCommand.sendChannelEmbed = true
    }
    if (updatedCommand.privateEmbed && isEmbedValid(updatedCommand.privateEmbed)) {
      editedCommand.sendPrivateEmbed = true
    }
    if (updatedCommand.specificChannel?.trim()) {
      editedCommand.isSpecificChannel = true
    }
    if (updatedCommand.reaction?.trim()) {
      editedCommand.isReact = true
    }
    if (updatedCommand.deleteIfStrings?.trim()) {
      editedCommand.deleteIf = true
    }
    if (typeof updatedCommand.deleteNum === 'number' && updatedCommand.deleteNum > 0) {
      editedCommand.deleteX = true
    }
    if (updatedCommand.roleToAssign?.trim()) {
      editedCommand.isRoleAssigner = true
    }
    if (updatedCommand.requiredRole?.trim()) {
      editedCommand.isRequiredRole = true
    }
    // cooldown is handled via initializeActiveActions below

    // Force reactivity after a batch of in-place assignments.
    editedCommand = { ...editedCommand }

    // Re-initialize active actions based on updated command.
    initializeActiveActions(editedCommand)
  }

  function handleAiCommandUpdate(updatedCommand: BCFDCommand) {
    applyAiCommandUpdate(updatedCommand)
  }

  function getAvailableActions(
    activeActions: Array<{ type: string; name: string }>,
    isLimitedType: boolean
  ) {
    const allActions = [
      { type: 'sendMessage', name: $t('send-message') },
      { type: 'sendPrivateMessage', name: $t('send-private-message') },
      { type: 'sendChannelEmbed', name: $t('send-channel-embed') },
      { type: 'sendPrivateEmbed', name: $t('send-private-embed') },
      { type: 'specificChannel', name: $t('is-specific-channel') },
      { type: 'reaction', name: $t('react-to-message') },
      { type: 'deleteIf', name: $t('delete-if-contains') },
      { type: 'deleteAfter', name: $t('delete-after') },
      { type: 'deleteX', name: $t('delete-x-times') },
      { type: 'roleAssigner', name: $t('role-assigner') },
      { type: 'kick', name: $t('kick') },
      { type: 'ban', name: $t('ban') },
      { type: 'voiceMute', name: $t('voice-mute') },
      { type: 'requiredRole', name: $t('requires-role') },
      { type: 'requireAdmin', name: $t('requires-admin') },
      { type: 'nsfw', name: $t('is-nsfw') },
      { type: 'cooldown', name: $t('cooldown') }
    ]

    return allActions.filter(
      (action) =>
        !activeActions.find((active) => active.type === action.type) &&
        (isLimitedType ? typeLimited.find((t) => t == action.type) : true)
    )
  }

  function addAction(type: string) {
    dropdownOpen = false
    const action = getAvailableActions(activeActions, isLimitedType).find((a) => a.type === type)
    if (action) {
      activeActions = [...activeActions, action]
      // Set corresponding command property
      updateCommandProperty(type, true)
    }
  }

  function removeAction(type: string) {
    activeActions = activeActions.filter((a) => a.type !== type)
    // Clear corresponding command property
    updateCommandProperty(type, false)
  }

  function updateCommandProperty(type: string, value: boolean) {
    // Map action types to command properties
    switch (type) {
      case 'sendMessage':
        editedCommand.actionArr[0] = value
        break
      case 'sendPrivateMessage':
        editedCommand.actionArr[1] = value
        break
      case 'sendChannelEmbed':
        editedCommand.sendChannelEmbed = value
        break
      case 'sendPrivateEmbed':
        editedCommand.sendPrivateEmbed = value
        break
      case 'specificChannel':
        editedCommand.isSpecificChannel = value
        break
      case 'reaction':
        editedCommand.isReact = value
        break
      case 'deleteIf':
        editedCommand.deleteIf = value
        break
      case 'deleteAfter':
        editedCommand.deleteAfter = value
        break
      case 'deleteX':
        editedCommand.deleteX = value
        break
      case 'roleAssigner':
        editedCommand.isRoleAssigner = value
        break
      case 'kick':
        editedCommand.isKick = value
        break
      case 'ban':
        editedCommand.isBan = value
        break
      case 'voiceMute':
        editedCommand.isVoiceMute = value
        break
      case 'requiredRole':
        editedCommand.isRequiredRole = value
        break
      case 'requireAdmin':
        editedCommand.isAdmin = value
        break
      case 'nsfw':
        editedCommand.isNSFW = value
        break
      case 'phrase':
        editedCommand.phrase = value
        break
      case 'startsWith':
        editedCommand.startsWith = value
        break
      case 'cooldown':
        if (!value) {
          editedCommand.cooldown = 0
          editedCommand.cooldownType = ''
          editedCommand.cooldownMessage = ''
        }
        break
    }
  }

  let editedCommand: BCFDCommand = $state()

  const typeLimited = [
    'requiredRole',
    'requireAdmin',
    'nsfw',
    'phrase',
    'deleteAfter',
    'deleteX',
    'deleteIf',
    'reaction',
    'kick',
    'ban',
    'voiceMute'
  ]

  let isLimitedType =
    $derived(editedCommand?.type == TYPE_MEMBER_JOIN ||
    editedCommand?.type == TYPE_MEMBER_LEAVE ||
    editedCommand?.type == TYPE_MEMBER_BAN)

  $effect(() => {
    if (isLimitedType) {
      for (let i of typeLimited) {
        removeAction(i)
      }
      // reset the fields that are not needed for these types
    }
  })

  // Validation
  let descriptionError: TranslationKey | '' = $state('')
  let commandError: TranslationKey | '' = $state('')

  function isEmbedValid(embed: {
    title: string
    description: string
    hexColor: string
    imageURL: string
    thumbnailURL: string
    footer: string
  }): boolean {
    if (!embed) return false
    return !!(
      embed.title?.trim() ||
      embed.description?.trim() ||
      embed.hexColor?.trim() ||
      embed.imageURL?.trim() ||
      embed.thumbnailURL?.trim() ||
      embed.footer?.trim()
    )
  }

  // Reactive validation for description
  $effect(() => {
    descriptionError = editedCommand?.commandDescription?.trim() ? '' : 'description-required'
  })

  // Reactive validation for command field (only for types that need it)
  $effect(() => {
    const needsCommand =
      editedCommand?.type === TYPE_MESSAGE_RECEIVED ||
      editedCommand?.type === TYPE_PM_RECEIVED ||
      editedCommand?.type === TYPE_REACTION
    commandError = needsCommand && !editedCommand?.command?.trim() ? 'command-required' : ''
  })

  // Reactive validation for action fields - use $derived to avoid effect read/write cycles
  let actionErrors: Record<string, TranslationKey> = $derived.by(() => {
    const errors: Record<string, TranslationKey> = {}
    for (const action of activeActions) {
      switch (action.type) {
        case 'sendMessage':
          if (!editedCommand?.channelMessage?.trim()) {
            errors['sendMessage'] = 'message-is-required'
          }
          break
        case 'sendPrivateMessage':
          if (!editedCommand?.privateMessage?.trim()) {
            errors['sendPrivateMessage'] = 'message-is-required'
          }
          break
        case 'sendChannelEmbed':
          if (!isEmbedValid(editedCommand?.channelEmbed)) {
            errors['sendChannelEmbed'] = 'embed-field-required'
          }
          break
        case 'sendPrivateEmbed':
          if (!isEmbedValid(editedCommand?.privateEmbed)) {
            errors['sendPrivateEmbed'] = 'embed-field-required'
          }
          break
        case 'specificChannel':
          if (!editedCommand?.specificChannel?.trim()) {
            errors['specificChannel'] = 'channel-id-required'
          }
          break
        case 'reaction':
          if (!editedCommand?.reaction?.trim()) {
            errors['reaction'] = 'reaction-required'
          }
          break
        case 'deleteIf':
          if (!editedCommand?.deleteIfStrings?.trim()) {
            errors['deleteIf'] = 'delete-strings-required'
          }
          break
        case 'deleteX':
          if (!editedCommand?.deleteNum || editedCommand.deleteNum < 1) {
            errors['deleteX'] = 'delete-number-required'
          }
          break
        case 'roleAssigner':
          if (!editedCommand?.roleToAssign?.trim()) {
            errors['roleAssigner'] = 'role-id-is-required'
          }
          break
        case 'requiredRole':
          if (!editedCommand?.requiredRole?.trim()) {
            errors['requiredRole'] = 'role-id-is-required'
          }
          break
      }
    }
    return errors
  })

  let hasErrors =
    $derived(descriptionError !== '' ||
    commandError !== '' ||
    Object.keys(actionErrors).length > 0 ||
    activeActions.length === 0)

  function handleSubmit() {
    if (
      editedCommand.type === TYPE_MEMBER_JOIN ||
      editedCommand.type === TYPE_MEMBER_LEAVE ||
      editedCommand.type === TYPE_MEMBER_BAN
    ) {
      // reset the fields that are not needed for these types
      editedCommand.isRequiredRole = false
      editedCommand.requiredRole = ''
      editedCommand.isAdmin = false
      editedCommand.phrase = false
      editedCommand.isNSFW = false
      editedCommand.deleteAfter = false
      editedCommand.deleteX = false
      editedCommand.deleteNum = 0
      editedCommand.deleteIf = false
      editedCommand.deleteIfStrings = ''
      editedCommand.isReact = false
      editedCommand.reaction = ''
      editedCommand.isKick = false
      editedCommand.isBan = false
      editedCommand.isVoiceMute = false
      editedCommand.command = ''
    }

    if (mode === 'edit') {
      dispatch('update', { command: editedCommand, index })
    } else {
      dispatch('add', editedCommand)
    }
  }

  function initializeActiveActions(cmd: BCFDCommand) {
    activeActions = []
    if (cmd.actionArr[0]) activeActions.push({ type: 'sendMessage', name: $t('send-message') })
    if (cmd.actionArr[1])
      activeActions.push({ type: 'sendPrivateMessage', name: $t('send-private-message') })
    if (cmd.sendChannelEmbed)
      activeActions.push({ type: 'sendChannelEmbed', name: $t('send-channel-embed') })
    if (cmd.sendPrivateEmbed)
      activeActions.push({ type: 'sendPrivateEmbed', name: $t('send-private-embed') })
    if (cmd.isSpecificChannel)
      activeActions.push({ type: 'specificChannel', name: $t('is-specific-channel') })
    if (cmd.isReact) activeActions.push({ type: 'reaction', name: $t('react-to-message') })
    if (cmd.deleteIf) activeActions.push({ type: 'deleteIf', name: $t('delete-if-contains') })
    if (cmd.deleteAfter) activeActions.push({ type: 'deleteAfter', name: $t('delete-after') })
    if (cmd.deleteX) activeActions.push({ type: 'deleteX', name: $t('delete-x-times') })
    if (cmd.isRoleAssigner) activeActions.push({ type: 'roleAssigner', name: $t('role-assigner') })
    if (cmd.isKick) activeActions.push({ type: 'kick', name: $t('kick') })
    if (cmd.isBan) activeActions.push({ type: 'ban', name: $t('ban') })
    if (cmd.isVoiceMute) activeActions.push({ type: 'voiceMute', name: $t('voice-mute') })
    if (cmd.isRequiredRole) activeActions.push({ type: 'requiredRole', name: $t('requires-role') })
    if (cmd.isAdmin) activeActions.push({ type: 'requireAdmin', name: $t('requires-admin') })
    if (cmd.isNSFW) activeActions.push({ type: 'nsfw', name: $t('is-nsfw') })
    if (cmd.cooldown && cmd.cooldown > 0)
      activeActions.push({ type: 'cooldown', name: $t('cooldown') })

    if (cmd.phrase) triggerDropdown = 2
    else if (cmd.startsWith) triggerDropdown = 1
    else triggerDropdown = 0
  }

  onMount(() => {
    editedCommand = command
      ? { ...command }
      : {
          id: crypto.randomUUID(),
          actionArr: [false, false],
          channelMessage: '',
          command: '',
          commandDescription: '',
          deleteAfter: false,
          deleteIf: false,
          deleteIfStrings: '',
          deleteNum: 0,
          deleteX: false,
          ignoreErrorMessage: false,
          isBan: false,
          isKick: false,
          isNSFW: false,
          isReact: false,
          isRequiredRole: false,
          isRoleAssigner: false,
          isSpecificChannel: false,
          isSpecificMessage: false,
          isVoiceMute: false,
          isAdmin: false,
          phrase: false,
          privateMessage: '',
          reaction: '',
          roleToAssign: '',
          sendChannelEmbed: false,
          sendPrivateEmbed: false,
          specificChannel: '',
          specificMessage: '',
          startsWith: false,
          requiredRole: '',
          type: 0,
          channelEmbed: {
            title: '',
            description: '',
            hexColor: '',
            imageURL: '',
            thumbnailURL: '',
            footer: ''
          },
          privateEmbed: {
            title: '',
            description: '',
            hexColor: '',
            imageURL: '',
            thumbnailURL: '',
            footer: ''
          }
        }

    if (mode === 'edit' && command) {
      initializeActiveActions(command)
    }
  })
</script>

{#if editedCommand}
  <Dialog bind:dialog onclose={() => console.log('closed')}>
    <p>
      {$t('import-json-command')}:
    </p>
    <input
      type="text"
      bind:value={importText}
      placeholder="Paste JSON here"
      class="input w-full"
    />
    {#if showImportError}
      <p>Bad JSON provided. Does not match required structure for command.</p>
    {/if}
    <div class="modal-action">
      <form method="dialog">
        <button
          disabled={!importText}
          class="btn btn-sm btn-error"
          onclick={(e) => {
            const newCommand = validateBCFDCommand(importText)
            if (newCommand) {
              editedCommand = newCommand
              initializeActiveActions(editedCommand)
              dialog.close()
              importText = ''
              showImportError = false
            } else {
              e.preventDefault()
              showImportError = true
            }
          }}>{$t('import')}</button
        >
        <button
          class="btn btn-sm btn-ghost"
          onclick={() => {
            importText = ''
            showImportError = false
          }}>{$t('cancel')}</button
        >
      </form>
    </div>
  </Dialog>

  <HeaderBar>
    <div class=" font-bold text-2xl">{$t(mode === 'edit' ? 'edit-command' : 'add-command')}</div>
    <div class="flex justify-end gap-2 items-center">
      <details class="dropdown" bind:open={dropdownOpen}>
        <summary class="btn btn-primary"
          ><span class="material-symbols-outlined">add</span>{$t('actions')}</summary
        >
        <ul
          class="menu dropdown-content bg-base-100 rounded-box z-1 w-52 p-2 shadow max-h-96 overflow-y-auto flex flex-col gap-1 flex-nowrap"
        >
          {#each getAvailableActions(activeActions, isLimitedType) as action}
            <li>
              <button class="dropdown-item" onclick={() => addAction(action.type)}>
                {action.name}
              </button>
            </li>
          {/each}
        </ul>
      </details>
      <!-- AI Assistant button -->
      <span class="tooltip tooltip-primary tooltip-bottom" data-tip={$t('ai-assistant')}>
        <button
          type="button"
          class="btn {$aiPanelOpen ? 'btn-secondary' : 'btn-primary'}"
          onclick={toggleAiPanel}
          class:btn-active={$aiPanelOpen}
        >
          <span class="material-symbols-outlined">smart_toy</span>
        </button>
      </span>
      <!-- import button -->
      <span class="tooltip tooltip-primary tooltip-bottom" data-tip={$t('import')}>
        <button type="button" class="btn btn-primary" onclick={() => dialog.showModal()}>
          <span class="material-symbols-outlined">upload</span>
        </button>
      </span>

      <span
        class="tooltip tooltip-primary tooltip-bottom"
        data-tip={hasErrors
          ? $t('fix-errors-to-save')
          : $t(mode === 'edit' ? 'update-command' : 'add-command')}
      >
        <button type="submit" disabled={hasErrors} class="btn btn-primary" onclick={handleSubmit}
          ><span class="material-symbols-outlined">save</span></button
        >
      </span>
      <!-- cancel button-->
      <button type="button" class="btn btn-secondary" onclick={() => dispatch('cancel')}
        ><span class="material-symbols-outlined">close</span></button
      >
    </div>
  </HeaderBar>

  <!-- Split view container -->
  <div class="flex flex-1 overflow-hidden" style="height: calc(100vh - 120px);">
    <!-- Left side: Editor (scrollable) -->
    <div
      class="flex-1 overflow-y-auto {$aiPanelOpen ? 'w-1/2' : 'w-full'} transition-all duration-300"
    >
      <div class="p-4">
        <div class="">
          <!-- <div class="break-words">{JSON.stringify(editedCommand)}</div> -->
          <form onsubmit={(e) => e.preventDefault()} class="space-y-4">
            <!-- Replace checkbox sections with action cards -->
            <div class="space-y-4">
              <div class="card bg-base-200">
                <div class="card-header flex justify-between items-center p-3">
                  <h3 class="text-lg font-bold">{$t('details')}</h3>
                </div>
                <div class="card-body">
                  <!-- Base Details -->
                  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div class="form-control">
                      <label class="label" for="type">
                        <span class="label-text">{$t('choose-command-type')}</span>
                      </label>
                      <select
                        id="type"
                        bind:value={editedCommand.type}
                        class="select w-full"
                        required
                      >
                        <option value={0}>{$t('message-received')}</option>
                        <option value={1}>{$t('private-message-received')}</option>
                        <option value={2}>{$t('member-join')}</option>
                        <option value={3}>{$t('member-leave')}</option>
                        <option value={4}>{$t('member-ban')}</option>
                        <option value={5}>{$t('reaction')}</option>
                      </select>
                    </div>
                    <div class="form-control">
                      <label class="label" for="commandDescription">
                        <span class="label-text">{$t('description')}</span>
                      </label>
                      <input
                        type="text"
                        id="commandDescription"
                        bind:value={editedCommand.commandDescription}
                        class="input w-full"
                        class:border-error={descriptionError}
                        placeholder="This is a command that does something"
                        required
                      />
                      {#if descriptionError}
                        <label class="label" for="commandDescription">
                          <span class="label-text-alt text-error">{$t(descriptionError)}</span>
                        </label>
                      {/if}
                    </div>
                    {#if editedCommand.type !== TYPE_MEMBER_JOIN && editedCommand.type !== TYPE_MEMBER_LEAVE && editedCommand.type !== TYPE_MEMBER_BAN}
                      {#if editedCommand.type !== TYPE_REACTION}
                        <div class="form-control col-span-2">
                          <label class="label" for="command">
                            <span class="label-text">{$t('command')}</span>
                          </label>
                          <input
                            type="text"
                            id="command"
                            bind:value={editedCommand.command}
                            class="input w-full"
                            class:border-error={commandError}
                            placeholder="!command"
                            required
                          />
                          {#if commandError}
                            <label class="label" for="command">
                              <span class="label-text-alt text-error">{$t(commandError)}</span>
                            </label>
                          {/if}
                        </div>
                        {#if editedCommand.type == TYPE_MESSAGE_RECEIVED || editedCommand.type === TYPE_PM_RECEIVED}
                          <div class="form-control">
                            <label class="label" for="type">
                              <span class="label-text">{$t('command-trigger')}</span>
                            </label>
                            <select
                              id="type"
                              bind:value={triggerDropdown}
                              class="select w-full"
                              required
                              onchange={() => {
                                editedCommand.phrase = triggerDropdown == 2
                                editedCommand.startsWith = triggerDropdown == 1
                              }}
                            >
                              <option value={0}>{$t('command-only')}</option>
                              <option value={1}>{$t('starts-with')}</option>
                              <option value={2}>{$t('phrase')}</option>
                            </select>
                          </div>
                        {/if}
                      {:else}
                        <div class="form-control col-span-2">
                          <label class="label" for="reaction">
                            <span class="label-text">{$t('reaction')}</span>
                          </label>
                          <input
                            type="text"
                            id="reaction"
                            bind:value={editedCommand.command}
                            class="input"
                            class:border-error={commandError}
                            placeholder={$t('reaction-placeholder')}
                            required
                          />
                          {#if commandError}
                            <label class="label" for="reaction">
                              <span class="label-text-alt text-error">{$t(commandError)}</span>
                            </label>
                          {/if}
                        </div>
                      {/if}
                    {/if}
                  </div>
                </div>
              </div>
              {#if activeActions.length === 0}
                <p class="text-center text-error text-xs mt-2">{$t('no-actions-added-hint')}</p>
              {/if}
              {#each activeActions as action}
                <div class="card bg-base-200">
                  <div class="card-header flex justify-between items-center p-3">
                    <h3 class="text-lg font-bold">{action.name}</h3>
                    <button
                      class="btn btn-sm btn-circle btn-primary"
                      onclick={() => removeAction(action.type)}
                    >
                      <span class="material-symbols-outlined">close</span>
                    </button>
                  </div>
                  <div class="card-body">
                    <!-- Action specific fields here -->
                    {#if action.type === 'sendMessage'}
                      <div class={actionErrors['sendMessage'] ? 'ring-2 ring-error rounded' : ''}>
                        <CodeEditor bind:value={editedCommand.channelMessage} />
                      </div>
                      {#if actionErrors['sendMessage']}
                        <p class="text-error text-xs mt-2">{$t(actionErrors['sendMessage'])}</p>
                      {/if}
                    {:else if action.type === 'sendChannelEmbed'}
                      <div
                        class={actionErrors['sendChannelEmbed']
                          ? 'ring-2 ring-error rounded p-2 -m-2'
                          : ''}
                      >
                        <div class="form-control">
                          <label class="label" for="channelEmbedTitle">
                            <span class="label-text">{$t('channel-embed-title')}</span>
                          </label>
                          <CodeEditor bind:value={editedCommand.channelEmbed.title} />
                        </div>

                        <div class="form-control">
                          <label class="label" for="channelEmbedDescription">
                            <span class="label-text">{$t('channel-embed-description')}</span>
                          </label>
                          <CodeEditor bind:value={editedCommand.channelEmbed.description} />
                        </div>

                        <div class="form-control">
                          <label class="label" for="channelEmbedFooter">
                            <span class="label-text">{$t('channel-embed-footer')}</span>
                          </label>
                          <CodeEditor bind:value={editedCommand.channelEmbed.footer} />
                        </div>

                        <div class="form-control">
                          <label class="label" for="channelEmbedImage">
                            <span class="label-text">{$t('channel-embed-image')}</span>
                          </label>
                          <CodeEditor bind:value={editedCommand.channelEmbed.imageURL} />
                        </div>

                        <div class="form-control">
                          <label class="label" for="channelEmbedThumbnail">
                            <span class="label-text">{$t('channel-embed-thumbnail')}</span>
                          </label>
                          <CodeEditor bind:value={editedCommand.channelEmbed.thumbnailURL} />
                        </div>

                        <div class="form-control">
                          <label class="label" for="channelEmbedColor">
                            <span class="label-text">{$t('channel-embed-color')}</span>
                          </label>
                          <CodeEditor bind:value={editedCommand.channelEmbed.hexColor} />
                        </div>
                      </div>
                      {#if actionErrors['sendChannelEmbed']}
                        <p class="text-error text-xs mt-2">
                          {$t(actionErrors['sendChannelEmbed'])}
                        </p>
                      {/if}
                    {:else if action.type === 'sendPrivateMessage'}
                      <div
                        class={actionErrors['sendPrivateMessage']
                          ? 'ring-2 ring-error rounded'
                          : ''}
                      >
                        <CodeEditor bind:value={editedCommand.privateMessage} />
                      </div>
                      {#if actionErrors['sendPrivateMessage']}
                        <p class="text-error text-xs mt-2">
                          {$t(actionErrors['sendPrivateMessage'])}
                        </p>
                      {/if}
                    {:else if action.type === 'sendPrivateEmbed'}
                      <div
                        class={actionErrors['sendPrivateEmbed']
                          ? 'ring-2 ring-error rounded p-2 -m-2'
                          : ''}
                      >
                        <div class="form-control">
                          <label class="label" for="privateEmbedTitle">
                            <span class="label-text">{$t('private-embed-title')}</span>
                          </label>
                          <CodeEditor bind:value={editedCommand.privateEmbed.title} />
                        </div>

                        <div class="form-control">
                          <label class="label" for="privateEmbedDescription">
                            <span class="label-text">{$t('private-embed-description')}</span>
                          </label>
                          <CodeEditor bind:value={editedCommand.privateEmbed.description} />
                        </div>

                        <div class="form-control">
                          <label class="label" for="privateEmbedFooter">
                            <span class="label-text">{$t('private-embed-footer')}</span>
                          </label>
                          <CodeEditor bind:value={editedCommand.privateEmbed.footer} />
                        </div>

                        <div class="form-control">
                          <label class="label" for="privateEmbedImage">
                            <span class="label-text">{$t('private-embed-image')}</span>
                          </label>
                          <CodeEditor bind:value={editedCommand.privateEmbed.imageURL} />
                        </div>

                        <div class="form-control">
                          <label class="label" for="privateEmbedThumbnail">
                            <span class="label-text">{$t('private-embed-thumbnail')}</span>
                          </label>
                          <CodeEditor bind:value={editedCommand.privateEmbed.thumbnailURL} />
                        </div>

                        <div class="form-control">
                          <label class="label" for="privateEmbedColor">
                            <span class="label-text">{$t('private-embed-color')}</span>
                          </label>
                          <CodeEditor bind:value={editedCommand.privateEmbed.hexColor} />
                        </div>
                      </div>
                      {#if actionErrors['sendPrivateEmbed']}
                        <p class="text-error text-xs mt-2">
                          {$t(actionErrors['sendPrivateEmbed'])}
                        </p>
                      {/if}
                    {:else if action.type === 'specificChannel'}
                      <div
                        class={actionErrors['specificChannel'] ? 'ring-2 ring-error rounded' : ''}
                      >
                        <CodeEditor bind:value={editedCommand.specificChannel} />
                      </div>
                      {#if actionErrors['specificChannel']}
                        <p class="text-error text-xs mt-2">{$t(actionErrors['specificChannel'])}</p>
                      {/if}
                    {:else if action.type === 'reaction'}
                      <div class={actionErrors['reaction'] ? 'ring-2 ring-error rounded' : ''}>
                        <CodeEditor bind:value={editedCommand.reaction} />
                      </div>
                      {#if actionErrors['reaction']}
                        <p class="text-error text-xs mt-2">{$t(actionErrors['reaction'])}</p>
                      {/if}
                    {:else if action.type === 'deleteIf'}
                      <div class="form-control">
                        <label class="label" for="deleteIfStrings">
                          <span class="label-text">{$t('delete-if-contains')}</span>
                        </label>
                        <input
                          type="text"
                          id="deleteIfStrings"
                          bind:value={editedCommand.deleteIfStrings}
                          class="input"
                          class:border-error={actionErrors['deleteIf']}
                        />
                        {#if actionErrors['deleteIf']}
                          <label class="label" for="deleteIfStrings">
                            <span class="label-text-alt text-error"
                              >{$t(actionErrors['deleteIf'])}</span
                            >
                          </label>
                        {/if}
                      </div>
                    {:else if action.type === 'deleteAfter'}
                      Deletes the command message after.
                    {:else if action.type === 'deleteX'}
                      <div class="form-control">
                        <label class="label" for="deleteNum">
                          <span class="label-text">{$t('delete-x-times')}</span>
                        </label>
                        <input
                          type="number"
                          bind:value={editedCommand.deleteNum}
                          class="input"
                          class:border-error={actionErrors['deleteX']}
                          min="1"
                          max="99"
                        />
                        {#if actionErrors['deleteX']}
                          <label class="label" for="deleteNum">
                            <span class="label-text-alt text-error"
                              >{$t(actionErrors['deleteX'])}</span
                            >
                          </label>
                        {/if}
                      </div>
                    {:else if action.type === 'roleAssigner'}
                      <div class={actionErrors['roleAssigner'] ? 'ring-2 ring-error rounded' : ''}>
                        <CodeEditor bind:value={editedCommand.roleToAssign} />
                      </div>
                      {#if actionErrors['roleAssigner']}
                        <p class="text-error text-xs mt-2">{$t(actionErrors['roleAssigner'])}</p>
                      {/if}
                    {:else if action.type === 'kick'}
                      Kicks the mentioned user
                    {:else if action.type === 'ban'}
                      Bans the mentioned user
                    {:else if action.type === 'voiceMute'}
                      Voice mutes the mentioned user
                    {:else if action.type === 'requiredRole'}
                      <div class={actionErrors['requiredRole'] ? 'ring-2 ring-error rounded' : ''}>
                        <CodeEditor bind:value={editedCommand.requiredRole} />
                      </div>
                      {#if actionErrors['requiredRole']}
                        <p class="text-error text-xs mt-2">{$t(actionErrors['requiredRole'])}</p>
                      {/if}
                    {:else if action.type === 'requireAdmin'}
                      Requires Administrator Role
                    {:else if action.type === 'nsfw'}
                      Requires NSFW Channel
                    {:else if action.type === 'cooldown'}
                      <p class="text-base-content/50 text-sm mb-2">{$t('cooldown-hint')}</p>
                      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div class="form-control">
                          <label class="label" for="cooldown">
                            <span class="label-text">{$t('cooldown')} (s)</span>
                          </label>
                          <input
                            type="number"
                            id="cooldown"
                            bind:value={editedCommand.cooldown}
                            class="input w-full"
                            min="0"
                            placeholder="0"
                          />
                        </div>
                        <div class="form-control">
                          <label class="label" for="cooldownType">
                            <span class="label-text">{$t('cooldown-type')}</span>
                          </label>
                          <select
                            id="cooldownType"
                            bind:value={editedCommand.cooldownType}
                            class="select w-full"
                          >
                            <option value="User">{$t('cooldown-user')}</option>
                            <option value="Server">{$t('cooldown-server')}</option>
                            <option value="Global">{$t('cooldown-global')}</option>
                          </select>
                        </div>
                      </div>
                      <div class="form-control mt-2">
                        <label class="label" for="cooldownMessage">
                          <span class="label-text">{$t('cooldown-message')}</span>
                        </label>
                        <input
                          type="text"
                          id="cooldownMessage"
                          bind:value={editedCommand.cooldownMessage}
                          class="input w-full"
                          placeholder="This command is on cooldown. Try again in $cooldownRemaining()s."
                        />
                      </div>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          </form>
        </div>
      </div>
    </div>

    <!-- Right side: AI Chat Panel -->
    {#if $aiPanelOpen}
      <div class="w-1/2 max-w-xl border-l border-base-300 flex flex-col">
        <AIChat
          command={editedCommand}
          onCommandUpdate={handleAiCommandUpdate}
          {allCommands}
          on:close={toggleAiPanel}
        />
      </div>
    {/if}
  </div>
{/if}
