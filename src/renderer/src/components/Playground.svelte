<script lang="ts">
  import { onMount } from 'svelte'
  import type { BCFDCommand, BCFDInteractionCommand } from '../types/types'
  import { createPlaygroundState, PLAYGROUND_LIMITS } from '../../../shared/playground/types'
  import type { FakePermission, PlaygroundRequest } from '../../../shared/playground/types'
  import { PlaygroundSavedData } from '../utils/playgroundSavedData'
  import { PlaygroundSession } from '../utils/playgroundSession'

  const savedData = new PlaygroundSavedData()
  const session = new PlaygroundSession(
    () => new Worker(new URL('../utils/playgroundWorker.ts', import.meta.url), { type: 'module' })
  )
  let world = $state(createPlaygroundState())
  let commands = $state<BCFDCommand[]>([])
  let interactions = $state<BCFDInteractionCommand[]>([])
  let mode = $state<'message' | 'slash'>('message')
  let interactionId = $state('')
  let optionInputs = $state<Record<string, string>>(Object.create(null))
  const selectedInteraction = $derived(
    interactions.find((interaction) => interaction.id === interactionId)
  )
  let senderId = $state('100000000000000001')
  let content = $state('')
  let roleIdDraft = $state('')
  let roleNameDraft = $state('')
  let trace = $state<string[]>([])
  let errors = $state<string[]>([])
  let busy = $state(false)
  let loading = $state(false)
  let alive = true
  let loadGeneration = 0
  const permissions: FakePermission[] = ['admin', 'manageMessages', 'kick', 'ban', 'mute']

  async function loadCommands() {
    const generation = ++loadGeneration
    loading = true
    try {
      const saved = await savedData.load((channel) => window.electron.ipcRenderer.invoke(channel))
      if (!saved || !alive || generation !== loadGeneration) return
      commands = saved.commands
      interactions = saved.interactions
      errors = saved.errors
      interactionId = interactions[0]?.id ?? ''
      optionInputs = Object.create(null)
      trace = [
        `Loaded ${commands.length} message commands and ${interactions.length} slash commands read-only`
      ]
    } catch (error) {
      if (alive && generation === loadGeneration)
        errors = [error instanceof Error ? error.message : 'Unable to read saved commands']
    } finally {
      if (alive && generation === loadGeneration) loading = false
    }
  }

  function reset() {
    session.cancel()
    savedData.cancel()
    loadGeneration++
    loading = false
    busy = false
    world = createPlaygroundState()
    senderId = world.members[0].id
    content = ''
    roleIdDraft = ''
    roleNameDraft = ''
    optionInputs = Object.create(null)
    trace = ['Fake server reset; saved commands were not changed']
    errors = []
  }

  async function runRequest(request: PlaygroundRequest) {
    if (busy || loading) return
    busy = true
    const promise = session.run(request)
    const revision = session.revision
    try {
      const result = await promise
      if (!alive || !session.isCurrent(revision)) return
      world = result.state
      trace = result.trace
      errors = result.errors
      content = ''
      if (
        !world.members.some((member) => member.id === senderId && !member.kicked && !member.banned)
      )
        senderId = world.members.find((member) => !member.kicked && !member.banned)?.id ?? ''
    } catch (error) {
      if (alive && session.isCurrent(revision))
        errors = [error instanceof Error ? error.message : 'Playground execution failed']
    } finally {
      if (alive && session.isCurrent(revision)) busy = false
    }
  }

  function send() {
    if (!content.trim()) return
    void runRequest({
      state: structuredClone($state.snapshot(world)),
      commands: structuredClone($state.snapshot(commands)),
      senderId,
      content
    })
  }

  function invokeSlash() {
    if (!selectedInteraction) return
    const options: Record<string, string | number | boolean> = Object.create(null)
    for (const option of selectedInteraction.options) {
      const value = optionInputs[option.name]
      if (value === undefined || value === '') continue
      options[option.name] =
        option.type === 5
          ? value === 'true'
          : option.type === 4 || option.type === 10
            ? Number(value)
            : value
    }
    void runRequest({
      kind: 'slash',
      state: structuredClone($state.snapshot(world)),
      interactions: structuredClone($state.snapshot(interactions)),
      senderId,
      commandId: selectedInteraction.id,
      options
    })
  }

  function clickButton(messageId: number, customId: string) {
    void runRequest({
      kind: 'button',
      state: structuredClone($state.snapshot(world)),
      interactions: structuredClone($state.snapshot(interactions)),
      senderId,
      messageId,
      customId
    })
  }

  function addFakeRole() {
    if (busy || world.roles.length >= PLAYGROUND_LIMITS.roles) return
    if (
      !/^\d{1,20}$/.test(roleIdDraft) ||
      !roleNameDraft.trim() ||
      world.roles.some((role) => role.id === roleIdDraft)
    ) {
      errors = ['Use a unique fake role ID (1–20 digits) and a role name']
      return
    }
    world.roles = [...world.roles, { id: roleIdDraft, name: roleNameDraft.trim().slice(0, 100) }]
    roleIdDraft = ''
    roleNameDraft = ''
    errors = []
  }

  function changeRole(memberId: string, roleId: string) {
    if (busy) return
    world.members = world.members.map((member) =>
      member.id !== memberId
        ? member
        : {
            ...member,
            roles: member.roles.includes(roleId)
              ? member.roles.filter((id) => id !== roleId)
              : [...member.roles, roleId]
          }
    )
  }

  function changePermission(memberId: string, permission: FakePermission) {
    if (busy) return
    world.members = world.members.map((member) =>
      member.id !== memberId
        ? member
        : {
            ...member,
            permissions: member.permissions.includes(permission)
              ? member.permissions.filter((item) => item !== permission)
              : [...member.permissions, permission]
          }
    )
  }

  onMount(() => {
    void loadCommands()
    return () => {
      alive = false
      loadGeneration++
      savedData.cancel()
      session.cancel()
    }
  })
