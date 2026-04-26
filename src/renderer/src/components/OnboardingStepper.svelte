<script lang="ts">
  import type { OnboardingStep } from '../stores/onboarding'
  import { slide } from 'svelte/transition'

  let {
    currentStep,
    onDismiss,
    onAction
  }: {
    currentStep: OnboardingStep
    onDismiss: () => void
    onAction?: () => void
  } = $props()

  const steps: { key: OnboardingStep; label: string; message: string; actionLabel?: string }[] = [
    {
      key: 'ENTER_TOKEN',
      label: '1',
      message: 'Visit the Discord Developer Portal to create a bot and copy its token.',
      actionLabel: 'Open Portal'
    },
    {
      key: 'CREATE_COMMAND',
      label: '2',
      message: 'Create a command so your bot has something to do.',
      actionLabel: 'Go to Commands'
    },
    {
      key: 'HOST_BOT',
      label: '3',
      message: 'Press Login to bring your bot online!'
    }
  ]

  let stepIndex = $derived(steps.findIndex((s) => s.key === currentStep))
  let activeStep = $derived(steps[stepIndex])
</script>

{#if currentStep !== 'COMPLETE'}
  <div transition:slide={{ duration: 200 }} class="card bg-base-100 shadow-lg w-full">
    <div class="card-body p-4">
      <!-- Header -->
      <div class="flex justify-between items-center">
        <h3 class="card-title text-sm">Getting Started</h3>
        <button class="btn btn-ghost btn-xs opacity-60" onclick={onDismiss}>Dismiss</button>
      </div>

      <!-- Step dots -->
      <div class="flex items-center justify-center gap-1 my-2">
        {#each steps as step, i}
          <div
            class={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
              i <= stepIndex
                ? 'bg-primary text-primary-content'
                : 'bg-base-300 text-base-content/40'
            }`}
          >
            {#if i < stepIndex}
              <span class="material-symbols-outlined text-sm">check</span>
            {:else}
              {step.label}
            {/if}
          </div>
          {#if i < steps.length - 1}
            <div
              class={`h-0.5 flex-1 transition-colors ${
                i < stepIndex ? 'bg-primary' : 'bg-base-300'
              }`}
            ></div>
          {/if}
        {/each}
      </div>

      <!-- Message -->
      {#if activeStep}
        <p class="text-center text-sm opacity-70">{activeStep.message}</p>
        {#if activeStep.actionLabel}
          <div class="card-actions justify-center mt-1">
            <button class="btn btn-outline btn-primary btn-sm" onclick={onAction}>
              {activeStep.actionLabel}
            </button>
          </div>
        {/if}
      {/if}
    </div>
  </div>
{/if}
