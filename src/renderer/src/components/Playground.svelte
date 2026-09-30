<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { decodeBCFDCommandArray, type CanonicalBCFDCommand } from '../../../shared/commandCodec'
  import {
    createPlaygroundFixture,
    type PlaygroundFixture,
    type PlaygroundResult
  } from '../../../shared/playground'
  import { runPlayground } from '../playground/client'
  import type { BCFDInteractionCommand, BCFDSlashCommandOption } from '../types/types'

  type ConversationTurn = {
    id: number
    sender: string
    message: string
    time: string
    result?: PlaygroundResult
    error?: string
  }

  let commands: CanonicalBCFDCommand[] = $state([])
  let interactions: BCFDInteractionCommand[] = $state([])
  let selectedCommand = $state('message:all')
  let interactionOptions: Record<string, string | number | boolean> = $state({})
  const initialFixture = createPlaygroundFixture()
  let fixture: PlaygroundFixture = $state(initialFixture)
  let senderId = $state(initialFixture.members[0].id)
  let message = $state('')
  let botStateDraft = $state('{}')
  let turns: ConversationTurn[] = $state([])
  let busy = $state(false)
  let loading = $state(true)
  let loadError = $state('')
  let validationError = $state('')
  let conversation: HTMLDivElement | undefined = $state()
  let composer: HTMLTextAreaElement | undefined = $state()
  let generation = 0
  let loadGeneration = 0
  let nextTurnId = 0

  const activeMembers = $derived(fixture.members.filter((member) => member.status === 'active'))
  const sender = $derived(fixture.members.find((member) => member.id === senderId))
  const selected = $derived(
    selectedCommand === 'message:all'
      ? commands
      : commands.filter((_, index) => `message:${index}` === selectedCommand)
  )
  const selectedInteraction = $derived(
    interactions.find((interaction) => `interaction:${interaction.id}` === selectedCommand)
  )
  const messageCommandCount = $derived(commands.filter((command) => command.type === 0).length)

  onMount(() => {
    void loadCommands()
    return () => {
      generation += 1
      loadGeneration += 1
    }
  })

  async function loadCommands() {
    const currentLoad = ++loadGeneration
    loading = true
    loadError = ''
    try {
      const [result, loadedInteractions] = await Promise.all([
        window.electron.ipcRenderer.invoke('get-commands'),
        window.electron.ipcRenderer.invoke('get-interactions')
      ])
      const loaded = decodeBCFDCommandArray(result.bcfdCommands).map((entry) => entry.command)
      if (currentLoad !== loadGeneration) return
      commands = loaded
      interactions = loadedInteractions
      selectedCommand = 'message:all'
      interactionOptions = {}
    } catch (error) {
      if (currentLoad !== loadGeneration) return
      loadError = error instanceof Error ? error.message : 'Could not read saved commands.'
    } finally {
      if (currentLoad === loadGeneration) loading = false
    }
  }

  async function scrollToLatest() {
    await tick()
    if (conversation) conversation.scrollTop = conversation.scrollHeight
  }

  function reset() {
    generation += 1
    busy = false
    turns = []
    fixture = createPlaygroundFixture()
    senderId = fixture.members[0].id
    botStateDraft = '{}'
    interactionOptions = {}
    message = ''
    validationError = ''
    composer?.focus()
  }

  function mention(memberId: string) {
    if (busy) return
    const start = composer?.selectionStart ?? message.length
    const end = composer?.selectionEnd ?? message.length
    const before = message.slice(0, start)
    const after = message.slice(end)
    const inserted = `${before && !/\s$/.test(before) ? ' ' : ''}<@${memberId}>${after && !/^\s/.test(after) ? ' ' : ''}`
    message = before + inserted + after
    void tick().then(() => {
      composer?.focus()
      composer?.setSelectionRange(start + inserted.length, start + inserted.length)
    })
  }

  function displayMentions(text: string) {
    return text.replace(/<@!?(\d+)>/g, (mention, id: string) => {
      const member = fixture.members.find((candidate) => candidate.id === id)
      return member ? `@${member.name}` : mention
    })
  }

  function updateRoles(value: string) {
    if (!sender) return
    sender.roles = [
      ...new Set(
        value
          .split(',')
          .map((role) => role.trim())
          .filter(Boolean)
      )
    ]
  }

  function embedColor(value: string) {
    const normalized = value.startsWith('#') ? value : `#${value}`
    return /^#[\da-f]{6}$/i.test(normalized) ? normalized : '#818cf8'
  }

  function optionValue(option: BCFDSlashCommandOption): string | number | boolean {
    const current = interactionOptions[option.name]
    if (option.type === 5) return current === true
    if (option.type === 4 || option.type === 10) {
      if (current === '' || current === undefined) return ''
      return Number(current)
    }
    return current ?? ''
  }

  function optionLabel(option: BCFDSlashCommandOption): string {
    const labels: Record<number, string> = {
      3: 'Text',
      4: 'Integer',
      5: 'True / false',
      6: 'Fake user',
      7: 'Channel ID',
      8: 'Role ID',
      10: 'Number'
    }
    return `${option.name}${option.required ? ' *' : ''} · ${labels[option.type] ?? 'Value'}`
  }

  async function sendMessage(event?: SubmitEvent) {
    event?.preventDefault()
    if (
      busy ||
      loading ||
      (!selectedInteraction && !message.trim()) ||
      !sender ||
      sender.status !== 'active' ||
      (!selected.length && !selectedInteraction)
    ) {
      return
    }
    validationError = ''
    let state: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(botStateDraft)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Use a JSON object for fake botState, such as {"score": 10}.')
      }
      state = parsed as Record<string, unknown>
    } catch (error) {
      validationError = `Fake botState: ${error instanceof Error ? error.message : 'Invalid JSON.'}`
      return
    }
    const currentGeneration = generation
    const id = ++nextTurnId
    const input = selectedInteraction ? `/${selectedInteraction.commandName}` : message
    const senderName = sender.name
    const requestFixture = { ...$state.snapshot(fixture), botState: state }
    const requestCommands = $state.snapshot(selected)
    const requestInteraction = selectedInteraction
      ? $state.snapshot(selectedInteraction)
      : undefined
    turns = [
      ...turns,
      {
        id,
        sender: senderName,
        message: input,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }
    ]
    if (!selectedInteraction) message = ''
    busy = true
    void scrollToLatest()
    try {
      const result = await runPlayground({
        commands: requestCommands,
        interactions: requestInteraction ? [requestInteraction] : [],
        fixture: requestFixture,
        senderId,
        message: input,
        interaction: requestInteraction
          ? {
              commandId: requestInteraction.id,
              options: Object.fromEntries(
                requestInteraction.options.map((option) => [option.name, optionValue(option)])
              )
            }
          : undefined
      })
      if (currentGeneration !== generation) return
      fixture = result.fixture
      turns = turns.map((turn) => (turn.id === id ? { ...turn, result } : turn))
      if (!fixture.members.some((member) => member.id === senderId && member.status === 'active')) {
        senderId = fixture.members.find((member) => member.status === 'active')?.id ?? ''
      }
    } catch (error) {
      if (currentGeneration !== generation) return
      const reason = error instanceof Error ? error.message : 'The simulation failed. Try again.'
      turns = turns.map((turn) => (turn.id === id ? { ...turn, error: reason } : turn))
    } finally {
      if (currentGeneration === generation) {
        busy = false
        void scrollToLatest()
        void tick().then(() => composer?.focus())
      }
    }
  }

  async function clickFakeButton(
    commandId: string,
    path: string[],
    options: Record<string, string | number | boolean>
  ) {
    if (busy) return
    const interaction = interactions.find((candidate) => candidate.id === commandId)
    if (!interaction) return
    const currentGeneration = generation
    const id = ++nextTurnId
    const senderName = sender?.name ?? 'Unknown'
    turns = [
      ...turns,
      {
        id,
        sender: senderName,
        message: `Clicked ${path[path.length - 1]}`,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }
    ]
    busy = true
    try {
      const result = await runPlayground({
        commands: [],
        interactions: [$state.snapshot(interaction)],
        fixture: $state.snapshot(fixture),
        senderId,
        message: '',
        interaction: {
          commandId,
          options: $state.snapshot(options),
          buttonPath: path
        }
      })
      if (currentGeneration !== generation) return
      fixture = result.fixture
      turns = turns.map((turn) => (turn.id === id ? { ...turn, result } : turn))
    } catch (error) {
      if (currentGeneration !== generation) return
      turns = turns.map((turn) =>
        turn.id === id
          ? { ...turn, error: error instanceof Error ? error.message : 'Button simulation failed.' }
          : turn
      )
    } finally {
      if (currentGeneration === generation) busy = false
      void scrollToLatest()
    }
  }
