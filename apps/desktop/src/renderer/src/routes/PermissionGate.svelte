<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import WizardShell from '../lib/WizardShell.svelte'

  interface GateStatus {
    passed: boolean
    keychain: boolean
    launchAgent: boolean
    bridgeDir: boolean
    jericoDir: boolean
  }

  let status: GateStatus | null = null
  let refreshError = ''
  let loading = true
  let fixing: Record<string, boolean> = {}
  let fixingError: Record<string, string> = {}
  let continuing = false
  let continueError = ''
  let copied = false

  let pollTimer: ReturnType<typeof setTimeout> | null = null

  onMount(() => {
    void refresh().then(() => {
      // The screen tells the user it re-checks every three seconds, so it has
      // to. Polling used to start only after a failed Continue, which meant a
      // user who fixed ~/.bridge in a terminal — the one item with no button —
      // sat in front of a screen that had already stopped looking.
      if (!status || !status.passed) startPolling()
    })
  })

  onDestroy(() => {
    if (pollTimer) clearTimeout(pollTimer)
  })

  async function refresh(): Promise<void> {
    loading = true
    refreshError = ''
    try {
      status = await window.bridge.checkPermissions()
    } catch {
      refreshError = 'Unable to check permissions'
      // keep stale status on error
    }
    loading = false
  }

  function startPolling(): void {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = setTimeout(async () => {
      await refresh()
      if (!status || !status.passed) startPolling()
    }, 3000)
  }

  async function handleFix(grant: 'keychain' | 'launchAgent' | 'bridgeDir'): Promise<void> {
    fixing = { ...fixing, [grant]: true }
    fixingError = { ...fixingError, [grant]: '' }
    try {
      if (grant === 'launchAgent') {
        const result = await window.bridge.installLaunchAgent()
        if (!result.ok) throw new Error(result.error ?? 'install failed')
      } else if (grant === 'keychain') {
        const result = await window.bridge.healKeychainAcl()
        if (!result.ok) throw new Error(result.error ?? 'heal failed')
      }
      // bridgeDir has no auto-fix — show instructions
    } catch (err: unknown) {
      fixingError = { ...fixingError, [grant]: err instanceof Error ? err.message : String(err) }
    } finally {
      await refresh()
      fixing = { ...fixing, [grant]: false }
    }
  }

  async function handleQuit(): Promise<void> {
    await window.bridge.quitApp()
  }

  async function handleContinue(): Promise<void> {
    continuing = true
    continueError = ''
    if (pollTimer) clearTimeout(pollTimer)
    try {
      const result = await window.bridge.completePermissionSetup()
      if (!result.ok) {
        await refresh()
        if (!status || !status.passed) {
          continueError = 'Some permissions are still not granted. Please fix all items above.'
          startPolling()
        }
      }
    } catch (err: unknown) {
      continueError = err instanceof Error ? err.message : String(err)
    } finally {
      continuing = false
    }
  }

  const CHOWN = 'sudo chown -R $(whoami) ~/.bridge'

  async function copyChown(): Promise<void> {
    try {
      await navigator.clipboard.writeText(CHOWN)
      copied = true
      setTimeout(() => { copied = false }, 1400)
    } catch {
      // Clipboard denied — the command is visible and selectable either way.
    }
  }

  // How many are actually wrong, so the heading can say it rather than
  // hedge. A gate that says "some things need fixing" makes the user count.
  $: failing = status
    ? [status.keychain, status.launchAgent, status.bridgeDir, status.jericoDir]
        .filter((ok) => !ok).length
    : 0
  // `status === null` is not "nothing is wrong" — it is "we do not know", and
  // the two must never render the same sentence. checkPermissions() throwing
  // left this screen announcing "Everything checks out." over an empty list.
  $: heading =
    status === null
      ? 'Cannot check this Mac.'
      : failing === 0
        ? 'Everything checks out.'
        : failing === 1
          ? 'One thing needs fixing.'
          : `${['', 'One', 'Two', 'Three', 'Four'][failing] ?? failing} things need fixing.`
</script>

<!-- No rail: the gate is a block, not a step. Numbering it would imply it sits
     on the path through setup when it is a stop sign across it. -->
