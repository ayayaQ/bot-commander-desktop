<script lang="ts">
  import type { OnboardingStep } from '../stores/onboarding'
  import { t, type TranslationKey } from '../stores/localisation'
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

  const steps: {
    key: OnboardingStep
    label: string
    messageKey: TranslationKey
    actionLabelKey?: TranslationKey
  }[] = [
    {
      key: 'ENTER_TOKEN',
      label: '1',
      messageKey: 'onboarding-enter-token-message',
      actionLabelKey: 'onboarding-open-portal'
    },
    {
      key: 'CREATE_COMMAND',
      label: '2',
      messageKey: 'onboarding-create-command-message',
      actionLabelKey: 'onboarding-go-to-commands'
    },
    {
      key: 'HOST_BOT',
      label: '3',
      messageKey: 'onboarding-host-bot-message'
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
        <h3 class="card-title text-sm">{$t('onboarding-getting-started')}</h3>
        <button class="btn btn-ghost btn-xs opacity-60" onclick={onDismiss}>{$t('dismiss')}</button>
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
        <p class="text-center text-sm opacity-70">{$t(activeStep.messageKey)}</p>
        {#if activeStep.actionLabelKey}
          <div class="card-actions justify-center mt-1">
            <button class="btn btn-outline btn-primary btn-sm" onclick={onAction}>
              {$t(activeStep.actionLabelKey)}
            </button>
          </div>
        {/if}
      {/if}
    </div>
  </div>
{/if}