</script>

<section class="playground" aria-label="Command testing playground">
  <header class="playground-header">
    <div class="title-group">
      <span class="material-symbols-outlined title-icon" aria-hidden="true">science</span>
      <div>
        <h1>Command playground</h1>
        <p>Your commands. A completely fake server.</p>
      </div>
    </div>
    <button
      class="btn btn-sm btn-ghost"
      onclick={reset}
      title="Clear chat and restore all fake members and context"
    >
      <span class="material-symbols-outlined text-base" aria-hidden="true">restart_alt</span>
      Reset
    </button>
  </header>

  <div class="safety-banner" role="note">
    <span class="material-symbols-outlined" aria-hidden="true">shield</span>
    <div>
      <strong>Simulation only. No real Discord effects.</strong>
      <span
        >Saved commands are read-only. Test data stays in this tab and is cleared when you leave.</span
      >
    </div>
    <span class="sandbox-tag">OFFLINE SANDBOX</span>
  </div>

  <p class="subset-notice">
    Limited offline subset: scripts, AI, botState writes, cooldowns, and message deletion do not
    run. Saved slash commands and their fake button replies are supported.
  </p>

  <div class="test-controls">
    <label class="command-selector">
      <span>Saved commands</span>
      <select
        class="select select-sm w-full"
        bind:value={selectedCommand}
        disabled={busy || loading || (!commands.length && !interactions.length)}
      >
        <optgroup label="Message commands">
          <option value="message:all">All saved message commands ({commands.length})</option>
          {#each commands as command, index}
            <option value={`message:${index}`}>
              {command.command || '(unnamed command)'}{command.type !== 0
                ? ' · event type unsupported'
                : ''}
            </option>
          {/each}
        </optgroup>
        <optgroup label="Slash commands">
          {#each interactions as interaction}
            <option value={`interaction:${interaction.id}`}>/{interaction.commandName}</option>
          {/each}
        </optgroup>
      </select>
    </label>
    <button
      class="btn btn-sm btn-ghost reload-button"
      onclick={loadCommands}
      disabled={busy || loading}
      aria-label="Reload saved commands"
      title="Read the latest saved commands"
    >
      <span class="material-symbols-outlined text-base" aria-hidden="true">refresh</span>
      Reload
    </button>
    <span class="command-count">{messageCommandCount} message · {interactions.length} slash</span>
  </div>

  <details class="scope-details">
    <summary>Supported subset &amp; fake test context</summary>
    <div class="scope-content">
      <p>
        <strong>This is an approximation, not the live Discord runtime.</strong> Supports message-command
        matching, saved slash commands, typed slash options, fake button follow-ups, basic BCFD identity/message/option
        values, $if conditions, replies, DMs, embeds, reactions, and local role/kick/ban/voice-mute effects.
      </p>
      <p>
        Eval, AI/network operations, cooldowns, all message deletion, specific-channel routing,
        event commands, and unsupported BCFD are blocked for the entire command. Fake botState is a
        JSON snapshot for inspection; reading or writing it in commands is unsupported. Check the
        trace for each command's limits.
      </p>
      <p>
        Moderation uses an administrator-only approximation. Discord permission combinations, role
        hierarchy, publication, autocomplete, and network/API failures are not modeled. Role
        assignment toggles the invoking sender's role. Link buttons are displayed but never opened.
      </p>
      <fieldset disabled={busy} class="context-fields">
        <legend>Fake context · used on the next message</legend>
        <label
          >Server ID <input
            class="input input-sm"
            bind:value={fixture.guildId}
            spellcheck="false"
          /></label
        >
        <label
          >Channel ID <input
            class="input input-sm"
            bind:value={fixture.channelId}
            spellcheck="false"
          /></label
        >
        <label>Channel name <input class="input input-sm" bind:value={fixture.channelName} /></label
        >
        <label class="checkbox-field"
          ><input class="checkbox checkbox-sm" type="checkbox" bind:checked={fixture.nsfw} /> NSFW channel</label
        >
        {#if sender}
          <label
            >{sender.name}'s roles (comma-separated)
            <input
              class="input input-sm"
              value={sender.roles.join(', ')}
              onchange={(event) => updateRoles(event.currentTarget.value)}
              placeholder="moderator, member"
            />
          </label>
          <label class="checkbox-field"
            ><input class="checkbox checkbox-sm" type="checkbox" bind:checked={sender.admin} />
            {sender.name} is an administrator</label
          >
        {/if}
        <label class="state-field"
          >Fake botState (JSON object, no persistence)
          <textarea
            class="textarea textarea-sm"
            bind:value={botStateDraft}
            rows="3"
            spellcheck="false"
            aria-describedby="state-help"></textarea>
          <span id="state-help">This never loads or changes your real bot state.</span>
        </label>
      </fieldset>
    </div>
  </details>

  {#if loadError}
    <div class="alert alert-error compact-alert" role="alert">
      Could not load saved commands: {loadError}
    </div>
  {:else if loading}
    <div class="loading-notice" role="status">Reading saved commands…</div>
  {:else if !commands.length && !interactions.length}
    <div class="alert compact-alert" role="status">
      No saved commands yet. Create a message or interaction command, then come back to test it
      here.
    </div>
  {/if}

  <div class="server-layout">
    <div class="channel">
      <div class="channel-header">
        <span class="channel-hash" aria-hidden="true">#</span>
        <strong>{fixture.channelName || 'playground'}</strong>
        <span class="channel-description">Fake channel</span>
        {#if fixture.nsfw}<span class="badge badge-sm badge-warning">NSFW</span>{/if}
      </div>
      <div
        class="conversation"
        bind:this={conversation}
        role="log"
        aria-label="Simulated conversation"
        aria-live="polite"
        aria-relevant="additions text"
        aria-busy={busy}
      >
        {#if !turns.length}
          <div class="welcome">
            <div class="welcome-icon" aria-hidden="true">#</div>
            <h2>Welcome to #{fixture.channelName || 'playground'}</h2>
            <p>
              Type a saved command below and see what your bot would say. Click a fake member to
              mention them.
            </p>
            <div class="welcome-note">
              <span class="material-symbols-outlined text-base" aria-hidden="true">bolt</span> No bot
              login or Discord connection needed
            </div>
          </div>
        {/if}
        {#each turns as turn (turn.id)}
          <article class="message-row">
            <div class="avatar-circle user-avatar" aria-hidden="true">
              {turn.sender.slice(0, 1)}
            </div>
            <div class="message-body">
              <div class="message-heading">
                <strong>{turn.sender}</strong><span class="identity-tag">FAKE USER</span><time
                  >{turn.time}</time
                >
              </div>
              <p class="message-content">{displayMentions(turn.message)}</p>
            </div>
          </article>
          {#if turn.result}
            {#each turn.result.outputs as output}
              <article class="message-row bot-message">
                <div class="avatar-circle bot-avatar" aria-hidden="true">
                  <span class="material-symbols-outlined">smart_toy</span>
                </div>
                <div class="message-body">
                  <div class="message-heading">
                    <strong>Bot Commander</strong><span class="identity-tag bot-tag"
                      >SIMULATED BOT</span
                    >
                  </div>
                  <div class="destination">
                    {output.reply ? '↳ Reply · ' : ''}{displayMentions(output.destination)}
                  </div>
                  {#if output.ephemeral}<span class="ephemeral-tag">EPHEMERAL</span>{/if}
                  {#if output.text}<p class="message-content">
                      {displayMentions(output.text)}
                    </p>{/if}
                  {#if output.embed}
                    <div
                      class="embed-card"
                      style:border-left-color={embedColor(output.embed.hexColor)}
                    >
                      {#if output.embed.title}<strong class="embed-title"
                          >{displayMentions(output.embed.title)}</strong
                        >{/if}
                      {#if output.embed.description}<p class="message-content">
                          {displayMentions(output.embed.description)}
                        </p>{/if}
                      {#if output.embed.imageURL}<p class="media-placeholder">
                          Image URL (not loaded): {output.embed.imageURL}
                        </p>{/if}
                      {#if output.embed.thumbnailURL}<p class="media-placeholder">
                          Thumbnail URL (not loaded): {output.embed.thumbnailURL}
                        </p>{/if}
                      {#if output.embed.footer}<p class="embed-footer">
                          {displayMentions(output.embed.footer)}
                        </p>{/if}
                    </div>
                  {/if}
                  {#if output.buttons?.length}
                    <div class="fake-buttons" aria-label="Simulated interaction buttons">
                      {#each output.buttons as button}
                        <button
                          type="button"
                          class="btn btn-xs"
                          disabled={busy || button.disabled || button.style === 5}
                          onclick={() =>
                            clickFakeButton(
                              output.interactionCommandId ?? '',
                              button.path,
                              output.interactionOptions ?? {}
                            )}
                          title={button.style === 5
                            ? 'External link buttons are disabled offline'
                            : `Simulate ${button.label}`}>{button.label}</button
                        >
                      {/each}
                    </div>
                  {/if}
                </div>
              </article>
            {/each}
            <div class="turn-summary">
              {#if !turn.result.outputs.length}
                <p class="no-output">
                  {turn.result.traces.some((trace) => trace.status === 'ran')
                    ? 'Command processed with no simulated reply. See actions below.'
                    : 'No simulated reply. Check matching, filters, or unsupported features below.'}
                </p>
              {/if}
              {#each turn.result.traces.filter((trace) => trace.status === 'ran') as trace}
                {#each trace.actions as action}<div class="action-line">
                    <span class="material-symbols-outlined" aria-hidden="true">bolt</span>{action}
                  </div>{/each}
              {/each}
              <details class="trace-details">
                <summary
                  >Execution trace · {turn.result.traces.filter((trace) => trace.status === 'ran')
                    .length} ran · {turn.result.traces.filter(
                    (trace) => trace.status === 'filtered'
                  ).length} filtered · {turn.result.traces.filter(
                    (trace) => trace.status === 'unsupported'
                  ).length} unsupported</summary
                >
                <div class="trace-content">
                  {#each turn.result.traces as trace}
                    <section class="trace-command">
                      <div class="trace-heading">
                        <strong>{trace.command || '(unnamed command)'}</strong><span
                          class="trace-status"
                          class:unsupported={trace.status === 'unsupported'}>{trace.status}</span
                        >
                      </div>
                      {#if trace.checks.length}<h3>Matching &amp; filters</h3>
                        <ul>
                          {#each trace.checks as check}<li>
                              {check.passed ? '✓' : '✕'}
                              {check.label}
                            </li>{/each}
                        </ul>{/if}
                      {#if trace.conditions.length}<h3>Conditions</h3>
                        <ul>
                          {#each trace.conditions as condition}<li>{condition}</li>{/each}
                        </ul>{/if}
                      {#if trace.actions.length}<h3>Simulated actions</h3>
                        <ul>
                          {#each trace.actions as action}<li>{action}</li>{/each}
                        </ul>{/if}
                      {#if trace.issues.length}<h3 class="issue-title">Limitations / issues</h3>
                        <ul>
                          {#each trace.issues as issue}<li>{issue}</li>{/each}
                        </ul>{/if}
                    </section>
                  {/each}
                  <details class="state-snapshots">
                    <summary>Fake botState before / after (unchanged by supported commands)</summary
                    >
                    <h3>Before</h3>
                    <pre>{JSON.stringify(turn.result.stateBefore, null, 2)}</pre>
                    <h3>After</h3>
                    <pre>{JSON.stringify(turn.result.stateAfter, null, 2)}</pre>
                  </details>
                </div>
              </details>
            </div>
          {:else if turn.error}
            <div class="run-error" role="alert">
              <strong>Simulation failed.</strong>
              {turn.error} No fake member changes were applied.
            </div>
          {:else}
            <div class="typing-indicator" role="status">
              <span class="loading loading-dots loading-xs"></span> Simulating command…
            </div>
          {/if}
        {/each}
      </div>

      <form class="composer" onsubmit={sendMessage}>
        <div class="composer-topline">
          <label for="playground-sender">Send as</label>
          <select
            id="playground-sender"
            class="select select-xs"
            bind:value={senderId}
            disabled={busy || !activeMembers.length}
          >
            {#each activeMembers as member}<option value={member.id}
                >{member.name}{member.admin ? ' · admin' : ''}</option
              >{/each}
          </select>
          <span>Enter to send · Shift+Enter for a new line</span>
        </div>
        {#if !activeMembers.length}<p class="run-error">
            All fake members were removed. Reset the playground to continue.
          </p>{/if}
        {#if validationError}<p class="run-error" role="alert">{validationError}</p>{/if}
        {#if selectedInteraction}
          <div class="interaction-options">
            <div class="interaction-heading">
              <strong>/{selectedInteraction.commandName}</strong>
              <span>{selectedInteraction.commandDescription}</span>
            </div>
            {#if !selectedInteraction.options.length}
              <p class="option-empty">This slash command has no options.</p>
            {/if}
            {#each selectedInteraction.options as option}
              <label>
                <span>{optionLabel(option)}</span>
                {#if option.choices?.length}
                  <select class="select select-sm" bind:value={interactionOptions[option.name]}>
                    <option value="">{option.required ? 'Choose…' : 'Not provided'}</option>
                    {#each option.choices as choice}
                      <option value={choice.value}>{choice.name}</option>
                    {/each}
                  </select>
                {:else if option.type === 5}
                  <input
                    class="checkbox checkbox-sm"
                    type="checkbox"
                    checked={interactionOptions[option.name] === true}
                    onchange={(event) =>
                      (interactionOptions[option.name] = event.currentTarget.checked)}
                  />
                {:else if option.type === 6}
                  <select class="select select-sm" bind:value={interactionOptions[option.name]}>
                    <option value=""
                      >{option.required ? 'Choose a fake member…' : 'Not provided'}</option
                    >
                    {#each activeMembers as member}<option value={member.id}>{member.name}</option
                      >{/each}
                  </select>
                {:else}
                  <input
                    class="input input-sm"
                    type={option.type === 4 || option.type === 10 ? 'number' : 'text'}
                    step={option.type === 4 ? '1' : 'any'}
                    bind:value={interactionOptions[option.name]}
                    placeholder={option.description}
                  />
                {/if}
              </label>
            {/each}
          </div>
        {:else}
          <div class="composer-input">
            <textarea
              bind:this={composer}
              bind:value={message}
              rows="2"
              maxlength="4000"
              aria-label="Message to simulate"
              placeholder={`Message #${fixture.channelName || 'playground'}`}
              disabled={busy || loading || !commands.length || !activeMembers.length}
              onkeydown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                  event.preventDefault()
                  void sendMessage()
                }
              }}></textarea>
            <button
              class="btn btn-primary btn-sm"
              type="submit"
              disabled={busy ||
                loading ||
                (!selected.length && !selectedInteraction) ||
                (!selectedInteraction && !message.trim()) ||
                !activeMembers.length}
              aria-label="Send simulated message"
            >
              {#if busy}<span class="loading loading-spinner loading-xs"></span>{:else}<span
                  class="material-symbols-outlined text-base"
                  aria-hidden="true">send</span
                >{/if}
              Send
            </button>
          </div>
        {/if}
        {#if selectedInteraction}
          <button
            class="btn btn-primary btn-sm interaction-run"
            type="submit"
            disabled={busy || loading || !activeMembers.length}
          >
            {#if busy}<span class="loading loading-spinner loading-xs"></span>{/if}
            Run /{selectedInteraction.commandName}
          </button>
        {/if}
        <p class="composer-footnote">
          Only this local simulation changes. Commands and real bot state are never saved here.
        </p>
      </form>
    </div>

    <aside class="member-sidebar" aria-label="Fake server members">
      <div class="members-heading">
        <h2>FAKE MEMBERS</h2>
        <span>{activeMembers.length} active</span>
      </div>
      <p class="members-help">Click to insert a mention</p>
      <div class="member-list">
        {#each fixture.members as member}
          <button
            type="button"
            class="member"
            class:removed={member.status !== 'active'}
            disabled={busy || member.status !== 'active'}
            onclick={() => mention(member.id)}
            title={`Mention ${member.name} (${member.id})`}
            aria-label={`Mention ${member.name}`}
          >
            <span class="avatar-circle member-avatar" aria-hidden="true"
              >{member.name.slice(0, 1)}<span
                class="presence"
                class:offline={member.status !== 'active'}
              ></span></span
            >
            <span class="member-info"
              ><strong
                >{member.name}{#if member.admin}<span
                    class="admin-mark"
                    title="Administrator"
                    aria-label="Administrator">♛</span
                  >{/if}</strong
              ><span
                >{member.status === 'active'
                  ? member.muted
                    ? 'Voice muted'
                    : 'Online'
                  : member.status}</span
              ></span
            >
          </button>
          <div class="member-roles" aria-label={`${member.name}'s roles`}>
            {#each member.roles as role}<span class="role-chip">{role}</span>{/each}
            {#if !member.roles.length}<span class="no-roles">No roles</span>{/if}
          </div>
        {/each}
      </div>
      <div class="member-sidebar-note">
        <span class="material-symbols-outlined" aria-hidden="true">info</span>
        <p>
          Role changes, kicks, bans, and voice mutes affect only these fake members. Reset restores
          everyone.
        </p>
      </div>
    </aside>
  </div>
</section>

<style>
  .playground {
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--color-base-100);
    overflow-y: auto;
    color: var(--color-base-content);
  }
  .playground-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    padding: 1.1rem 1.25rem 0.85rem;
  }
  .title-group {
    display: flex;
    gap: 0.7rem;
    align-items: center;
    min-width: 0;
  }
  .title-icon {
    color: var(--color-primary);
    font-size: 1.8rem;
  }
  h1 {
    font-size: 1.2rem;
    font-weight: 700;
    line-height: 1.35;
  }
  .title-group p {
    font-size: 0.78rem;
    opacity: 0.6;
    margin-top: 0.18rem;
  }
  .safety-banner {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    margin: 0 1.25rem;
    padding: 0.7rem 0.8rem;
    border: 1px solid color-mix(in srgb, var(--color-success) 32%, transparent);
    background: color-mix(in srgb, var(--color-success) 8%, transparent);
    border-radius: 0.65rem;
  }
  .safety-banner > .material-symbols-outlined {
    color: var(--color-success);
    font-size: 1.25rem;
  }
  .safety-banner strong {
    display: block;
    font-size: 0.8rem;
  }
  .safety-banner div > span {
    display: block;
    font-size: 0.71rem;
    margin-top: 0.15rem;
    opacity: 0.72;
  }
  .sandbox-tag {
    margin-left: auto;
    font-size: 0.55rem;
    font-weight: 800;
    letter-spacing: 0.1em;
    opacity: 0.7;
    white-space: nowrap;
  }
  .subset-notice {
    margin: 0.45rem 1.25rem 0;
    font-size: 0.65rem;
    line-height: 1.45;
    opacity: 0.7;
  }
  .test-controls {
    display: flex;
    align-items: end;
    gap: 0.5rem;
    padding: 0.8rem 1.25rem 0.55rem;
  }
  .command-selector {
    flex: 1;
    max-width: 440px;
    min-width: 0;
  }
  .command-selector > span {
    display: block;
    font-size: 0.68rem;
    font-weight: 650;
    margin-bottom: 0.3rem;
    opacity: 0.7;
  }
  .command-count {
    font-size: 0.65rem;
    opacity: 0.55;
    padding-bottom: 0.55rem;
    margin-left: auto;
    white-space: nowrap;
  }
  .scope-details {
    margin: 0 1.25rem 0.65rem;
    font-size: 0.72rem;
  }
  summary {
    cursor: pointer;
    font-weight: 600;
    padding: 0.3rem 0;
  }
  .scope-details > summary {
    opacity: 0.7;
  }
  .scope-content {
    padding: 0.7rem 0.85rem;
    background: var(--color-base-200);
    border: 1px solid var(--color-base-300);
    border-radius: 0.6rem;
    margin-top: 0.3rem;
  }
  .scope-content > p {
    line-height: 1.55;
    margin-bottom: 0.5rem;
  }
  .context-fields {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.7rem;
    padding-top: 0.5rem;
  }
  .context-fields legend {
    font-weight: 700;
    padding-top: 0.5rem;
  }
  .context-fields label {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    min-width: 0;
    font-size: 0.7rem;
  }
  .context-fields input:not([type='checkbox']),
  .context-fields textarea {
    width: 100%;
  }
  .context-fields .checkbox-field {
    flex-direction: row;
    align-items: center;
    gap: 0.5rem;
  }
  .state-field {
    grid-column: 1 / -1;
  }
  .state-field textarea {
    font-family: monospace;
  }
  .state-field > span {
    opacity: 0.6;
    font-size: 0.65rem;
  }
  .compact-alert {
    margin: 0 1.25rem 0.75rem;
    width: auto;
    padding: 0.7rem 0.9rem;
    font-size: 0.75rem;
  }
  .loading-notice {
    padding: 0.2rem 1.25rem 0.7rem;
    font-size: 0.75rem;
    opacity: 0.65;
  }
  .server-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 185px;
    flex: 1;
    min-height: 350px;
    border-top: 1px solid var(--color-base-300);
  }
  .channel {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .channel-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.65rem 1.1rem;
    border-bottom: 1px solid var(--color-base-300);
    min-width: 0;
  }
  .channel-hash {
    font-size: 1.6rem;
    line-height: 1;
    opacity: 0.5;
    font-weight: 500;
  }
  .channel-header > strong {
    font-size: 0.9rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .channel-description {
    font-size: 0.65rem;
    opacity: 0.5;
    border-left: 1px solid var(--color-base-300);
    padding-left: 0.6rem;
    margin-left: 0.25rem;
    white-space: nowrap;
  }
  .conversation {
    flex: 1;
    min-height: 200px;
    overflow-y: auto;
    padding: 0.8rem 0;
  }
  .welcome {
    padding: 1.1rem 1.35rem 1.5rem;
  }
  .welcome-icon {
    display: grid;
    place-items: center;
    background: var(--color-base-200);
    border-radius: 50%;
    width: 3.2rem;
    height: 3.2rem;
    font-size: 2rem;
    opacity: 0.8;
    margin-bottom: 0.85rem;
  }
  .welcome h2 {
    font-size: 1.2rem;
    line-height: 1.4;
    font-weight: 750;
    overflow-wrap: anywhere;
  }
  .welcome > p {
    font-size: 0.79rem;
    opacity: 0.65;
    line-height: 1.55;
    margin-top: 0.45rem;
    max-width: 430px;
  }
  .welcome-note {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    margin-top: 1rem;
    font-size: 0.68rem;
    color: var(--color-primary);
  }
  .message-row {
    display: flex;
    align-items: flex-start;
    gap: 0.65rem;
    padding: 0.6rem 1.1rem;
  }
  .avatar-circle {
    flex-shrink: 0;
    display: grid;
    place-items: center;
    border-radius: 50%;
    width: 2.1rem;
    height: 2.1rem;
    font-size: 0.8rem;
    font-weight: 700;
  }
  .user-avatar,
  .member-avatar {
    background: color-mix(in srgb, var(--color-primary) 20%, var(--color-base-200));
    color: var(--color-base-content);
  }
  .bot-avatar {
    background: #5865f2;
    color: white;
    border-radius: 0.65rem;
  }
  .bot-avatar .material-symbols-outlined {
    font-size: 1.2rem;
  }
  .message-body {
    min-width: 0;
    flex: 1;
  }
  .message-heading {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    flex-wrap: wrap;
    line-height: 1.4;
  }
  .message-heading strong {
    font-size: 0.8rem;
  }
  .identity-tag {
    font-size: 0.48rem;
    padding: 0.05rem 0.22rem;
    border-radius: 0.2rem;
    background: var(--color-base-300);
    font-weight: 700;
    letter-spacing: 0.035em;
  }
  .bot-tag {
    background: #5865f2;
    color: white;
  }
  time {
    font-size: 0.58rem;
    opacity: 0.45;
  }
  .message-content {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 0.82rem;
    line-height: 1.55;
    margin-top: 0.15rem;
  }
  .destination {
    font-size: 0.63rem;
    opacity: 0.55;
    margin: 0.1rem 0 0.2rem;
    overflow-wrap: anywhere;
  }
  .ephemeral-tag {
    display: inline-block;
    margin-top: 0.15rem;
    font-size: 0.5rem;
    font-weight: 750;
    opacity: 0.55;
  }
  .fake-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin-top: 0.45rem;
  }
  .embed-card {
    border-left: 3px solid;
    border-radius: 0.3rem;
    background: var(--color-base-200);
    padding: 0.75rem;
    margin-top: 0.4rem;
    max-width: 440px;
  }
  .embed-title {
    font-size: 0.86rem;
    overflow-wrap: anywhere;
    display: block;
  }
  .media-placeholder {
    margin-top: 0.55rem;
    padding: 0.5rem;
    border: 1px dashed color-mix(in srgb, var(--color-base-content) 22%, transparent);
    border-radius: 0.2rem;
    font-size: 0.68rem;
    opacity: 0.7;
    overflow-wrap: anywhere;
  }
  .embed-footer {
    font-size: 0.65rem;
    margin-top: 0.6rem;
    opacity: 0.7;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .turn-summary {
    margin: 0.15rem 1.1rem 0.65rem 3.85rem;
  }
  .no-output {
    font-size: 0.71rem;
    opacity: 0.6;
    margin-bottom: 0.3rem;
  }
  .action-line {
    display: flex;
    gap: 0.3rem;
    align-items: flex-start;
    font-size: 0.69rem;
    line-height: 1.5;
    opacity: 0.8;
    margin: 0.2rem 0;
    overflow-wrap: anywhere;
  }
  .action-line .material-symbols-outlined {
    font-size: 0.85rem;
    color: var(--color-primary);
    margin-top: 0.1rem;
  }
  .trace-details {
    font-size: 0.67rem;
  }
  .trace-details > summary {
    opacity: 0.6;
  }
  .trace-content {
    border: 1px solid var(--color-base-300);
    border-radius: 0.4rem;
    background: var(--color-base-200);
    padding: 0.65rem;
    margin-top: 0.25rem;
  }
  .trace-command + .trace-command {
    border-top: 1px solid var(--color-base-300);
    padding-top: 0.65rem;
    margin-top: 0.65rem;
  }
  .trace-heading {
    display: flex;
    gap: 0.4rem;
    justify-content: space-between;
    align-items: flex-start;
    overflow-wrap: anywhere;
  }
  .trace-status {
    border-radius: 0.2rem;
    background: var(--color-base-300);
    padding: 0.07rem 0.3rem;
    font-size: 0.6rem;
  }
  .trace-status.unsupported {
    color: var(--color-warning);
  }
  .trace-content h3 {
    font-size: 0.64rem;
    opacity: 0.65;
    font-weight: 700;
    margin-top: 0.6rem;
    margin-bottom: 0.2rem;
  }
  .trace-content ul {
    padding-left: 1rem;
    list-style: disc;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
  .issue-title {
    color: var(--color-warning);
  }
  .state-snapshots {
    margin-top: 0.7rem;
    border-top: 1px solid var(--color-base-300);
    padding-top: 0.3rem;
  }
  .state-snapshots pre {
    max-height: 180px;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 0.66rem;
    padding: 0.45rem;
    background: var(--color-base-100);
    border-radius: 0.3rem;
  }
  .run-error {
    font-size: 0.72rem;
    color: var(--color-error);
    padding: 0.4rem 0.7rem;
    overflow-wrap: anywhere;
  }
  .conversation > .run-error {
    margin: 0.2rem 1rem 0.8rem 3rem;
  }
  .typing-indicator {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    font-size: 0.7rem;
    opacity: 0.6;
    margin: 0.5rem 1rem 0.5rem 3.8rem;
  }
  .composer {
    padding: 0.7rem 1rem 0.6rem;
    border-top: 1px solid var(--color-base-300);
  }
  .composer-topline {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    margin-bottom: 0.45rem;
  }
  .composer-topline label {
    font-size: 0.65rem;
    opacity: 0.6;
  }
  .composer-topline .select {
    width: auto;
    max-width: 150px;
    font-size: 0.68rem;
  }
  .composer-topline > span {
    margin-left: auto;
    font-size: 0.54rem;
    opacity: 0.5;
  }
  .composer-input {
    display: flex;
    align-items: flex-end;
    gap: 0.5rem;
    background: var(--color-base-200);
    border: 1px solid var(--color-base-300);
    border-radius: 0.65rem;
    padding: 0.6rem;
  }
  .composer-input:focus-within {
    border-color: var(--color-primary);
  }
  .composer-input textarea {
    resize: vertical;
    flex: 1;
    width: 0;
    min-height: 2.5rem;
    max-height: 140px;
    outline: none;
    border: none;
    background: transparent;
    font-size: 0.8rem;
    line-height: 1.5;
  }
  .composer-input textarea:disabled {
    opacity: 0.5;
  }
  .interaction-options {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.55rem;
    padding: 0.7rem;
    border: 1px solid var(--color-base-300);
    border-radius: 0.65rem;
    background: var(--color-base-200);
  }
  .interaction-heading,
  .option-empty {
    grid-column: 1 / -1;
  }
  .interaction-heading strong,
  .interaction-heading span {
    display: block;
  }
  .interaction-heading strong {
    font-size: 0.8rem;
  }
  .interaction-heading span,
  .option-empty {
    font-size: 0.65rem;
    opacity: 0.6;
  }
  .interaction-options label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
    font-size: 0.62rem;
  }
  .interaction-run {
    margin-top: 0.5rem;
  }
  .composer-footnote {
    font-size: 0.56rem;
    opacity: 0.45;
    margin-top: 0.4rem;
  }
  .member-sidebar {
    background: var(--color-base-200);
    border-left: 1px solid var(--color-base-300);
    padding: 1rem 0.75rem;
    overflow-y: auto;
    min-width: 0;
  }
  .members-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.3rem;
  }
  .members-heading h2 {
    font-size: 0.59rem;
    font-weight: 800;
    letter-spacing: 0.055em;
    opacity: 0.65;
  }
  .members-heading > span {
    font-size: 0.54rem;
    opacity: 0.5;
  }
  .members-help {
    font-size: 0.57rem;
    margin-top: 0.35rem;
    opacity: 0.5;
  }
  .member-list {
    margin-top: 0.8rem;
  }
  .member {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    border-radius: 0.45rem;
    padding: 0.4rem 0.25rem;
    width: 100%;
    text-align: left;
    cursor: pointer;
  }
  .member:hover:enabled {
    background: var(--color-base-300);
  }
  .member:focus-visible {
    outline: 2px solid var(--color-primary);
  }
  .member.removed {
    opacity: 0.4;
    cursor: default;
  }
  .member-avatar {
    position: relative;
    width: 1.95rem;
    height: 1.95rem;
    font-size: 0.74rem;
  }
  .presence {
    position: absolute;
    right: -1px;
    bottom: 0;
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: var(--color-success);
    border: 2px solid var(--color-base-200);
  }
  .presence.offline {
    background: color-mix(in srgb, var(--color-base-content) 35%, var(--color-base-200));
  }
  .member-info {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .member-info strong {
    font-size: 0.73rem;
    line-height: 1.5;
  }
  .member-info > span {
    font-size: 0.59rem;
    opacity: 0.55;
    text-transform: capitalize;
  }
  .admin-mark {
    color: var(--color-warning);
    margin-left: 0.3rem;
    font-size: 0.85rem;
  }
  .member-roles {
    display: flex;
    flex-wrap: wrap;
    gap: 0.2rem;
    padding-left: 2.8rem;
    margin-bottom: 0.65rem;
  }
  .role-chip {
    font-size: 0.51rem;
    padding: 0.12rem 0.3rem;
    background: var(--color-base-300);
    border-radius: 0.25rem;
    overflow-wrap: anywhere;
  }
  .no-roles {
    font-size: 0.53rem;
    opacity: 0.35;
  }
  .member-sidebar-note {
    display: flex;
    gap: 0.3rem;
    border-top: 1px solid var(--color-base-300);
    padding-top: 0.8rem;
    margin-top: 1.1rem;
    opacity: 0.5;
  }
  .member-sidebar-note > span {
    font-size: 0.9rem;
  }
  .member-sidebar-note p {
    font-size: 0.59rem;
    line-height: 1.6;
  }
  @media (max-width: 1050px) {
    .sandbox-tag,
    .command-count,
    .composer-topline > span {
      display: none;
    }
    .server-layout {
      grid-template-columns: minmax(0, 1fr) 150px;
    }
    .member-sidebar {
      padding-left: 0.5rem;
      padding-right: 0.5rem;
    }
    .members-heading {
      flex-wrap: wrap;
    }
  }
  @media (max-width: 760px) {
    .playground-header {
      padding: 0.8rem;
    }
    .safety-banner {
      margin-inline: 0.8rem;
    }
    .test-controls {
      padding-inline: 0.8rem;
    }
    .scope-details {
      margin-inline: 0.8rem;
    }
    .server-layout {
      grid-template-columns: minmax(0, 1fr);
    }
    .member-sidebar {
      border-left: 0;
      border-top: 1px solid var(--color-base-300);
      overflow: visible;
    }
    .member-list {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    .member {
      width: auto;
    }
    .member-roles {
      padding: 0;
      align-items: center;
      margin: 0;
      max-width: 100px;
    }
    .member-sidebar-note {
      margin-top: 0.6rem;
      padding-top: 0.5rem;
    }
    .channel-description {
      display: none;
    }
    .context-fields {
      grid-template-columns: minmax(0, 1fr);
    }
    .conversation {
      min-height: 230px;
      max-height: 55vh;
    }
  }
</style>
