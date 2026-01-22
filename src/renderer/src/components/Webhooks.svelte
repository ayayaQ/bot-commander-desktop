<script lang="ts">
  import { onMount } from 'svelte'
  import { t } from '../stores/localisation'
  import {
    sendWebhook,
    webhookPresetsStore,
    loadWebhookPresets,
    saveWebhookPresets
  } from '../stores/webhooks'
  import type { WebhookPreset } from '../types/types'
  import HeaderBar from './HeaderBar.svelte'
  import Dialog from './Dialog.svelte'

  let webhookUrl = $state('')
  let name = $state('')
  let avatarUrl = $state('')
  let messageType: 'message' | 'embed' = $state('message')
  let message = $state('')
  let embedTitle = $state('')
  let embedDescription = $state('')
  let embedColor = $state('#5865F2')
  let embedFooter = $state('')
  let embedImageUrl = $state('')
  let embedThumbnailUrl = $state('')
  let presetAlias = $state('')
  let selectedPresetId: string | null = $state(null)

  let webhookUrlError = $state('')
  let presetAliasError = $state('')
  let presetToDelete: WebhookPreset | null = $state(null)

  let savePresetDialog: HTMLDialogElement = $state()
  let deleteConfirmDialog: HTMLDialogElement = $state()

  const webhookUrlRegex = /^https:\/\/discord\.com\/api\/webhooks\/\d+\/[\w-]+$/

  onMount(() => {
    loadWebhookPresets()
  })

  function send() {
    if (!webhookUrlRegex.test(webhookUrl)) {
      webhookUrlError = 'Invalid webhook URL format'
      return
    }
    webhookUrlError = ''

    // use ipc renderer to send webhook to main process
    sendWebhook(
      webhookUrl,
      name,
      avatarUrl,
      messageType,
      message,
      embedTitle,
      embedDescription,
      embedColor,
      embedFooter,
      embedImageUrl,
      embedThumbnailUrl
    )
  }

  function openSavePresetDialog() {
    if (!webhookUrlRegex.test(webhookUrl)) {
      webhookUrlError = 'Invalid webhook URL format'
      return
    }
    webhookUrlError = ''
    presetAlias = ''
    presetAliasError = ''
    savePresetDialog.showModal()
  }

  async function savePreset() {
    if (!presetAlias.trim()) {
      presetAliasError = 'Please enter an alias for the preset'
      return
    }
    presetAliasError = ''

    const newPreset: WebhookPreset = {
      id: crypto.randomUUID(),
      alias: presetAlias,
      webhookUrl,
      name,
      avatarUrl,
      messageType,
      message,
      embedTitle,
      embedDescription,
      embedColor,
      embedFooter,
      embedImageUrl,
      embedThumbnailUrl
    }

    const updatedPresets = [...$webhookPresetsStore, newPreset]
    await saveWebhookPresets(updatedPresets)
    savePresetDialog.close()
    selectedPresetId = newPreset.id
  }

  function loadPreset(preset: WebhookPreset) {
    webhookUrl = preset.webhookUrl
    name = preset.name
    avatarUrl = preset.avatarUrl
    messageType = preset.messageType || 'message'
    message = preset.message
    embedTitle = preset.embedTitle || ''
    embedDescription = preset.embedDescription || ''
    embedColor = preset.embedColor || '#5865F2'
    embedFooter = preset.embedFooter || ''
    embedImageUrl = preset.embedImageUrl || ''
    embedThumbnailUrl = preset.embedThumbnailUrl || ''
    selectedPresetId = preset.id
  }

  function openDeleteConfirmDialog(preset: WebhookPreset) {
    presetToDelete = preset
    deleteConfirmDialog.showModal()
  }

  async function confirmDeletePreset() {
    if (!presetToDelete) return

    const updatedPresets = $webhookPresetsStore.filter((p) => p.id !== presetToDelete.id)
    await saveWebhookPresets(updatedPresets)

    if (selectedPresetId === presetToDelete.id) {
      selectedPresetId = null
    }

    deleteConfirmDialog.close()
    presetToDelete = null
  }
</script>

