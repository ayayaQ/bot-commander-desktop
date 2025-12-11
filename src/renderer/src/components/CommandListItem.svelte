<script lang="ts">
  import { t } from '../stores/localisation'
  import { settingsStore } from '../stores/settings'
  import type { BCFDCommand } from '../types/types'
  import { highlightBCFD } from '../utils/highlight'
  import Dialog from './Dialog.svelte'

  export let command: BCFDCommand
  export let editCommand: (command: BCFDCommand) => void
  export let deleteCommand: (command: BCFDCommand) => void

  let dialog: HTMLDialogElement

  function exportCommand() {
    const jsonCommand = JSON.stringify(command, null, 2)
    navigator.clipboard
      .writeText(jsonCommand)
      .then(() => {
        const toast = document.getElementById('toast') as HTMLDivElement
        toast.classList.remove('hidden')
        setTimeout(() => toast.classList.add('hidden'), 3000)
      })
      .catch((err) => console.error('Failed to copy command: ', err))
  }

  const TYPE_MESSAGE_RECEIVED = 0
  const TYPE_PM_RECEIVED = 1
  const TYPE_MEMBER_JOIN = 2
  const TYPE_MEMBER_LEAVE = 3
  const TYPE_MEMBER_BAN = 4
  const TYPE_REACTION = 5

  const PREVIEW_LIMIT = 140

  function truncatePreview(text: string | undefined, limit = PREVIEW_LIMIT) {
    if (!text) return ''
    const trimmed = text.trim()
    return trimmed.length > limit ? `${trimmed.slice(0, limit - 3)}...` : trimmed
  }

  function embedPreview(embed?: BCFDCommand['channelEmbed']) {
    if (!embed) return ''
    const parts = [embed.title, embed.description, embed.footer].filter(Boolean)
    return parts.join(' - ')
  }

  function buildPreview(command: BCFDCommand) {
    const previews: Array<{ label: string; value: string }> = []

    if (command.actionArr?.[0] && command.channelMessage) {
      previews.push({ label: 'Channel', value: truncatePreview(command.channelMessage) })
    }

    if (command.actionArr?.[1] && command.privateMessage) {
      previews.push({ label: 'DM', value: truncatePreview(command.privateMessage) })
    }

    if (command.sendChannelEmbed) {
      const value = truncatePreview(embedPreview(command.channelEmbed) || 'Embed configured')
      previews.push({ label: 'Channel embed', value })
    }

    if (command.sendPrivateEmbed) {
      const value = truncatePreview(embedPreview(command.privateEmbed) || 'Embed configured')
      previews.push({ label: 'DM embed', value })
    }

    if (command.isReact && command.reaction) {
      previews.push({ label: 'Reaction', value: truncatePreview(command.reaction, 40) })
    }

    if (command.deleteAfter) {
      previews.push({ label: 'Cleanup', value: 'Deletes the command message after sending' })
    }

    if (command.deleteX && command.deleteNum) {
      previews.push({ label: 'Cleanup', value: `Deletes ${command.deleteNum} message(s)` })
    }

    if (command.deleteIf && command.deleteIfStrings) {
      previews.push({
        label: 'Cleanup',
        value: `Deletes if contains: ${truncatePreview(command.deleteIfStrings, 60)}`
      })
    }

    return previews
  }

  $: previewItems = buildPreview(command)

  function displayNameForCommand(command: BCFDCommand) {
    switch (command.type) {
      case TYPE_MESSAGE_RECEIVED:
        return command.command
      case TYPE_PM_RECEIVED:
        return command.command
      case TYPE_MEMBER_JOIN:
        return 'Member Join'
      case TYPE_MEMBER_LEAVE:
        return 'Member Leave'
      case TYPE_MEMBER_BAN:
        return 'Member Ban'
      default:
        return command.command
    }
  }

  function displayIconForCommand(command: BCFDCommand) {
    // icons should be unique from material symbols
    switch (command.type) {
      case TYPE_MESSAGE_RECEIVED:
        return 'message'
      case TYPE_PM_RECEIVED:
        return 'chat'
      case TYPE_MEMBER_JOIN:
        return 'person_add'
      case TYPE_MEMBER_LEAVE:
        return 'exit_to_app'
      case TYPE_MEMBER_BAN:
        return 'person_remove'
      case TYPE_REACTION:
        return 'thumb_up'
      default:
        return 'message'
    }
  }
</script>

<li class="card bg-base-200 shadow-xl">
  <div class="card-body">
    <div class="flex justify-between items-start">
      <div class="flex items-center justify-center gap-2">
        <div class="flex items-center justify-center">
          <span class="material-symbols-outlined" style="font-size: 3rem;"
            >{displayIconForCommand(command)}</span
          >
        </div>
        <div class="space-y-2">
          <h3 class="card-title">{displayNameForCommand(command)}</h3>
          <p class="text-sm text-base-content/80">{command.commandDescription}</p>

          {#if !$settingsStore.hideOutput}
            <div class="border-t border-base-300 pt-2">
              <p class="text-xs font-semibold uppercase text-base-content/60 tracking-wide">
                Output preview
              </p>
              {#if previewItems.length}
                <div class="mt-1 grid gap-2 md:grid-cols-2">
                  {#each previewItems as item}
                    <div class="flex items-start gap-2">
                      <span class="badge badge-ghost badge-sm">{item.label}</span>
                      <div
                        class="text-sm leading-snug text-base-content/80 font-mono whitespace-pre-wrap break-words"
                        aria-label="Output preview"
                      >
                        {@html highlightBCFD(item.value)}
                      </div>
                    </div>
                  {/each}
                </div>
              {:else}
                <p class="text-sm text-base-content/60">No outputs configured.</p>
              {/if}
            </div>
          {/if}
        </div>
      </div>
      <div class="space-x-2 shrink-0">
        <span class="tooltip tooltip-primary tooltip-bottom" data-tip={$t('edit')}>
          <button class="btn btn-square btn-ghost" on:click={() => editCommand(command)}
            ><span class="material-symbols-outlined">edit</span></button
          >
        </span>
        <span class="tooltip tooltip-primary tooltip-bottom" data-tip={$t('export')}>
          <button class="btn btn-square btn-ghost" on:click={exportCommand}
            ><span class="material-symbols-outlined">download</span></button
          >
        </span>
        <span class="tooltip tooltip-primary tooltip-bottom" data-tip={$t('delete')}>
          <button
            class="btn btn-square btn-ghost"
            on:click={(e) => {
              if (e.shiftKey) {
                deleteCommand(command)
              } else {
                dialog.showModal()
              }
            }}><span class="material-symbols-outlined">delete</span></button
          >
        </span>

        <Dialog bind:dialog on:close={() => console.log('closed')}>
          <p>
            {$t('are-you-sure-you-want-to-delete-the-command')}
            {$t('open-quote')}{command.command}{$t('close-quote')}
          </p>
          <div class="modal-action">
            <form method="dialog">
              <button class="btn btn-sm btn-error" on:click={() => deleteCommand(command)}
                >{$t('delete')}</button
              >
              <button class="btn btn-sm btn-ghost">{$t('cancel')}</button>
            </form>
          </div>
        </Dialog>
      </div>
    </div>
  </div>
</li>

<div id="toast" class="toast toast-bottom toast-end hidden z-50 mb-14">
  <div class="alert alert-success select-none">
    <span>{$t('command-exported-to-clipboard')}</span>
  </div>
</div>
