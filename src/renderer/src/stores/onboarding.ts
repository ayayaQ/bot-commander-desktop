import { writable, get } from 'svelte/store'

export type OnboardingStep = 'ENTER_TOKEN' | 'CREATE_COMMAND' | 'HOST_BOT' | 'COMPLETE'

export type OnboardingState = {
  stepperDismissed: boolean
  botHostedOnce: boolean
  dismissedTips: string[]
}

const defaultState: OnboardingState = {
  stepperDismissed: false,
  botHostedOnce: false,
  dismissedTips: []
}

function createOnboardingStore() {
  const { subscribe, set, update } = writable<OnboardingState>(defaultState)

  return {
    subscribe,
    set,
    update,

    async load() {
      try {
        const state = await window.electron.ipcRenderer.invoke('get-onboarding')
        set({ ...defaultState, ...state })
      } catch {
        // First run - no onboarding file yet
      }
    },

    async save(state: OnboardingState) {
      set(state)
      await window.electron.ipcRenderer.invoke('save-onboarding', state)
    },

    async dismissStepper() {
      update((s) => {
        const newState = { ...s, stepperDismissed: true }
        window.electron.ipcRenderer.invoke('save-onboarding', newState)
        return newState
      })
    },

    async dismissTip(tipId: string) {
      update((s) => {
        const newState = { ...s, dismissedTips: [...s.dismissedTips, tipId] }
        window.electron.ipcRenderer.invoke('save-onboarding', newState)
        return newState
      })
    },

    isTipDismissed(tipId: string): boolean {
      return get({ subscribe }).dismissedTips.includes(tipId)
    },

    async markBotHostedOnce() {
      update((s) => {
        if (s.botHostedOnce) return s
        const newState = { ...s, botHostedOnce: true }
        window.electron.ipcRenderer.invoke('save-onboarding', newState)
        return newState
      })
    }
  }
}

export const onboardingStore = createOnboardingStore()

/**
 * Derived store that computes the current onboarding step dynamically.
 * Requires `liveToken` and `hasCommands` to be passed in from the component context.
 */
export function getCurrentStep(
  state: OnboardingState,
  liveToken: string,
  hasCommands: boolean,
  isConnected: boolean
): OnboardingStep {
  if (state.stepperDismissed) return 'COMPLETE'
  if (!liveToken) return 'ENTER_TOKEN'
  if (!hasCommands) return 'CREATE_COMMAND'
  if (!state.botHostedOnce && !isConnected) return 'HOST_BOT'
  return 'COMPLETE'
}
