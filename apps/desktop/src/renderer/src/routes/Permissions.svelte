<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { currentStep, WizardStep } from '../stores/wizard.js'
  import WizardShell from '../lib/WizardShell.svelte'

  // ── Login item ──────────────────────────────────────────────────────────
  let loginEnabled = true
  let loginStuck = true

  // ── Documents access observation ────────────────────────────────────────
  // The action opens Full Disk Access settings, but the running daemon can
  // truthfully verify only whether its Documents probe succeeds.
  type AccessState = 'idle' | 'probing' | 'waiting' | 'checking' | 'readable' | 'timeout'
  let accessState: AccessState = 'idle'
  let pollIntervalId: ReturnType<typeof setInterval> | null = null
  let pollTimeoutId: ReturnType<typeof setTimeout> | null = null

  const POLL_INTERVAL_MS = 2000
  const POLL_TIMEOUT_MS = 120_000

  onMount(async () => {
    const result = await window.bridge.setLoginItem(true)
    loginStuck = result.didStick
  })

  onDestroy(() => {
    clearPolling()
  })

  function clearPolling(): void {
    if (pollIntervalId !== null) { clearInterval(pollIntervalId); pollIntervalId = null }
    if (pollTimeoutId !== null) { clearTimeout(pollTimeoutId); pollTimeoutId = null }
  }

  /** `bind:checked` has already written the new value by the time change fires,
   *  so flipping it again inverted it a second time — the switch snapped back
   *  and the daemon was told the opposite of what the user asked for. */
  async function toggleLogin(): Promise<void> {
    const wanted = loginEnabled
    const result = await window.bridge.setLoginItem(wanted)
    if (!result.didStick) loginEnabled = !wanted
    loginStuck = result.didStick
  }

  async function setupFDA(): Promise<void> {
    if (accessState === 'probing' || accessState === 'waiting' || accessState === 'readable') return
    accessState = 'probing'
    // Dev note: in dev mode the probing entity is "node"/"Electron", not "bridge-agent".
    // The fallback copy in the UI covers the "+"-path for that case.
    await window.bridge.probeAndOpenFDA()
    accessState = 'waiting'
    startPolling()
  }

  function startPolling(): void {
    clearPolling()
    pollIntervalId = setInterval(async () => {
      const { readable } = await window.bridge.checkDocumentsAccess()
      if (readable) {
        clearPolling()
        accessState = 'readable'
        setTimeout(() => proceed(), 1200)
      }
    }, POLL_INTERVAL_MS)

    pollTimeoutId = setTimeout(() => {
      clearPolling()
      if (accessState === 'waiting') accessState = 'timeout'
    }, POLL_TIMEOUT_MS)
  }

  async function checkNow(): Promise<void> {
    accessState = 'checking'
    const { readable } = await window.bridge.checkDocumentsAccess()
    if (readable) {
      clearPolling()
      accessState = 'readable'
      setTimeout(() => proceed(), 1200)
    } else {
      // Still denied — resume polling and show feedback
      accessState = 'waiting'
    }
  }

  function proceed(): void {
    clearPolling()
    currentStep.set(WizardStep.Done)
  }

  // The status word carries the state; the square only reinforces it.
  const ACCESS_STATUS: Record<AccessState, { word: string; mk: string }> = {
    idle: { word: 'not checked', mk: '' },
    probing: { word: 'opening settings', mk: 'wait' },
    waiting: { word: 'waiting for you', mk: 'wait' },
    checking: { word: 'checking', mk: 'wait' },
    readable: { word: 'Documents readable', mk: 'pass' },
    timeout: { word: 'timed out', mk: '' },
  }
</script>

<WizardShell step="permissions">
  <h2 tabindex="-1">Two grants, both optional.</h2>
  <p class="p">You can skip either one now and set it up later from the menu bar.</p>

  <ul class="reg" aria-label="Optional permissions">
    <li>
      <div class="rt">
        {#if ACCESS_STATUS[accessState].mk}
          <span class="mk {ACCESS_STATUS[accessState].mk}" aria-hidden="true"></span>
        {/if}
        Full Disk Access
        <span class="s" class:st={!!ACCESS_STATUS[accessState].mk}
              class:pass={ACCESS_STATUS[accessState].mk === 'pass'}
              class:wait={ACCESS_STATUS[accessState].mk === 'wait'}>
          {ACCESS_STATUS[accessState].word}
        </span>
      </div>
      <p class="rd">
        Lets agents read and write anywhere your account can, without a separate macOS
        prompt per folder. The daemon runs unsandboxed as you — so this grant is real,
        and skipping it is a reasonable choice.
      </p>
      <p class="rd" style="margin-top:7px">
        The daemon needs its own grant. Granting it to the Jerico app does not cover it.
      </p>

      {#if accessState === 'waiting'}
        <p class="rd" style="margin-top:7px">
          Toggle <b>bridge-agent</b> on in System Settings. This screen notices by itself.
        </p>
      {:else if accessState === 'timeout'}
        <p class="rd" style="margin-top:7px">
          Nothing arrived in two minutes. You can grant it later from the menu bar.
        </p>
        <details>
          <summary>Don't see bridge-agent in the list?</summary>
          <div class="tech">
            <p>
              Click <b>+</b> in the Full Disk Access list, press <kbd>⌘⇧G</kbd>, paste
              <code>/Applications/jerico.app/Contents/Resources/bridge-agent</code>,
              click <b>Open</b>, then toggle it on.
            </p>
          </div>
        </details>
      {/if}

      {#if accessState !== 'readable'}
        <div class="ra">
          <!-- Skip sits next to Set up at the same size, not as a grey
               afterthought: FDA is genuinely optional and pretending
               otherwise is what makes people grant things they did not
               want to grant. -->
          {#if accessState === 'idle'}
            <button type="button" class="btn btn-ghost btn-sm" on:click={setupFDA}>Set up</button>
          {:else if accessState === 'waiting'}
            <button type="button" class="btn btn-ghost btn-sm" on:click={checkNow}>Check now</button>
          {:else if accessState === 'timeout'}
            <button type="button" class="btn btn-ghost btn-sm" on:click={setupFDA}>Try again</button>
          {/if}
          <button type="button" class="btn btn-text btn-sm" style="padding:6px 2px" on:click={proceed}>
            Skip
          </button>
        </div>
      {/if}
    </li>

    <li>
      <div class="rt">
        Open Jerico at login
        <span class="s">{loginEnabled ? 'on' : 'off'}</span>
      </div>
      <p class="rd">
        Opens the menu-bar app when you log in. The daemon's own login service is
        separate — that is the next screen.
      </p>
      <div class="ra">
        <label class="tg">
          <input type="checkbox" bind:checked={loginEnabled} on:change={toggleLogin} />
          <span class="box" aria-hidden="true"></span>
          <span class="txt">{loginEnabled ? 'Enabled' : 'Disabled'}</span>
        </label>
      </div>
      {#if loginEnabled && !loginStuck}
        <p class="callout">
          macOS did not accept this automatically. Open
          <b>System Settings → General → Login Items</b> and add Jerico there.
        </p>
      {/if}
    </li>
  </ul>

  <svelte:fragment slot="actions">
    <button type="button" class="btn btn-primary" on:click={proceed}>Continue</button>
  </svelte:fragment>
</WizardShell>
