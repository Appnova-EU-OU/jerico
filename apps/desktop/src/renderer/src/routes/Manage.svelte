<script lang="ts">
  import { onMount } from 'svelte'
  import WindowShell from '../lib/WindowShell.svelte'

  type Summary = Awaited<ReturnType<typeof window.bridge.getManageSummary>>

  let summary: Summary | null = null
  let understood = false
  let status: 'idle' | 'uninstalling' | 'done' | 'error' = 'idle'
  let errorMessage = ''
  let loginItem = true
  let loginStuck = true
  let tierSaving = false

  onMount(async () => {
    // Both reads are independent; a slow daemon must not hold up the login-item
    // toggle, which is answered locally.
    void window.bridge.getManageSummary().then((s) => { summary = s }).catch(() => { /* shown as unknown */ })
    void window.bridge.getLoginItemEnabled().then((v) => { loginItem = v }).catch(() => { /* leave the default */ })
  })

  /** `bind:checked` has already written the new value by the time change fires,
   *  so flipping it again here inverted it a second time: the checkbox snapped
   *  back and the daemon was told the opposite of what the user asked for. */
  async function toggleLoginItem(): Promise<void> {
    const wanted = loginItem
    const { didStick } = await window.bridge.setLoginItem(wanted)
    // macOS can refuse. Showing the switch in a position the system does not
    // actually hold is worse than showing it unchanged.
    if (!didStick) loginItem = !wanted
    loginStuck = didStick
  }

  async function setTier(event: Event): Promise<void> {
    const tier = (event.currentTarget as HTMLSelectElement).value
    tierSaving = true
    await window.bridge.setClaudeTier(tier)
    tierSaving = false
  }

  async function confirmUninstall(): Promise<void> {
    if (!understood) return
    status = 'uninstalling'
    errorMessage = ''
    const result = await window.bridge.uninstallDaemon()
    if (result.ok) {
      status = 'done'
    } else {
      status = 'error'
      errorMessage = result.error ?? 'Uninstall failed. Try running: bridge-agent uninstall --force'
    }
  }

  async function quit(): Promise<void> {
    await window.bridge.quitApp()
  }

  async function openLogs(): Promise<void> {
    const { out } = await window.bridge.getLogsPath()
    await window.bridge.openExternal(`file://${out}`)
  }

  async function reauth(): Promise<void> {
    await window.bridge.openAuthUrl()
  }

  const TIERS = [
    { value: 'pro', label: 'Pro — 40 prompts / 5h' },
    { value: 'free', label: 'Free — 10 prompts / 5h' },
    { value: 'max_5x', label: 'Max 5× — 200 prompts / 5h' },
    { value: 'max_20x', label: 'Max 20× — 200 prompts / 5h' },
  ]

  const dash = (v: string | null | undefined): string => (v == null || v === '' ? '—' : v)
</script>

