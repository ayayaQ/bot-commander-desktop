<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import type { BCFDCommand } from '../types/types'
  import { t } from '../stores/localisation'
  import CodeEditor from './CodeEditor.svelte'

  export let command: BCFDCommand
  export let open = false

  const dispatch = createEventDispatcher<{ close: void }>()

  const TYPE_MESSAGE_RECEIVED = 0
  const TYPE_PM_RECEIVED = 1
  const TYPE_MEMBER_JOIN = 2
  const TYPE_MEMBER_LEAVE = 3
  const TYPE_MEMBER_BAN = 4
  const TYPE_REACTION = 5

  function getTypeName(type: number): string {
    switch (type) {
      case TYPE_MESSAGE_RECEIVED:
        return $t('message-received')
      case TYPE_PM_RECEIVED:
        return $t('private-message-received')
      case TYPE_MEMBER_JOIN:
        return $t('member-join')
      case TYPE_MEMBER_LEAVE:
        return $t('member-leave')
      case TYPE_MEMBER_BAN:
        return $t('member-ban')
      case TYPE_REACTION:
        return $t('reaction')
      default:
        return 'Unknown'
    }
  }

  function getTriggerType(cmd: BCFDCommand): string {
    if (cmd.phrase) return $t('phrase')
    if (cmd.startsWith) return $t('starts-with')
    return $t('command-only')
  }

  function getActiveActions(cmd: BCFDCommand): Array<{ type: string; name: string }> {
    const actions: Array<{ type: string; name: string }> = []
    if (cmd.actionArr?.[0]) actions.push({ type: 'sendMessage', name: $t('send-message') })
    if (cmd.actionArr?.[1]) actions.push({ type: 'sendPrivateMessage', name: $t('send-private-message') })
    if (cmd.sendChannelEmbed) actions.push({ type: 'sendChannelEmbed', name: $t('send-channel-embed') })
    if (cmd.sendPrivateEmbed) actions.push({ type: 'sendPrivateEmbed', name: $t('send-private-embed') })
    if (cmd.isSpecificChannel) actions.push({ type: 'specificChannel', name: $t('is-specific-channel') })
    if (cmd.isReact) actions.push({ type: 'reaction', name: $t('react-to-message') })
    if (cmd.deleteIf) actions.push({ type: 'deleteIf', name: $t('delete-if-contains') })
    if (cmd.deleteAfter) actions.push({ type: 'deleteAfter', name: $t('delete-after') })
    if (cmd.deleteX) actions.push({ type: 'deleteX', name: $t('delete-x-times') })
    if (cmd.isRoleAssigner) actions.push({ type: 'roleAssigner', name: $t('role-assigner') })
    if (cmd.isKick) actions.push({ type: 'kick', name: $t('kick') })
    if (cmd.isBan) actions.push({ type: 'ban', name: $t('ban') })
    if (cmd.isVoiceMute) actions.push({ type: 'voiceMute', name: $t('voice-mute') })
    if (cmd.isRequiredRole) actions.push({ type: 'requiredRole', name: $t('requires-role') })
    if (cmd.isAdmin) actions.push({ type: 'requireAdmin', name: $t('requires-admin') })
    if (cmd.isNSFW) actions.push({ type: 'nsfw', name: $t('is-nsfw') })
    return actions
  }

  function isEmbedConfigured(embed?: BCFDCommand['channelEmbed']): boolean {
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

  $: activeActions = getActiveActions(command)
  $: showCommand =
    command.type !== TYPE_MEMBER_JOIN &&
    command.type !== TYPE_MEMBER_LEAVE &&
    command.type !== TYPE_MEMBER_BAN

  function handleClose() {
    dispatch('close')
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      handleClose()
    }
  }
