<script lang="ts">
  import { onMount } from 'svelte'
  import { currentStep, WizardStep } from '../stores/wizard.js'
  import WizardShell from '../lib/WizardShell.svelte'

  /** True when the wizard was reopened here because the server rejected the
   *  token this Mac was using — not because the user is signing in for the
   *  first time. The screen has to say so. */
  export let reauth = false

  let token = ''
  let loading = false
  let error = ''
  let endpointsLoading = true
  let connectPageLabel = ''
  let configurationError = ''

  onMount(async () => {
    const endpoints = await window.bridge.getServerEndpoints()
    if (!endpoints.ok || !endpoints.connectPageLabel) {
      configurationError = endpoints.error ?? 'This profile has no valid server configuration.'
    } else {
      connectPageLabel = endpoints.connectPageLabel
    }
    endpointsLoading = false
  })

  async function openAuthPage(): Promise<void> {
    if (endpointsLoading || configurationError) return
    await window.bridge.openAuthUrl()
  }

  async function validateAndContinue(): Promise<void> {
    const trimmed = token.trim()
    if (!trimmed) {
      error = 'Please enter your token.'
      return
    }
    loading = true
    error = ''
    const result = await window.bridge.validateToken(trimmed)
    if (!result.ok) {
      error = result.error ?? 'Token validation failed. Please try again.'
      loading = false
      return
    }
    // The screen promises the Keychain and nothing else, so a Keychain write
    // that fails has to stop the flow and say so — there is no longer a
    // silent fallback that writes the token to a file (#556).
    const saved = await window.bridge.saveAuth(trimmed)
    if (!saved.ok) {
      error = saved.error ?? 'Could not store the token in your Keychain.'
      loading = false
      return
    }
    currentStep.set(WizardStep.ServiceConsent)
    loading = false
  }
</script>

<WizardShell step="auth" row>
  <h2 tabindex="-1">{reauth ? 'This Mac was signed out.' : 'Sign this Mac in.'}</h2>
  {#if reauth}
    <p class="p" role="status">
      The server stopped accepting the token this Mac was using — it was revoked,
      it expired, or it now belongs to a different machine. Nothing else about
      your setup changed. Paste a new one to reconnect.
    </p>
  {/if}
  <p class="p">
    Generate a daemon token in your browser, then paste it here. Jerico stores it in
    your <b>macOS Keychain</b>. Processes running as your macOS user can read or replace it.
  </p>

  {#if configurationError}
    <p class="err" role="alert">{configurationError}</p>
  {/if}

  <div class="inp">
    <label for="tok">Daemon token</label>
    <!-- svelte-ignore a11y-autofocus -->
    <input
      id="tok"
      type="password"
      bind:value={token}
      spellcheck="false"
      autocomplete="off"
      autofocus
      placeholder="brg_…"
      disabled={loading || endpointsLoading || !!configurationError}
      on:keydown={(e) => e.key === 'Enter' && validateAndContinue()}
    />
    <p class="hint">Settings → Daemon Tokens → New token</p>
    {#if error}
      <p class="err" role="alert">{error}</p>
    {/if}
  </div>

  {#if connectPageLabel}
    <p class="p" style="margin-top:18px">
      <a href="#top" on:click|preventDefault={openAuthPage}>{connectPageLabel}</a>
      opens in your default browser.
    </p>
  {/if}

  <svelte:fragment slot="actions">
    <!-- The ghost is declared first because it is genuinely step one: open the
         page, copy the token, then validate. Tab order follows the task. -->
    <button type="button" class="btn btn-ghost" on:click={openAuthPage} disabled={loading || endpointsLoading || !!configurationError}>
      {endpointsLoading ? 'Loading server…' : connectPageLabel ? `Open ${connectPageLabel}` : 'Server configuration required'}
    </button>
    <button
      type="button"
      class="btn btn-primary"
      on:click={validateAndContinue}
      disabled={loading || endpointsLoading || !!configurationError || token.trim() === ''}
    >
      {loading ? 'Validating…' : 'Validate & continue'}
    </button>
  </svelte:fragment>
</WizardShell>
