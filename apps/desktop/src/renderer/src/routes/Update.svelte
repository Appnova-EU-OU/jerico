<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import type { UpdaterStatusPayload } from '../../../preload/types.d.ts'
  import WindowShell from '../lib/WindowShell.svelte'

  let currentVersion = ''
  let status: UpdaterStatusPayload = { type: 'checking' }
  let unsubscribe: (() => void) | null = null
  let busy = false

  onMount(async () => {
    currentVersion = await window.bridge.getAppVersion()
    unsubscribe = window.bridge.onUpdaterStatus((payload) => {
      status = payload
      // A result arriving means whatever we asked for has been answered.
      if (payload.type !== 'downloading') busy = false
    })
    // Trigger a check — the main process may have already set status via
    // lastStatus replay on did-finish-load, but always kick a fresh check
    // so the user sees a definitive result even if the window pre-existed.
    await window.bridge.checkForUpdates()
  })

  onDestroy(() => { unsubscribe?.() })

  function handleUpdateNow(): void {
    busy = true
    void window.bridge.downloadUpdate()
  }

  function handleRestart(): void {
    busy = true
    void window.bridge.installUpdate()
  }

  function handleRetry(): void {
    busy = true
    void window.bridge.checkForUpdates()
  }

  $: availableVersion = (status.type === 'available' || status.type === 'downloaded')
    ? (status as Extract<UpdaterStatusPayload, { version: string }>).version
    : null

  $: downloadPercent = status.type === 'downloading' ? status.percent : 0

  $: errorMessage = status.type === 'error' ? status.message : ''

  /* What actually failed, and therefore what is true about the user's machine.
     The design (design/03-update-and-manage.html) draws ONE failure screen and
     it is written for the install: "the app was moved out of /Applications, or
     its signature could not be read". Every error used to get that copy, so a
     feed that would not load — nothing downloaded, nothing installed, the app
     exactly where it has always been — told the user to go and check where
     their app was. The other three screens are new, and each says only what is
     known to be true of its own phase. The updater's own words are quoted in
     all four, because that is the string someone searches for. */
  $: errorPhase = status.type === 'error' ? status.phase : 'unknown'
  $: errorCopy = {
    check: {
      head: "Couldn't reach the update server.",
      why: 'Nothing was downloaded and nothing was changed. Retry — if it keeps failing, '
        + 'the update server or your network connection is the thing to look at.',
      next: 'Retry. Jerico also checks on its own every few hours, so this usually clears '
        + 'itself without you doing anything.',
    },
    download: {
      head: "The download didn't finish.",
      why: 'Your current install is untouched and the partial download has been discarded. '
        + 'Retrying starts it again from the beginning.',
      next: 'Retry. If it keeps stopping partway, the connection is dropping — a different '
        + 'network is worth trying before anything else.',
    },
    stage: {
      head: "The update couldn't be prepared.",
      why: 'Your current install is untouched and the downloaded update was not staged.',
      next: 'Retry. Jerico will download and prepare the update again before offering restart.',
    },
    install: {
      head: 'The update could not be installed.',
      why: 'Your current install is untouched. This usually means the app was moved out of '
        + '/Applications, or its signature could not be read.',
      next: 'Retry once. If it fails again, download the DMG and replace the app by hand — '
        + 'your token and settings survive.',
    },
    /* No phase was in flight, so anything said about a cause would be invented. */
    unknown: {
      head: 'The update stopped with an error.',
      why: 'Your current install is untouched.',
      next: 'Retry. If it repeats, the message above is the part worth reporting.',
    },
  }[errorPhase]

  /** Bytes as the user thinks of them. Sizes here are always tens of MB, so
   *  one decimal is the right resolution — 86.0 MB, not 86 MB or 85.98 MB. */
  const mb = (bytes: number | undefined): string =>
    bytes === undefined ? '' : `${(bytes / 1_000_000).toFixed(1)} MB`

  /** Rounded to something a person can act on. "about 40s left" is useful;
   *  "37.4s left" is a number pretending to be a promise. */
  function eta(transferred?: number, total?: number, rate?: number): string {
    if (!transferred || !total || !rate || rate <= 0) return ''
    const secs = (total - transferred) / rate
    if (secs < 10) return 'a moment left'
    if (secs < 90) return `about ${Math.round(secs / 5) * 5}s left`
    return `about ${Math.round(secs / 60)} min left`
  }

  /** The tagline is where the state gets one word. */
  $: tagline =
    status.type === 'available' && status.sizeBytes ? mb(status.sizeBytes)
    : status.type === 'downloading' ? `${downloadPercent}%`
    : status.type === 'downloaded' ? 'staged'
    : status.type === 'error' ? 'still installed'
    : 'installed'
</script>

