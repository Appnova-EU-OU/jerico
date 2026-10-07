import { writable } from 'svelte/store'

export enum WizardStep {
  Welcome = 'welcome',
  Migrate = 'migrate',
  Auth = 'auth',
  Permissions = 'permissions',
  ServiceConsent = 'service-consent',
  Done = 'done',
}

export const currentStep = writable<WizardStep>(WizardStep.Welcome)
