<script lang="ts">
  import { commitWorld, dmChannel } from '../../../shared/playground/world'
  import { onDestroy, onMount } from 'svelte'
  import type { BCFDCommand, BCFDInteractionCommand } from '../../../main/types/types'
  import type { PlaygroundState } from '../../../shared/playground/types'
  import type {
    AgentValidationReport as Report,
    AgentValidationRequest,
    AgentValidationSuite
  } from '../../../shared/agentValidationTypes'
  import { validateAgentValidationSuite } from '../../../shared/playground/agentValidationFixtures'
  import AgentValidationReport from './AgentValidationReport.svelte'
  import type { ValidationReportBinding } from '../utils/agentValidationReport'

  let {
    commands,
    interactions,
    world,
    defaultWrapEval = true,
    replay = null
  }: {
    commands: BCFDCommand[]
    interactions: BCFDInteractionCommand[]
    world: PlaygroundState
    defaultWrapEval?: boolean
    replay?: AgentValidationRequest | null
  } = $props()
  let target = $state('')
  let input = $state('!test')
  let expected = $state('Pong!')
  let draft = $state('')
  let candidateDraft = $state('')
  let reportBinding = $state<ValidationReportBinding | undefined>()
  let reportCandidate = $state<AgentValidationRequest['candidate'] | undefined>()
  let candidateKey = ''
  let report = $state<Report | null>(null)
  let error = $state('')
  let busy = $state(false)
  let worker: Worker | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let generation = 0
  let includeOthers = $state(false)
  let wrapEval = $state(true)
  onMount(() => {
    wrapEval = defaultWrapEval
    if (replay) {
      target = `${replay.candidateKind}:${replay.candidate.id}`
      draft = JSON.stringify(replay.suite, null, 2)
      wrapEval = replay.wrapEvalInIIFE
    }
  })
  const resources = $derived([
    ...commands.map((item) => ({
      key: `command:${item.id}`,
      name: item.command,
      kind: 'command' as const,
      value: item
    })),
    ...interactions.map((item) => ({
      key: `interaction:${item.id}`,
      name: `/${item.commandName}`,
      kind: 'interaction' as const,
      value: item
    }))
  ])
  const selected = $derived(resources.find((item) => item.key === target))

  $effect(() => {
    const next = JSON.stringify(selected?.value)
    if (candidateKey !== next) {
      candidateKey = next
      cancel()
      report = null
      candidateDraft = selected ? JSON.stringify(selected.value, null, 2) : ''
    }
  })

  function cancel() {
    generation++
    clearTimeout(timer)
    worker?.terminate()
    worker = undefined
    busy = false
  }
  onDestroy(cancel)
  function createCase() {
    if (!selected) return
    cancel()
    report = null
    const kinds = ['message', 'dm', 'memberJoin', 'memberLeave', 'memberBan', 'reaction'] as const
    const kind =
      selected.kind === 'interaction' ? 'slash' : kinds[(selected.value as BCFDCommand).type]
    const state = structuredClone($state.snapshot(world))
    if (state.world) commitWorld(state)
    const senderId = state.members.find(
      (member) => !member.bot && !member.kicked && !member.banned
    )?.id
    if (!senderId) {
      error = 'Choose a world with an available fake sender'
      return
    }
    const dm = kind === 'dm' && state.world ? dmChannel(state, senderId) : undefined
    const suite: AgentValidationSuite = {
      version: state.world ? 3 : 2,
      ...(includeOthers
        ? {
            resources: {
              commands: $state.snapshot(commands),
              interactions: $state.snapshot(interactions)
            }
          }
        : {}),
      cases: [
        {
          name: 'Expected response',
          state,
          steps: [
            {
              kind,
              senderId,
              ...(state.world
                ? {
                    context: {
                      guildId: dm ? null : state.guildId || null,
                      channelId: dm?.id ?? state.channelId
                    }
                  }
                : {}),
              ...(kind === 'slash' ? { options: {} } : { content: input }),
              ...(kind === 'reaction'
                ? { messageId: world.messages.at(-1)?.id ?? (state.world ? '1' : 1) }
                : {}),
              assertions: [
                { path: '/outcome', equals: 'executed' },
                { path: '/effects/messages/0/content', equals: expected }
              ]
            }
          ]
        }
      ]
    }
    draft = JSON.stringify(suite, null, 2)
  }
  async function hash(value: unknown) {
    const bytes = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(value))
    )
    return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('')
  }
  async function run() {
    if (!selected) return
    cancel()
    const revision = generation
    busy = true
    report = null
    error = ''
    try {
      const suite = validateAgentValidationSuite(JSON.parse(draft))
      const candidate = JSON.parse(candidateDraft) as AgentValidationRequest['candidate']
      if (candidate.id !== selected.value.id)
        throw new Error('Keep the selected candidate ID when editing this disposable draft')
      reportCandidate = candidate
      const request: AgentValidationRequest = {
        candidateKind: selected.kind,
        candidate,
        suite,
        candidateHash: await hash(candidate),
        fixtureHash: await hash(suite),
        baseRevision: replay?.baseRevision ?? null,
        wrapEvalInIIFE: wrapEval
      }
      if (revision !== generation) return
      reportBinding = {
        candidateHash: request.candidateHash,
        fixtureHash: request.fixtureHash,
        baseRevision: request.baseRevision,
        wrapEvalInIIFE: request.wrapEvalInIIFE
      }
      worker = new Worker(new URL('../utils/playgroundWorker.ts', import.meta.url), {
        type: 'module'
      })
      worker.onmessage = (event) => {
        if (revision !== generation) return
        report = event.data.report ?? null
        error = event.data.error ?? ''
        cancel()
      }
      worker.onerror = () => {
        if (revision === generation) {
          error = 'Validation worker failed'
          cancel()
        }
      }
      timer = setTimeout(() => {
        error = 'Validation exceeded its time limit'
        cancel()
      }, 20000)
      worker.postMessage({ kind: 'validation', request })
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure)
      cancel()
    }
  }
