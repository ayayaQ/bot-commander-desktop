<script lang="ts">
  import type { BCFDCommand } from '../types/types'
  import { highlightBCFD } from '../utils/highlight'

  export let command: BCFDCommand

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
</script>

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
