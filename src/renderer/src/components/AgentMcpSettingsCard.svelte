<script lang="ts">
  import { onMount } from 'svelte'
  import { createAgentMcpControls, parseAgentMcpDraft } from '../stores/agentMcp'
  import type { AgentMcpCatalogKind, AgentMcpServerConfig } from '../../../shared/agentMcpTypes'

  const controls = createAgentMcpControls(window.electron.ipcRenderer)
  const kinds: AgentMcpCatalogKind[] = ['tools', 'resources', 'resourceTemplates']
  const labels = { tools: 'Tools', resources: 'Resources', resourceTemplates: 'Resource templates' }
  let editing = $state(false)
  let dirty = $state(false)
  let id = $state('')
  let label = $state('')
  let executable = $state('')
  let cwd = $state('')
  let args = $state('[]')
  let protocol = $state<AgentMcpServerConfig['protocol']>('legacy')
  let environment = $state<string[]>([])
  let formError = $state('')
  const blocked = $derived(
    !!$controls.busy || !!$controls.preparation || !!$controls.status?.paused
  )
  const editBlocked = $derived(
    !!$controls.status?.paused ||
      (!!$controls.busy && $controls.busy !== 'prepare' && $controls.busy !== 'start')
  )

  onMount(() => {
    controls.mount()
    return () => controls.unmount()
  })
  function changed() {
    dirty = true
    formError = ''
    controls.configurationChanged()
  }
  function edit(server: AgentMcpServerConfig) {
    controls.configurationChanged()
    editing = true
    id = server.id
    label = server.label
    executable = server.executable
    cwd = server.cwd
    args = JSON.stringify(server.args)
    protocol = server.protocol
    environment = [...server.environment]
    dirty = false
    formError = ''
  }
  function clear() {
    controls.configurationChanged()
    editing = false
    dirty = false
    id = ''
    label = ''
    executable = ''
    cwd = ''
    args = '[]'
    protocol = 'legacy'
    environment = []
    formError = ''
  }
  async function save(event: SubmitEvent) {
    event.preventDefault()
    formError = ''
    try {
      const config = parseAgentMcpDraft(
        { id, label, executable, cwd, argsJson: args, protocol, environment },
        $controls.status?.environmentNames ?? []
      )
      if (await controls.configure(config)) {
        editing = true
        dirty = false
      }
    } catch (error) {
      formError = error instanceof Error ? error.message : 'Invalid server configuration.'
    }
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (
      event.key === 'Escape' &&
      ($controls.preparation || $controls.busy === 'prepare' || $controls.busy === 'start')
    ) {
      event.preventDefault()
      controls.cancel()
    }
  }}
/>

<section
  class="rounded-box border border-base-300 bg-base-200/50 p-4 space-y-4 mt-4"
  aria-label="Agent MCP servers"
