<script lang="ts">
  import { t } from '../stores/localisation'
  import { validateBCFDCommand, type BCFDCommand } from '../types/types'
  import { createEventDispatcher, onMount } from 'svelte'
  import HeaderBar from './HeaderBar.svelte'
  import Dialog from './Dialog.svelte'
  import CodeEditor from './CodeEditor.svelte'

  export let mode: 'edit' | 'add' = 'add'
  export let command: BCFDCommand | null = null
  export let index: number | null = null

  const TYPE_MESSAGE_RECEIVED = 0
  const TYPE_PM_RECEIVED = 1
  const TYPE_MEMBER_JOIN = 2
  const TYPE_MEMBER_LEAVE = 3
  const TYPE_MEMBER_BAN = 4
  const TYPE_REACTION = 5

  const dispatch = createEventDispatcher()
  let dialog: HTMLDialogElement
  let importText: string = ''
  let showImportError = false

  let dropdownOpen = false

  let activeActions: Array<{ type: string; name: string }> = []
  let triggerDropdown = 0

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
      { type: 'nsfw', name: $t('is-nsfw') }
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
    }
  }

  let editedCommand: BCFDCommand

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

  $: isLimitedType =
    editedCommand?.type == TYPE_MEMBER_JOIN ||
    editedCommand?.type == TYPE_MEMBER_LEAVE ||
    editedCommand?.type == TYPE_MEMBER_BAN

  $: if (isLimitedType) {
    for (let i of typeLimited) {
      removeAction(i)
    }
    // reset the fields that are not needed for these types
  }

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

    if (cmd.phrase) triggerDropdown = 2
    else if (cmd.startsWith) triggerDropdown = 1
    else triggerDropdown = 0
  }

  onMount(() => {
    editedCommand = command
      ? { ...command }
      : {
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
      console.log(command)
      initializeActiveActions(command)
    }
  })
</script>

