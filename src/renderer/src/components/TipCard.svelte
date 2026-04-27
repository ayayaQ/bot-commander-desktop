<script lang="ts">
  import { onboardingStore } from '../stores/onboarding'
  import { t } from '../stores/localisation'
  import { slide } from 'svelte/transition'

  let {
    tipId,
    icon,
    title,
    body,
    dismissed = $bindable(false)
  }: {
    tipId: string
    icon: string
    title: string
    body: string
    dismissed?: boolean
  } = $props()

  let dismissedLocally = $state(false)
  let dismissedByStore = $derived($onboardingStore.dismissedTips.includes(tipId))

  $effect(() => {
    if (dismissedByStore) {
      dismissed = true
    }
  })

  function dismiss() {
    dismissedLocally = true
    dismissed = true
    onboardingStore.dismissTip(tipId)
  }
</script>

{#if !dismissedLocally && !dismissed && !dismissedByStore}
  <div transition:slide={{ duration: 200 }} class="mx-4 my-3">
    <div class="alert shadow-md">
      <span class="material-symbols-outlined text-primary">{icon}</span>
      <div>
        <h3 class="font-bold text-sm">{title}</h3>
        <div class="text-xs opacity-70">{body}</div>
      </div>
      <button class="btn btn-ghost btn-xs" onclick={dismiss}>{$t('got-it')}</button>
    </div>
  </div>
{/if}