</script>

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    on:click={handleBackdropClick}
  >
    <div class="bg-base-100 rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col m-4">
      <!-- Header -->
      <div class="flex items-center justify-between p-4 border-b border-base-300">
        <h2 class="text-xl font-bold">{$t('command-preview') || 'Command Preview'}</h2>
        <button class="btn btn-sm btn-ghost btn-circle" on:click={handleClose}>
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>

      <!-- Content -->
      <div class="flex-1 overflow-y-auto p-4 space-y-4">
        <!-- Details Card -->
        <div class="card bg-base-200">
          <div class="card-header p-3">
            <h3 class="text-lg font-bold">{$t('details')}</h3>
          </div>
          <div class="card-body">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <span class="text-sm text-base-content/60">{$t('choose-command-type')}</span>
                <p class="font-medium">{getTypeName(command.type)}</p>
              </div>
              <div>
                <span class="text-sm text-base-content/60">{$t('description')}</span>
                <p class="font-medium">{command.commandDescription || '-'}</p>
              </div>
              {#if showCommand}
                <div class="col-span-2">
                  <span class="text-sm text-base-content/60">
                    {command.type === TYPE_REACTION ? $t('reaction') : $t('command')}
                  </span>
                  <p class="font-medium font-mono">{command.command || '-'}</p>
                </div>
                {#if command.type === TYPE_MESSAGE_RECEIVED || command.type === TYPE_PM_RECEIVED}
                  <div>
                    <span class="text-sm text-base-content/60">{$t('command-trigger')}</span>
                    <p class="font-medium">{getTriggerType(command)}</p>
                  </div>
                {/if}
              {/if}
            </div>
          </div>
        </div>

        <!-- Action Cards -->
        {#each activeActions as action}
          <div class="card bg-base-200">
            <div class="card-header p-3">
              <h3 class="text-lg font-bold">{action.name}</h3>
            </div>
            <div class="card-body">
              {#if action.type === 'sendMessage'}
                <CodeEditor value={command.channelMessage || ''} readonly={true} />
              {:else if action.type === 'sendPrivateMessage'}
                <CodeEditor value={command.privateMessage || ''} readonly={true} />
              {:else if action.type === 'sendChannelEmbed'}
                {#if isEmbedConfigured(command.channelEmbed)}
                  <div class="space-y-3">
                    {#if command.channelEmbed?.title}
                      <div>
                        <span class="text-sm text-base-content/60">{$t('channel-embed-title')}</span>
                        <CodeEditor value={command.channelEmbed.title} readonly={true} />
                      </div>
                    {/if}
                    {#if command.channelEmbed?.description}
                      <div>
                        <span class="text-sm text-base-content/60">{$t('channel-embed-description')}</span>
                        <CodeEditor value={command.channelEmbed.description} readonly={true} />
                      </div>
                    {/if}
                    {#if command.channelEmbed?.footer}
                      <div>
                        <span class="text-sm text-base-content/60">{$t('channel-embed-footer')}</span>
                        <CodeEditor value={command.channelEmbed.footer} readonly={true} />
                      </div>
                    {/if}
                    {#if command.channelEmbed?.imageURL}
                      <div>
                        <span class="text-sm text-base-content/60">{$t('channel-embed-image')}</span>
                        <p class="font-mono text-sm break-all">{command.channelEmbed.imageURL}</p>
                      </div>
                    {/if}
                    {#if command.channelEmbed?.thumbnailURL}
                      <div>
                        <span class="text-sm text-base-content/60">{$t('channel-embed-thumbnail')}</span>
                        <p class="font-mono text-sm break-all">{command.channelEmbed.thumbnailURL}</p>
                      </div>
                    {/if}
                    {#if command.channelEmbed?.hexColor}
                      <div class="flex items-center gap-2">
                        <span class="text-sm text-base-content/60">{$t('channel-embed-color')}</span>
                        <span
                          class="w-4 h-4 rounded border border-base-300"
                          style="background-color: {command.channelEmbed.hexColor}"
                        ></span>
                        <span class="font-mono text-sm">{command.channelEmbed.hexColor}</span>
                      </div>
                    {/if}
                  </div>
                {:else}
                  <p class="text-base-content/60">{$t('no-embed-configured') || 'No embed configured'}</p>
                {/if}
              {:else if action.type === 'sendPrivateEmbed'}
                {#if isEmbedConfigured(command.privateEmbed)}
                  <div class="space-y-3">
                    {#if command.privateEmbed?.title}
                      <div>
                        <span class="text-sm text-base-content/60">{$t('private-embed-title')}</span>
                        <CodeEditor value={command.privateEmbed.title} readonly={true} />
                      </div>
                    {/if}
                    {#if command.privateEmbed?.description}
                      <div>
                        <span class="text-sm text-base-content/60">{$t('private-embed-description')}</span>
                        <CodeEditor value={command.privateEmbed.description} readonly={true} />
                      </div>
                    {/if}
                    {#if command.privateEmbed?.footer}
                      <div>
                        <span class="text-sm text-base-content/60">{$t('private-embed-footer')}</span>
                        <CodeEditor value={command.privateEmbed.footer} readonly={true} />
                      </div>
                    {/if}
                    {#if command.privateEmbed?.imageURL}
                      <div>
                        <span class="text-sm text-base-content/60">{$t('private-embed-image')}</span>
                        <p class="font-mono text-sm break-all">{command.privateEmbed.imageURL}</p>
                      </div>
                    {/if}
                    {#if command.privateEmbed?.thumbnailURL}
                      <div>
                        <span class="text-sm text-base-content/60">{$t('private-embed-thumbnail')}</span>
                        <p class="font-mono text-sm break-all">{command.privateEmbed.thumbnailURL}</p>
                      </div>
                    {/if}
                    {#if command.privateEmbed?.hexColor}
                      <div class="flex items-center gap-2">
                        <span class="text-sm text-base-content/60">{$t('private-embed-color')}</span>
                        <span
                          class="w-4 h-4 rounded border border-base-300"
                          style="background-color: {command.privateEmbed.hexColor}"
                        ></span>
                        <span class="font-mono text-sm">{command.privateEmbed.hexColor}</span>
                      </div>
                    {/if}
                  </div>
                {:else}
                  <p class="text-base-content/60">{$t('no-embed-configured') || 'No embed configured'}</p>
                {/if}
              {:else if action.type === 'specificChannel'}
                <div>
                  <span class="text-sm text-base-content/60">{$t('channel-id') || 'Channel ID'}</span>
                  <p class="font-mono">{command.specificChannel}</p>
                </div>
              {:else if action.type === 'reaction'}
                <div>
                  <span class="text-sm text-base-content/60">{$t('reaction')}</span>
                  <p class="font-mono">{command.reaction}</p>
                </div>
              {:else if action.type === 'deleteIf'}
                <div>
                  <span class="text-sm text-base-content/60">{$t('delete-if-contains')}</span>
                  <p class="font-mono">{command.deleteIfStrings}</p>
                </div>
              {:else if action.type === 'deleteAfter'}
                <p class="text-base-content/80">{$t('deletes-command-message') || 'Deletes the command message after sending'}</p>
              {:else if action.type === 'deleteX'}
                <div>
                  <span class="text-sm text-base-content/60">{$t('delete-x-times')}</span>
                  <p class="font-medium">{command.deleteNum} {$t('messages') || 'message(s)'}</p>
                </div>
              {:else if action.type === 'roleAssigner'}
                <div>
                  <span class="text-sm text-base-content/60">{$t('role-id') || 'Role ID'}</span>
                  <p class="font-mono">{command.roleToAssign}</p>
                </div>
              {:else if action.type === 'kick'}
                <p class="text-base-content/80">{$t('kicks-mentioned-user') || 'Kicks the mentioned user'}</p>
              {:else if action.type === 'ban'}
                <p class="text-base-content/80">{$t('bans-mentioned-user') || 'Bans the mentioned user'}</p>
              {:else if action.type === 'voiceMute'}
                <p class="text-base-content/80">{$t('voice-mutes-mentioned-user') || 'Voice mutes the mentioned user'}</p>
              {:else if action.type === 'requiredRole'}
                <div>
                  <span class="text-sm text-base-content/60">{$t('role-id') || 'Role ID'}</span>
                  <p class="font-mono">{command.requiredRole}</p>
                </div>
              {:else if action.type === 'requireAdmin'}
                <p class="text-base-content/80">{$t('requires-administrator') || 'Requires Administrator Role'}</p>
              {:else if action.type === 'nsfw'}
                <p class="text-base-content/80">{$t('requires-nsfw-channel') || 'Requires NSFW Channel'}</p>
              {/if}
            </div>
          </div>
        {/each}

        {#if activeActions.length === 0}
          <div class="text-center py-8 text-base-content/60">
            <span class="material-symbols-outlined text-4xl mb-2">info</span>
            <p>{$t('no-actions-configured') || 'No actions configured for this command.'}</p>
          </div>
        {/if}
      </div>

      <!-- Footer -->
      <div class="flex justify-end p-4 border-t border-base-300">
        <button class="btn btn-ghost" on:click={handleClose}>
          {$t('close') || 'Close'}
        </button>
      </div>
    </div>
  </div>
{/if}