</script>

<details class="border border-base-300 rounded p-3" open={!!replay}>
  <summary class="font-semibold cursor-pointer">Validate a disposable scenario</summary>
  <div class="space-y-3 mt-3">
    <p class="text-xs opacity-70">
      Assertions validate the selected draft. AI calls require exact prompt mocks in aiMocks. These
      tests never save commands.
    </p>
    <label class="block text-sm"
      >Target
      <select
        class="select select-sm w-full"
        bind:value={target}
        onchange={() => {
          report = null
        }}
        disabled={busy}
      >
        <option value="">Choose a command</option>
        {#each resources as resource}<option value={resource.key}>{resource.name}</option>{/each}
      </select>
    </label>
    <details>
      <summary class="text-xs cursor-pointer">Edit the disposable candidate</summary>
      <textarea
        class="textarea w-full font-mono text-xs mt-2"
        rows={8}
        bind:value={candidateDraft}
        disabled={busy}
        maxlength={131072}
        oninput={() => (report = null)}
        aria-label="Disposable candidate JSON"></textarea>
      <p class="text-xs opacity-60">
        Changes here are tested only. They never replace the saved command.
      </p>
    </details>
    <div class="flex gap-2 flex-wrap">
      <label class="text-xs"
        >Input <input class="input input-sm" bind:value={input} disabled={busy} /></label
      >
      <label class="text-xs"
        >Expected reply <input
          class="input input-sm"
          bind:value={expected}
          disabled={busy}
        /></label
      >
    </div>
    <label class="flex gap-2 text-xs"
      ><input type="checkbox" bind:checked={includeOthers} disabled={busy} /> Include the other loaded
      resource snapshots</label
    >
    <label class="flex gap-2 text-xs"
      ><input
        type="checkbox"
        bind:checked={wrapEval}
        disabled={busy}
        onchange={() => (report = null)}
      /> Wrapped eval scope</label
    >
    <button class="btn btn-sm" disabled={!selected || busy} onclick={createCase}
      >Create case from current fake world</button
    >
    <label class="block text-xs"
      >Scenario JSON — edit steps, mocks, and assertions
      <textarea
        class="textarea w-full font-mono text-xs"
        rows={10}
        bind:value={draft}
        maxlength={524288}
        disabled={busy}
        oninput={() => (report = null)}></textarea>
    </label>
    <div class="flex gap-2">
      <button class="btn btn-primary btn-sm" disabled={!selected || !draft || busy} onclick={run}
        >{busy ? 'Validating…' : 'Run strict validation'}</button
      >
      {#if busy}<button class="btn btn-sm" onclick={cancel}>Cancel</button>{/if}
    </div>
    {#if error}<p class="text-error text-sm" role="alert">{error}</p>{/if}
    {#if report}<AgentValidationReport
        {report}
        candidate={reportCandidate}
        binding={reportBinding}
      />{/if}
  </div>
</details>
