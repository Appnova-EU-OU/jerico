<script lang="ts">
  import { onMount } from 'svelte'
  import WizardShell from '../lib/WizardShell.svelte'
  import Mark from '../lib/Mark.svelte'

  let machine = ''
  let server = ''
  let serviceInstalled: boolean | null = null

  // Read rather than assumed. The previous screen offers "run this session
  // only" as a first-class choice, so a Finish screen that always claims
  // "starts at login" would be lying to exactly the people who declined it.
  onMount(async () => {
    const s = await window.bridge.getConnectionSummary()
    machine = s.machine
    server = s.server
    serviceInstalled = s.serviceInstalled
  })

  async function finish(): Promise<void> {
    await window.bridge.completeSetup()
  }
</script>

<WizardShell step="done">
  <Mark />
  <h2 tabindex="-1">This Mac is connected.</h2>
  <p class="p">
    The mark is in your menu bar now. Click it to see what is running, check the
    connection, or stop the daemon.
  </p>

  <div class="out">
    {#if machine}
      <span class="l"><span class="k">machine</span><span class="v">{machine}</span></span>
    {/if}
    {#if server}
      <span class="l"><span class="k">server</span><span class="v">{server}</span></span>
    {/if}
    {#if serviceInstalled !== null}
      <span class="l" class:ok={serviceInstalled}>
        <span class="k">service</span>
        <span class="v">
          {serviceInstalled ? 'installed · starts at login' : 'this session only'}
        </span>
      </span>
    {/if}
  </div>

  <svelte:fragment slot="actions">
    <button type="button" class="btn btn-primary" on:click={finish}>Open Jerico</button>
  </svelte:fragment>
</WizardShell>
