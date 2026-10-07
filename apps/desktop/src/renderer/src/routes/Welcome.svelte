<script lang="ts">
  import { currentStep, WizardStep } from '../stores/wizard.js'
  import WizardShell from '../lib/WizardShell.svelte'
  import Mark from '../lib/Mark.svelte'

  function proceed(): void {
    currentStep.set(WizardStep.Migrate)
  }
</script>

<WizardShell step="welcome">
  <Mark />
  <h2 tabindex="-1">Let's connect this Mac.</h2>
  <p class="p">
    Jerico runs one small daemon here. It starts the agent CLIs you already have
    installed — Claude Code, Codex, Qwen, a plain shell — and connects outward to your
    server. The only thing it listens on is a loopback port for the app on this Mac;
    nothing on your network can reach it.
  </p>
  <p class="p">
    Five steps: carry over an existing install, sign in, review what the daemon
    can do, choose two optional permissions, and finish.
  </p>
  <p class="meta">About two minutes</p>

  <svelte:fragment slot="actions">
    <button type="button" class="btn btn-primary" on:click={proceed}>Get started</button>
  </svelte:fragment>
</WizardShell>