<WindowShell name="Software update" row>
  {#if status.type === 'checking'}
    <h2 tabindex="-1">Checking for updates.</h2>
    <div class="vers">
      <span class="v to">{currentVersion || '—'}</span>
      <span class="tagline">installed</span>
    </div>
    <div class="bar">
      <div class="track indet" role="progressbar" aria-label="Checking for updates"><i></i></div>
    </div>

  {:else if status.type === 'not-available'}
    <h2 tabindex="-1">You're on the latest version.</h2>
    <div class="vers">
      <span class="v to">{currentVersion || '—'}</span>
      <span class="tagline">installed</span>
    </div>
    <p class="p">
      Jerico checks again every six hours, and once shortly after each launch.
    </p>
    <p class="meta">Last checked just now</p>

  {:else if status.type === 'available'}
    <h2 tabindex="-1">Version {availableVersion} is available.</h2>
    <div class="vers">
      <span class="v">{currentVersion || '—'}</span>
      <span class="ar" aria-hidden="true">→</span>
      <span class="v to">{availableVersion}</span>
      <span class="tagline">{tagline}</span>
    </div>
    <!-- What the user is actually agreeing to, before they agree to it. The
         daemon restarting is the part people do not expect. -->
    <ul class="notes">
      <li>
        <span class="k">Daemon</span>
        <span class="t">
          The daemon updates with the app. Panels running right now will be
          <b>terminated</b> when you restart.
        </span>
      </li>
      <li>
        <span class="k">Signed</span>
        <span class="t">Developer ID, notarised and stapled by Apple.</span>
      </li>
      <li>
        <span class="k">Timing</span>
        <span class="t">Download now, restart whenever you like — nothing restarts on its own.</span>
      </li>
    </ul>

  {:else if status.type === 'downloading'}
    <h2 tabindex="-1">Downloading {availableVersion ?? 'the update'}.</h2>
    <div class="vers">
      <span class="v">{currentVersion || '—'}</span>
      <span class="ar" aria-hidden="true">→</span>
      <span class="v to">{availableVersion ?? '—'}</span>
      <span class="tagline">{downloadPercent}%</span>
    </div>
    <div class="bar">
      <div
        class="track"
        role="progressbar"
        aria-label="Download progress"
        aria-valuenow={downloadPercent}
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <i style="width:{downloadPercent}%"></i>
      </div>
      <div class="row">
        {#if status.total}
          <span>{mb(status.transferred)} of {mb(status.total)}</span>
        {/if}
        {#if eta(status.transferred, status.total, status.bytesPerSecond)}
          <span class="r">{eta(status.transferred, status.total, status.bytesPerSecond)}</span>
        {/if}
      </div>
    </div>
    <p class="p">You can close this window — the download keeps going.</p>

  {:else if status.type === 'preparing'}
    <h2 tabindex="-1">Preparing update…</h2>
    <div class="vers">
      <span class="v">{currentVersion || '—'}</span>
      <span class="ar" aria-hidden="true">→</span>
      <span class="v to">{status.version}</span>
      <span class="tagline">staging</span>
    </div>
    <div class="bar">
      <div class="track indet" role="progressbar" aria-label="Preparing update"><i></i></div>
    </div>
    <p class="p">Jerico is staging the update locally. You can restart once it is ready.</p>

  {:else if status.type === 'downloaded'}
    <h2 tabindex="-1">{availableVersion} is ready to install.</h2>
    <div class="vers">
      <span class="v">{currentVersion || '—'}</span>
      <span class="ar" aria-hidden="true">→</span>
      <span class="v to">{availableVersion}</span>
      <span class="tagline">staged</span>
    </div>
    <ul class="notes">
      <li>
        <span class="k">On restart</span>
        <span class="t">Jerico quits, swaps itself, and reopens in the menu bar.</span>
      </li>
      {#if status.activePanels && status.activePanels > 0}
        <li>
          <span class="k">Panels</span>
          <span class="t">
            <b>
              {status.activePanels}
              {status.activePanels === 1 ? 'panel is' : 'panels are'} running.
            </b>
            Restarting stops {status.activePanels === 1 ? 'it' : 'them'} — finish or stop your
            work first.
          </span>
        </li>
      {/if}
    </ul>

  {:else if status.type === 'error'}
    <h2 tabindex="-1">{errorCopy.head}</h2>
    <div class="vers">
      <span class="v to">{currentVersion || '—'}</span>
      <span class="tagline">still installed</span>
    </div>
    <!-- The updater's own words, quoted. Someone searching for this error
         needs the string the tool actually produced, not a paraphrase. -->
    <div class="errbox" role="alert">
      <div class="h">Updater</div>
      <div class="m">{errorMessage}</div>
      <div class="w">{errorCopy.why}</div>
    </div>
    <ul class="notes">
      <li>
        <span class="k">Next</span>
        <span class="t">{errorCopy.next}</span>
      </li>
    </ul>
  {/if}

  <svelte:fragment slot="actions">
    {#if status.type === 'available'}
      <button type="button" class="btn btn-primary" disabled={busy} on:click={handleUpdateNow}>
        {busy ? 'Starting…' : 'Download'}
      </button>
    {:else if status.type === 'downloaded'}
      <button type="button" class="btn btn-primary" disabled={busy} on:click={handleRestart}>
        {busy ? 'Restarting…' : 'Restart to apply'}
      </button>
    {:else if status.type === 'error'}
      <button type="button" class="btn btn-primary" disabled={busy} on:click={handleRetry}>
        {busy ? 'Checking…' : 'Retry'}
      </button>
    {:else if status.type === 'not-available'}
      <button type="button" class="btn btn-ghost" disabled={busy} on:click={handleRetry}>
        Check again
      </button>
    {/if}
  </svelte:fragment>
</WindowShell>
