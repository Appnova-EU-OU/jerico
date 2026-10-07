<script lang="ts">
  import { onMount } from 'svelte'
  import { currentStep, WizardStep } from '../stores/wizard.js'
  import WizardShell from '../lib/WizardShell.svelte'

  let understood = false
  let status: 'idle' | 'installing' | 'running' | 'error' = 'idle'
  let errorMessage = ''
  let endpointsLoading = true
  let endpointWsUrl = ''
  let configurationError = ''

  onMount(async () => {
    const [consent, endpoints] = await Promise.all([
      window.bridge.getConsentStatus(),
      window.bridge.getServerEndpoints(),
    ])
    if (!endpoints.ok || !endpoints.wsUrl) {
      configurationError = endpoints.error ?? 'This profile has no valid server configuration.'
    } else {
      endpointWsUrl = endpoints.wsUrl
    }
    endpointsLoading = false
    const { consented } = consent
    if (consented) {
      // Already consented on a prior run — continue to optional permissions.
      // (There used to be an Install step between the two that nothing ever
      // routed to; it was deleted with its enum entry.)
      currentStep.set(WizardStep.Permissions)
    }
  })

  async function handleInstallService(): Promise<void> {
    if (endpointsLoading || configurationError) return
    status = 'installing'
    errorMessage = ''
    const consent = await window.bridge.recordConsent()
    if (!consent.ok) {
      status = 'error'
      errorMessage = 'Consent could not be recorded. Check that Jerico can write its settings and try again.'
      return
    }
    const result = await window.bridge.installDaemon()
    if (result.ok) {
      currentStep.set(WizardStep.Permissions)
    } else {
      status = 'error'
      errorMessage = result.error ?? 'Installation failed. Please try again.'
    }
  }

  async function handleRunNow(): Promise<void> {
    if (endpointsLoading || configurationError) return
    status = 'running'
    errorMessage = ''
    const consent = await window.bridge.recordConsent()
    if (!consent.ok) {
      status = 'error'
      errorMessage = 'Consent could not be recorded. Check that Jerico can write its settings and try again.'
      return
    }
    const result = await window.bridge.runNow()
    if (result.ok) {
      currentStep.set(WizardStep.Permissions)
    } else {
      status = 'error'
      errorMessage = result.error ?? 'Could not start daemon. Please try again.'
    }
  }

  $: busy = endpointsLoading || status === 'installing' || status === 'running'
</script>