<WizardShell step={null} name="Permissions required" row>
  <h2 tabindex="-1">{loading && !status ? 'Checking this Mac…' : heading}</h2>
  <!-- The body has to follow the heading. The moment the last item is fixed the
       screen still stands here waiting for Continue, and telling someone to fix
       what is already fixed reads as the screen not having noticed. -->
  <p class="p" role="status" aria-live="polite">
    {#if !status}
      Checking the four things Jerico needs to run in the background on this Mac.
    {:else if failing === 0}
      All four are in place. Continue to finish setting up.
    {:else}
      Jerico cannot run reliably in the background without these. Fix them here, or quit
      and come back.
    {/if}
  </p>

  {#if refreshError}
    <p class="callout" role="alert">{refreshError} — showing the last known result.</p>
  {/if}

  <!-- The list changes underneath the user while they fix things in Terminal.
       Without a live region a screen-reader user gets no signal at all that the
       thing they just fixed went green — which is the one moment this screen
       exists for. -->
  <!-- A list, and each row an item. Read out of Chromium's own accessibility
       tree, these four were a flat run of sibling strings — "Keychain access",
       "OK", the description, "Login service", "MISSING" — with no grouping, no
       count, and nothing tying a status to the thing it describes. -->
  {#if status}
    <ul class="reg" aria-live="polite" aria-label="What Jerico needs on this Mac">
      <li>
        <div class="rt">
          <span class="mk {status.keychain ? 'pass' : 'fail'}" aria-hidden="true"></span>
          Keychain access
          <span class="s st {status.keychain ? 'pass' : 'fail'}">
            {status.keychain ? 'ok' : 'missing'}
          </span>
        </div>
        <p class="rd">
          Stores your token in the login keychain so the daemon can read it without asking
          for your password every time.
        </p>
        {#if !status.keychain}
          <p class="callout">
            macOS will ask: <b>“bridge-agent wants to use the login keychain.”</b>
            Choose <b>Always Allow</b> — not Allow, not Deny.
          </p>
          {#if fixingError['keychain']}
            <p class="rd" style="color:var(--down)">{fixingError['keychain']}</p>
          {/if}
          <div class="ra">
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              disabled={fixing['keychain']}
              aria-label="Grant Keychain access"
              on:click={() => handleFix('keychain')}
            >
              {fixing['keychain'] ? 'Granting…' : 'Grant'}
            </button>
          </div>
        {/if}
      </li>

      <li>
        <div class="rt">
          <span class="mk {status.launchAgent ? 'pass' : 'fail'}" aria-hidden="true"></span>
          Login service
          <span class="s st {status.launchAgent ? 'pass' : 'fail'}">
            {status.launchAgent ? 'ok' : 'missing'}
          </span>
        </div>
        <p class="rd">
          Registers the daemon with launchd so it keeps running after you close this window.
        </p>
        {#if !status.launchAgent}
          {#if fixingError['launchAgent']}
            <p class="rd" style="color:var(--down)">{fixingError['launchAgent']}</p>
          {/if}
          <div class="ra">
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              disabled={fixing['launchAgent']}
              aria-label="Install the login service"
              on:click={() => handleFix('launchAgent')}
            >
              {fixing['launchAgent'] ? 'Installing…' : 'Install'}
            </button>
          </div>
        {/if}
      </li>

      <li>
        <div class="rt">
          <span class="mk {status.bridgeDir ? 'pass' : 'fail'}" aria-hidden="true"></span>
          ~/.bridge
          <span class="s st {status.bridgeDir ? 'pass' : 'fail'}">
            {status.bridgeDir ? 'ok' : 'wrong owner'}
          </span>
        </div>
        {#if status.bridgeDir}
          <p class="rd">Owned by you.</p>
        {:else}
          <p class="rd">
            Jerico keeps its lock and state files here, and something else owns the folder —
            usually a <code>sudo</code> run in the past.
          </p>
          <p class="rd" style="margin-top:7px">
            There is no safe automatic fix for this one. Run it yourself:
          </p>
          <div class="cmd">
            <code>{CHOWN}</code>
            <button
              type="button"
              class="copy"
              aria-label="Copy the ~/.bridge ownership command"
              on:click={copyChown}
            >
              {copied ? 'copied' : 'copy'}
            </button>
          </div>
        {/if}
      </li>

      <li>
        <div class="rt">
          <span class="mk {status.jericoDir ? 'pass' : 'fail'}" aria-hidden="true"></span>
          ~/.jerico
          <span class="s st {status.jericoDir ? 'pass' : 'fail'}">
            {status.jericoDir ? 'ok' : 'wrong owner'}
          </span>
        </div>
        {#if status.jericoDir}
          <p class="rd">Owned by you.</p>
        {:else}
          <p class="rd">
            Settings and profiles live here, and something else owns the folder.
          </p>
          <div class="cmd">
            <code>sudo chown -R $(whoami) ~/.jerico</code>
          </div>
        {/if}
      </li>
    </ul>

    {#if failing > 0}
      <p class="meta">Re-checking every 3 seconds</p>
    {/if}
  {/if}

  {#if continueError}
    <p class="callout" role="alert">{continueError}</p>
  {/if}

  <svelte:fragment slot="actions">
    <button
      type="button"
      class="btn btn-primary"
      disabled={!status || !status.passed || continuing}
      on:click={handleContinue}
    >
      {continuing ? 'Checking…' : 'Continue'}
    </button>
    <button type="button" class="btn btn-text" on:click={handleQuit}>Quit</button>
  </svelte:fragment>
</WizardShell>
