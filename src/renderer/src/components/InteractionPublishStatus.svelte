<script lang="ts">
  import {
    interactionPublication,
    publicationRequestPending,
    publicationTransportError
  } from '../stores/interactionPublication'
  import { connectionStore } from '../stores/connection'
  import { t, type TranslationKey } from '../stores/localisation'
  import type { PublicationError } from '../../../shared/interactionPublication'

  const errorKeys: Record<PublicationError['code'], TranslationKey> = {
    'bot-required': 'sync-bot-required',
    'server-missing': 'sync-server-missing',
    'duplicate-names': 'sync-duplicate-names',
    permissions: 'sync-permissions-help',
    network: 'sync-network-help',
    discord: 'sync-discord-help',
    'save-failed': 'sync-save-failed',
    'scope-save-failed': 'sync-scope-save-failed',
    'connection-changed': 'sync-connection-changed',
    'command-missing': 'sync-command-missing'
  }
  let busy = $derived($interactionPublication.busy || $publicationRequestPending)
  let failed = $derived(
    !!$interactionPublication.error || $interactionPublication.targets.some((t) => t.error)
  )
  let stale = $derived($interactionPublication.staleIds.length > 0)
  let visible = $derived(
    busy ||
      $interactionPublication.completed ||
      !!$publicationTransportError ||
      !$connectionStore.connected
  )
</script>

{#if visible}
  <div
    class="mx-4 my-3 rounded-lg border border-base-300 bg-base-200 p-3 text-sm space-y-2"
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >
    {#if busy}
      <p class="flex items-center gap-2">
        <span class="loading loading-spinner loading-xs" aria-hidden="true"></span>
        {$t('sync-in-progress')}
      </p>
    {:else if $publicationTransportError}
      <p class="text-error">{$t('sync-discord-help')}</p>
      <p class="break-words">{$publicationTransportError}</p>
    {:else if $interactionPublication.completed}
      <p
        class="font-medium"
        class:text-warning={failed || stale}
        class:text-success={!failed && !stale}
      >
        {$t(
          failed
            ? 'sync-failed-help'
            : stale
              ? 'sync-changed-during-publish'
              : $interactionPublication.operation === 'sync'
                ? 'sync-completed'
                : $interactionPublication.operation === 'register'
                  ? 'sync-registered'
                  : 'sync-unregistered'
        )}
      </p>
      {#if $interactionPublication.error}
        <p>{$t(errorKeys[$interactionPublication.error.code])}</p>
        {#if $interactionPublication.error.detail}<p class="break-words">
            {$interactionPublication.error.detail}
          </p>{/if}
      {/if}
      {#if failed && stale}<p>{$t('sync-changed-during-publish')}</p>{/if}
      {#if $interactionPublication.targets.length}
        <ul class="list-disc pl-5 space-y-1">
          {#each $interactionPublication.targets as target}
            <li class="break-words">
              <span class="font-medium"
                >{target.guildId
                  ? $t('sync-server-label').replace('{id}', target.guildId)
                  : $t('sync-global-scope')}:</span
              >
              {#if target.error}
                {$t(errorKeys[target.error.code])}
                {#if target.error.detail}<span>{target.error.detail}</span>{/if}
              {:else}
                {$t('sync-discord-confirmed')}
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
    {#if !$connectionStore.connected && !busy}<p>{$t('sync-bot-required')}</p>{/if}
  </div>
{/if}
