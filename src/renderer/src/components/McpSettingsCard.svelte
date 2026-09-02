<script lang="ts">
  import { onMount } from 'svelte'
  import type { McpAccessMode, McpActivityEntry, McpServerStatus } from '../../../shared/mcpTypes'

  const emptyStatus: McpServerStatus = {
    enabled: false,
    accessMode: 'read-only',
    port: 43721,
    running: false,
    endpoint: 'http://127.0.0.1:43721/mcp',
    tokenConfigured: false,
    secureStorageAvailable: false,
    activeRequests: 0
  }

  let status: McpServerStatus = $state(emptyStatus)
  let entries: McpActivityEntry[] = $state([])
  let port = $state(43721)
  let busy = $state(false)
  let notice = $state('')
  let noticeError = $state(false)

  onMount(() => {
    const handleStatus = (next: McpServerStatus) => {
      status = next
      port = next.port
    }
    const handleActivity = (next: McpActivityEntry[]) => {
      entries = next
    }
    window.electron.ipcRenderer.on('mcp:status', handleStatus)
    window.electron.ipcRenderer.on('mcp:activity', handleActivity)
    void Promise.all([
      window.electron.ipcRenderer.invoke('mcp:get-status'),
      window.electron.ipcRenderer.invoke('mcp:get-activity')
    ]).then(([nextStatus, nextEntries]) => {
      handleStatus(nextStatus)
      handleActivity(nextEntries)
    })
    return () => {
      window.electron.ipcRenderer.removeListener('mcp:status', handleStatus)
      window.electron.ipcRenderer.removeListener('mcp:activity', handleActivity)
    }
  })

  function showNotice(message: string, error = false) {
    notice = message
    noticeError = error
    setTimeout(() => {
      if (notice === message) notice = ''
    }, 4000)
  }

  async function updateConfig(updates: Record<string, unknown>) {
    busy = true
    try {
      status = await window.electron.ipcRenderer.invoke('mcp:update-config', updates)
      port = status.port
    } catch (error) {
      showNotice(error instanceof Error ? error.message : 'Failed to update MCP settings', true)
    } finally {
      busy = false
    }
  }

  async function toggleEnabled() {
    await updateConfig({ enabled: !status.enabled })
  }

  async function changeAccess(event: Event) {
    const accessMode = (event.currentTarget as HTMLSelectElement).value as McpAccessMode
    await updateConfig({ accessMode })
  }

  async function savePort() {
    await updateConfig({ port })
  }

  async function copyToken() {
    try {
      await window.electron.ipcRenderer.invoke('mcp:copy-token')
      showNotice('MCP token copied to the clipboard.')
    } catch (error) {
      showNotice(error instanceof Error ? error.message : 'Failed to copy MCP token', true)
    }
  }

  async function rotateToken() {
    if (
      !confirm('Rotate the MCP token? Existing Codex and Claude configurations will stop working.')
    )
      return
    busy = true
    try {
      status = await window.electron.ipcRenderer.invoke('mcp:rotate-token')
      showNotice('MCP token rotated. Copy the new token into each client environment.')
    } catch (error) {
      showNotice(error instanceof Error ? error.message : 'Failed to rotate MCP token', true)
    } finally {
      busy = false
    }
  }

  async function copyText(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value)
      showNotice(`${label} configuration copied.`)
    } catch {
      showNotice(`Could not copy the ${label} configuration. Select it manually instead.`, true)
    }
  }

  async function clearActivity() {
    entries = await window.electron.ipcRenderer.invoke('mcp:clear-activity')
  }

  let codexConfig = $derived(`[mcp_servers.bot_commander]
url = "${status.endpoint}"
bearer_token_env_var = "BOT_COMMANDER_MCP_TOKEN"
default_tools_approval_mode = "writes"`)

  let claudeConfig = $derived(`{
  "mcpServers": {
    "bot-commander": {
      "type": "http",
      "url": "${status.endpoint}",
      "headers": {
        "Authorization": "Bearer \${BOT_COMMANDER_MCP_TOKEN}"
      }
    }
  }
}`)
</script>

