<script lang="ts">
  import { onboardingStore } from '../stores/onboarding'
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

  let visible = $state(true)

  $effect(() => {
    if (onboardingStore.isTipDismissed(tipId)) {
      visible = false
      dismissed = true
    }
  })

  function dismiss() {
    visible = false
    dismissed = true
    onboardingStore.dismissTip(tipId)
  }
</script>

{#if visible}
  <div transition:slide={{ duration: 200 }} class="mx-4 my-3">
    <div class="alert shadow-md">
      <span class="material-symbols-outlined text-primary">{icon}</span>
      <div>
        <h3 class="font-bold text-sm">{title}</h3>
        <div class="text-xs opacity-70">{body}</div>
      </div>
      <button class="btn btn-ghost btn-xs" onclick={dismiss}>Got it</button>
    </div>
  </div>
{/if}