<HeaderBar>
  <h2 class="text-2xl font-bold">{$t('send-webhook')}</h2>
  <div class="flex gap-2">
    <button onclick={openSavePresetDialog} class="btn btn-primary">
      <span class="material-symbols-outlined">save</span>
      Save Preset
    </button>
  </div>
</HeaderBar>

<div class="flex h-full">
  <!-- Main Content Area -->
  <div class="flex-1 p-4 overflow-y-auto">
    <div class="p-4 bg-base-200 rounded-lg shadow-lg max-w-2xl mx-auto">
      <form onsubmit={(e) => { e.preventDefault(); send() }} class="space-y-4">
        <div class="form-control">
          <label for="webhookUrl" class="label">
            <span class="label-text">{$t('webhook-url')}</span>
          </label>
          <input
            type="text"
            id="webhookUrl"
            bind:value={webhookUrl}
            oninput={() => (webhookUrlError = '')}
            class="input w-full {webhookUrlError ? 'border-error' : ''}"
            placeholder="https://discord.com/api/webhooks/..."
            required
          />
          {#if webhookUrlError}
            <!-- svelte-ignore a11y_label_has_associated_control -->
            <label class="label">
              <span class="label-text-alt text-error">{webhookUrlError}</span>
            </label>
          {/if}
        </div>

        <div class="form-control">
          <label for="name" class="label">
            <span class="label-text">{$t('name')}</span>
          </label>
          <input
            type="text"
            id="name"
            bind:value={name}
            class="input w-full"
            placeholder={$t('bot')}
          />
        </div>

        <div class="form-control">
          <label for="avatarUrl" class="label">
            <span class="label-text">{$t('avatar')}</span>
          </label>
          <input
            type="url"
            id="avatarUrl"
            bind:value={avatarUrl}
            class="input w-full"
            placeholder="https://example.com/avatar.png"
          />
        </div>

        <div class="form-control">
          <!-- svelte-ignore a11y_label_has_associated_control -->
          <label class="label">
            <span class="label-text">Message Type</span>
          </label>
          <div class="flex gap-4">
            <label class="label cursor-pointer gap-2">
              <input
                type="radio"
                name="messageType"
                value="message"
                bind:group={messageType}
                class="radio radio-primary"
              />
              <span class="label-text">Regular Message</span>
            </label>
            <label class="label cursor-pointer gap-2">
              <input
                type="radio"
                name="messageType"
                value="embed"
                bind:group={messageType}
                class="radio radio-primary"
              />
              <span class="label-text">Embed</span>
            </label>
          </div>
        </div>

        {#if messageType === 'message'}
          <div class="form-control">
            <label for="message" class="label">
              <span class="label-text">{$t('message')}</span>
            </label>
            <textarea
              id="message"
              bind:value={message}
              class="textarea h-24 w-full"
              placeholder={$t('message-placeholder')}
              required
            ></textarea>
          </div>
        {:else}
          <div class="form-control">
            <label for="embedTitle" class="label">
              <span class="label-text">Embed Title</span>
            </label>
            <input
              type="text"
              id="embedTitle"
              bind:value={embedTitle}
              class="input w-full"
              placeholder="Embed title"
            />
          </div>

          <div class="form-control">
            <label for="embedDescription" class="label">
              <span class="label-text">Embed Description</span>
            </label>
            <textarea
              id="embedDescription"
              bind:value={embedDescription}
              class="textarea h-24 w-full"
              placeholder="Embed description"
              required
            ></textarea>
          </div>

          <div class="form-control">
            <label for="embedColor" class="label">
              <span class="label-text">Embed Color</span>
            </label>
            <input
              type="color"
              id="embedColor"
              bind:value={embedColor}
              class="input w-full h-12"
            />
          </div>

          <div class="form-control">
            <label for="embedFooter" class="label">
              <span class="label-text">Embed Footer</span>
            </label>
            <input
              type="text"
              id="embedFooter"
              bind:value={embedFooter}
              class="input w-full"
              placeholder="Footer text"
            />
          </div>

          <div class="form-control">
            <label for="embedImageUrl" class="label">
              <span class="label-text">Embed Image URL</span>
            </label>
            <input
              type="url"
              id="embedImageUrl"
              bind:value={embedImageUrl}
              class="input w-full"
              placeholder="https://example.com/image.png"
            />
          </div>

          <div class="form-control">
            <label for="embedThumbnailUrl" class="label">
              <span class="label-text">Embed Thumbnail URL</span>
            </label>
            <input
              type="url"
              id="embedThumbnailUrl"
              bind:value={embedThumbnailUrl}
              class="input w-full"
              placeholder="https://example.com/thumbnail.png"
            />
          </div>
        {/if}

        <button type="submit" class="btn btn-primary w-full"
          ><span class="material-symbols-outlined">send</span>{$t('send')}</button
        >
      </form>
    </div>
  </div>

  <!-- Sidebar for Presets -->
  <div class="w-64 bg-base-300 p-4 overflow-y-auto border-r border-base-content/10">
    <h3 class="text-lg font-bold mb-4">Presets</h3>
    {#if $webhookPresetsStore.length === 0}
      <p class="text-center text-base-content/60 text-sm py-8">No presets saved yet</p>
    {:else}
      <div class="space-y-2">
        {#each $webhookPresetsStore as preset}
          <div
            class="card bg-base-200 shadow-sm cursor-pointer hover:bg-base-100 transition-colors {selectedPresetId ===
            preset.id
              ? 'ring-2 ring-primary'
              : ''}"
            onclick={() => loadPreset(preset)}
            onkeydown={(e) => e.key === 'Enter' && loadPreset(preset)}
            role="button"
            tabindex="0"
          >
            <div class="card-body p-3">
              <div class="flex justify-between items-start">
                <div class="flex-1 min-w-0">
                  <h4 class="font-bold text-sm truncate">{preset.alias}</h4>
                  <p class="text-xs text-base-content/60 truncate">{preset.webhookUrl}</p>
                </div>
                <button
                  onclick={(e) => { e.stopPropagation(); openDeleteConfirmDialog(preset) }}
                  class="btn btn-xs btn-ghost btn-square text-error"
                  title="Delete preset"
                >
                  <span class="material-symbols-outlined text-base">delete</span>
                </button>
              </div>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<!-- Save Preset Dialog -->
<Dialog bind:dialog={savePresetDialog}>
  <h3 class="font-bold text-lg mb-4">Save Webhook Preset</h3>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <form
    onsubmit={(e) => { e.preventDefault(); savePreset() }}
    class="space-y-4"
    onkeydown={(e) => e.key === 'Escape' && savePresetDialog.close()}
  >
    <div class="form-control">
      <label for="presetAlias" class="label">
        <span class="label-text">Preset Alias</span>
      </label>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        type="text"
        id="presetAlias"
        bind:value={presetAlias}
        oninput={() => (presetAliasError = '')}
        class="input w-full {presetAliasError ? 'border-error' : ''}"
        placeholder="My Webhook Preset"
        required
        autofocus
      />
      {#if presetAliasError}
        <!-- svelte-ignore a11y_label_has_associated_control -->
        <label class="label">
          <span class="label-text-alt text-error">{presetAliasError}</span>
        </label>
      {/if}
    </div>
    <div class="modal-action">
      <button type="button" class="btn btn-ghost" onclick={() => savePresetDialog.close()}
        >Cancel</button
      >
      <button type="submit" class="btn btn-primary">Save</button>
    </div>
  </form>
</Dialog>

<!-- Delete Confirmation Dialog -->
<Dialog bind:dialog={deleteConfirmDialog}>
  <h3 class="font-bold text-lg mb-4">Delete Preset</h3>
  <p class="mb-4">Are you sure you want to delete the preset "{presetToDelete?.alias}"?</p>
  <p class="text-sm text-base-content/60 mb-6">This action cannot be undone.</p>
  <div class="modal-action">
    <button type="button" class="btn btn-ghost" onclick={() => deleteConfirmDialog.close()}>
      Cancel
    </button>
    <button type="button" class="btn btn-error" onclick={confirmDeletePreset}>
      <span class="material-symbols-outlined">delete</span>
      Delete
    </button>
  </div>
</Dialog>
