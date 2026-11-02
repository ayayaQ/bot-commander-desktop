// Fake in-memory host only. This fixture never contacts Electron, providers or real storage.
import { mount, tick } from 'svelte'
import { get } from 'svelte/store'
import Settings from '../../src/renderer/src/components/Settings.svelte'
import {
  settingsStore,
  settingsDraftStore,
  settingsSaveStatus,
  loadSettings,
  patchSettings
} from '../../src/renderer/src/stores/settings'
import '../../src/renderer/app.css'

const clone = (value) => structuredClone(value)
const keys = { openai: 'fake-saved-openai', openrouter: 'fake-saved-openrouter' }
let host = {
  ...get(settingsStore),
  agentReviewerProvider: 'openai',
  agentDecisionAccountRevision: 'fake-reviewer-1',
  openaiKeyConfigured: true,
  openrouterKeyConfigured: true,
  openaiAccountRevision: 'fake-openai-1',
  openrouterAccountRevision: 'fake-openrouter-1',
  deepseekChatAccountRevision: 'fake-chat-1',
  agentWebAccountRevision: 'fake-web-1'
}
let serial = 1
let nextCredentialResult = 'success'
let releaseCredential
const calls = [] // Channel names only: request values are deliberately never logged.
const listeners = new Map()
let queue = Promise.resolve()
function mutate(operation) {
  const next = queue.catch(() => {}).then(operation)
  queue = next
  return next
}
function rotate(provider) {
  host[`${provider}AccountRevision`] = `fake-${provider}-${++serial}`
  if (host.agentReviewerProvider === provider)
    host.agentDecisionAccountRevision = `fake-reviewer-${serial}`
}
window.electron = {
  ipcRenderer: {
    on(channel, listener) {
      const group = listeners.get(channel) || new Set()
      group.add(listener)
      listeners.set(channel, group)
    },
    removeListener(channel, listener) {
      listeners.get(channel)?.delete(listener)
    },
    send() {
      throw new Error('Unexpected fixture send')
    },
    async invoke(channel, ...args) {
      calls.push(channel)
      if (channel === 'get-settings') return clone(host)
      if (channel === 'save-settings')
        return mutate(async () => {
          const safe = clone(args[0])
          for (const field of [
            'openaiApiKey',
            'openrouterApiKey',
            'deepseekApiKey',
            'deepseekWebApiKey'
          ])
            delete safe[field]
          for (const field of [
            'openaiKeyConfigured',
            'openrouterKeyConfigured',
            'openaiAccountRevision',
            'openrouterAccountRevision',
            'agentDecisionAccountRevision'
          ])
            safe[field] = host[field]
          const previousReviewer = host.agentReviewerProvider
          host = safe
          if (host.agentReviewerProvider !== previousReviewer)
            host.agentDecisionAccountRevision = `fake-reviewer-${++serial}`
          return clone(host)
        })
      if (channel === 'save-provider-key') {
        const request = clone(args[0])
        return mutate(async () => {
          const outcome = nextCredentialResult
          nextCredentialResult = 'success'
          if (outcome === 'delayed')
            await new Promise((resolve) => {
              releaseCredential = resolve
            })
          if (outcome === 'stale') {
            keys[request.provider] = 'fake-external-replacement'
            rotate(request.provider)
          }
          if (request.expectedRevision !== host[`${request.provider}AccountRevision`])
            throw new Error('Provider account changed')
          if (outcome === 'failure') throw new Error('Fake storage unavailable')
          keys[request.provider] = request.action === 'remove' ? '' : request.value
          host[`${request.provider}KeyConfigured`] = Boolean(keys[request.provider])
          rotate(request.provider)
          return clone(host)
        })
      }
      if (channel === 'fetch-ai-models') return []
      if (channel === 'get-ai-model-capabilities') return {}
      if (channel === 'memory:list')
        return {
          memories: [],
          limits: {
            maximumMemories: 100,
            maximumMemoryCharacters: 1000,
            maximumTotalCharacters: 20000
          }
        }
      if (channel === 'agent-mcp:list')
        return { revision: 'fake-mcp-1', servers: [], environmentNames: [], paused: false }
      if (channel === 'mcp:get-status')
        return {
          enabled: false,
          accessMode: 'read-only',
          port: 43721,
          running: false,
          endpoint: 'http://127.0.0.1:43721/mcp',
          tokenConfigured: false,
          secureStorageAvailable: false,
          activeRequests: 0
        }
      if (channel === 'mcp:get-activity') return []
      throw new Error(`Unexpected fixture invoke: ${channel}`)
    }
  }
}

