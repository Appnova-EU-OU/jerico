<script lang="ts">
  import { currentStep, WizardStep } from './stores/wizard.js'
  import Welcome from './routes/Welcome.svelte'
  import Migrate from './routes/Migrate.svelte'
  import Auth from './routes/Auth.svelte'
  import Permissions from './routes/Permissions.svelte'
  import ServiceConsent from './routes/ServiceConsent.svelte'
  import Done from './routes/Done.svelte'
  import Update from './routes/Update.svelte'
  import Manage from './routes/Manage.svelte'
  import PermissionGate from './routes/PermissionGate.svelte'
  import Popover from './routes/Popover.svelte'

  // Dedicated windows load the shared renderer with a hash that selects the view.
  const hash = window.location.hash
  // The menu-bar popover. It replaced tray.setContextMenu() and absorbed the
  // start/stop progress window with it, which is why there is no #action here.
  const isPopover = hash === '#popover'
  const isUpdateWindow = hash === '#update'
  const isManageWindow = hash === '#manage'

  // Re-auth flow: daemon rejected the token, wizard opened with #auth-step — skip Welcome.
  // The reason travels with it. Being dropped back on the sign-in screen with
  // no explanation is indistinguishable from the app losing your work, and it
  // is the exact moment a user needs to be told what happened.
  export const reauth = hash === '#auth-step'
  if (reauth) {
    currentStep.set(WizardStep.Auth)
  }

  // Phase B: permission gate — separate from the main wizard step flow.
  $: isPermissionGate = hash === '#permission-gate'
</script>

{#if isPopover}
  <Popover />
{:else if isPermissionGate}
  <PermissionGate />
{:else if isUpdateWindow}
  <Update />
{:else if isManageWindow}
  <Manage />
{:else if $currentStep === WizardStep.Welcome}
  <Welcome />
{:else if $currentStep === WizardStep.Migrate}
  <Migrate />
{:else if $currentStep === WizardStep.Auth}
  <Auth {reauth} />
{:else if $currentStep === WizardStep.Permissions}
  <Permissions />
{:else if $currentStep === WizardStep.ServiceConsent}
  <ServiceConsent />
{:else if $currentStep === WizardStep.Done}
  <Done />
{/if}

<!-- No styles here. The ground, the type scale and every primitive live in
     app.css, which is the token layer ported from the approved design; a
     component-scoped body rule competing with it is how two palettes end up on
     screen at once. Each route brings its own shell. -->
