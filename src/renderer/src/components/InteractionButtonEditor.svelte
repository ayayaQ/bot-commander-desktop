<script lang="ts">
  import type { BCFDInteractionButton } from '../types/types'
  import { t } from '../stores/localisation'
  import InteractionActionEditor from './InteractionActionEditor.svelte'

  export let button: BCFDInteractionButton
  export let onDelete: () => void

  let isExpanded = false

  const buttonStyles = [
    { value: 1, label: 'Primary', class: 'btn-primary' },
    { value: 2, label: 'Secondary', class: 'btn-neutral' },
    { value: 3, label: 'Success', class: 'btn-success' },
    { value: 4, label: 'Danger', class: 'btn-error' },
    { value: 5, label: 'Link', class: 'btn-info' }
  ]

  function getButtonStyleClass(style: number): string {
    return buttonStyles.find((s) => s.value === style)?.class || 'btn-neutral'
  }
</script>

<div class="card bg-base-200 overflow-hidden">
  <!-- Button Header (always visible) -->
  <button
    class="w-full p-4 flex items-center justify-between hover:bg-base-300 transition-colors"
    on:click={() => (isExpanded = !isExpanded)}
    type="button"
  >
    <div class="flex items-center gap-3">
      <span class="material-symbols-outlined text-base-content/70">
        {isExpanded ? 'expand_less' : 'expand_more'}
      </span>
      <span class="btn btn-sm {getButtonStyleClass(button.style)} pointer-events-none">
        {button.label || 'Button'}
      </span>
      {#if button.disabled}
        <span class="badge badge-warning badge-sm">{$t('disabled')}</span>
      {/if}
    </div>
    <button
      class="btn btn-sm btn-ghost text-error"
      on:click|stopPropagation={onDelete}
      type="button"
    >
      <span class="material-symbols-outlined">delete</span>
    </button>
  </button>

  <!-- Button Details (expandable) -->
  {#if isExpanded}
    <div class="p-4 pt-0 border-t border-base-300">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <!-- Label -->
        <div class="form-control">
          <label class="label">
            <span class="label-text">{$t('button-label')}</span>
          </label>
          <input
            type="text"
            class="input input-bordered input-sm"
            bind:value={button.label}
            placeholder="Click me"
          />
        </div>

        <!-- Style -->
        <div class="form-control">
          <label class="label">
            <span class="label-text">{$t('button-style')}</span>
          </label>
          <select class="select select-bordered select-sm" bind:value={button.style}>
            {#each buttonStyles as style}
              <option value={style.value}>{$t('style-' + style.label.toLowerCase())}</option>
            {/each}
          </select>
        </div>

        <!-- Custom ID -->
        <div class="form-control">
          <label class="label">
            <span class="label-text">{$t('button-custom-id')}</span>
          </label>
          <input
            type="text"
            class="input input-bordered input-sm"
            bind:value={button.customId}
            placeholder="unique-button-id"
          />
        </div>

        <!-- Emoji -->
        <div class="form-control">
          <label class="label">
            <span class="label-text">{$t('button-emoji')}</span>
          </label>
          <input
            type="text"
            class="input input-bordered input-sm"
            bind:value={button.emoji}
            placeholder="Optional emoji"
          />
        </div>

        <!-- URL (only for Link style) -->
        {#if button.style === 5}
          <div class="form-control md:col-span-2">
            <label class="label">
              <span class="label-text">{$t('button-url')}</span>
            </label>
            <input
              type="text"
              class="input input-bordered input-sm"
              bind:value={button.url}
              placeholder="https://example.com"
            />
          </div>
        {/if}

        <!-- Disabled toggle -->
        <div class="form-control md:col-span-2">
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" class="checkbox checkbox-sm" bind:checked={button.disabled} />
            <span class="label-text">{$t('button-disabled')}</span>
          </label>
        </div>
      </div>

      <!-- Button Action (not needed for Link style) -->
      {#if button.style !== 5}
        <div class="divider">{$t('button-action')}</div>
        <InteractionActionEditor action={button.action} showEphemeral={true} showDefer={true} />
      {/if}
    </div>
  {/if}
</div>
