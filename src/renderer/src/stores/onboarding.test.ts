import { describe, expect, it } from 'vitest'
import { getCurrentStep, type OnboardingState } from './onboarding'

const baseState: OnboardingState = {
  stepperDismissed: false,
  botHostedOnce: false,
  dismissedTips: []
}

describe('getCurrentStep', () => {
  it('walks through token, command, hosting, and complete states', () => {
    expect(getCurrentStep(baseState, '', false, false)).toBe('ENTER_TOKEN')
    expect(getCurrentStep(baseState, 'token', false, false)).toBe('CREATE_COMMAND')
    expect(getCurrentStep(baseState, 'token', true, false)).toBe('HOST_BOT')
    expect(getCurrentStep(baseState, 'token', true, true)).toBe('COMPLETE')
    expect(getCurrentStep({ ...baseState, botHostedOnce: true }, 'token', true, false)).toBe(
      'COMPLETE'
    )
  })

  it('treats dismissed onboarding as complete regardless of app state', () => {
    expect(
      getCurrentStep({ ...baseState, stepperDismissed: true }, '', false, false)
    ).toBe('COMPLETE')
  })
})
