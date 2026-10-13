<script lang="ts">
  import { onMount } from 'svelte'
  import {
    createAgentMcpControls,
    parseAgentMcpDraft,
    parseAgentMcpOAuthDraft,
    parseAgentMcpOAuthPublicClient,
    type AgentMcpOAuthDraft
  } from '../stores/agentMcp'
  import type { AgentMcpCatalogKind, AgentMcpServerConfig } from '../../../shared/agentMcpTypes'

  const controls = createAgentMcpControls(window.electron.ipcRenderer)
  const kinds: AgentMcpCatalogKind[] = ['tools', 'resources', 'resourceTemplates']
  const labels = { tools: 'Tools', resources: 'Resources', resourceTemplates: 'Resource templates' }
  let editing = $state(false)
  let dirty = $state(false)
  let id = $state('')
  let label = $state('')
  let transport = $state<'stdio' | 'http'>('stdio')
  let endpoint = $state('')
  let allowLoopbackHttp = $state(false)
  let executable = $state('')
  let cwd = $state('')
  let args = $state('[]')
  let protocol = $state<AgentMcpServerConfig['protocol']>('legacy')
  let environment = $state<string[]>([])
  let formError = $state('')
  let oauthDrafts = $state<Record<string, AgentMcpOAuthDraft>>({})
  let oauthDirty = $state<Record<string, boolean>>({})
  let oauthFormError = $state('')
  let oauthErrorServerId = $state('')
  const reviewServer = $derived(
    $controls.status?.servers.find((entry) => entry.server.id === $controls.preparation?.serverId)
      ?.server
  )
  const blocked = $derived(
    !!$controls.busy ||
      !!$controls.preparation ||
      !!$controls.oauthReview ||
      !!$controls.status?.paused
  )
  const editBlocked = $derived(
    !!$controls.status?.paused ||
      (!!$controls.busy &&
        $controls.busy !== 'prepare' &&
        $controls.busy !== 'start' &&
        !$controls.busy.startsWith('oauth-'))
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
    transport = server.transport === 'http' ? 'http' : 'stdio'
    endpoint = server.transport === 'http' ? server.endpoint : ''
    allowLoopbackHttp = server.transport === 'http' ? server.allowLoopbackHttp : false
    executable = server.transport === 'http' ? '' : server.executable
    cwd = server.transport === 'http' ? '' : server.cwd
    args = server.transport === 'http' ? '[]' : JSON.stringify(server.args)
    protocol = server.protocol
    environment = server.transport === 'http' ? [] : [...server.environment]
    dirty = false
    formError = ''
  }
  function clear() {
    controls.configurationChanged()
    editing = false
    dirty = false
    id = ''
    label = ''
    transport = 'stdio'
    endpoint = ''
    allowLoopbackHttp = false
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
        transport === 'http'
          ? { transport, id, label, endpoint, protocol, allowLoopbackHttp }
          : { id, label, executable, cwd, argsJson: args, protocol, environment },
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
  function oauthDraft(serverId: string): AgentMcpOAuthDraft {
    return (
      oauthDrafts[serverId] ?? {
        clientId: '',
        issuer: '',
        redirectPort: '49152',
        redirectPath: '/oauth/callback',
        scopes: '',
        clientName: 'Bot Commander Desktop'
      }
    )
  }
  function oauthChanged(serverId: string, key: keyof AgentMcpOAuthDraft, event: Event) {
    oauthDrafts[serverId] = {
      ...oauthDraft(serverId),
      [key]: (event.target as HTMLInputElement).value
    }
    oauthDirty[serverId] = true
    oauthFormError = ''
    controls.configurationChanged()
  }
  async function configureOAuth(serverId: string, register: boolean) {
    oauthFormError = ''
    oauthErrorServerId = serverId
    try {
      if (register)
        await controls.prepareRegistration(serverId, parseAgentMcpOAuthDraft(oauthDraft(serverId)))
      else if (
        await controls.configureOAuth(
          serverId,
          parseAgentMcpOAuthPublicClient(oauthDraft(serverId))
        )
      )
        oauthDirty[serverId] = false
    } catch (error) {
      oauthFormError = error instanceof Error ? error.message : 'Invalid public OAuth settings.'
    }
  }
  async function confirmOAuth() {
    const review = $controls.oauthReview
    if (await controls.confirmOAuth()) {
      if (review?.kind === 'registration') oauthDirty[review.serverId] = false
    }
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (
      event.key === 'Escape' &&
      ($controls.preparation ||
        $controls.oauthReview ||
        $controls.oauthServerId ||
        $controls.busy === 'prepare' ||
        $controls.busy === 'start')
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
    Connect the built-in agent to a trusted installed stdio server or Streamable HTTP endpoint.
    Saving starts nothing. Each Start needs a fresh review. Every tool call and resource read needs
    human approval, including Auto. Planning exposes local metadata only.
  </p>
  <p class="rounded-lg border border-base-300 p-3 text-sm">
    {#if transport === 'http'}
      Starting an HTTP connection contacts the exact endpoint before tool approval, including
      initialization and metadata discovery. The endpoint can observe your network address and MCP
      traffic. Use HTTPS for remote servers. Optional OAuth uses a public client and separate
      reviews. Credentials and custom headers cannot be entered here.
    {:else}
      Server code runs with your OS permissions and is not sandboxed. It can access files and the
      network before tool approval. Do not put credentials or private values in arguments. Use an
      absolute executable path, never a shell or package installer.
    {/if}
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
      <h4 class="font-semibold">
        {reviewServer?.transport === 'http'
          ? 'Review exact HTTP connection'
          : 'Review exact launch'}
      </h4>
      <p class="text-sm">
        {#if reviewServer?.transport === 'http'}
          Confirm only if you trust the exact endpoint and authentication revision in this
          disclosure. Starting sends initialization and metadata requests over the network before
          tool approval. The disclosure identifies the exact authentication state. This Start does
          not request an OAuth grant.
        {:else}
          Confirm only if you trust this installed executable.
        {/if}
        Its metadata may go to the selected AI provider; approved returned text enters the local transcript
        and may go to that provider. Server metadata and output are untrusted. This is startup approval
        only.
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
  {#if $controls.oauthReview}
    <section
      class="rounded-box border-2 border-warning p-3 space-y-3"
      aria-label="Review exact OAuth action"
    >
      <h4 class="font-semibold">
        {$controls.oauthReview.kind === 'registration'
          ? 'Review public client registration'
          : 'Review browser sign-in'}
      </h4>
      <p class="text-sm">
        Review the exact destinations, public settings and consequences below. Approve this one
        action only if you trust them. Registration and sign-in each need separate approval; neither
        starts an MCP connection. A completed sign-in needs a fresh connection review.
      </p>
      <pre class="whitespace-pre-wrap break-all text-xs max-h-72 overflow-auto">{$controls
          .oauthReview.disclosure}</pre>
      <p class="text-xs">
        Expires: {new Date($controls.oauthReview.expiresAt).toLocaleTimeString()}
      </p>
      <button class="btn btn-sm btn-warning" onclick={confirmOAuth} disabled={!!$controls.busy}
        >{$controls.oauthReview.kind === 'registration'
          ? 'Register once'
          : 'Open browser once'}</button
      >
      <button class="btn btn-sm" onclick={() => controls.cancel()}>Cancel OAuth</button>
    </section>
  {:else if $controls.oauthServerId}
    <div class="flex flex-wrap items-center gap-2 text-sm" role="status">
      <span
        >{$controls.busy === 'oauth-prepare-registration'
          ? 'Preparing OAuth registration review…'
          : $controls.busy === 'oauth-prepare-sign-in'
            ? 'Preparing OAuth sign-in review…'
            : $controls.busy === 'oauth-register'
              ? 'Registering public client…'
              : $controls.busy === 'oauth-sign-in'
                ? 'Waiting for browser sign-in…'
                : 'Configuring public client…'}</span
      >
      <button class="btn btn-sm" onclick={() => controls.cancel()}>Cancel OAuth</button>
    </div>
  {/if}
  <form class="space-y-3" onsubmit={save}>
    <h4 class="font-medium">{editing ? 'Edit saved server' : 'Configure a server'}</h4>
    <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
      <label class="form-control"
        >Transport<select
          class="select select-bordered"
          bind:value={transport}
          onchange={changed}
          disabled={editBlocked}
          ><option value="stdio">Installed stdio</option><option value="http"
            >Streamable HTTP</option
          ></select
        ></label
      >
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
      {#if transport === 'http'}
        <label class="form-control"
          >Endpoint URL<input
            class="input input-bordered font-mono text-xs"
            type="url"
            bind:value={endpoint}
            oninput={changed}
            maxlength="4096"
            placeholder="https://example.com/mcp"
            disabled={editBlocked}
          /></label
        >
      {:else}
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
      {/if}
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
    {#if transport === 'http'}
      <label class="label cursor-pointer justify-start gap-2 text-sm"
        ><input
          class="checkbox checkbox-sm"
          type="checkbox"
          bind:checked={allowLoopbackHttp}
          onchange={changed}
          disabled={editBlocked}
        />Allow unencrypted HTTP on literal 127.0.0.1 or [::1] for local testing</label
      >
      <p class="text-xs opacity-70">
        No credentials, query strings or fragments in the endpoint. Redirects are refused. Saving
        neither contacts the endpoint nor discovers metadata.
      </p>
    {:else}
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
    {/if}
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
      {#if entry.server.transport === 'http' && entry.server.endpoint.startsWith('https://')}
        <section
          class="rounded-box border border-base-300 p-3 space-y-3"
          aria-label="OAuth public client settings"
        >
          <h4 class="font-medium">Optional session-only OAuth</h4>
          <p class="text-xs opacity-70">
            Use a preregistered public client, or explicitly review a new public client
            registration. Settings and grants stay in main-process memory for this app session. The
            callback is exactly http://127.0.0.1:{oauthDraft(entry.server.id)
              .redirectPort}{oauthDraft(entry.server.id).redirectPath}. Leave scopes empty unless
            the service requires scopes you choose. No offline scope is added.
          </p>
          {#if entry.oauth}<p class="text-sm" role="status">
              OAuth: {entry.oauth.state}{entry.oauth.message ? ` · ${entry.oauth.message}` : ''}
            </p>{/if}
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label class="form-control"
              >Public client ID<input
                class="input input-bordered font-mono text-xs"
                value={oauthDraft(entry.server.id).clientId}
                oninput={(event) => oauthChanged(entry.server.id, 'clientId', event)}
                maxlength="1024"
                disabled={editBlocked ||
                  entry.state === 'connected' ||
                  entry.state === 'connecting' ||
                  entry.cleanupPending}
              /></label
            >
            <label class="form-control"
              >OAuth issuer<input
                class="input input-bordered font-mono text-xs"
                type="url"
                value={oauthDraft(entry.server.id).issuer}
                oninput={(event) => oauthChanged(entry.server.id, 'issuer', event)}
                maxlength="4096"
                placeholder="https://auth.example.com"
                disabled={editBlocked ||
                  entry.state === 'connected' ||
                  entry.state === 'connecting' ||
                  entry.cleanupPending}
              /></label
            >
            <label class="form-control"
              >Loopback port<input
                class="input input-bordered font-mono text-xs"
                inputmode="numeric"
                value={oauthDraft(entry.server.id).redirectPort}
                oninput={(event) => oauthChanged(entry.server.id, 'redirectPort', event)}
                maxlength="5"
                disabled={editBlocked ||
                  entry.state === 'connected' ||
                  entry.state === 'connecting' ||
                  entry.cleanupPending}
              /></label
            >
            <label class="form-control"
              >Loopback path<input
                class="input input-bordered font-mono text-xs"
                value={oauthDraft(entry.server.id).redirectPath}
                oninput={(event) => oauthChanged(entry.server.id, 'redirectPath', event)}
                maxlength="512"
                disabled={editBlocked ||
                  entry.state === 'connected' ||
                  entry.state === 'connecting' ||
                  entry.cleanupPending}
              /></label
            >
            <label class="form-control"
              >Requested scopes (space-separated)<input
                class="input input-bordered font-mono text-xs"
                value={oauthDraft(entry.server.id).scopes}
                oninput={(event) => oauthChanged(entry.server.id, 'scopes', event)}
                maxlength="4127"
                disabled={editBlocked ||
                  entry.state === 'connected' ||
                  entry.state === 'connecting' ||
                  entry.cleanupPending}
              /></label
            >
            <label class="form-control"
              >Registration client name<input
                class="input input-bordered text-xs"
                value={oauthDraft(entry.server.id).clientName}
                oninput={(event) => oauthChanged(entry.server.id, 'clientName', event)}
                maxlength="128"
                disabled={editBlocked ||
                  entry.state === 'connected' ||
                  entry.state === 'connecting' ||
                  entry.cleanupPending}
              /></label
            >
          </div>
          {#if oauthFormError && oauthErrorServerId === entry.server.id}<p
              class="text-error text-sm"
              role="alert"
            >
              {oauthFormError}
            </p>{/if}
          <div class="flex flex-wrap gap-2">
            <button
              class="btn btn-xs"
              onclick={() => configureOAuth(entry.server.id, false)}
              disabled={blocked ||
                entry.state === 'connected' ||
                entry.state === 'connecting' ||
                entry.cleanupPending ||
                (dirty && id.trim() === entry.server.id)}>Configure public client</button
            >
            <button
              class="btn btn-xs"
              onclick={() => configureOAuth(entry.server.id, true)}
              disabled={blocked ||
                entry.state === 'connected' ||
                entry.state === 'connecting' ||
                entry.cleanupPending ||
                (dirty && id.trim() === entry.server.id)}>Review registration</button
            >
            <button
              class="btn btn-xs"
              onclick={() => controls.prepareSignIn(entry.server.id)}
              disabled={blocked ||
                !entry.oauth?.hasClient ||
                oauthDirty[entry.server.id] ||
                entry.state === 'connected' ||
                entry.state === 'connecting' ||
                entry.cleanupPending ||
                (dirty && id.trim() === entry.server.id)}>Review sign-in</button
            >
          </div>
          {#if oauthDirty[entry.server.id]}<p class="text-xs opacity-70">
              Configure these public client settings or complete registration before reviewing
              sign-in.
            </p>{/if}
        </section>
      {/if}
      {#if entry.message}<p class="text-sm break-all">{entry.message}</p>{/if}
      {#if entry.cleanupPending}<p class="text-warning text-sm">
          {entry.server.transport === 'http'
            ? 'HTTP connection cleanup remains unverified. Retry Disconnect before another connection.'
            : 'Owned process cleanup remains unverified. Retry Disconnect before another launch.'}
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
                Available scalar templates can propose one exact resource read. Review the template,
                values and expanded URI before approving once.
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
    HTTPS HTTP servers can use optional session-only OAuth after separate explicit reviews.
    Credential input, installation and package/shell runners are unavailable. No automatic reconnect
    or retry. Disconnect and cancellation cannot undo effects.
  </p>
</section>