<WindowShell name="Manage" row>
  {#if status === 'done'}
    <h2 tabindex="-1">Jerico is off this Mac.</h2>
    <p class="p">
      The daemon is stopped, its login service is gone, and everything Jerico wrote has been
      deleted. One thing is left, and only you can do it: drag <b>Jerico.app</b> to the Trash.
    </p>
    <p class="meta">Your projects and agent CLIs were not touched</p>

  {:else}
    <h2 tabindex="-1">This installation.</h2>
    <p class="p">Everything Jerico put on this Mac, and how to take it back off.</p>

    <ul class="reg" aria-label="This installation">
      <li>
        <div class="rt">Identity</div>
        <div class="kv">
          <span class="l"><span class="k">machine</span><span class="v">{dash(summary?.machine)}</span></span>
          <span class="l"><span class="k">server</span><span class="v">{dash(summary?.server)}</span></span>
          <span class="l">
            <span class="k">app</span>
            <span class="v">
              {dash(summary?.appVersion)} · {dash(summary?.arch)} · {summary
                ? (summary.signed ? 'signed' : 'unsigned dev build')
                : '—'}
            </span>
          </span>
          <span class="l">
            <span class="k">daemon</span>
            <span class="v">
              {#if summary}
                {dash(summary.daemonVersion)} ·
                {summary.daemonRunning ? 'running' : 'not running'}
                {#if summary.activePanels > 0}
                  · {summary.activePanels}
                  {summary.activePanels === 1 ? 'panel' : 'panels'}
                {/if}
              {:else}—{/if}
            </span>
          </span>
          <span class="l"><span class="k">token</span><span class="v">{dash(summary?.tokenStore)}</span></span>
        </div>
        <div class="ra">
          <button type="button" class="btn btn-ghost btn-sm" on:click={reauth}>Re-authenticate</button>
          <button type="button" class="btn btn-text btn-sm" style="padding:7px 2px" on:click={openLogs}>
            Open logs
          </button>
        </div>
      </li>

      <li>
        <div class="rt">
          {#if summary?.documentsFolderReadable !== null && summary !== null}
            <span class="mk {summary.documentsFolderReadable ? 'pass' : 'fail'}" aria-hidden="true"></span>
          {/if}
          Documents folder access
          <span class="s">
            {#if summary === null}checking
            {:else if summary.documentsFolderReadable === null}unknown — daemon not answering
            {:else if summary.documentsFolderReadable}readable
            {:else}blocked{/if}
          </span>
        </div>
        <p class="rd">
          This checks only whether the daemon can read Documents. It does not determine whether
          Full Disk Access is granted. You can review the broader grant separately in System Settings.
        </p>
        <div class="ra">
          <button type="button" class="btn btn-ghost btn-sm" on:click={() => window.bridge.openFDASettings()}>
            Open the settings pane
          </button>
        </div>
      </li>

      <li>
        <div class="rt">Startup <span class="s">app and daemon</span></div>
        <p class="rd">Two separate things, so they are two separate switches.</p>
        <div class="ra" style="gap:20px">
          <label class="tg">
            <input type="checkbox" bind:checked={loginItem} on:change={toggleLoginItem} />
            <span class="box" aria-hidden="true"></span>
            <span class="txt">Open the app at login</span>
          </label>
          <!-- The daemon's own login service is the launchd job, which is what
               Uninstall removes. It is stated rather than toggled here, because
               turning it off is the same act as removing Jerico. -->
          <span class="txt" style="font-family:var(--mono);font-size:10.5px;color:var(--ink-3)">
            Daemon login service: {summary?.serviceInstalled ? 'installed' : 'not installed'}
          </span>
        </div>
        {#if !loginStuck}
          <p class="callout">
            macOS did not accept this. Open <b>System Settings → General → Login Items</b>
            and add Jerico there.
          </p>
        {/if}
      </li>

      <li>
        <div class="rt">Claude plan <span class="s">quota maths</span></div>
        <p class="rd">
          Sets the denominator for the five-hour prompt gauge. Jerico cannot read your plan from
          Anthropic, so this is the one setting you have to tell it.
        </p>
        <div class="ra">
          <select
            class="sel"
            aria-label="Claude plan"
            disabled={summary === null || tierSaving}
            value={summary?.claudeTier ?? 'pro'}
            on:change={setTier}
          >
            {#each TIERS as t (t.value)}
              <option value={t.value}>{t.label}</option>
            {/each}
          </select>
        </div>
      </li>

      <li class="danger">
        <div class="rt">Remove Jerico from this Mac <span class="s">cannot be undone</span></div>
        <p class="rd">
          Stops the daemon, unloads the login service, and deletes what Jerico wrote. Dragging
          the app to the Trash on its own leaves all of it behind.
        </p>

        {#if status === 'error'}
          <div class="errbox" role="alert">
            <div class="h">Uninstall failed</div>
            <div class="m">{errorMessage}</div>
          </div>
        {/if}

        <div class="confirm">
          <label class="cc">
            <input type="checkbox" bind:checked={understood} disabled={status === 'uninstalling'} />
            <span class="box" aria-hidden="true"></span>
            <span class="t">
              I understand this deletes:
              <ul>
                <li>the Keychain token</li>
                <li>~/.jerico and ~/.bridge</li>
                <li>the launchd login service</li>
                <li>daemon logs</li>
              </ul>
            </span>
          </label>
          <div class="ra">
            <button
              type="button"
              class="btn btn-danger btn-sm"
              disabled={!understood || status === 'uninstalling'}
              on:click={confirmUninstall}
            >
              {status === 'uninstalling' ? 'Removing…' : 'Remove'}
            </button>
            <span class="meta" style="margin:0">Your projects and agent CLIs are untouched</span>
          </div>
        </div>
      </li>
    </ul>
  {/if}

  <svelte:fragment slot="actions">
    {#if status === 'done'}
      <button type="button" class="btn btn-primary" on:click={quit}>Quit Jerico</button>
    {/if}
  </svelte:fragment>
</WindowShell>