>
  <h3 class="text-lg font-semibold">Agent MCP servers</h3>
  <p class="text-sm">
    Connect the built-in agent to a trusted, already-installed stdio server. Saving starts nothing.
    Each Start needs a fresh launch review. Every tool call and resource read needs human approval,
    including Auto. Planning exposes local metadata only.
  </p>
  <p class="rounded-lg border border-base-300 p-3 text-sm">
    Server code runs with your OS permissions and is not sandboxed. It can access files and the
    network before tool approval. Do not put credentials or private values in arguments. Use an
    absolute executable path, never a shell or package installer.
  </p>
  {#if $controls.status?.paused}<p class="text-warning text-sm" role="status">
      Agent MCP controls are paused.
    </p>{/if}
  {#if $controls.error}<p class="text-error text-sm" role="alert">{$controls.error}</p>{/if}
  {#if $controls.notice}<p class="text-sm" role="status">{$controls.notice}</p>{/if}
  {#if !$controls.status}
    <div class="flex flex-wrap gap-2 text-sm">
      <span
        >{$controls.busy === 'load' ? 'Loading server status…' : 'Server status unavailable.'}</span
      ><button class="btn btn-sm" onclick={() => controls.reload()} disabled={!!$controls.busy}
        >Load status</button
      >
    </div>
  {/if}
  {#if $controls.preparation}
    <section
      class="rounded-box border-2 border-warning p-3 space-y-3"
      aria-label="Review exact MCP launch"
    >
      <h4 class="font-semibold">Review exact launch</h4>
      <p class="text-sm">
        Confirm only if you trust this installed executable. Its metadata may go to the selected AI
        provider; approved returned text enters the local transcript and may go to that provider.
        Server metadata and output are untrusted. This is startup approval only.
      </p>
      <pre class="whitespace-pre-wrap break-all text-xs max-h-72 overflow-auto">{$controls
          .preparation.disclosure}</pre>
      <p class="text-xs break-all">
        Launch identity: {$controls.preparation.launchDigest}<br />Expires: {new Date(
          $controls.preparation.expiresAt
        ).toLocaleTimeString()}
      </p>
      <button
        class="btn btn-sm btn-warning"
        onclick={() => controls.start()}
        disabled={!!$controls.busy}>Start once</button
      >
      <button class="btn btn-sm" onclick={() => controls.cancel()}>Cancel</button>
    </section>
  {:else if $controls.busy === 'prepare' || $controls.busy === 'start'}
    <div class="flex flex-wrap items-center gap-2 text-sm" role="status">
      <span>{$controls.busy === 'prepare' ? 'Preparing launch review…' : 'Starting server…'}</span
      ><button class="btn btn-sm" onclick={() => controls.cancel()}>Cancel Start</button>
    </div>
  {/if}
  <form class="space-y-3" onsubmit={save}>
    <h4 class="font-medium">{editing ? 'Edit saved server' : 'Configure an installed server'}</h4>
    <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
      <label class="form-control"
        >Server ID<input
          class="input input-bordered"
          bind:value={id}
          oninput={changed}
          maxlength="16"
          disabled={editBlocked || editing}
        /></label
      >
      <label class="form-control"
        >Label<input
          class="input input-bordered"
          bind:value={label}
          oninput={changed}
          maxlength="80"
          disabled={editBlocked}
        /></label
      >
      <label class="form-control"
        >Installed executable (absolute path)<input
          class="input input-bordered font-mono text-xs"
          bind:value={executable}
          oninput={changed}
          disabled={editBlocked}
        /></label
      >
      <label class="form-control"
        >Working directory (absolute path)<input
          class="input input-bordered font-mono text-xs"
          bind:value={cwd}
          oninput={changed}
          disabled={editBlocked}
        /></label
      >
      <label class="form-control"
        >Arguments (JSON array)<textarea
          class="textarea textarea-bordered font-mono text-xs"
          bind:value={args}
          oninput={changed}
          disabled={editBlocked}></textarea></label
      >
      <label class="form-control"
        >Protocol compatibility<select
          class="select select-bordered"
          bind:value={protocol}
          onchange={changed}
          disabled={editBlocked}
          ><option value="legacy">Legacy negotiation</option><option value="2026-07-28"
            >2026-07-28</option
          ></select
        ></label
      >
    </div>
    <fieldset class="space-y-2" disabled={editBlocked}>
      <legend class="text-sm">Optional inherited safe environment names</legend>
      <p class="text-xs opacity-70">
        No custom values or credentials can be entered or saved here.
      </p>
      {#each $controls.status?.environmentNames ?? [] as name}<label
          class="label cursor-pointer inline-flex gap-2"
          ><input
            class="checkbox checkbox-sm"
            type="checkbox"
            value={name}
            bind:group={environment}
            onchange={changed}
          />{name}</label
        >{/each}
    </fieldset>
    {#if formError}<p class="text-error text-sm" role="alert">{formError}</p>{/if}
    <div class="flex flex-wrap gap-2">
      <button class="btn btn-sm btn-primary" type="submit" disabled={blocked || !$controls.status}
        >Save configuration</button
      ><button class="btn btn-sm" type="button" onclick={clear} disabled={editBlocked}
        >{editing ? 'New server' : 'Clear'}</button
      >
    </div>
    {#if dirty && editing}<p class="text-xs opacity-70">
        Save your edits before starting this server.
      </p>{/if}
  </form>
  {#if $controls.status && !$controls.status.servers.length}<p class="text-sm opacity-70">
      No agent MCP servers configured.
    </p>{/if}
  {#each $controls.status?.servers ?? [] as entry (entry.server.id)}
    <article class="rounded-box border border-base-300 p-3 space-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <strong class="break-all">{entry.server.label}</strong><span class="badge"
          >{entry.server.id}: {entry.state}</span
        >
      </div>
      {#if entry.message}<p class="text-sm break-all">{entry.message}</p>{/if}
      {#if entry.cleanupPending}<p class="text-warning text-sm">
          Owned process cleanup remains unverified. Retry Disconnect before another launch.
        </p>{/if}
      <div class="flex flex-wrap gap-2">
        <button class="btn btn-xs" onclick={() => edit(entry.server)} disabled={editBlocked}
          >Edit</button
        >
        <button
          class="btn btn-xs"
          onclick={() => controls.remove(entry.server.id)}
          disabled={blocked}>Remove</button
        >
        <button
          class="btn btn-xs btn-primary"
          onclick={() => controls.prepare(entry.server.id)}
          disabled={blocked ||
            entry.state === 'connected' ||
            entry.state === 'connecting' ||
            entry.cleanupPending ||
            (dirty && id.trim() === entry.server.id)}>Review startup</button
        >
        <button
          class="btn btn-xs"
          onclick={() => controls.disconnect(entry.server.id)}
          disabled={blocked || (entry.state === 'disabled' && !entry.cleanupPending)}
          >Disconnect</button
        >
      </div>
      <details class="text-sm">
        <summary class="cursor-pointer">Saved configuration (starts nothing)</summary>
        <pre class="whitespace-pre-wrap break-all text-xs max-h-48 overflow-auto">{JSON.stringify(
            entry.server,
            null,
            2
          )}</pre>
      </details>
      {#if entry.catalog}
        <p class="text-xs opacity-70">Local catalog generation {entry.catalog.generation}</p>
        {#each kinds as kind}
          {@const category = entry.catalog[kind]}
          <details class="text-sm">
            <summary class="cursor-pointer"
              >{labels[kind]}: {category.state} ({category.available}/{category.count} available)</summary
            >
            {#if category.reason}<p class="text-xs break-all">{category.reason}</p>{/if}
            {#if kind === 'resourceTemplates'}<p class="text-xs opacity-70">
                Templates are metadata-only. They cannot be expanded or read by the agent.
              </p>{/if}
            {#each category.entries as item}
              <div class="border-t border-base-300 py-2 text-xs">
                <strong class="break-all">{item.remoteKey}</strong> · {item.state}
                <p class="break-all opacity-70">Local alias: {item.alias}</p>
                {#if item.reason}<p class="break-all">{item.reason}</p>{/if}
                {#if item.descriptorJson}<pre
                    class="whitespace-pre-wrap break-all text-xs max-h-48 overflow-auto">{item.descriptorJson}</pre>{/if}
              </div>
            {/each}
            {#if !category.entries.length}<p class="text-xs opacity-70">
                No locally captured entries.
              </p>{/if}
          </details>
        {/each}
      {:else}<p class="text-xs opacity-70">
          No catalog captured. Start explicitly to discover tools.
        </p>{/if}
      <div class="flex flex-wrap gap-2">
        <button
          class="btn btn-xs"
          onclick={() => controls.refresh(entry.server.id, ['tools'])}
          disabled={blocked || entry.state !== 'connected'}>Refresh tool metadata</button
        >
        <button
          class="btn btn-xs"
          onclick={() => controls.refresh(entry.server.id, ['resources'])}
          disabled={blocked || entry.state !== 'connected'}>Refresh resource metadata</button
        >
        <button
          class="btn btn-xs"
          onclick={() => controls.refresh(entry.server.id, ['resourceTemplates'])}
          disabled={blocked || entry.state !== 'connected'}>Refresh template metadata</button
        >
      </div>
    </article>
  {/each}
  <p class="text-xs opacity-70">
    HTTP, OAuth, credential injection, installation and package/shell runners are unavailable. No
    automatic reconnect or retry. Disconnect and cancellation cannot undo effects.
  </p>
</section>