{#if editedCommand}
  <Dialog bind:dialog on:close={() => console.log('closed')}>
    <p>
      {$t('import-json-command')}:
    </p>
    <input
      type="text"
      bind:value={importText}
      placeholder="Paste JSON here"
      class="input input-bordered w-full"
    />
    {#if showImportError}
      <p>Bad JSON provided. Does not match required structure for command.</p>
    {/if}
    <div class="modal-action">
      <form method="dialog">
        <button
          disabled={!importText}
          class="btn btn-sm btn-error"
          on:click={(e) => {
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
          on:click={() => {
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
          class="menu dropdown-content bg-base-100 rounded-box z-[1] w-52 p-2 shadow max-h-96 overflow-y-auto flex flex-col gap-1 flex-nowrap"
        >
          {#each getAvailableActions(activeActions, isLimitedType) as action}
            <li>
              <button class="dropdown-item" on:click={() => addAction(action.type)}>
                {action.name}
              </button>
            </li>
          {/each}
        </ul>
      </details>
      <!-- import button -->
      <span class="tooltip tooltip-primary tooltip-bottom" data-tip={$t('import')}>
        <button type="button" class="btn btn-primary" on:click={() => dialog.showModal()}>
          <span class="material-symbols-outlined">upload</span>
        </button>
      </span>

      <span
        class="tooltip tooltip-primary tooltip-bottom"
        data-tip={activeActions.length == 0
          ? 'Actions Required to Save'
          : $t(mode === 'edit' ? 'update-command' : 'add-command')}
      >
        <button
          type="submit"
          disabled={activeActions.length == 0}
          class="btn btn-primary"
          on:click={handleSubmit}><span class="material-symbols-outlined">save</span></button
        >
      </span>
      <!-- cancel button-->
      <button type="button" class="btn btn-secondary" on:click={() => dispatch('cancel')}
        ><span class="material-symbols-outlined">close</span></button
      >
    </div>
  </HeaderBar>

  <div class="p-4">
    <div class="">
      <!-- <div class="break-words">{JSON.stringify(editedCommand)}</div> -->
      <form on:submit|preventDefault={() => {}} class="space-y-4">
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
                    class="select select-bordered"
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
                    class="input input-bordered"
                    placeholder="This is a command that does something"
                    required
                  />
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
                        class="input input-bordered"
                        placeholder="!command"
                        required
                      />
                    </div>
                    {#if editedCommand.type == TYPE_MESSAGE_RECEIVED || editedCommand.type === TYPE_PM_RECEIVED}
                      <div class="form-control">
                        <label class="label" for="type">
                          <span class="label-text">{$t('command-trigger')}</span>
                        </label>
                        <select
                          id="type"
                          bind:value={triggerDropdown}
                          class="select select-bordered"
                          required
                          on:change={() => {
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
                        class="input input-bordered"
                        placeholder={$t('reaction-placeholder')}
                        required
                      />
                    </div>
                  {/if}
                {/if}
              </div>
            </div>
          </div>
          {#each activeActions as action}
            <div class="card bg-base-200">
              <div class="card-header flex justify-between items-center p-3">
                <h3 class="text-lg font-bold">{action.name}</h3>
                <button
                  class="btn btn-sm btn-circle btn-primary"
                  on:click={() => removeAction(action.type)}
                >
                  <span class="material-symbols-outlined">close</span>
                </button>
              </div>
              <div class="card-body">
                <!-- Action specific fields here -->
                {#if action.type === 'sendMessage'}
                  <CodeEditor bind:value={editedCommand.channelMessage} />
                {:else if action.type === 'sendChannelEmbed'}
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
                {:else if action.type === 'sendPrivateMessage'}<div class="form-control">
                    <label class="label" for="privateMessage">
                      <span class="label-text">{$t('private-message')}</span>
                    </label>
                    <CodeEditor bind:value={editedCommand.privateMessage} />
                  </div>{:else if action.type === 'sendPrivateEmbed'}<div class="form-control">
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
                  </div>{:else if action.type === 'specificChannel'}<div class="form-control">
                    <label class="label" for="specificChannel">
                      <span class="label-text">{$t('specific-channel')}</span>
                    </label>
                    <CodeEditor bind:value={editedCommand.specificChannel} />
                  </div>{:else if action.type === 'reaction'}<div class="form-control">
                    <label class="label" for="reactToMessage  ">
                      <span class="label-text">{$t('react-to-message')}</span>
                    </label>
                    <CodeEditor bind:value={editedCommand.reaction} />
                  </div>{:else if action.type === 'deleteIf'}<div class="form-control">
                    <label class="label" for="deleteIfStrings">
                      <span class="label-text">{$t('delete-if-contains')}</span>
                    </label>
                    <input
                      type="text"
                      id="deleteIfStrings"
                      bind:value={editedCommand.deleteIfStrings}
                      class="input input-bordered"
                    />
                  </div>{:else if action.type === 'deleteAfter'}Deletes the command message after.{:else if action.type === 'deleteX'}<div
                    class="form-control"
                  >
                    <label class="label" for="deleteNum">
                      <span class="label-text">{$t('delete-x-times')}</span>
                    </label>
                    <input
                      type="number"
                      bind:value={editedCommand.deleteNum}
                      class="input input-bordered"
                      min="1"
                      max="99"
                    />
                  </div>{:else if action.type === 'roleAssigner'}
                  <div class="form-control">
                    <label class="label" for="roleToAssign">
                      <span class="label-text">{$t('role-to-assign')}</span>
                    </label>
                    <CodeEditor bind:value={editedCommand.roleToAssign} />
                  </div>{:else if action.type === 'kick'}Kicks the mentioned user{:else if action.type === 'ban'}Bans
                  the mentioned user{:else if action.type === 'voiceMute'}Voice mutes the mentioned
                  user{:else if action.type === 'requiredRole'}<div class="form-control">
                    <label class="label" for="requiredRole">
                      <span class="label-text">{$t('required-role')}</span>
                    </label>
                    <CodeEditor bind:value={editedCommand.requiredRole} />
                  </div>{:else if action.type === 'requireAdmin'}Requires Administrator Role{:else if action.type === 'nsfw'}Requires
                  NSFW Channel{/if}
              </div>
            </div>
          {/each}
        </div>
      </form>
    </div>
  </div>
{/if}