await loadSettings()
mount(Settings, { target: document.getElementById('app') })
await tick()

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
async function wait(predicate) {
  const until = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > until) throw new Error('Fixture UI did not settle')
    await new Promise((resolve) => setTimeout(resolve, 10))
    await tick()
  }
}
function input(provider) {
  return document.getElementById(`${provider}-key`)
}
function card(provider) {
  return input(provider).closest('.form-control')
}
function button(provider, label) {
  return [...card(provider).querySelectorAll('button')].find(
    (item) => item.textContent.trim() === label
  )
}
async function type(provider, value) {
  input(provider).value = value
  input(provider).dispatchEvent(new Event('input', { bubbles: true }))
  await tick()
}
async function click(provider, label) {
  const control = button(provider, label)
  assert(!control.disabled, `${label} unexpectedly disabled`)
  control.click()
  await tick()
}
function cleanSnapshots() {
  for (const store of [settingsStore, settingsDraftStore]) {
    const snapshot = JSON.stringify(get(store))
    assert(
      !/ApiKey|fake-saved-|fake-entered-|fake-external-/.test(snapshot),
      'Credential leaked into renderer settings'
    )
  }
  assert(
    !document.body.textContent.includes('fake-entered-'),
    'Transient credential displayed as text'
  )
}

window.__settingsCredentialFixture = {
  ready: true,
  async run() {
    const flows = []
    cleanSnapshots()
    for (const provider of ['openai', 'openrouter']) {
      const providerSelect = [...document.querySelectorAll('select')].find((select) =>
        ['openai', 'openrouter', 'deepseek'].every((value) =>
          [...select.options].some((option) => option.value === value)
        )
      )
      assert(providerSelect, 'Chat provider select missing')
      providerSelect.value = provider
      providerSelect.dispatchEvent(new Event('change', { bubbles: true }))
      await wait(
        () =>
          host.aiProvider === provider &&
          !get(settingsSaveStatus).saving &&
          !get(settingsSaveStatus).unsaved
      )
      await tick()
      assert(input(provider).value === '', 'Saved key returned to input')
      assert(input(provider).type === 'password', 'New input must remain masked')
      assert(card(provider).textContent.includes('Key configured'), 'Configured indicator missing')
      const saved = keys[provider]
      await patchSettings({ theme: 'dark' })
      assert(keys[provider] === saved, 'Unrelated save changed a key')
      flows.push(`${provider}: blank unchanged input preserves saved key`)

      const before = calls.filter((channel) => channel === 'save-provider-key').length
      await type(provider, 'fake-entered-cancel')
      await click(provider, 'Cancel')
      assert(
        input(provider).value === '' && keys[provider] === saved,
        'Cancel changed host credential'
      )
      assert(
        calls.filter((channel) => channel === 'save-provider-key').length === before,
        'Cancel sent credential IPC'
      )
      flows.push(`${provider}: cancel clears transient input without IPC`)

      const revision = host[`${provider}AccountRevision`]
      await type(provider, 'fake-entered-replacement')
      await click(provider, 'Replace key')
      await wait(() => keys[provider] === 'fake-entered-replacement' && !input(provider).disabled)
      assert(input(provider).value === '', 'Success retained transient input')
      assert(
        host[`${provider}AccountRevision`] !== revision,
        'Replacement failed to rotate revision'
      )
      cleanSnapshots()
      flows.push(`${provider}: explicit replacement and revision refresh`)

      // The actual ModelPicker refresh button must remain usable after account replacement.
      const modelLabel = [...document.querySelectorAll('label')].find(
        (label) => label.textContent.trim() === 'Model'
      )
      const picker = modelLabel?.closest('.form-control')?.querySelector('button')
      assert(picker, 'Model picker missing')
      picker.click()
      await tick()
      const refresh = [...document.querySelectorAll('button')].find((item) =>
        item.textContent.trim().endsWith('Refresh')
      )
      assert(refresh && !refresh.disabled, 'Model refresh unavailable')
      const catalogs = calls.filter((channel) => channel === 'fetch-ai-models').length
      refresh.click()
      await wait(() => calls.filter((channel) => channel === 'fetch-ai-models').length > catalogs)
      // Close via the picker dialog's close control before continuing credential input.
      const close = [...document.querySelectorAll('.modal.modal-open button')].find(
        (item) => item.textContent.trim() === 'close'
      )
      assert(close, 'Model picker close control missing')
      close.click()
      await tick()
      flows.push(`${provider}: model refresh still invokes host catalog`)

      nextCredentialResult = 'delayed'
      await type(provider, 'fake-entered-delayed')
      await click(provider, 'Replace key')
      await wait(() => !!releaseCredential)
      assert(
        button(provider, 'Remove key').disabled && button(provider, 'Cancel').disabled,
        'Busy credential actions remained enabled'
      )
      const ordinary = patchSettings({
        developerPrompt: 'fake ordinary draft during credential save'
      })
      releaseCredential()
      releaseCredential = undefined
      await ordinary
      await wait(() => keys[provider] === 'fake-entered-delayed' && !input(provider).disabled)
      assert(
        host.developerPrompt === 'fake ordinary draft during credential save',
        'Credential load erased ordinary draft'
      )
      cleanSnapshots()
      flows.push(`${provider}: busy actions blocked and concurrent ordinary save preserved`)

      nextCredentialResult = 'failure'
      const active = keys[provider]
      const activeRevision = host[`${provider}AccountRevision`]
      await type(provider, 'fake-entered-failure')
      await click(provider, 'Replace key')
      await wait(() => !!card(provider).querySelector('[role="alert"]'))
      assert(
        keys[provider] === active && host[`${provider}AccountRevision`] === activeRevision,
        'Failed write changed active credential'
      )
      assert(input(provider).value === '', 'Failure retained transient input')
      cleanSnapshots()
      flows.push(`${provider}: failed persistence preserves active state`)

      nextCredentialResult = 'stale'
      await type(provider, 'fake-entered-stale')
      await click(provider, 'Replace key')
      await wait(() => !!card(provider).querySelector('[role="alert"]'))
      assert(keys[provider] === 'fake-external-replacement', 'Stale save overwrote external change')
      await loadSettings()
      await tick()
      assert(input(provider).value === '', 'Revision change retained transient input')
      cleanSnapshots()
      flows.push(`${provider}: stale write rejected and external revision adopted`)

      await click(provider, 'Remove key')
      await wait(() => !get(settingsStore)[`${provider}KeyConfigured`] && !input(provider).disabled)
      assert(keys[provider] === '', 'Explicit removal failed')
      assert(
        card(provider).textContent.includes('No key configured'),
        'Removal indicator incorrect'
      )
      flows.push(`${provider}: explicit removal updates configured indicator`)
    }
    // Use the real reviewer select and ensure ordinary settings saves remain usable.
    const reviewer = document.getElementById('agent-reviewer-provider')
    reviewer.value = 'openrouter'
    reviewer.dispatchEvent(new Event('change', { bubbles: true }))
    await wait(() => host.agentReviewerProvider === 'openrouter' && !get(settingsSaveStatus).saving)
    assert(
      get(settingsStore).agentReviewerProvider === 'openrouter',
      'Reviewer selection did not persist'
    )
    flows.push('reviewer selection persists with credential-free public settings')
    cleanSnapshots()
    return { passed: true, flows, browserExecuted: true, fakeStorageOnly: true }
  }
}