<div class="rounded-box border border-base-300 bg-base-200/50 p-4 space-y-4">
  <div class="flex flex-wrap items-start justify-between gap-4">
    <div>
      <div class="flex items-center gap-2">
        <h3 class="text-lg font-semibold">External agent access</h3>
        <span class="badge {status.running ? 'badge-success' : status.error ? 'badge-error' : ''}">
          {status.running ? 'Running' : status.error ? 'Error' : 'Stopped'}
        </span>
      </div>
      <p class="text-sm opacity-70 mt-1">
        Let Codex, Claude Code, or another local MCP client work with this running app.
      </p>
    </div>
    <input
      type="checkbox"
      class="toggle toggle-primary"
      checked={status.enabled}
      disabled={busy || (!status.secureStorageAvailable && !status.enabled)}
      aria-label="Enable external agent access"
      onchange={toggleEnabled}
    />
  </div>

  {#if !status.secureStorageAvailable}
    <div class="alert alert-warning text-sm">
      Secure credential storage is unavailable, so the authenticated MCP server cannot be enabled.
    </div>
  {/if}
  {#if status.error}
    <div class="alert alert-error text-sm">{status.error}</div>
  {/if}
  {#if notice}
    <div class="alert {noticeError ? 'alert-error' : 'alert-success'} text-sm">{notice}</div>
  {/if}

  <div class="grid gap-3 md:grid-cols-2">
    <label class="form-control">
      <span class="label-text mb-1">Access</span>
      <select
        class="select select-bordered"
        value={status.accessMode}
        disabled={busy}
        onchange={changeAccess}
      >
        <option value="read-only">Read only</option>
        <option value="read-write">Read and write</option>
      </select>
    </label>
    <label class="form-control">
      <span class="label-text mb-1">Loopback port</span>
      <div class="join">
        <input
          class="input input-bordered join-item w-full"
          type="number"
          min="1024"
          max="65535"
          bind:value={port}
        />
        <button class="btn join-item" disabled={busy || port === status.port} onclick={savePort}
          >Apply</button
        >
      </div>
    </label>
  </div>

  <div class="rounded-lg bg-base-300/50 p-3 text-sm">
    <div class="font-medium">Endpoint</div>
    <code class="break-all">{status.endpoint}</code>
    <div class="mt-2 flex flex-wrap gap-2">
      <button class="btn btn-sm" disabled={!status.tokenConfigured} onclick={copyToken}
        >Copy token</button
      >
      <button
        class="btn btn-sm btn-outline"
        disabled={busy || !status.tokenConfigured}
        onclick={rotateToken}
      >
        Rotate token
      </button>
    </div>
  </div>

  {#if status.accessMode === 'read-write'}
    <div class="alert alert-warning text-sm">
      Authenticated clients can change commands, interactions, bot state, startup JavaScript,
      developer instructions, and memories. Keep write approvals enabled in your agent harness.
    </div>
  {/if}

  <div class="grid gap-3 xl:grid-cols-2">
    <div>
      <div class="flex items-center justify-between mb-1">
        <span class="text-sm font-medium">Codex config.toml</span>
        <button class="btn btn-ghost btn-xs" onclick={() => copyText(codexConfig, 'Codex')}
          >Copy</button
        >
      </div>
      <pre
        class="overflow-x-auto rounded-lg bg-base-300 p-3 text-xs whitespace-pre-wrap">{codexConfig}</pre>
    </div>
    <div>
      <div class="flex items-center justify-between mb-1">
        <span class="text-sm font-medium">Claude Code .mcp.json</span>
        <button class="btn btn-ghost btn-xs" onclick={() => copyText(claudeConfig, 'Claude Code')}
          >Copy</button
        >
      </div>
      <pre
        class="overflow-x-auto rounded-lg bg-base-300 p-3 text-xs whitespace-pre-wrap">{claudeConfig}</pre>
    </div>
  </div>
  <p class="text-xs opacity-60">
    Set <code>BOT_COMMANDER_MCP_TOKEN</code> to the copied token in the environment that starts your client.
    Bot Commander never writes agent configuration files automatically.
  </p>

  <div>
    <div class="flex items-center justify-between mb-2">
      <div>
        <span class="font-medium">Recent activity</span>
        {#if status.activeRequests > 0}
          <span class="loading loading-spinner loading-xs ml-2"></span>
        {/if}
      </div>
      <button class="btn btn-ghost btn-xs" disabled={entries.length === 0} onclick={clearActivity}
        >Clear</button
      >
    </div>
    {#if entries.length === 0}
      <p class="text-sm opacity-60">No MCP tool calls in this app session.</p>
    {:else}
      <div class="max-h-64 overflow-y-auto space-y-2">
        {#each entries as entry (entry.id)}
          <div
            class="flex items-start justify-between gap-3 rounded-lg border border-base-300 p-2 text-sm"
          >
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <code>{entry.tool}</code>
                <span
                  class="badge badge-sm {entry.kind === 'write' ? 'badge-warning' : 'badge-ghost'}"
                  >{entry.kind}</span
                >
                {#if entry.status === 'running'}
                  <span class="loading loading-dots loading-xs"></span>
                {:else}
                  <span class={entry.status === 'error' ? 'text-error' : 'text-success'}
                    >{entry.status}</span
                  >
                {/if}
              </div>
              <div class="truncate text-xs opacity-60">
                {entry.client}{entry.targetLabel ? ` · ${entry.targetLabel}` : ''}{entry.summary
                  ? ` · ${entry.summary}`
                  : ''}
              </div>
            </div>
            <span class="shrink-0 text-xs opacity-50">
              {entry.durationMs === undefined ? '' : `${entry.durationMs} ms`}
            </span>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
