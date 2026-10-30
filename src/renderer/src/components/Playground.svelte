<script lang="ts">
  import {
    normalizeWorld,
    commitWorld,
    selectWorldContext,
    dmChannel
  } from '../../../shared/playground/world'
  import { onMount, tick } from 'svelte'
  import { addPlaygroundMember, commandEventDraft } from '../utils/playgroundControls'
  import { get } from 'svelte/store'
  import { settingsStore } from '../stores/settings'
  import { playgroundReplay } from '../stores/playgroundReplay'
  import PlaygroundTests from './PlaygroundTests.svelte'
  import { commandEvents } from '../../../shared/runtime/dispatch'
  import { validateAgentValidationState } from '../../../shared/playground/agentValidationFixtures'
  import type { BCFDCommand, BCFDInteractionCommand } from '../types/types'
  import { PLAYGROUND_LIMITS } from '../../../shared/playground/types'
  import type { FakePermission, PlaygroundRequest } from '../../../shared/playground/types'
  import { formatBotStateDraft, parseBotStateDraft } from '../../../shared/playground/botStateDraft'
  import { PlaygroundSavedData } from '../utils/playgroundSavedData'
  import { PlaygroundSession } from '../utils/playgroundSession'

  const savedData = new PlaygroundSavedData()
  const session = new PlaygroundSession(
    () => new Worker(new URL('../utils/playgroundWorker.ts', import.meta.url), { type: 'module' })
  )
  const replayRequest = get(playgroundReplay)
  playgroundReplay.set(null)
  const initialWorld = replayRequest?.suite.cases[0]?.state ?? normalizeWorld()
  let view = $state<'chat' | 'commands' | 'settings'>(replayRequest ? 'settings' : 'chat')
  let newMemberName = $state('')
  let addingMember = $state(false)
  let memberError = $state('')
  let commandQuery = $state('')
  let transcript: HTMLDivElement | undefined = $state()
  let messageInput: HTMLInputElement | undefined = $state()
  let worldDraft = $state('')
  let worldError = $state('')
  let reactionMessageId = $state('')
  let world = $state(initialWorld)
  let botStateDraft = $state(formatBotStateDraft(initialWorld.botState))
  let botStateDraftError = $state('')
  const wrapEval = $derived(replayRequest?.wrapEvalInIIFE ?? !$settingsStore.useLegacyInterpreter)
  let selectedCommandIds = $state<string[]>([])
  let selectedInteractionIds = $state<string[]>([])
  let mockPrompt = $state('')
  let mockResponse = $state('')
  let commands = $state<BCFDCommand[]>([])
  let interactions = $state<BCFDInteractionCommand[]>([])
  const activeCommands = $derived(commands.filter((item) => selectedCommandIds.includes(item.id)))
  const activeInteractions = $derived(
    interactions.filter((item) => selectedInteractionIds.includes(item.id))
  )
  let mode = $state<(typeof commandEvents)[number] | 'slash'>('message')
  let interactionId = $state('')
  let optionInputs = $state<Record<string, string>>(Object.create(null))
  const selectedInteraction = $derived(
    activeInteractions.find((interaction) => interaction.id === interactionId)
  )
  let senderId = $state(
    initialWorld.members.find((member) => !member.bot && !member.kicked && !member.banned)?.id ?? ''
  )
  const people = $derived(world.members.filter((member) => !member.bot))
  const availableSenders = $derived(people.filter((member) => !member.kicked && !member.banned))
  const selectedSender = $derived(people.find((member) => member.id === senderId))
  const ownerId = $derived(
    world.world?.guilds.find((guild) => guild.id === world.guildId)?.ownerId ?? people[0]?.id
  )
  const filteredCommands = $derived(
    commands.filter((item) =>
      `${item.command} ${item.commandDescription}`
        .toLowerCase()
        .includes(commandQuery.toLowerCase())
    )
  )
  const filteredInteractions = $derived(
    interactions.filter((item) =>
      `${item.commandName} ${item.commandDescription}`
        .toLowerCase()
        .includes(commandQuery.toLowerCase())
    )
  )
  let content = $state('')
  let roleIdDraft = $state('')
  let roleNameDraft = $state('')
  let trace = $state<string[]>([])
  let errors = $state<string[]>([])
  let notices = $state<string[]>([])
  let busy = $state(false)
  let loading = $state(false)
  let alive = true
  let loadGeneration = 0
  const permissions: FakePermission[] = ['admin', 'manageMessages', 'kick', 'ban', 'mute']

  async function loadCommands() {
    if (replayRequest) {
      commands = replayRequest.suite.resources?.commands ?? []
      interactions = replayRequest.suite.resources?.interactions ?? []
      if (replayRequest.candidateKind === 'command') {
        const candidate = replayRequest.candidate as BCFDCommand
        commands = commands.some((item) => item.id === candidate.id)
          ? commands.map((item) => (item.id === candidate.id ? candidate : item))
          : [...commands, candidate]
      } else {
        const candidate = replayRequest.candidate as BCFDInteractionCommand
        interactions = interactions.some((item) => item.id === candidate.id)
          ? interactions.map((item) => (item.id === candidate.id ? candidate : item))
          : [...interactions, candidate]
      }
      selectedCommandIds = commands.map((item) => item.id)
      selectedInteractionIds = interactions.map((item) => item.id)
      return
    }
    session.cancel()
    const generation = ++loadGeneration
    loading = true
    try {
      const saved = await savedData.load((channel) => window.electron.ipcRenderer.invoke(channel))
      if (!saved || !alive || generation !== loadGeneration) return
      commands = saved.commands
      interactions = saved.interactions
      selectedCommandIds = commands.map((item) => item.id)
      selectedInteractionIds = interactions.map((item) => item.id)
      errors = saved.errors
      notices = []
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
    world = normalizeWorld()
    syncBotStateDraft()
    senderId = world.members[0].id
    content = ''
    mode = 'message'
    reactionMessageId = ''
    addingMember = false
    memberError = ''
    newMemberName = ''
    worldDraft = ''
    worldError = ''
    roleIdDraft = ''
    roleNameDraft = ''
    optionInputs = Object.create(null)
    trace = ['Fake session reset; saved commands were not changed']
    errors = []
    notices = []
  }

  async function runRequest(request: PlaygroundRequest) {
    if (busy || loading) return
    busy = true
    notices = []
    let revision = session.revision
    try {
      if (request.state.world) {
        commitWorld(request.state)
        const channel =
          request.kind === 'dm' ? dmChannel(request.state, request.senderId) : undefined
        request.context = {
          guildId: channel ? null : request.state.guildId || null,
          channelId: channel?.id ?? request.state.channelId
        }
      }
      const promise = session.run(request)
      revision = session.revision
      const result = await promise
      if (!alive || !session.isCurrent(revision)) return
      world = result.state
      syncBotStateDraft()
      trace = [
        ...result.trace,
        ...(result.warnings ?? []).map((warning) => `Delivery warning: ${warning}`),
        ...(result.incomplete ?? []).map((reason) => `Incomplete simulation: ${reason}`)
      ]
      errors = result.errors
      notices = result.feedback ?? []
      content = ''
      if (
        !world.members.some(
          (member) => member.id === senderId && !member.bot && !member.kicked && !member.banned
        )
      )
        senderId =
          world.members.find((member) => !member.bot && !member.kicked && !member.banned)?.id ?? ''
    } catch (error) {
      if (alive && session.isCurrent(revision))
        errors = [error instanceof Error ? error.message : 'Playground execution failed']
    } finally {
      if (alive && session.isCurrent(revision)) busy = false
    }
  }

  function syncBotStateDraft() {
    botStateDraft = formatBotStateDraft($state.snapshot(world.botState))
    botStateDraftError = ''
  }

  function applyBotStateDraft() {
    if (busy) return
    try {
      world.botState = parseBotStateDraft(botStateDraft)
      syncBotStateDraft()
    } catch (error) {
      botStateDraftError =
        error instanceof Error ? error.message : 'Enter a bounded JSON object for bot state'
    }
  }

  function advanceClock(milliseconds: number) {
    if (busy || !Number.isSafeInteger(world.clockMs + milliseconds)) return
    world.clockMs += milliseconds
  }

  function send() {
    if (!senderId || (mode === 'reaction' && !reactionMessageId)) return
    if (!content.trim() && ['message', 'dm', 'reaction'].includes(mode)) return
    void runRequest({
      state: structuredClone($state.snapshot(world)),
      commands: structuredClone($state.snapshot(activeCommands)),
      wrapEvalInIIFE: wrapEval,
      kind: mode === 'slash' ? 'message' : mode,
      messageId:
        mode === 'reaction'
          ? world.world
            ? reactionMessageId
            : Number(reactionMessageId)
          : undefined,
      senderId,
      content
    })
  }

  function invokeSlash() {
    if (!selectedInteraction || !senderId) return
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
      interactions: structuredClone($state.snapshot(activeInteractions)),
      commands: structuredClone($state.snapshot(activeCommands)),
      wrapEvalInIIFE: wrapEval,
      senderId,
      commandId: selectedInteraction.id,
      options
    })
  }

  function clickButton(messageId: string | number, customId: string) {
    void runRequest({
      kind: 'button',
      state: structuredClone($state.snapshot(world)),
      interactions: structuredClone($state.snapshot(activeInteractions)),
      commands: structuredClone($state.snapshot(activeCommands)),
      wrapEvalInIIFE: wrapEval,
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
    commitWorld(world)
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
    commitWorld(world)
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
    commitWorld(world)
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

  function chooseCommand(value: string) {
    if (value.startsWith('interaction:')) {
      const id = value.slice('interaction:'.length)
      if (!activeInteractions.some((item) => item.id === id)) return
      mode = 'slash'
      interactionId = id
      optionInputs = Object.create(null)
      content = ''
    } else {
      const command = activeCommands.find((item) => `command:${item.id}` === value)
      if (!command) return
      const draft = commandEventDraft(command)
      mode = draft.mode
      content = draft.content
    }
    view = 'chat'
    if (mode !== 'slash') void tick().then(() => messageInput?.focus())
  }

  function addMember() {
    if (busy || loading) return
    try {
      addPlaygroundMember(world, newMemberName)
      newMemberName = ''
      addingMember = false
      memberError = ''
    } catch (error) {
      memberError = error instanceof Error ? error.message : 'Unable to add member'
    }
  }

  $effect(() => {
    if (!activeInteractions.some((item) => item.id === interactionId)) {
      interactionId = activeInteractions[0]?.id ?? ''
      optionInputs = Object.create(null)
    }
  })

  $effect(() => {
    if (!availableSenders.some((member) => member.id === senderId))
      senderId = availableSenders[0]?.id ?? ''
  })

  $effect(() => {
    const count = world.messages.length
    if (view === 'chat' && count) {
      void tick().then(() => transcript?.scrollTo({ top: transcript.scrollHeight }))
    }
  })
</script>

{#snippet icon(name: string)}
  <span class="material-symbols-outlined" aria-hidden="true">{name}</span>
{/snippet}

{#snippet avatar(name: string, bot = false)}
  <span
    class="person-avatar"
    class:bot-avatar={bot}
    data-tone={name.charCodeAt(0) % 3}
    aria-hidden="true"
  >
    {#if bot}{@render icon('smart_toy')}{:else}{name.slice(0, 1).toUpperCase()}{/if}
  </span>
{/snippet}

<section class="playground">
  <header class="playground-header">
    <div class="page-title">
      <div>
        <h1>Playground</h1>
      </div>
    </div>
    <div class="header-actions">
      <button class="btn btn-sm reload-button" disabled={busy || loading} onclick={loadCommands}>
        {@render icon('refresh')}{loading ? 'Loading...' : 'Reload saved data'}
      </button>
      <button class="btn btn-sm btn-error reset-button" onclick={reset}>
        {@render icon('delete')}Reset session
      </button>
    </div>
  </header>

  <div class="playground-layout">
    <aside class="server-sidebar panel">
      <h2>Server</h2>
      <div class="server-card">
        <span class="server-icon">{@render icon('sports_esports')}</span>
        <div>
          <strong>{world.guildName}</strong><span class="server-id"
            >ID: {world.guildId || 'Direct messages'}</span
          >
        </div>
      </div>
      <nav aria-label="Playground views">
        <button
          class:active={view === 'chat'}
          aria-current={view === 'chat' ? 'page' : undefined}
          onclick={() => (view = 'chat')}
        >
          {@render icon('chat_bubble')}Chat
        </button>
        <button
          class:active={view === 'commands'}
          aria-current={view === 'commands' ? 'page' : undefined}
          onclick={() => (view = 'commands')}
        >
          {@render icon('bookmark')}Saved Commands<span class="command-count"
            >{commands.length + interactions.length}</span
          >
        </button>
        <button
          class:active={view === 'settings'}
          aria-current={view === 'settings' ? 'page' : undefined}
          onclick={() => (view = 'settings')}
        >
          {@render icon('settings')}Settings
        </button>
      </nav>
    </aside>

    <main class="playground-main">
      {#if errors.length}
        <div class="session-errors" role="alert">
          {@render icon('error')}
          <div>
            {#each errors as error}<p>{error}</p>{/each}
          </div>
        </div>
      {/if}
      {#if notices.length}
        <div class="session-notices" role="status">
          {@render icon('info')}
          <div>
            {#each notices as notice}<p>{notice}</p>{/each}
          </div>
        </div>
      {/if}
      <div class="chat-view" hidden={view !== 'chat'}>
        <section class="conversation panel" aria-label="Simulated conversation">
          <header class="channel-header">
            <div class="channel-title">
              <span class="channel-hash">#</span>
              <h2>{world.channelName}</h2>
            </div>
            <span class="offline-badge"><span></span>Offline &middot; Simulated</span>
          </header>
          <div
            class="transcript"
            bind:this={transcript}
            role="log"
            aria-label="Playground messages"
            aria-live="polite"
          >
            {#if world.messages.length === 0}
              <div class="empty-chat">
                <span class="empty-icon">{@render icon('forum')}</span>
                <h3>Try a command</h3>
                <p>Choose a saved command or type a message.</p>
                <button class="btn btn-sm" onclick={() => (view = 'commands')}
                  >Browse saved commands</button
                >
              </div>
            {/if}
            {#each world.messages as message (message.id)}
              {@const isBot = message.kind !== 'user'}
              <article class="chat-message" class:deleted-message={message.deleted}>
                {@render avatar(message.author, isBot)}
                <div class="message-body">
                  <div class="message-heading">
                    <strong>{message.author}</strong>
                    {#if isBot}<span class="identity-badge bot-badge">BOT</span>
                    {:else if message.authorId === ownerId || (!message.authorId && message.author === people.find((person) => person.id === ownerId)?.name)}<span
                        class="identity-badge">SERVER OWNER</span
                      >{/if}
                    {#if message.kind === 'dm'}<span class="message-context">Private message</span
                      >{/if}
                  </div>
                  {#if message.content}<p class="message-content">
                      {message.content === '\u200B' ? '[Empty response]' : message.content}
                    </p>{/if}
                  {#if message.replyTo}<p class="message-meta">Reply to #{message.replyTo}</p>{/if}
                  {#if message.deleted}<p class="message-meta">Message deleted</p>{/if}
                  {#if message.ephemeral}<p class="message-meta">
                      Only visible to {world.members.find(
                        (member) => member.id === message.recipient
                      )?.name ?? message.recipient}
                    </p>{/if}
                  {#if message.deferred}<p class="message-meta">Response deferred</p>{/if}
                  {#if message.kind === 'dm'}<p class="message-meta">
                      To {world.world?.users.find((user) => user.id === message.recipient)?.name ??
                        message.recipient}
                    </p>{/if}
                  {#if message.embed}
                    <div
                      class="message-embed"
                      style:border-left-color={/^#?[0-9a-f]{6}$/i.test(message.embed.hexColor ?? '')
                        ? `#${message.embed.hexColor.replace('#', '')}`
                        : undefined}
                    >
                      {#if message.embed.title}<h3>{message.embed.title}</h3>{/if}
                      <p class="message-content">{message.embed.description}</p>
                      {#if message.embed.footer}<p class="message-meta">
                          {message.embed.footer}
                        </p>{/if}
                      {#if message.embed.imageURL || message.embed.thumbnailURL}
                        <details class="embed-media">
                          <summary>Attached image details</summary>
                          {#if message.embed.imageURL}<p>Image: {message.embed.imageURL}</p>{/if}
                          {#if message.embed.thumbnailURL}<p>
                              Thumbnail: {message.embed.thumbnailURL}
                            </p>{/if}
                        </details>
                      {/if}
                    </div>
                  {/if}
                  {#if message.buttons?.length}
                    <div class="message-buttons">
                      {#each message.buttons as button}
                        <button
                          class="btn btn-sm"
                          disabled={busy ||
                            loading ||
                            !senderId ||
                            message.deleted ||
                            button.disabled ||
                            button.style === 5 ||
                            (message.ephemeral && message.recipient !== senderId)}
                          onclick={() => clickButton(message.id, button.customId)}
                        >
                          {button.label}{button.style === 5 ? ' (simulated link)' : ''}
                        </button>
                      {/each}
                    </div>
                  {/if}
                  {#if message.reactions?.length}<p class="message-reactions">
                      {message.reactions.join(' ')}
                    </p>{/if}
                  <details class="message-details">
                    <summary>Message details</summary>
                    <p>
                      Fake message ID: {message.id} &middot; Channel: {message.channelId ??
                        world.channelId}
                    </p>
                    {#each message.buttons?.filter((button) => button.style === 5 && button.url) ?? [] as button}<p
                      >
                        Link: {button.url}
                      </p>{/each}
                  </details>
                </div>
              </article>
            {/each}
            {#if busy}<p class="running-indicator" role="status">
                Playground Bot is responding...
              </p>{/if}
          </div>
        </section>

        <section class="composer panel" aria-label="Send a simulated event">
          <div class="composer-toolbar">
            <label class="sender-control">
              <span class="sr-only">Send as</span>
              {@render avatar(selectedSender?.name ?? '?')}
              <select class="select select-sm" bind:value={senderId} disabled={busy || loading}>
                {#each availableSenders as member}<option value={member.id}>{member.name}</option
                  >{/each}
                {#if !availableSenders.length}<option value="">No available members</option>{/if}
              </select>
            </label>
            <label class="event-control">
              {@render icon('chat_bubble')}
              <span class="sr-only">Event type</span>
              <select class="select select-sm" bind:value={mode} disabled={busy || loading}>
                <option value="message">Message</option><option value="dm">Private message</option>
                <option value="slash">Slash command</option><option value="reaction"
                  >Reaction added</option
                >
                <option value="memberJoin">Member joins</option><option value="memberLeave"
                  >Member leaves</option
                ><option value="memberBan">Member banned</option>
              </select>
            </label>
          </div>
          {#if mode === 'reaction'}
            <label class="reaction-target"
              >React to
              <select
                class="select select-sm"
                bind:value={reactionMessageId}
                disabled={busy || loading}
              >
                <option value="">Choose a message</option>
                {#each world.messages.filter((message) => !message.deleted && (!world.world || message.channelId === world.channelId)) as message}<option
                    value={String(message.id)}
                    >#{message.id} &middot; {message.author}: {message.content.slice(0, 45)}</option
                  >{/each}
              </select>
            </label>
          {/if}
          {#if mode !== 'slash'}
            <form
              class="message-form"
              onsubmit={(event) => {
                event.preventDefault()
                send()
              }}
            >
              {#if ['message', 'dm', 'reaction'].includes(mode)}
                <input
                  class="input message-input"
                  bind:this={messageInput}
                  aria-label={mode === 'reaction' ? 'Reaction emoji' : 'Message or command'}
                  placeholder={mode === 'reaction'
                    ? 'Type a reaction emoji...'
                    : 'Type a message or command...'}
                  bind:value={content}
                  maxlength={PLAYGROUND_LIMITS.input}
                  disabled={busy || loading || !senderId}
                />
              {:else}
                <p class="event-description">
                  {selectedSender?.name ?? 'This member'}
                  {mode === 'memberJoin'
                    ? 'joins'
                    : mode === 'memberLeave'
                      ? 'leaves'
                      : 'is banned from'} the server. Your matching event commands will run.
                </p>
              {/if}
              <div class="composer-footer">
                <label class="saved-command-control">
                  {@render icon('bolt')}<span class="sr-only">Saved command (optional)</span>
                  <select
                    class="select select-sm"
                    value=""
                    disabled={busy || loading}
                    onchange={(event) => {
                      const value = event.currentTarget.value
                      event.currentTarget.value = ''
                      chooseCommand(value)
                    }}
                  >
                    <option value="">Saved command (optional)</option>
                    <optgroup label="Message & event commands"
                      >{#each activeCommands as command}<option value={`command:${command.id}`}
                          >{command.command}</option
                        >{/each}</optgroup
                    >
                    <optgroup label="Slash commands"
                      >{#each activeInteractions as interaction}<option
                          value={`interaction:${interaction.id}`}>/{interaction.commandName}</option
                        >{/each}</optgroup
                    >
                  </select>
                </label>
                <button
                  class="btn btn-primary send-button"
                  disabled={busy ||
                    loading ||
                    !senderId ||
                    (mode === 'reaction' && !reactionMessageId) ||
                    (!content.trim() && ['message', 'dm', 'reaction'].includes(mode))}
                >
                  {@render icon('send')}{busy
                    ? 'Running...'
                    : ['message', 'dm', 'reaction'].includes(mode)
                      ? 'Send'
                      : 'Run event'}
                </button>
              </div>
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
                  disabled={busy || loading || !senderId}
                >
                  {#each activeInteractions as interaction}<option value={interaction.id}
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
                        required={option.required}
                        bind:value={optionInputs[option.name]}
                        disabled={busy || loading}
                        ><option value="">Choose…</option>{#each option.choices as choice}<option
                            value={String(choice.value)}>{choice.name}</option
                          >{/each}</select
                      >
                    {:else if option.type === 5}
                      <select
                        class="select select-sm grow"
                        required={option.required}
                        bind:value={optionInputs[option.name]}
                        disabled={busy || loading}
                        ><option value="">Not provided</option><option value="true">true</option
                        ><option value="false">false</option></select
                      >
                    {:else if option.type === 6}
                      <select
                        class="select select-sm grow"
                        required={option.required}
                        bind:value={optionInputs[option.name]}
                        disabled={busy || loading}
                        ><option value="">Choose fake user…</option
                        >{#each world.members.filter((member) => !member.bot && !member.kicked && !member.banned) as member}<option
                            value={member.id}>{member.name}</option
                          >{/each}</select
                      >
                    {:else if option.type === 7}
                      <select
                        class="select select-sm grow"
                        required={option.required}
                        bind:value={optionInputs[option.name]}
                        disabled={busy || loading}
                        ><option value="">Choose fake channel…</option><option
                          value={world.channelId}>#{world.channelName}</option
                        ></select
                      >
                    {:else if option.type === 8}
                      <select
                        class="select select-sm grow"
                        required={option.required}
                        bind:value={optionInputs[option.name]}
                        disabled={busy || loading}
                        ><option value="">Choose fake role…</option
                        >{#each world.roles as role}<option value={role.id}>{role.name}</option
                          >{/each}</select
                      >
                    {:else}
                      <input
                        required={option.required}
                        type={option.type === 4 || option.type === 10 ? 'number' : 'text'}
                        step={option.type === 4 ? 1 : 'any'}
                        class="input input-sm grow"
                        bind:value={optionInputs[option.name]}
                        placeholder={option.type === 4
                          ? 'Integer'
                          : option.type === 10
                            ? 'Number'
                            : 'Text'}
                        disabled={busy || loading}
                        maxlength={6000}
                      />
                    {/if}
                  </label>
                {/each}
                <button class="btn btn-sm btn-primary" disabled={busy || loading || !senderId}
                  >{busy ? 'Running…' : `Invoke /${selectedInteraction.commandName}`}</button
                >
              {:else}<p class="text-sm opacity-60">No saved slash commands</p>{/if}
            </form>
          {/if}
          {#if !availableSenders.length}<p class="text-sm text-warning">
              Add a member or reset the session to keep testing.
            </p>{/if}
        </section>
      </div>

      <section class="commands-view panel" hidden={view !== 'commands'} aria-label="Saved commands">
        <header class="view-header">
          <h2>Saved Commands</h2>
        </header>
        <div class="commands-content">
          <input
            class="input w-full"
            type="search"
            aria-label="Search saved commands"
            placeholder="Search commands..."
            bind:value={commandQuery}
          />
          <p class="commands-help">
            {activeCommands.length + activeInteractions.length} enabled &middot; Changes here only affect
            this playground session.
          </p>
          {#each filteredCommands as command}
            <div class="command-row">
              <input
                class="checkbox checkbox-sm"
                type="checkbox"
                aria-label={`Enable ${command.command}`}
                bind:group={selectedCommandIds}
                value={command.id}
                disabled={busy || loading}
              />
              <div>
                <strong>{command.command}</strong><span
                  >{command.commandDescription || 'No description'} &middot; {commandEvents[
                    command.type
                  ]}</span
                >
              </div>
              <button
                class="btn btn-sm"
                disabled={busy || loading || !selectedCommandIds.includes(command.id)}
                onclick={() => chooseCommand(`command:${command.id}`)}
                >Try it {@render icon('arrow_forward')}</button
              >
            </div>
          {/each}
          {#each filteredInteractions as interaction}
            <div class="command-row">
              <input
                class="checkbox checkbox-sm"
                type="checkbox"
                aria-label={`Enable /${interaction.commandName}`}
                bind:group={selectedInteractionIds}
                value={interaction.id}
                disabled={busy || loading}
              />
              <div>
                <strong>/{interaction.commandName}</strong><span
                  >{interaction.commandDescription || 'Slash command'}</span
                >
              </div>
              <button
                class="btn btn-sm"
                disabled={busy || loading || !selectedInteractionIds.includes(interaction.id)}
                onclick={() => chooseCommand(`interaction:${interaction.id}`)}
                >Try it {@render icon('arrow_forward')}</button
              >
            </div>
          {/each}
          {#if !filteredCommands.length && !filteredInteractions.length}<p class="empty-commands">
              {loading
                ? 'Loading your saved commands...'
                : commands.length + interactions.length
                  ? 'No commands match your search.'
                  : 'No saved commands yet. Create a command in the app, then reload saved data here.'}
            </p>{/if}
        </div>
      </section>

      <section
        class="settings-view panel"
        hidden={view !== 'settings'}
        aria-label="Playground settings"
      >
        <header class="view-header">
          <h2>Playground Settings</h2>
        </header>
        <div class="settings-content">
          <section class="simple-setting">
            <h3>Test cooldowns</h3>
            <p>Skip waiting by moving the simulated clock forward.</p>
            <div class="flex flex-wrap gap-2">
              <button
                class="btn btn-sm"
                disabled={busy || loading}
                onclick={() => advanceClock(1000)}>Skip 1 second</button
              ><button
                class="btn btn-sm"
                disabled={busy || loading}
                onclick={() => advanceClock(10_000)}>Skip 10 seconds</button
              >
            </div>
          </section>
          <section class="simple-setting">
            <h3>AI response</h3>
            <p>Commands that use AI will receive this reply.</p>
            <textarea
              class="textarea w-full"
              aria-label="Default simulated AI response"
              bind:value={world.ai.response}
              maxlength={PLAYGROUND_LIMITS.output}
              disabled={busy || loading}
              rows={3}></textarea>
          </section>
          <details class="advanced-settings" open={!!replayRequest}>
            <summary>Advanced settings {replayRequest ? 'Agent replay loaded' : ''}</summary>
            <details class="w-full">
              <summary class="text-xs cursor-pointer">Offline session controls</summary>
              <div class="grid gap-3 mt-2 md:grid-cols-2">
                <div class="space-y-2">
                  <h2 class="font-semibold text-sm">Fake clock and cooldowns</h2>
                  <p class="text-xs">Fake time: {world.clockMs.toLocaleString()} ms</p>
                  <div class="flex gap-2">
                    <button
                      class="btn btn-xs"
                      disabled={busy || !Number.isSafeInteger(world.clockMs + 1000)}
                      onclick={() => advanceClock(1000)}>Advance 1 second</button
                    >
                    <button
                      class="btn btn-xs"
                      disabled={busy || !Number.isSafeInteger(world.clockMs + 10_000)}
                      onclick={() => advanceClock(10_000)}>Advance 10 seconds</button
                    >
                  </div>
                  <p class="text-xs opacity-70">
                    Time advances only when you click. Reset fake session clears the clock and
                    cooldowns.
                  </p>
                  <h2 class="font-semibold text-sm">Offline AI simulation</h2>
                  <label class="block text-xs"
                    >Simulated AI response
                    <textarea
                      class="textarea textarea-sm w-full mt-1"
                      rows={2}
                      bind:value={world.ai.response}
                      maxlength={PLAYGROUND_LIMITS.output}
                      disabled={busy}></textarea></label
                  >
                  <label class="block text-xs"
                    >Simulated AI failure (empty for success)
                    <input
                      class="input input-sm w-full mt-1"
                      bind:value={world.ai.error}
                      maxlength={PLAYGROUND_LIMITS.input}
                      disabled={busy}
                      placeholder="Example: simulated provider unavailable"
                    /></label
                  >
                  <p class="text-xs opacity-70">
                    Interactive defaults only. Strict tests require an exact prompt mock.
                  </p>
                  <label class="block text-xs"
                    >Exact AI prompt <input
                      class="input input-sm w-full"
                      bind:value={mockPrompt}
                      disabled={busy}
                    /></label
                  >
                  <label class="block text-xs"
                    >Mock response <input
                      class="input input-sm w-full"
                      bind:value={mockResponse}
                      disabled={busy}
                    /></label
                  >
                  <button
                    class="btn btn-xs"
                    disabled={busy || !mockPrompt || (world.aiMocks?.length ?? 0) >= 100}
                    onclick={() => {
                      world.aiMocks = [
                        ...(world.aiMocks ?? []).filter((item) => item.prompt !== mockPrompt),
                        { prompt: mockPrompt, response: mockResponse }
                      ]
                      mockPrompt = ''
                      mockResponse = ''
                    }}>Add exact mock</button
                  >
                  <p class="text-xs">{world.aiMocks?.length ?? 0} exact prompt mocks configured</p>
                  <label class="block text-xs"
                    >Random seed <input
                      class="input input-sm w-full"
                      type="number"
                      min={0}
                      max={4294967295}
                      value={world.randomSeed ?? 1}
                      onchange={(event) =>
                        (world.randomSeed = Number(event.currentTarget.value) >>> 0)}
                      disabled={busy}
                    /></label
                  >
                  <label class="block text-xs"
                    >Startup JavaScript (runs on a fresh session)
                    <textarea
                      class="textarea w-full font-mono text-xs"
                      rows={4}
                      value={world.startupSource ?? ''}
                      maxlength={16384}
                      disabled={busy}
                      onchange={(event) => {
                        session.cancel()
                        world.startupSource = event.currentTarget.value
                      }}></textarea>
                  </label>
                </div>
                <div class="space-y-2">
                  <h2 class="font-semibold text-sm">Fake session bot state</h2>
                  <label class="block text-xs"
                    >Bot state JSON draft
                    <textarea
                      class="textarea textarea-sm w-full font-mono mt-1"
                      rows={8}
                      bind:value={botStateDraft}
                      maxlength={PLAYGROUND_LIMITS.stateBytes}
                      disabled={busy}
                      aria-invalid={botStateDraftError ? 'true' : 'false'}
                      aria-describedby="playground-bot-state-help playground-bot-state-error"
                    ></textarea></label
                  >
                  <button class="btn btn-xs" disabled={busy} onclick={applyBotStateDraft}
                    >Apply draft</button
                  >
                  <p id="playground-bot-state-help" class="text-xs opacity-70">
                    Apply commits a JSON object to this fake session only. Draft edits are not sent.
                    Every completed request refreshes the draft from committed state, including
                    script changes. Maximum {PLAYGROUND_LIMITS.stateBytes.toLocaleString()} characters.
                  </p>
                  <p id="playground-bot-state-error" class="text-xs text-error" aria-live="polite">
                    {botStateDraftError}
                  </p>
                </div>
              </div>
            </details>
            <details class="w-full">
              <summary class="text-xs cursor-pointer">Fake channel/server context</summary>
              {#if world.world}
                <label class="text-xs"
                  >Event channel
                  <select
                    class="select select-xs"
                    disabled={busy}
                    value={world.channelId}
                    onchange={(event) => {
                      commitWorld(world)
                      const channel = world.world!.channels.find(
                        (item) => item.id === event.currentTarget.value
                      )!
                      selectWorldContext(world, {
                        guildId: channel.guildId || null,
                        channelId: channel.id
                      })
                      senderId =
                        world.members.find(
                          (member) => !member.bot && !member.kicked && !member.banned
                        )?.id ?? ''
                    }}
                  >
                    {#each world.world.channels.filter((channel) => !channel.deleted) as channel}
                      <option value={channel.id}
                        >{world.world.guilds.find((guild) => guild.id === channel.guildId)?.name ??
                          'DM'} / {channel.name}</option
                      >
                    {/each}
                  </select>
                </label>
              {/if}
              <div class="flex flex-wrap gap-2 mt-2">
                <label class="text-xs"
                  >Server ID <input
                    class="input input-xs"
                    bind:value={world.guildId}
                    maxlength={20}
                    disabled={busy || !!world.world}
                  /></label
                >
                <label class="text-xs"
                  >Channel ID <input
                    class="input input-xs"
                    bind:value={world.channelId}
                    maxlength={20}
                    disabled={busy || !!world.world}
                  /></label
                >
                <label class="flex items-center gap-1 text-xs"
                  ><input
                    type="checkbox"
                    class="checkbox checkbox-xs"
                    bind:checked={world.nsfw}
                    onchange={(event) => {
                      const channel = world.channels?.find((item) => item.id === world.channelId)
                      world.nsfw = event.currentTarget.checked
                      if (channel) channel.nsfw = world.nsfw
                      commitWorld(world)
                    }}
                    disabled={busy}
                  />Fake NSFW channel</label
                >
              </div>
            </details>
            {#if !world.world}
              <button
                class="btn btn-xs"
                disabled={busy}
                onclick={() => {
                  world = normalizeWorld($state.snapshot(world))
                  session.cancel()
                }}>Upgrade world to string IDs and guild permissions</button
              >
            {/if}
            <details class="border border-base-300 rounded p-3 mt-2">
              <summary class="font-semibold cursor-pointer"
                >Fake world and operation details</summary
              >
              <p class="text-xs my-2">
                Configure world.users, guilds, memberships, roles (permissions and positions), and
                channels (overwrites), plus failures, startupSource, randomSeed, and explicit
                aiMocks. Applying a world starts a fresh script session.
              </p>
              <button
                class="btn btn-xs"
                disabled={busy}
                onclick={() => (worldDraft = JSON.stringify($state.snapshot(world), null, 2))}
                >Inspect current world</button
              >
              <textarea
                class="textarea w-full font-mono text-xs my-2"
                rows={8}
                bind:value={worldDraft}
                maxlength={65536}
                disabled={busy}
                aria-label="Fake world JSON"></textarea>
              <button
                class="btn btn-xs"
                disabled={busy || !worldDraft}
                onclick={() => {
                  try {
                    const next = validateAgentValidationState(JSON.parse(worldDraft))
                    session.cancel()
                    if (next.world)
                      selectWorldContext(next, {
                        guildId: next.guildId || null,
                        channelId: next.channelId
                      })
                    world = next
                    syncBotStateDraft()
                    worldError = ''
                  } catch (error) {
                    worldError = error instanceof Error ? error.message : String(error)
                  }
                }}>Apply fake world</button
              >
              {#if worldError}<p class="text-error text-xs">{worldError}</p>{/if}
              <pre class="text-xs max-h-48 overflow-auto whitespace-pre-wrap">{JSON.stringify(
                  { events: world.events ?? [], operations: world.operations ?? [] },
                  null,
                  2
                )}</pre>
            </details>
            <details class="text-xs">
              <summary class="cursor-pointer">Causal events ({world.events?.length ?? 0})</summary>
              <ol class="max-h-48 overflow-auto space-y-2 py-2" aria-label="Causal events">
                {#each world.events ?? [] as event (event.id)}
                  <li>
                    <code>{event.id}</code>: {event.kind} · {event.status}
                    {#if event.parentOperationId}
                      <span>caused by {event.parentOperationId} in {event.parentEventId}</span>
                    {/if}
                    <div class="opacity-60">
                      User {event.senderId} · guild {event.context.guildId ?? 'DM'} · scheduled {event.scheduledAt}ms
                      · dispatched {event.dispatchedAt ?? 'pending'}ms
                      {#if event.reason}· {event.reason}{/if}
                    </div>
                  </li>
                {/each}
              </ol>
            </details>
            <PlaygroundTests
              commands={activeCommands}
              interactions={activeInteractions}
              {world}
              defaultWrapEval={wrapEval}
              replay={replayRequest}
            />
            <details class="diagnostics">
              <summary>Run details ({trace.length})</summary>{#each trace as line}<p
                  class="text-xs whitespace-pre-wrap mt-1"
                >
                  {line}
                </p>{/each}
            </details>
            <details class="role-settings">
              <summary>Manage roles</summary>
              {#each world.roles as role}<p class="text-xs mt-2">{role.name}: {role.id}</p>{/each}
              <form
                class="space-y-2 mt-3"
                onsubmit={(event) => {
                  event.preventDefault()
                  addFakeRole()
                }}
              >
                <input
                  class="input input-sm w-full"
                  aria-label="New fake role ID"
                  placeholder="Role ID"
                  bind:value={roleIdDraft}
                  maxlength={20}
                  disabled={busy || loading}
                />
                <input
                  class="input input-sm w-full"
                  aria-label="New fake role name"
                  placeholder="Role name"
                  bind:value={roleNameDraft}
                  maxlength={100}
                  disabled={busy || loading}
                />
                <button
                  class="btn btn-sm"
                  disabled={busy || loading || world.roles.length >= PLAYGROUND_LIMITS.roles}
                  >Add role</button
                >
              </form>
            </details>
          </details>
        </div>
      </section>
    </main>

    <aside class="members-sidebar panel" aria-label="Server members">
      <header>
        <h2>Server Members ({people.length})</h2>
        <button
          class="btn btn-sm btn-square btn-ghost"
          aria-label={addingMember ? 'Cancel adding member' : 'Add member'}
          disabled={busy ||
            loading ||
            !world.guildId ||
            world.members.length >= PLAYGROUND_LIMITS.members ||
            (world.world?.users.length ?? 0) >= PLAYGROUND_LIMITS.members}
          onclick={() => (addingMember = !addingMember)}
          >{@render icon(addingMember ? 'close' : 'add')}</button
        >
      </header>
      {#if addingMember}
        <form
          class="add-member-form"
          onsubmit={(event) => {
            event.preventDefault()
            addMember()
          }}
        >
          <input
            class="input input-sm w-full"
            aria-label="New member name"
            placeholder="Member name"
            bind:value={newMemberName}
            maxlength={100}
            disabled={busy || loading}
          />
          <button class="btn btn-sm btn-primary" disabled={busy || loading || !newMemberName.trim()}
            >Add member</button
          >
          {#if memberError}<p class="text-error text-xs" role="alert">{memberError}</p>{/if}
        </form>
      {/if}
      <div class="member-list">
        {#each people as member}
          <div class="member-card" class:removed-member={member.kicked || member.banned}>
            <div class="member-summary">
              {@render avatar(member.name)}
              <button
                class="member-name"
                title={`Mention ${member.name}`}
                disabled={busy ||
                  loading ||
                  member.kicked ||
                  member.banned ||
                  !['message', 'dm'].includes(mode)}
                onclick={() => {
                  content += `${content ? ' ' : ''}<@${member.id}>`
                  view = 'chat'
                }}><strong>{member.name}</strong><span>{member.id}</span></button
              >
              {#if member.id === ownerId}<span class="owner-icon" title="Server owner"
                  >{@render icon('crown')}</span
                >{/if}
            </div>
            {#if member.banned || member.kicked || member.muted}<p class="member-status">
                {member.banned ? 'Banned' : member.kicked ? 'Left server' : 'Muted'}
              </p>{/if}
            <details class="member-options">
              <summary
                aria-label={`Options for ${member.name}`}
                title={`Options for ${member.name}`}>&bull;&bull;&bull;</summary
              >
              <div class="member-options-content">
                <h3>Roles</h3>
                {#each world.roles.filter((role) => role.id !== world.guildId && role.name !== 'Playground Bot') as role}<label
                    ><input
                      class="checkbox checkbox-xs"
                      type="checkbox"
                      checked={member.roles.includes(role.id)}
                      disabled={busy || loading}
                      onchange={() => changeRole(member.id, role.id)}
                    />{role.name}</label
                  >{/each}
                <h3>Permissions</h3>
                {#each permissions as permission}<label
                    ><input
                      class="checkbox checkbox-xs"
                      type="checkbox"
                      checked={member.permissions.includes(permission)}
                      disabled={busy || loading}
                      onchange={() => changePermission(member.id, permission)}
                    />{{
                      admin: 'Administrator',
                      manageMessages: 'Manage messages',
                      kick: 'Kick members',
                      ban: 'Ban members',
                      mute: 'Mute members'
                    }[permission]}</label
                  >{/each}
              </div>
            </details>
          </div>
        {/each}
      </div>
    </aside>
  </div>
</section>

<style>
  .playground {
    --pg-border: color-mix(in oklch, var(--color-base-content) 10%, transparent);
    --pg-muted: color-mix(in oklch, var(--color-base-content) 62%, transparent);
    height: 100%;
    min-height: 560px;
    display: flex;
    flex-direction: column;
    background: var(--color-base-200);
    color: var(--color-base-content);
    container-type: inline-size;
    padding: 14px;
    gap: 18px;
  }
  .playground :global(.material-symbols-outlined) {
    font-size: 22px;
    flex-shrink: 0;
  }
  .playground :global(button),
  .playground :global(summary) {
    cursor: pointer;
  }
  .playground :global(button:disabled) {
    cursor: default;
  }
  .playground :global([hidden]) {
    display: none !important;
  }
  .playground-header,
  .page-title,
  .header-actions {
    display: flex;
    align-items: center;
  }
  .playground-header {
    gap: 16px;
    justify-content: space-between;
    padding: 6px 6px 0;
    flex-wrap: wrap;
  }
  .page-title {
    gap: 16px;
  }
  .page-title h1 {
    font-size: 25px;
    font-weight: 750;
    line-height: 1.3;
  }
  .header-actions {
    gap: 10px;
  }
  .header-actions .btn {
    min-height: 38px;
    padding-inline: 15px;
    border-radius: 10px;
    font-weight: 500;
  }
  .reload-button {
    background: var(--color-base-100);
    border-color: var(--pg-border);
  }
  .playground-layout {
    display: grid;
    grid-template-columns: 215px minmax(0, 1fr) 245px;
    gap: 12px;
    flex: 1;
    min-height: 0;
  }
  .panel {
    border: 1px solid var(--pg-border);
    border-radius: 12px;
    background: var(--color-base-100);
  }
  .server-sidebar {
    padding: 18px 12px;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .server-sidebar h2 {
    font-size: 14px;
    font-weight: 650;
    margin: 0 4px 12px;
  }
  .server-card {
    display: flex;
    align-items: center;
    gap: 10px;
    border: 1px solid var(--pg-border);
    border-radius: 10px;
    padding: 12px 10px;
  }
  .server-card > div {
    min-width: 0;
  }
  .server-card strong {
    display: block;
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  .server-id {
    display: block;
    color: var(--pg-muted);
    font-size: 10px;
    margin-top: 3px;
    overflow-wrap: anywhere;
  }
  .server-icon {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 11px;
    background: var(--color-primary);
    color: var(--color-primary-content);
    flex-shrink: 0;
  }
  .server-sidebar nav {
    display: flex;
    flex-direction: column;
    gap: 7px;
    margin-top: 16px;
  }
  nav button {
    display: flex;
    align-items: center;
    text-align: left;
    gap: 12px;
    padding: 12px;
    border-radius: 10px;
    font-size: 13px;
  }
  nav button:hover {
    background: var(--color-base-200);
  }
  nav button.active {
    background: color-mix(in oklch, var(--color-primary) 14%, transparent);
    color: var(--color-primary);
  }
  .command-count {
    margin-left: auto;
    padding: 2px 7px;
    border-radius: 7px;
    font-size: 11px;
    background: var(--color-base-200);
    color: var(--pg-muted);
  }
  .playground-main,
  .chat-view {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    gap: 12px;
  }
  .chat-view {
    flex: 1;
  }
  .conversation {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .channel-header {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 12px;
    padding: 18px 20px 16px;
    border-bottom: 1px solid var(--pg-border);
  }
  .channel-title {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }
  .channel-hash {
    font-size: 32px;
    line-height: 1;
    color: var(--pg-muted);
  }
  .channel-title h2 {
    font-size: 23px;
    font-weight: 700;
    overflow-wrap: anywhere;
  }
  .offline-badge {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-left: auto;
    padding: 7px 10px;
    background: var(--color-base-200);
    border-radius: 12px;
    white-space: nowrap;
    font-size: 11px;
  }
  .offline-badge > span {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--color-success);
  }
  .transcript {
    flex: 1;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 22px 18px;
  }
  .empty-chat {
    min-height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    text-align: center;
    gap: 12px;
    padding: 30px 20px;
  }
  .empty-icon {
    width: 64px;
    height: 64px;
    display: grid;
    place-items: center;
    background: color-mix(in oklch, var(--color-primary) 10%, transparent);
    color: var(--color-primary);
    border-radius: 20px;
    margin-bottom: 4px;
  }
  .empty-icon :global(.material-symbols-outlined) {
    font-size: 32px;
  }
  .empty-chat h3 {
    font-size: 20px;
    font-weight: 700;
  }
  .empty-chat p {
    font-size: 13px;
    color: var(--pg-muted);
    max-width: 340px;
    line-height: 1.7;
  }
  .chat-message {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    margin-bottom: 26px;
  }
  .chat-message:last-child {
    margin-bottom: 0;
  }
  .person-avatar {
    display: inline-grid;
    place-items: center;
    width: 42px;
    height: 42px;
    flex-shrink: 0;
    border-radius: 50%;
    font-size: 18px;
    font-weight: 650;
    color: #83445b;
    background: #f6d9e5;
    border: 3px solid color-mix(in oklch, white 28%, transparent);
  }
  .person-avatar[data-tone='1'] {
    background: #dbe6fc;
    color: #46658b;
  }
  .person-avatar[data-tone='2'] {
    background: #ddeddf;
    color: #4e7159;
  }
  .person-avatar.bot-avatar {
    background: #f45079;
    color: white;
  }
  .message-body {
    min-width: 0;
    flex: 1;
    overflow-wrap: anywhere;
  }
  .message-heading {
    display: flex;
    align-items: center;
    gap: 7px;
    flex-wrap: wrap;
    min-height: 24px;
  }
  .message-heading strong {
    font-size: 15px;
    font-weight: 700;
  }
  .identity-badge {
    padding: 2px 5px;
    border-radius: 5px;
    background: color-mix(in oklch, var(--color-primary) 13%, transparent);
    color: var(--color-primary);
    font-size: 9px;
    font-weight: 650;
  }
  .bot-badge {
    background: var(--color-primary);
    color: var(--color-primary-content);
  }
  .message-context {
    color: var(--pg-muted);
    font-size: 11px;
    margin-left: 3px;
  }
  .message-content {
    white-space: pre-wrap;
    line-height: 1.65;
    font-size: 14px;
    margin-top: 4px;
  }
  .message-embed {
    margin-top: 10px;
    padding: 14px 18px;
    border-left: 4px solid var(--color-primary);
    border-radius: 7px;
    background: color-mix(in oklch, var(--color-base-200) 65%, var(--color-base-100));
  }
  .message-embed h3 {
    font-size: 16px;
    font-weight: 700;
    margin-bottom: 4px;
  }
  .message-meta,
  .embed-media,
  .message-details {
    color: var(--pg-muted);
    font-size: 10px;
    margin-top: 7px;
  }
  .message-details summary {
    opacity: 0.65;
  }
  .message-buttons {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 10px;
  }
  .message-reactions {
    display: inline-block;
    margin-top: 8px;
    border-radius: 8px;
    background: var(--color-base-200);
    padding: 3px 8px;
  }
  .deleted-message {
    opacity: 0.45;
  }
  .running-indicator {
    color: var(--pg-muted);
    font-size: 12px;
  }
  .composer {
    flex-shrink: 0;
    padding: 14px;
  }
  .composer-toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
    flex-wrap: wrap;
  }
  .sender-control,
  .event-control {
    display: flex;
    align-items: center;
    border: 1px solid var(--pg-border);
    border-radius: 9px;
    padding-left: 9px;
    max-width: 100%;
  }
  .sender-control :global(.person-avatar) {
    width: 24px;
    height: 24px;
    font-size: 11px;
    border-width: 1px;
  }
  .composer-toolbar .select {
    border: 0;
    background-color: transparent;
    outline-offset: -2px;
    max-width: 175px;
    box-shadow: none;
  }
  .event-control :global(.material-symbols-outlined) {
    font-size: 19px;
  }
  .message-input {
    width: 100%;
    font-size: 13px;
    border-color: var(--pg-border);
    border-radius: 8px;
    background: var(--color-base-100);
  }
  .composer-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-top: 10px;
  }
  .saved-command-control {
    display: flex;
    align-items: center;
    padding-left: 8px;
    border: 1px dashed var(--pg-border);
    border-radius: 8px;
    min-width: 0;
    max-width: 70%;
    color: var(--pg-muted);
  }
  .saved-command-control :global(.material-symbols-outlined) {
    font-size: 19px;
    color: var(--color-primary);
  }
  .saved-command-control .select {
    border: 0;
    box-shadow: none;
    background-color: transparent;
    font-size: 11px;
    min-width: 0;
    max-width: 100%;
  }
  .send-button {
    border-radius: 9px;
    min-height: 36px;
    height: 36px;
    padding-inline: 16px;
    font-size: 13px;
    font-weight: 500;
  }
  .event-description {
    font-size: 12px;
    line-height: 1.6;
    color: var(--pg-muted);
    padding-block: 4px;
  }
  .reaction-target {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 12px;
    margin-bottom: 10px;
  }
  .reaction-target select {
    flex: 1;
    min-width: 0;
  }
  .members-sidebar {
    min-width: 0;
    overflow-y: auto;
    padding: 16px 14px;
  }
  .members-sidebar > header {
    display: flex;
    align-items: center;
    gap: 4px;
    justify-content: space-between;
    margin-bottom: 14px;
  }
  .members-sidebar h2 {
    font-size: 14px;
    font-weight: 650;
  }
  .member-card {
    position: relative;
    padding: 6px 0 18px;
  }
  .member-summary {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-right: 4px;
  }
  .member-summary :global(.person-avatar) {
    width: 36px;
    height: 36px;
    font-size: 15px;
  }
  .member-name {
    display: block;
    text-align: left;
    min-width: 0;
    flex: 1;
  }
  .member-name strong {
    display: block;
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  .member-name > span {
    display: block;
    margin-top: 3px;
    color: var(--pg-muted);
    font-size: 10px;
    overflow-wrap: anywhere;
  }
  .owner-icon {
    color: var(--color-primary);
    display: flex;
  }
  .owner-icon :global(.material-symbols-outlined) {
    font-size: 17px;
  }
  .member-options > summary {
    list-style: none;
    font-size: 12px;
    letter-spacing: 1px;
    width: 24px;
    margin-left: auto;
    text-align: center;
    color: var(--pg-muted);
  }
  .member-options > summary::-webkit-details-marker {
    display: none;
  }
  .member-options-content {
    background: var(--color-base-200);
    border: 1px solid var(--pg-border);
    border-radius: 8px;
    padding: 10px;
    margin-top: 6px;
  }
  .member-options-content h3 {
    font-size: 11px;
    font-weight: 650;
    margin: 6px 0;
  }
  .member-options-content label {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 11px;
    padding: 4px 0;
  }
  .member-status {
    margin: 4px 0 0 46px;
    font-size: 10px;
    color: var(--pg-muted);
  }
  .removed-member .member-summary {
    opacity: 0.45;
  }
  .add-member-form {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 16px;
  }
  .session-errors {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    background: color-mix(in oklch, var(--color-error) 10%, var(--color-base-100));
    border: 1px solid color-mix(in oklch, var(--color-error) 30%, transparent);
    border-radius: 10px;
    padding: 12px;
    color: var(--color-error);
    font-size: 12px;
    max-height: 120px;
    overflow: auto;
    flex-shrink: 0;
    overflow-wrap: anywhere;
  }
  .session-notices {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px;
    border: 1px solid var(--pg-border);
    border-radius: 10px;
    background: var(--color-base-100);
    color: var(--pg-muted);
    font-size: 12px;
    max-height: 120px;
    overflow-y: auto;
    flex-shrink: 0;
    overflow-wrap: anywhere;
  }
  .commands-view,
  .settings-view {
    overflow-y: auto;
    min-height: 0;
    flex: 1;
  }
  .view-header {
    padding: 20px;
    border-bottom: 1px solid var(--pg-border);
  }
  .view-header h2 {
    font-size: 21px;
    font-weight: 700;
  }
  .commands-content,
  .settings-content {
    padding: 20px;
  }
  .commands-help {
    margin: 12px 0 6px;
    font-size: 11px;
    color: var(--pg-muted);
  }
  .command-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 15px 0;
    border-bottom: 1px solid var(--pg-border);
  }
  .command-row > div {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .command-row strong {
    display: block;
    font-size: 13px;
  }
  .command-row span {
    display: block;
    font-size: 11px;
    color: var(--pg-muted);
    margin-top: 3px;
  }
  .command-row .btn {
    flex-shrink: 0;
  }
  .empty-commands {
    padding-block: 24px;
    font-size: 13px;
    color: var(--pg-muted);
  }
  .simple-setting {
    padding-bottom: 22px;
    margin-bottom: 22px;
    border-bottom: 1px solid var(--pg-border);
  }
  .simple-setting h3 {
    font-size: 14px;
    font-weight: 650;
  }
  .simple-setting p {
    font-size: 12px;
    color: var(--pg-muted);
    margin: 5px 0 12px;
  }
  .advanced-settings > summary {
    font-size: 14px;
    font-weight: 650;
  }
  .advanced-settings :global(details) {
    margin-block: 15px;
  }
  .advanced-settings :global(input),
  .advanced-settings :global(select) {
    max-width: 100%;
  }
  .advanced-settings :global(pre) {
    overflow-wrap: anywhere;
  }
  @container (max-width: 1100px) {
    .playground-layout {
      grid-template-columns: 175px minmax(0, 1fr) 200px;
      gap: 10px;
    }
    .server-sidebar {
      padding-inline: 8px;
    }
    nav button {
      gap: 8px;
      padding-inline: 8px;
      font-size: 12px;
    }
    .members-sidebar {
      padding-inline: 10px;
    }
    .members-sidebar h2 {
      font-size: 12px;
    }
    .member-name > span {
      font-size: 9px;
    }
    .member-summary {
      gap: 6px;
    }
    .member-summary :global(.person-avatar) {
      width: 30px;
      height: 30px;
    }
    .header-actions .btn {
      font-size: 11px;
      padding-inline: 10px;
    }
  }
  @container (max-width: 850px) {
    .playground-layout {
      grid-template-columns: minmax(0, 1fr) 195px;
      grid-template-rows: auto minmax(0, 1fr);
    }
    .server-sidebar {
      grid-column: 1 / -1;
      padding: 8px;
      flex-direction: row;
      align-items: center;
      gap: 14px;
    }
    .server-sidebar h2,
    .server-card,
    .server-sidebar nav {
      flex-direction: row;
      margin: 0;
      flex: 1;
      gap: 4px;
    }
    nav button {
      padding: 8px 12px;
    }
    .channel-header {
      padding: 16px;
    }
    .channel-title h2 {
      font-size: 20px;
    }
    .playground-header {
      gap: 12px;
    }
    .page-title h1 {
      font-size: 22px;
    }
    .page-title {
      gap: 10px;
    }
  }
  @container (max-width: 620px) {
    .playground-layout {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto minmax(0, 1fr) auto;
    }
    .members-sidebar {
      max-height: 150px;
    }
    .members-sidebar > header {
      margin-bottom: 4px;
    }
    .member-list {
      display: flex;
      gap: 16px;
      align-items: flex-start;
      flex-wrap: wrap;
    }
    .member-card {
      flex: 1 0 155px;
      padding-bottom: 0;
    }
    .member-options[open] {
      position: relative;
      z-index: 1;
    }
    .header-actions {
      gap: 6px;
    }
    .offline-badge {
      font-size: 10px;
    }
    .channel-title h2 {
      font-size: 18px;
    }
    .message-context {
      display: none;
    }
    .transcript {
      padding-inline: 12px;
    }
    .chat-message {
      gap: 10px;
    }
    .chat-message :global(.person-avatar) {
      width: 32px;
      height: 32px;
      font-size: 14px;
    }
  }
</style>