<WizardShell step="service-consent">
  <h2 tabindex="-1">What the daemon can do on this Mac.</h2>
  <p class="p">Read this before installing the background service.</p>

  <!-- Plain-language capability first, the spawn-level truth folded
       underneath, and the sentence that matters — it can read your SSH keys —
       stated rather than softened. -->
  <div class="caps">
    <div>
      <div class="ct">Run programs and AI agents</div>
      <p class="cd">Starts and controls terminal sessions and coding agents on your behalf.</p>
    </div>
    <div>
      <div class="ct">Read and change your files</div>
      <p class="cd">
        Runs as you, outside macOS's sandbox. It can open and edit any file your account
        can — SSH keys, dotfiles, source code — both through the agents it starts and
        directly, on its own. The agents it starts run with their own confirmation
        prompts switched off. If you later grant Full Disk Access, this also includes
        other applications' data such as messages, mail, and browser history.
      </p>
    </div>
    <div>
      <div class="ct">Control the sessions it starts</div>
      <p class="cd">Types into, resizes and stops those sessions.</p>
    </div>
    <div>
      <div class="ct">See what is on this Mac</div>
      <p class="cd">
        Lists your installed agent CLIs and running dev servers, reads your local Claude
        Code transcripts, and can drive the iOS Simulator.
      </p>
    </div>
    <div>
      <div class="ct">Stay connected to your server</div>
      <p class="cd">
        Holds an authenticated outbound connection and carries out the above when you ask
        from the Jerico app.
      </p>
    </div>
  </div>

  <details>
    <summary>Technical details</summary>
    <div class="tech">
      <div class="tl">Sessions</div>
      <ul>
        <li>
          <code>spawn</code> — start a PTY for any installed agent, with that agent's
          own confirmation prompts turned off. Claude Code and Antigravity get
          <code>--dangerously-skip-permissions</code>; Qwen, Kimi, opencode, Aider,
          Ollama and Copilot get <code>--yolo</code>; Codex runs
          <code>-a never --sandbox workspace-write</code>, which auto-approves but
          keeps it inside the workspace
        </li>
        <li><code>input</code> / <code>kill</code> / <code>resize</code> — drive any running PTY</li>
        <li><code>watch_artifact_check</code> / <code>inspect_result</code> — check a
          build artefact, return an inspected element</li>
        <li><code>persona_apply</code> / <code>role_apply</code> — apply a persona or role</li>
        <li><code>permissions_changed</code> — type text into a running panel</li>
        <li><code>set_model</code> / <code>set_daemon_settings</code> — change agent model and daemon settings</li>
      </ul>

      <div class="tl">Files, directly — not only through an agent</div>
      <ul>
        <li><code>file_read</code> / <code>file_write</code> — read and write any file your account can</li>
        <li><code>dir_list</code> / <code>list_dir</code> / <code>project_tree</code> — enumerate directories</li>
        <li><code>git_diff</code> / <code>git_status</code> — read repository state</li>
        <li><code>image_drop</code> / <code>media_preview</code> — write dropped files, read images and video</li>
        <li><code>codegraph_query</code> — query the indexed symbol graph of your code</li>
      </ul>

      <div class="tl">Your machine</div>
      <ul>
        <li><code>detect_agents</code> / <code>detect_dev_servers</code> — enumerate installed CLIs and listening dev servers</li>
        <li>
          <code>claude_sessions_list</code> / <code>claude_session_rename</code> — read and rename
          your local Claude Code transcripts
        </li>
        <li><code>preview_proxy_start</code> / <code>preview_proxy_stop</code> — proxy a local port out through the server</li>
        <li><code>sim_*</code> — drive the iOS Simulator: tap, swipe, type, screenshot, install</li>
      </ul>

      <div class="tl">Data access</div>
      <p>
        Unsandboxed, as your user: <code>~/.ssh</code>, dotfiles, source, shell history.
        With Full Disk Access: other applications' data, including messages, mail, and
        browser history.
      </p>

      <div class="tl">Endpoint</div>
      <p><code>{endpointWsUrl || 'Server configuration required'}</code></p>
    </div>
  </details>

  <p class="p" style="font-size:12.5px">
    You can remove Jerico at any time: menu bar → <b>manage</b> → uninstall.
  </p>

  {#if status === 'error'}
    <p class="err" role="alert" style="font-family:var(--mono);font-size:10px;color:var(--down);margin-top:14px">
      {errorMessage}
    </p>
  {/if}
  {#if configurationError}
    <p class="err" role="alert" style="font-family:var(--mono);font-size:10px;color:var(--down);margin-top:14px">
      {configurationError}
    </p>
  {/if}

  <svelte:fragment slot="actions">
    <label class="consent">
      <input type="checkbox" bind:checked={understood} disabled={busy || !!configurationError} />
      <span class="box" aria-hidden="true"></span>
      <span class="t">I understand and consent to the above</span>
    </label>
    <!-- Both actions stay disabled until the box is ticked, and the safer one
         is not hidden behind a link. -->
    <button
      type="button"
      class="btn btn-primary"
      disabled={!understood || busy || !!configurationError}
      on:click={handleInstallService}
    >
      {status === 'installing' ? 'Installing…' : 'Install as login service'}
    </button>
    <button
      type="button"
      class="btn btn-ghost"
      disabled={!understood || busy || !!configurationError}
      on:click={handleRunNow}
    >
      {status === 'running' ? 'Starting…' : 'Run this session only'}
    </button>
  </svelte:fragment>
</WizardShell>
