<script lang="ts">
  import { onMount } from 'svelte'
  import { currentStep, WizardStep } from '../stores/wizard.js'
  import WizardShell from '../lib/WizardShell.svelte'

  let status: 'checking' | 'found' | 'migrating' | 'done' = 'checking'
  let configPath = ''
  let server = ''
  let error = ''

  onMount(async () => {
    const result = await window.bridge.detectLegacyConfig()

    if (!result.found) {
      currentStep.set(WizardStep.Auth)
      return
    }

    status = 'found'
    configPath = result.configPath ?? ''
    server = result.server ?? ''

  })

  async function confirmMigration(): Promise<void> {
    status = 'migrating'
    error = ''
    // This click is the credential boundary: detection only showed the file and
    // server. The bearer token is first read and validated after confirmation.
    const migrated = await window.bridge.migrateLegacyConfig()
    if (!migrated.ok) {
      status = 'found'
      error = migrated.error ?? 'Could not carry the token over.'
      return
    }
    status = 'done'
    await new Promise<void>((r) => setTimeout(r, 800))
    currentStep.set(WizardStep.ServiceConsent)
  }

  function useNewToken(): void {
    currentStep.set(WizardStep.Auth)
  }
</script>

<WizardShell step="migrate">
  <h2 tabindex="-1">Carrying over your command-line setup.</h2>
  <p class="p">
    You already ran <code>bridge-agent</code> from a terminal on this Mac. If that
    token still works, this Mac keeps it and you can skip signing in again.
  </p>

  {#if status !== 'checking'}
    <div class="out">
      {#if configPath}
        <span class="l"><span class="k">found</span><span class="v">{configPath}</span></span>
      {/if}
      {#if server}
        <span class="l"><span class="k">server</span><span class="v">{server}</span></span>
      {/if}
      {#if status === 'done'}
        <span class="l ok"><span class="k">token</span><span class="v">valid — carried into your Keychain</span></span>
      {:else if error}
        <span class="l bad"><span class="k">token</span><span class="v">{error}</span></span>
      {/if}
    </div>
  {/if}

  {#if status === 'checking' || status === 'migrating' || status === 'done'}
    <div class="scan" aria-hidden="true"></div>
  {/if}
  <p class="meta" role="status" aria-live="polite">
    {#if error}{error}{:else if status === 'done'}Continuing to permissions…{:else if status === 'migrating'}Validating and securing the token…{:else if status === 'found'}Confirm the server above before the token leaves this Mac.{:else}Checking your existing setup…{/if}
  </p>

  <svelte:fragment slot="actions">
    {#if status === 'found'}
      <button type="button" class="btn btn-ghost" on:click={useNewToken}>
        Sign in with a new token
      </button>
      <button type="button" class="btn btn-primary" on:click={confirmMigration}>
        Carry over this token
      </button>
    {/if}
  </svelte:fragment>
</WizardShell>
