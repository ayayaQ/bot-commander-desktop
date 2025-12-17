<script lang="ts">
  import { onMount, afterUpdate } from 'svelte'
  import { consoleStore, initConsoleListeners, type ConsoleMessage } from '../stores/console'

  let consoleElement: HTMLDivElement
  let autoScroll = true
  let collapsed = true
  let copiedId: number | null = null

  $: messages = $consoleStore

  function getIconForType(type: ConsoleMessage['type']): string {
    switch (type) {
      case 'info':
        return 'info'
      case 'error':
        return 'error'
      case 'warning':
        return 'warning'
      case 'event':
        return 'bolt'
      case 'success':
        return 'check_circle'
      default:
        return 'info'
    }
  }

  function getColorForType(type: ConsoleMessage['type']): string {
    switch (type) {
      case 'info':
        return 'text-info'
      case 'error':
        return 'text-error'
      case 'warning':
        return 'text-warning'
      case 'event':
        return 'text-primary'
      case 'success':
        return 'text-success'
      default:
        return 'text-base-content'
    }
  }

  function formatTimestamp(date: Date): string {
    return date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }

  function handleClear() {
    consoleStore.clear()
  }

  async function copyMessage(text: string, id: number) {
    try {
      await navigator.clipboard.writeText(text)
      copiedId = id
      setTimeout(() => (copiedId = null), 1500)
    } catch (e) {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
      } catch {}
      document.body.removeChild(ta)
      copiedId = id
      setTimeout(() => (copiedId = null), 1500)
    }
  }

  onMount(() => {
    initConsoleListeners()
  })

  afterUpdate(() => {
    if (autoScroll && consoleElement) {
      consoleElement.scrollTop = consoleElement.scrollHeight
    }
  })
</script>

<div class="flex flex-col bg-base-300 border-t border-base-content/10" class:h-48={!collapsed}>
  <div
    class="flex items-center justify-between px-3 py-1 bg-base-200 border-b border-base-content/10"
  >
    <button
      class="flex items-center gap-2 hover:bg-base-300 transition-colors cursor-pointer rounded px-1 -ml-1"
      on:click={() => (collapsed = !collapsed)}
    >
      <span
        class="material-symbols-outlined text-sm transition-transform"
        class:rotate-180={collapsed}>expand_more</span
      >
      <span class="material-symbols-outlined text-sm">terminal</span>
      <span class="text-sm font-medium">Console</span>
      <span class="badge badge-sm badge-ghost">{messages.length}</span>
    </button>
    <div class="flex items-center gap-2">
      {#if !collapsed}
        <label class="flex items-center gap-1 cursor-pointer">
          <input type="checkbox" class="checkbox checkbox-xs" bind:checked={autoScroll} />
          <span class="text-xs">Auto-scroll</span>
        </label>
        <button class="btn btn-ghost btn-xs" on:click={handleClear} title="Clear console">
          <span class="material-symbols-outlined text-sm">delete</span>
        </button>
      {/if}
    </div>
  </div>
  {#if !collapsed}
    <div bind:this={consoleElement} class="flex-1 overflow-y-auto p-2 font-mono text-xs space-y-1">
      {#if messages.length === 0}
        <div class="text-base-content/50 italic">No messages yet...</div>
      {:else}
        {#each messages as message (message.id)}
          <div
            class="flex items-start gap-2 hover:bg-base-content/5 rounded px-1 cursor-pointer"
            on:click={() => copyMessage(message.message, message.id)}
          >
            <span
              class="material-symbols-outlined text-sm {getColorForType(message.type)}"
              style="font-size: 14px;"
            >
              {getIconForType(message.type)}
            </span>
            <span class="text-base-content/50 shrink-0">[{formatTimestamp(message.timestamp)}]</span
            >
            {#if copiedId === message.id}
              <span class="ml-2 text-success text-xs">Copied!</span>
            {/if}
            <span class={getColorForType(message.type)}>{message.message}</span>
          </div>
        {/each}
      {/if}
    </div>
  {/if}
</div>