</script>

<section class="h-full flex flex-col min-h-0">
  <header class="p-4 bg-base-200 flex flex-wrap gap-2 items-center">
    <h1 class="text-xl font-bold grow">Playground</h1>
    <button class="btn btn-sm" disabled={busy || loading} onclick={loadCommands}
      >Reload saved data</button
    >
    <button class="btn btn-sm btn-warning" onclick={reset}>Reset fake server</button>
    <p class="w-full text-sm">
      Offline fake server. Saved commands are read-only. Scripts, AI, state writes and cooldowns are
      on hold. Unsupported effects fail closed. This is a bounded simulator, not exact Discord
      network parity.
    </p>
    <p class="w-full text-xs opacity-70">
      Server ID: {world.guildId} · Channel ID: {world.channelId}
    </p>
    <details class="w-full">
      <summary class="text-xs cursor-pointer">Fake channel/server context</summary>
      <div class="flex flex-wrap gap-2 mt-2">
        <label class="text-xs"
          >Server ID <input
            class="input input-xs"
            bind:value={world.guildId}
            maxlength={20}
            disabled={busy}
          /></label
        >
        <label class="text-xs"
          >Channel ID <input
            class="input input-xs"
            bind:value={world.channelId}
            maxlength={20}
            disabled={busy}
          /></label
        >
        <label class="flex items-center gap-1 text-xs"
          ><input
            type="checkbox"
            class="checkbox checkbox-xs"
            bind:checked={world.nsfw}
            disabled={busy}
          />Fake NSFW channel</label
        >
      </div>
    </details>
  </header>
  <div class="flex grow min-h-0">
    <div class="flex flex-col grow min-w-0">
      <h2 class="p-3 font-semibold border-b border-base-300"># {world.channelName}</h2>
      <div class="grow overflow-y-auto p-3 space-y-3" aria-live="polite">
        {#if world.messages.length === 0}<p class="opacity-60">
            Send a fake message to run matching saved message commands
          </p>{/if}
        {#each world.messages as message (message.id)}
          <article
            class="p-3 rounded bg-base-200 break-words {message.deleted ? 'opacity-40' : ''}"
          >
            <p class="text-xs font-semibold">
              {message.author}{message.kind === 'dm'
                ? ` · Fake DM to ${world.members.find((member) => member.id === message.recipient)?.name ?? message.recipient}`
                : ''}{message.replyTo ? ` · Reply to #${message.replyTo}` : ''}{message.deleted
                ? ' · Deleted'
                : ''}{message.ephemeral
                ? ` · Ephemeral to ${world.members.find((member) => member.id === message.recipient)?.name ?? message.recipient}`
                : ''}{message.deferred ? ' · Deferred' : ''}
            </p>
            <p class="whitespace-pre-wrap">
              {message.content === '\u200B'
                ? '[Empty interaction response: U+200B]'
                : message.content}
            </p>
            {#if message.embed}
              <div class="border-l-4 border-primary pl-3 mt-2">
                <p class="font-bold">{message.embed.title}</p>
                <p class="whitespace-pre-wrap">{message.embed.description}</p>
                <p class="text-xs">{message.embed.footer}</p>
                {#if message.embed.hexColor}<p class="text-xs">
                    Color: {message.embed.hexColor}
                  </p>{/if}
                {#if message.embed.imageURL}<p class="text-xs break-all">
                    Image URL (inert): {message.embed.imageURL}
                  </p>{/if}
                {#if message.embed.thumbnailURL}<p class="text-xs break-all">
                    Thumbnail URL (inert): {message.embed.thumbnailURL}
                  </p>{/if}
              </div>
            {/if}
            {#if message.buttons?.length}
              <div class="flex gap-2 flex-wrap mt-2">
                {#each message.buttons as button}
                  <button
                    class="btn btn-xs"
                    disabled={busy ||
                      loading ||
                      message.deleted ||
                      button.disabled ||
                      button.style === 5 ||
                      (message.ephemeral && message.recipient !== senderId)}
                    onclick={() => clickButton(message.id, button.customId)}
                    >{button.label}{button.style === 5 ? ' (inert link)' : ''}</button
                  >
                  {#if button.style === 5 && button.url}<span class="text-xs break-all"
                      >URL (inert): {button.url}</span
                    >{/if}
                {/each}
              </div>
            {/if}
          </article>
        {/each}
      </div>
      <div class="p-3 bg-base-200 space-y-2">
        <div class="flex flex-wrap items-center gap-2">
          <label class="flex items-center gap-2"
            >Send as
            <select class="select select-sm" bind:value={senderId} disabled={busy}>
              {#each world.members.filter((member) => !member.kicked && !member.banned) as member}<option
                  value={member.id}>{member.name}</option
                >{/each}
            </select>
          </label>
          <label class="flex items-center gap-2"
            >Mode
            <select class="select select-sm" bind:value={mode} disabled={busy}
              ><option value="message">Message</option><option value="slash">Slash command</option
              ></select
            >
          </label>
        </div>
        {#if mode === 'message'}
          <form
            class="flex gap-2"
            onsubmit={(event) => {
              event.preventDefault()
              send()
            }}
          >
            <input
              class="input input-sm grow min-w-32"
              aria-label="Fake message"
              placeholder="Saved trigger and optional mentions"
              bind:value={content}
              maxlength={PLAYGROUND_LIMITS.input}
              disabled={busy || loading}
            />
            <button class="btn btn-sm btn-primary" disabled={busy || loading || !content.trim()}
              >{busy ? 'Running…' : 'Send'}</button
            >
          </form>
        {:else}
          <form
            class="space-y-2"
            onsubmit={(event) => {
              event.preventDefault()
              invokeSlash()
            }}
          >
            <label class="flex items-center gap-2"
              >Saved slash command
              <select
                class="select select-sm grow"
                bind:value={interactionId}
                onchange={() => (optionInputs = Object.create(null))}
                disabled={busy || loading}
              >
                {#each interactions as interaction}<option value={interaction.id}
                    >/{interaction.commandName}</option
                  >{/each}
              </select>
            </label>
            {#if selectedInteraction}
              {#each selectedInteraction.options as option}
                <label class="flex items-center gap-2 text-sm"
                  >{option.name}{option.required ? ' *' : ''}
                  {#if option.choices?.length}
                    <select
                      class="select select-sm grow"
                      bind:value={optionInputs[option.name]}
                      disabled={busy}
                      ><option value="">Choose…</option>{#each option.choices as choice}<option
                          value={String(choice.value)}>{choice.name}</option
                        >{/each}</select
                    >
                  {:else if option.type === 5}
                    <select
                      class="select select-sm grow"
                      bind:value={optionInputs[option.name]}
                      disabled={busy}
                      ><option value="">Not provided</option><option value="true">true</option
                      ><option value="false">false</option></select
                    >
                  {:else if option.type === 6}
                    <select
                      class="select select-sm grow"
                      bind:value={optionInputs[option.name]}
                      disabled={busy}
                      ><option value="">Choose fake user…</option
                      >{#each world.members.filter((member) => !member.kicked && !member.banned) as member}<option
                          value={member.id}>{member.name}</option
                        >{/each}</select
                    >
                  {:else if option.type === 7}
                    <select
                      class="select select-sm grow"
                      bind:value={optionInputs[option.name]}
                      disabled={busy}
                      ><option value="">Choose fake channel…</option><option value={world.channelId}
                        >#{world.channelName}</option
                      ></select
                    >
                  {:else if option.type === 8}
                    <select
                      class="select select-sm grow"
                      bind:value={optionInputs[option.name]}
                      disabled={busy}
                      ><option value="">Choose fake role…</option>{#each world.roles as role}<option
                          value={role.id}>{role.name}</option
                        >{/each}</select
                    >
                  {:else}
                    <input
                      class="input input-sm grow"
                      bind:value={optionInputs[option.name]}
                      placeholder={option.type === 4
                        ? 'Integer'
                        : option.type === 10
                          ? 'Number'
                          : 'Text'}
                      disabled={busy}
                      maxlength={6000}
                    />
                  {/if}
                </label>
              {/each}
              <button class="btn btn-sm btn-primary" disabled={busy || loading}
                >{busy ? 'Running…' : `Invoke /${selectedInteraction.commandName}`}</button
              >
            {:else}<p class="text-sm opacity-60">No saved slash commands</p>{/if}
          </form>
        {/if}
      </div>
    </div>
    <aside class="w-60 shrink-0 p-3 border-l border-base-300 overflow-y-auto">
      <h2 class="font-semibold">Fake members</h2>
      {#each world.members as member}
        <div class="py-3 border-b border-base-300">
          <button
            class="btn btn-xs"
            disabled={busy || member.kicked || member.banned}
            onclick={() => (content += ` <@${member.id}>`)}>@{member.name}</button
          >
          <p class="text-xs break-all">{member.id}</p>
          <p class="text-xs">
            {member.banned ? 'Banned' : member.kicked ? 'Kicked' : 'In server'}{member.muted
              ? ' · Muted'
              : ''}
          </p>
          {#each world.roles as role}
            <label class="flex text-xs gap-2 mt-1"
              ><input
                type="checkbox"
                class="checkbox checkbox-xs"
                checked={member.roles.includes(role.id)}
                disabled={busy}
                onchange={() => changeRole(member.id, role.id)}
              />{role.name}</label
            >
          {/each}
          <details class="mt-2">
            <summary class="text-xs cursor-pointer">Permissions</summary>
            {#each permissions as permission}<label class="flex text-xs gap-2 mt-1"
                ><input
                  type="checkbox"
                  class="checkbox checkbox-xs"
                  checked={member.permissions.includes(permission)}
                  disabled={busy}
                  onchange={() => changePermission(member.id, permission)}
                />{permission}</label
              >{/each}
          </details>
        </div>
      {/each}
      <h3 class="font-semibold mt-3">Fake role IDs</h3>
      {#each world.roles as role}<p class="text-xs break-all mt-1">{role.name}: {role.id}</p>{/each}
      <form
        class="mt-3 space-y-1"
        onsubmit={(event) => {
          event.preventDefault()
          addFakeRole()
        }}
      >
        <input
          class="input input-xs w-full"
          aria-label="New fake role ID"
          placeholder="Fake role ID"
          bind:value={roleIdDraft}
          maxlength={20}
          disabled={busy}
        />
        <input
          class="input input-xs w-full"
          aria-label="New fake role name"
          placeholder="Fake role name"
          bind:value={roleNameDraft}
          maxlength={100}
          disabled={busy}
        />
        <button class="btn btn-xs" disabled={busy || world.roles.length >= PLAYGROUND_LIMITS.roles}
          >Add fake role</button
        >
      </form>
    </aside>
  </div>
  <details class="bg-base-300 p-3 max-h-48 overflow-y-auto" open={errors.length > 0}>
    <summary class="cursor-pointer">Trace ({trace.length}) · Errors ({errors.length})</summary>
    {#each trace as line}<p class="text-xs whitespace-pre-wrap mt-1">{line}</p>{/each}
    {#each errors as error}<p class="text-xs text-error whitespace-pre-wrap mt-1">{error}</p>{/each}
  </details>
</section>
