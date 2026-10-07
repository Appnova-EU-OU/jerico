<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte'
  import type { PopoverAction, PopoverLimit, PopoverState } from '../../../preload/types.d.ts'
  import { drawTrace, padSeries, TRACE_CEILING_MS } from '../lib/trace.js'
  import UsagePanel from '../lib/UsagePanel.svelte'
  import PanelsPanel from '../lib/PanelsPanel.svelte'

  /* ── what the surface is ────────────────────────────────────────────────
     A menu-bar popover replacing tray.setContextMenu(). NSMenu gave keyboard
     navigation, dismissal, focus return and VoiceOver roles for free; none of
     them survive the swap to a BrowserWindow, so each is built here:

       ↑/↓ Home/End  move between controls, the way a menu does
       Tab/Shift+Tab  still work — the arrows are an addition, not a replacement
       Enter/Space    activate (the browser's own button behaviour)
       Esc            dismiss (main watches for it too, in case this is wedged)

     Roles: this is a dialog, not a menu, because two thirds of it is readings
     rather than commands and role="menu" would promise a list of items that
     does not exist. The state is announced through a live region instead, so a
     screen-reader user hears the same headline a sighted user sees, which is
     the one thing the disabled first item of the old NSMenu did.               */

  /** The card has two views. The detail is NOT a separate window: a menu-bar
   *  surface that spawns a window to answer a question asked from the menu bar
   *  has lost the thread. It folds back with the appbar's back control, and with
   *  Escape — which main is told about, because main watches Escape too. */
  let view: 'main' | 'usage' | 'panels' = 'main'
  let state: PopoverState | null = null
  let anchorX = 184
  let logOpen = false
  let card: HTMLDivElement
  let canvas: HTMLCanvasElement
  let live = ''

  const disposers: Array<() => void> = []

  /** Opens are user-paced, but a rapid toggle should not become five HTTP requests
   *  per provider. Quota does not move inside half a minute anyway. */
  const USAGE_REFRESH_MIN_GAP_MS = 30_000
  let lastUsageRefreshAt = 0
  /** True while a refresh this card asked for is in flight. A row with no reading
   *  yet says "reading…" rather than flashing an amber fault it is about to
   *  resolve — the fault is true and, for one second on the first open, useless. */
  let usageRefreshing = false

  function maybeRefreshUsage(): void {
    const now = Date.now()
    if (now - lastUsageRefreshAt < USAGE_REFRESH_MIN_GAP_MS) return
    lastUsageRefreshAt = now
    usageRefreshing = true
    void window.bridge.refreshUsage().finally(() => { usageRefreshing = false }).catch(() => {
      // A refresh that could not be asked for changes nothing: the register keeps
      // drawing whatever the daemon last knew, dated if it is stale.
    })
  }

  // ── state in ────────────────────────────────────────────────────────────

  onMount(() => {
    document.documentElement.classList.add('popover-host')
    document.body.classList.add('popover-host')

    disposers.push(window.bridge.onPopoverState((s) => {
      const phaseChanged = state?.presentation.phase !== s.presentation.phase
      state = s
      if (phaseChanged) announce(s)
      void afterRender()
    }))
    disposers.push(window.bridge.onPopoverAnchor((a) => { anchorX = a.centerX }))
    // Dismissed: fold back to the main view. That unmounts UsagePanel, and its
    // onDestroy clears the poll and the clock it would otherwise keep running
    // behind a hidden window.
    disposers.push(window.bridge.onPopoverHidden(() => { setView('main') }))
    disposers.push(window.bridge.onPopoverOpened(() => {
      // Opening the card IS the user action the Keychain policy reserves its prompt
      // for. The scheduled cycle refuses to read the Keychain, so on a
      // Keychain-only install the register showed `keychain_locked` until the user
      // went into the detail view and came back — which worked and was tiring, and
      // tiring is a design defect. This is the surface the register lives on;
      // refreshing when it opens is the whole point.
      //
      // Fire-and-forget: the daemon updates its cache and the next state push
      // carries the reading. Rate-limited so toggling the card quickly cannot turn
      // into a burst of provider requests.
      maybeRefreshUsage()
      // The activity register folds again on every open: "open on whatever you
      // left expanded" is a surface remembering something nobody asked it to.
      logOpen = false
      // Open on the main view every time: "open on whatever you left expanded"
      // is a surface remembering something nobody asked it to.
      setView('main')
      if (state) announce(state)
      // A menu opens on its first item. The equivalent here is NOT the first
      // control in the document — that is the activity disclosure, which is the
      // least of them — but the primary action, which by construction is the
      // reason the popover was opened at all. Falls back to the first control
      // when the primary is disabled, which is the stopping state.
      void tick().then(() => { focusPrimary() })
    }))
    void window.bridge.popoverRequestState()
  })

  onDestroy(() => {
    for (const d of disposers) d()
    document.documentElement.classList.remove('popover-host')
    document.body.classList.remove('popover-host')
    stopScan()
  })

  /** The headline and its sub-line, said once, as one sentence. Fired on open
   *  and on every phase change — not on every poll, which would interrupt a
   *  screen-reader user every five seconds to tell them nothing changed. */
  function announce(s: PopoverState): void {
    const p = s.presentation
    const sub = [p.sub.status, ...p.sub.parts].filter(Boolean).join(', ')
    live = `${p.headline}. ${sub}.`
  }

  // ── keyboard ────────────────────────────────────────────────────────────

  function controls(): HTMLElement[] {
    if (!card) return []
    return Array.from(
      card.querySelectorAll<HTMLElement>('button:not([disabled]), [href]'),
    ).filter((el) => el.offsetParent !== null)
  }

  function focusIndex(i: number): void {
    const items = controls()
    if (items.length === 0) return
    const clamped = ((i % items.length) + items.length) % items.length
    items[clamped]?.focus()
  }

  function focusPrimary(): void {
    const go = card?.querySelector<HTMLButtonElement>('.go')
    if (go && !go.disabled) { go.focus(); return }
    focusIndex(0)
  }

  function move(delta: number): void {
    const items = controls()
    if (items.length === 0) return
    const at = items.indexOf(document.activeElement as HTMLElement)
    focusIndex(at === -1 ? (delta > 0 ? 0 : items.length - 1) : at + delta)
  }

  /** Tell main which view is up. Main's own Escape watcher exists because a
   *  crashed renderer would swallow the key; without this it would also close
   *  the card from the detail view, where the expected result is one step back. */
  function setView(next: 'main' | 'usage' | 'panels'): void {
    if (view === next) return
    view = next
    void window.bridge.popoverSetNested(next !== 'main')
    void afterRender()
  }

  function onKeydown(e: KeyboardEvent): void {
    switch (e.key) {
      case 'Escape':
        e.preventDefault()
        // One step back before dismissing: the detail is a view inside the card,
        // not a card of its own.
        if (view !== 'main') { setView('main'); return }
        void window.bridge.popoverClose()
        return
      case 'ArrowDown':
        e.preventDefault(); move(1); return
      case 'ArrowUp':
        e.preventDefault(); move(-1); return
      case 'Home':
        e.preventDefault(); focusIndex(0); return
      case 'End':
        e.preventDefault(); focusIndex(controls().length - 1); return
    }
  }

  // ── actions ─────────────────────────────────────────────────────────────

  function act(action: PopoverAction): void {
    void window.bridge.popoverAction(action)
  }

  function toggleLog(): void {
    logOpen = !logOpen
    void afterRender()
  }

  // ── size ────────────────────────────────────────────────────────────────
  //
  // The window is exactly as tall as the card. Seven states of genuinely
  // different length share this surface, and a fixed height would either clip
  // the longest or leave a hole under the shortest.

  let ro: ResizeObserver | null = null

  async function afterRender(): Promise<void> {
    await tick()
    report()
    paint()
  }

  /**
   * What the card gives up when it does not fit.
   *
   * PopoverWindow.resizeTo clamps to the work area and a clamp CLIPS — nothing
   * in the card scrolls — so the first thing a short display takes is the
   * BOTTOM: the action block, the one filled control the user opened the card
   * to press. The design's own rule is that the fix is never a grey row three
   * items down; unreachable is worse still.
   *
   * The strip goes first, ahead of the log. It costs ~65pt — more than the
   * whole panels register at four panels — and it answers coarsely what the
   * sub-line already answers ("CONNECTED · up 05:38"), about the socket rather
   * than about the work. The `05-agent-limits` sheet already refuses a second
   * plot on exactly this cost-of-canvas ground.
   */
  const TRACE_COST_PT = 65
  /** The event lines, not the register: the heading and its `more ↓` stay, so
   *  the tail is one click away rather than gone. ~18pt a line, three lines. */
  const LOG_COST_PT = 55
  /** Hysteresis. Shedding shortens the card, which would otherwise satisfy the
   *  un-shed test on the very next measurement and oscillate forever. Coming
   *  back requires room for what would return AND a margin. */
  const UNSHED_MARGIN_PT = 14
  /**
   * The ladder, in the order the clash ranked it: the strip goes before the log
   * does. The strip costs more than the whole panels register at four panels and
   * answers coarsely what the sub-line already answers; the log answers "what
   * just happened", which is the causal tail and worth more.
   *
   * The user's own expansion of the log is never overridden — `logOpen` is a
   * deliberate act and the card grows for it.
   */
  let shedTrace = false
  let shedLog = false

  function report(): void {
    if (!card) return
    const measured = card.getBoundingClientRect().height
    const budget = state?.contentBudget ?? 0
    if (budget > 0) {
      // `measured` reflects what is currently DRAWN, so shedding tests it as-is
      // while restoring has to add back what would return. Asymmetric on purpose.
      if (measured > budget) {
        if (!shedTrace) shedTrace = true
        else if (!shedLog && !logOpen) shedLog = true
      } else if (shedLog && measured + LOG_COST_PT + UNSHED_MARGIN_PT <= budget) {
        shedLog = false
      } else if (!shedLog && shedTrace && measured + TRACE_COST_PT + UNSHED_MARGIN_PT <= budget) {
        shedTrace = false
      }
    }
    void window.bridge.popoverResize(measured)
  }

  $: if (card && !ro) {
    ro = new ResizeObserver(() => { report() })
    ro.observe(card)
  }
  onDestroy(() => { ro?.disconnect(); ro = null })

  // ── the strip ───────────────────────────────────────────────────────────

  const reduceMotion =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  let scanPhase = 0
  let raf: number | null = null

  function stopScan(): void {
    if (raf !== null) { cancelAnimationFrame(raf); raf = null }
  }

  function runScan(): void {
    stopScan()
    if (reduceMotion) return
    let t0: number | null = null
    const frame = (t: number): void => {
      if (t0 === null) t0 = t
      scanPhase = ((t - t0) % 1400) / 1400
      paintCanvas()
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
  }

  function toneColour(tone: 'live' | 'hold' | 'down'): string {
    return tone === 'hold' ? '#ffb547' : tone === 'down' ? '#f0655e' : '#6fdca0'
  }

  function paintCanvas(): void {
    if (!canvas || !state) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = rect.width
    const h = rect.height
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawTrace(ctx, {
      mode: state.presentation.trace,
      series: state.rttHistory ?? [],
      colour: toneColour(state.presentation.tone),
      width: w,
      height: h,
      scanPhase,
    })
  }

  function paint(): void {
    paintCanvas()
    if (state?.presentation.trace === 'scan') runScan()
    else stopScan()
  }

  // ── formatting ──────────────────────────────────────────────────────────

  function clock(at: number): string {
    const d = new Date(at)
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }

  /** Every unknown reading in this surface goes through here, so an absent
   *  value can never be drawn as a zero by accident. */
  const UNKNOWN = '—'

  function ctxLabel(pct: number | null): string {
    return pct === null ? `ctx ${UNKNOWN}` : `ctx ${String(Math.round(pct))}%`
  }

  function rttLabel(ms: number | null): string {
    return ms === null ? UNKNOWN : String(Math.round(ms))
  }

  // ── limits register ─────────────────────────────────────────────────────

  const CELL_COUNT = 14
  const CELLS = Array.from({ length: CELL_COUNT }, (_, i) => i)

  /** The provider's OWN severity when it gave one; our threshold only as a
   *  fallback. Anthropic knows which of its limits binds and we do not. */
  function limitTone(l: PopoverLimit): '' | 'warn' | 'bad' {
    if (l.severity === 'critical') return 'bad'
    if (l.severity === 'warning') return 'warn'
    if (l.usedPercent === null) return ''
    if (l.usedPercent >= 90) return 'bad'
    if (l.usedPercent >= 80) return 'warn'
    return ''
  }

  /** `3h 53m`, `2d 04h`, `47m`; a window with no reset says so rather than
   *  borrowing another window's clock, and one whose reset has passed is not
   *  drawn as a countdown — an expired countdown is the "0 ms" mistake with a
   *  clock on it. */
  function resetLabel(l: PopoverLimit): string {
    if (l.fault !== null) return UNKNOWN
    if (l.resetsAt === null) return l.usedPercent === null ? UNKNOWN : 'no reset'
    const ms = l.resetsAt - Date.now()
    if (ms <= 0) return 'passed'
    const mins = Math.floor(ms / 60000)
    const d = Math.floor(mins / 1440)
    const h = Math.floor((mins % 1440) / 60)
    const m = mins % 60
    if (d > 0) return `${d}d ${String(h).padStart(2, '0')}h`
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
    return `${m}m`
  }

  /** The row's tooltip carries what the row has no width for.
   *
   *  The first line is not decoration. This register normalises every provider to
   *  the fraction USED, but some agents state the opposite: Antigravity's own
   *  screen reads "Weekly Limit Remaining — 100.00%" for the same account this row
   *  draws as 0%. Same number, opposite convention. One word in the tooltip is the
   *  whole cost of not making a user wonder which screen is lying. */
  function limitTitle(l: PopoverLimit): string {
    const parts: string[] = []
    if (l.usedPercent !== null) parts.push(`${Math.round(l.usedPercent)}% of this limit used`)
    if (l.scope !== null) parts.push(`weekly limit scoped to ${l.scope}`)
    if (l.stale && l.fetchedAt !== null) {
      parts.push(`${l.deferred ? 'updates when usage is opened' : 'last refresh failed'} — measured ${new Date(l.fetchedAt).toLocaleTimeString()}`)
    }
    if (l.resetsAt === null && l.usedPercent !== null) parts.push('the provider reported no reset time for this window')
    return parts.join(' · ')
  }

  $: p = state?.presentation ?? null
  $: subText = p ? p.sub.parts.join(' · ') : ''
  $: visibleEvents = state ? (logOpen ? state.events.slice(-12) : state.events.slice(-3)) : []
  $: limitsCount = state?.limits === null || state?.limits === undefined
    ? ''
    : state.limits.some((l) => l.stale)
      ? 'as of last refresh'
      : `${state.limits.filter((l) => l.usedPercent !== null).length} of ${state.limits.length} reported`
  $: lastRtt = state?.lastRttMs ?? null
  $: shownSeries = state?.rttHistory === null || state?.rttHistory === undefined
    ? []
    : padSeries(state.rttHistory)
  // Redraw whenever anything the strip depends on moves.
  $: if (state && canvas) { void shownSeries; void afterRender() }
</script>

<svelte:window on:keydown={onKeydown} />

<!-- Before the first state arrives the card draws a SKELETON rather than
     nothing. It should almost never be seen now that the window is pre-warmed
     (PopoverWindow.prewarm), but "almost never" is not never: a renderer
     recreated after a crash, or a click landing inside the first paint, used to
     show a transparent void — which reads as the app being broken rather than as
     it being a moment early. No spinner: the shape of the card is the honest
     progress indicator, and a spinning glyph on a surface that resolves in under
     a frame is noise. -->
{#if !state}
  <div class="wrap jerico-ui">
    <span class="notch" style="left:{anchorX}px" aria-hidden="true"></span>
    <div class="pop" role="dialog" aria-label="Jerico daemon" aria-busy="true">
      <p class="sr" aria-live="polite">Reading the daemon.</p>
      <div class="id"><b>&nbsp;</b></div>
      <div class="reading">
        <span class="marker skel" aria-hidden="true"></span>
        <h2 class="dim">Reading…</h2>
      </div>
      <div class="sub">asking the daemon for its state</div>
      <div class="trace"></div>
    </div>
  </div>
{:else if state && p}
  <!-- The notch points at the tray icon even when the card was clamped away
       from centre at the edge of a display, which is why its x comes from main
       rather than being 50%. -->
  <div class="wrap jerico-ui">
    <span class="notch" style="left:{anchorX}px" aria-hidden="true"></span>

    <div
      class="pop"
      data-tone={p.tone}
      bind:this={card}
      role="dialog"
      aria-label="Jerico daemon"
    >
      <p class="sr" aria-live="polite">{live}</p>

      {#if view === 'usage'}
        <UsagePanel onBack={() => setView('main')} />
      {:else if view === 'panels'}
        <PanelsPanel panels={state.panels} onBack={() => setView('main')} />
      {:else}
      {#if state.update.kind !== 'none' && state.update.kind !== 'checking'}
        <div class="upd">
          <span class="w" aria-hidden="true"></span>
          <span class="t">
            {#if state.update.kind === 'available'}
              Version <b>{state.update.version}</b> is available.
            {:else if state.update.kind === 'downloading'}
              {state.update.percent === 0 ? 'Starting download…' : `Downloading ${state.update.version ?? 'update'} — ${state.update.percent}%`}
            {:else if state.update.kind === 'preparing'}
              Preparing update…
            {:else if state.update.kind === 'failed'}
              Download failed. {state.update.message || 'Try again.'}
            {:else}
              Version <b>{state.update.version}</b> downloaded and ready.
            {/if}
          </span>
          {#if state.update.kind === 'available'}
            <button type="button" on:click={() => act('update-download')}>Download</button>
          {:else if state.update.kind === 'failed'}
            <button type="button" on:click={() => act('update-download')}>Retry</button>
          {:else if state.update.kind === 'ready'}
            <button type="button" on:click={() => act('update-install')}>Restart to apply</button>
          {:else}
            <button
              type="button"
              disabled={state.update.kind === 'downloading' && state.update.percent === 0}
              on:click={() => act('updates')}
            >{state.update.kind === 'downloading' ? state.update.percent === 0 ? 'Starting…' : 'Details' : 'Details'}</button>
          {/if}
        </div>
        {#if state.update.kind === 'downloading'}
          <div class="prog"><i style="width:{state.update.percent}%"></i></div>
        {/if}
      {/if}

      <div class="id">
        <b>{state.machine}</b><span aria-hidden="true">→</span><span>{p.context || state.server}</span>
      </div>

      <div class="reading">
        <span class="marker" aria-hidden="true"></span>
        <h2>{p.headline}</h2>
      </div>
      <!-- The separator lives inside the expression: literal whitespace at an
           element boundary is trimmed by the compiler, which printed
           "connected· no panels open". -->
      <div class="sub">
        {#if p.sub.status}<span class="st">{p.sub.status}</span>{/if}{p.sub.status && subText ? ' · ' : ''}{subText}
      </div>

      {#if !shedTrace}
      <div class="trace">
        <canvas bind:this={canvas} aria-hidden="true"></canvas>
        <!-- Said as well as drawn: the strip is a canvas, and a canvas says
             nothing at all to a screen reader. -->
        <span class="rtt" class:over={lastRtt !== null && lastRtt > TRACE_CEILING_MS}>
          <b>{rttLabel(lastRtt)}</b> ms
        </span>
      </div>
      {:else}
        <!-- The reading survives even when the plot cannot: shedding the strip
             must not be mistaken for losing the round-trip time. -->
        <div class="rtt-only">
          <b>{rttLabel(lastRtt)}</b> ms
        </div>
      {/if}

      <div class="rule"></div>

      <section class="sec">
        <!-- The phase's own count, plus the register's alert when there is one.
             Appended and not replaced: `p.count` says "none open" for a stopped
             daemon and "3 held" for a paused one, and neither is "running". -->
        <h3>panels <span class="n">{p.count}{state.panelsView.alert ? ` \u00b7 ${state.panelsView.alert}` : ''}</span></h3>
        <div class="panels" role="group" aria-label="Open panels">
          {#if state.panels.length === 0}
            <div class="empty">
              {p.phase === 'offline' ? 'no panels — the daemon is stopped'
                : p.phase === 'authfailed' ? 'no panels — not signed in'
                : p.phase === 'starting' ? 'nothing spawned yet'
                : 'no panels open'}
            </div>
          {:else}
            {#each state.panelsView.rows as row (row.cwd ?? '\u0000none')}
              <div class="p">
                <!-- The project, and how many panels it holds, on one line. The
                     leaf is drawn and the full path is the title, so folding it
                     costs nothing. -->
                <span class="proj-name" title={row.cwd ?? 'these panels reported no working directory'}>
                  {row.project ?? 'no project reported'}
                </span>
                <span class="pcount">{row.panels} {row.panels === 1 ? 'panel' : 'panels'}</span>
                <!-- The busiest panel in the group. An em dash is usually
                     correct rather than missing: context comes only from the
                     Claude usage watcher, so a shell group genuinely has none. -->
                <span
                  class="m"
                  class:warn={row.topContextPct !== null && row.topContextPct >= 85}
                  title={row.topContextPct === null ? 'context usage is reported for Claude panels only' : 'the highest context reading in this project'}
                >
                  {ctxLabel(row.topContextPct)}
                </span>
              </div>
              <!-- Drawn only when the project is not settled-healthy. Counted,
                   not named: the row stands for several panels, so naming one
                   would be a lie about the others. Which panel is in the detail. -->
              {#if row.marks.length > 0}
                <div class="pmarks">
                  {#each row.marks as mark (mark.text)}
                    <span class="pmark" class:warn={mark.tone === 'warn'} class:bad={mark.tone === 'bad'}>{mark.text}</span>
                  {/each}
                </div>
              {/if}
            {/each}
            <!-- By construction the tail is all settled-healthy: faults and
                 unknowns are never capped, so nothing bad can hide in here. -->
            {#if state.panelsView.hiddenProjects > 0}
              <div class="more-p">
                +{state.panelsView.hiddenProjects} more {state.panelsView.hiddenProjects === 1 ? 'project' : 'projects'}
                ({state.panelsView.hiddenPanels} {state.panelsView.hiddenPanels === 1 ? 'panel' : 'panels'}) · all ready
              </div>
            {/if}
          {/if}
        </div>
        {#if state.panelsView.coverage}
          <div class="cover">{state.panelsView.coverage}</div>
        {/if}
        {#if state.panels.length > 0}
          <button type="button" class="limbtn" on:click={() => setView('panels')}>panel detail →</button>
        {/if}
      </section>

      {#if state.limits !== null}
        <div class="rule"></div>

        <section class="sec">
          <h3>limits <span class="n">{limitsCount}</span></h3>
          <div class="lim" role="group" aria-label="Provider limits">
            {#if state.limits.length === 0}
              <div class="empty">no provider limits reported yet</div>
            {:else}
              {#each state.limits as l (l.agent)}
                <!-- One line per agent. `cells` rather than a continuous bar: a
                     cell is a unit, and a smooth bar implies a resolution a
                     percentage does not have. -->
                <div
                  class="a"
                  class:stale={l.stale}
                  data-tone={limitTone(l)}
                  title={limitTitle(l)}
                >
                  <span class="who">{l.agent}{#if l.scope}<i>{l.scope}</i>{/if}</span>
                  {#if l.fault !== null && usageRefreshing && l.usedPercent === null}
                    <span class="reading">reading…</span>
                  {:else if l.fault !== null}
                    <span class="faulttxt">{l.fault}</span>
                  {:else if l.usedPercent === null}
                    <span class="nodata"></span>
                  {:else}
                    <span class="cells">
                      {#each CELLS as i (i)}
                        <i class:on={i < Math.round((l.usedPercent / 100) * CELL_COUNT)}></i>
                      {/each}
                    </span>
                  {/if}
                  <span class="pct"><b>{l.usedPercent === null ? UNKNOWN : `${Math.round(l.usedPercent)}%`}</b></span>
                  <span class="rst">{resetLabel(l)}</span>
                </div>
              {/each}
            {/if}
          </div>
          <!-- The card's own button primitive, one step below the primary:
               transparent ground and an --edge border rather than the bright
               fill. Prominent because the register's most expensive content is
               behind it, and `→` rather than `↓` because it leaves the card. -->
          <button type="button" class="limbtn" on:click={() => setView('usage')}>usage detail →</button>
        </section>
      {/if}

      <div class="rule"></div>

      <section class="sec">
        <h3>
          activity
          <button
            type="button"
            class="disc"
            aria-expanded={logOpen}
            aria-controls="popover-log"
            on:click={toggleLog}
          >{logOpen ? 'less ↑' : 'more ↓'}</button>
        </h3>
        <div
          class="log"
          id="popover-log"
          data-open={logOpen ? '1' : '0'}
          role="log"
          aria-label="Recent activity"
        >
          {#if shedLog && !logOpen}
            <!-- Shed for room, not empty: saying so is the difference between a
                 quiet machine and a card that ran out of card. -->
            <div class="ln"><span class="e">hidden for room — open to read</span></div>
          {:else if visibleEvents.length === 0}
            <div class="ln"><span class="e">nothing recorded yet</span></div>
          {:else}
            {#each visibleEvents as e, i (`${e.at}|${e.event}|${i}`)}
              <div class="ln {e.level}">
                <span class="t">{clock(e.at)}</span>
                <span class="e">{e.event}</span>
                <span class="v">{e.detail}</span>
              </div>
            {/each}
          {/if}
        </div>
      </section>

      <div class="rule"></div>

      <!-- The primary action follows the fault, exactly as the headline does:
           normally it leaves for the app, but when the daemon is down it starts
           it, and when the token is rejected it re-authenticates. -->
      <div class="acts">
        <button
          type="button"
          class="go"
          disabled={!p.primary.enabled || state.busy}
          on:click={() => act(p.primary.action)}
        >{p.primary.label}</button>
        <div class="verbs">
          {#each p.verbs as verb (verb.action + verb.label)}
            <button
              type="button"
              class="verb {verb.tone}"
              disabled={state.busy}
              on:click={() => act(verb.action)}
            >{verb.label}</button>
          {/each}
        </div>
      </div>

      {/if}

      <div class="foot">
        <span class="v" title={state.daemonVersion ? `daemon ${state.daemonVersion}` : 'daemon version unknown'}>
          {state.appVersion}
        </span>
        <button type="button" on:click={() => act('manage')}>manage</button>
        <span class="d" aria-hidden="true">/</span>
        <button type="button" on:click={() => act('updates')}>updates</button>
        <span class="d" aria-hidden="true">/</span>
        <button type="button" on:click={() => act('logs')}>logs</button>
        <span class="d" aria-hidden="true">/</span>
        <button type="button" on:click={() => act('quit')}>quit</button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* Ported from design/01-tray-popover.html rev D. Scoped to this component
     rather than added to app.css: the tokens are shared, the one-off geometry
     of a 368pt menu-bar card is not, and app.css is a document three other
     windows also live in. */

  .wrap {
    position: relative;
    padding: 7px 22px 22px;   /* the notch, then room for the card's shadow */
    background: transparent;
  }

  /* The card and the notch are OPAQUE.
     The design drew both at ~85% over a macOS vibrancy blur. That composition
     was tried and reverted in popover.ts: the material fills the whole window
     rect, including the padding this card's shadow falls into, so it printed a
     milky halo around the card over any bright background — and at 82% the
     card's own graphite lifted towards whatever was behind it. `--win` is
     #0e0e0d, so an opaque card is the ground the design already specifies; what
     is lost is the blur, and what is gained is a surface that reads identically
     over every wallpaper. It is also the whole of the Reduce Transparency
     answer: there is one rendering, and it is the opaque one. */
  .notch {
    position: absolute; top: 1px; margin-left: -7px;
    width: 14px; height: 7px;
    clip-path: polygon(50% 0, 100% 100%, 0 100%);
    background: #131312;
    z-index: 3;
  }

  .pop {
    --state: var(--live);
    position: relative;
    border-radius: 10px;
    background: var(--win);
    border: 1px solid rgba(255, 255, 255, .075);
    /* THE SHADOW MUST DECAY INSIDE THE PADDING BELOW. It is not a free choice.
       The window is transparent and exactly SHADOW_PAD wider than the card
       (popover.ts), so anything the shadow still has left at that boundary is
       cut off by the window rect — which prints a flat rectangle the size of
       the WINDOW with a straight edge on every side. Over a dark wallpaper that
       is invisible; over a bright one it reads as an opaque near-white sheet
       around the card, which is how it reached a user.

       The design's `0 24px 60px -20px` is drawn in design/01-tray-popover.html
       against a dark page with unlimited room, where neither the extent nor the
       clip can be seen. Measured in the real window over a pure-white backdrop
       it is still at 236/255 (sides) and 191/255 (bottom) when it hits the
       window edge, and does not reach the backdrop until ~68px from the card.

       These values were measured, not guessed. Over #FFF this reaches 255 —
       the untouched backdrop — on all four edges, decaying to it 19px under the
       card and 14px to the sides, inside the 22px available; and it is DARKER
       than the original directly beneath the card (109/255 against 130/255).
       The card is lifted more and the wash is gone. The vertical offset carries
       the top edge: only 7px of padding exists above the card (the notch), so a
       shadow centred any higher than +6px clips there instead. Retune only
       against the same measurement, on all four edges. */
    box-shadow: 0 0 0 .5px rgba(0, 0, 0, .75), 0 6px 12px -3px rgba(0, 0, 0, .9);
    overflow: hidden;
  }
  .pop[data-tone='hold'] { --state: var(--hold); }
  .pop[data-tone='down'] { --state: var(--down); }

  /* announced, never shown */
  .sr {
    position: absolute; width: 1px; height: 1px;
    padding: 0; margin: -1px; overflow: hidden;
    clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }

  /* ── update notice ─────────────────────────────────────────────────── */

  .upd {
    display: flex; align-items: baseline; gap: 9px;
    padding: 9px 15px 10px; border-bottom: 1px solid rgba(255, 255, 255, .06);
  }
  .upd .w { width: 7px; height: 7px; background: var(--hold); flex: none; align-self: center; }
  .upd .t { flex: 1; font-family: var(--mono); font-size: 10.5px; letter-spacing: .03em; color: var(--ink-2); }
  .upd .t b { font-weight: 500; color: var(--ink); }
  .upd button {
    font-family: var(--mono); font-size: 10px; font-weight: 500; letter-spacing: .09em;
    text-transform: uppercase; color: var(--hold); background: none;
    border: 0; border-bottom: 1px solid rgba(255, 181, 71, .45); padding: 0 0 1px; cursor: pointer;
    transition: color .14s var(--ease), border-color .14s var(--ease);
  }
  .upd button:hover { color: #ffcd7d; border-color: #ffcd7d; }
  .upd button:focus-visible { outline: 1px solid var(--hold); outline-offset: 3px; }

  /* download progress: a rule that fills, directly under the notice it describes */
  .prog { height: 1px; background: rgba(255, 255, 255, .07); }
  .prog i { display: block; height: 1px; background: var(--hold); transition: width .4s linear; }

  /* ── identity ──────────────────────────────────────────────────────── */

  .id {
    display: flex; align-items: center; gap: 7px; padding: 10px 15px 0;
    font-family: var(--mono); font-size: 10px; letter-spacing: .04em;
    color: var(--ink-ghost); white-space: nowrap;
  }
  .id b { font-weight: 400; color: var(--ink-3); }
  .id span:last-child { overflow: hidden; text-overflow: ellipsis; }

  /* ── the primary reading ───────────────────────────────────────────── */

  .reading { padding: 5px 15px 0; display: flex; align-items: flex-start; gap: 10px; }
  .marker { width: 7px; height: 7px; margin-top: 14px; background: var(--state); flex: none; }
  /* The skeleton's marker carries no state colour, because no state is known
     yet — drawing it green would be a claim. */
  .marker.skel { background: var(--rule-2); }
  .reading h2.dim { color: var(--ink-3); }
  .reading h2 {
    margin: 0;
    font-size: 33px; font-weight: 300; font-stretch: 125%;
    letter-spacing: -.028em; line-height: 1.04; color: var(--ink);
  }
  .sub {
    padding: 3px 15px 0 32px;
    font-family: var(--mono); font-size: 10.5px; letter-spacing: .03em; color: var(--ink-3);
  }
  .sub .st { color: var(--state); }

  /* ── heartbeat trace ───────────────────────────────────────────────── */

  .trace { position: relative; margin: 11px 0 0; height: 54px; }
  .trace canvas { display: block; width: 100%; height: 54px; }
  .trace .rtt {
    position: absolute; right: 15px; top: 2px;
    font-family: var(--mono); font-size: 10px; letter-spacing: .06em; color: var(--ink-ghost);
    background: linear-gradient(90deg, transparent, var(--win) 24%); padding-left: 20px;
  }
  .trace .rtt b { font-weight: 500; color: var(--ink-2); }
  .trace .rtt.over b { color: var(--hold); }

  .rule { height: 1px; background: rgba(255, 255, 255, .06); }

  /* ── registers ─────────────────────────────────────────────────────── */
  /* Lowercase mono section words — a terminal habit, not a dashboard tag. */

  .sec { padding: 10px 15px 11px; }
  .sec > h3 {
    margin: 0 0 6px; font-family: var(--mono); font-size: 10px; font-weight: 400;
    letter-spacing: .06em; color: var(--ink-ghost);
    display: flex; align-items: baseline; gap: 8px;
  }
  .sec > h3 .n { margin-left: auto; opacity: .85; }

  .panels { display: flex; flex-direction: column; gap: 3px; }
  .panels .p {
    display: flex; align-items: baseline; gap: 9px;
    font-family: var(--mono); font-size: 11px; letter-spacing: .01em;
  }
  /* The project owns the line; its panel count sits right beside the name
     rather than in a far column, because "jerico, 3 panels" is one fact. */
  .panels .p .proj-name { color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .panels .p .pcount { color: var(--ink-3); flex: 1; }
  .panels .p .m { color: var(--ink-ghost); }
  .panels .p .m.warn { color: var(--hold); }
  .panels .empty { font-family: var(--mono); font-size: 11px; color: var(--ink-ghost); }

  /* The secondary line of a panel row. Indented to the project column so it
     reads as belonging to the row above rather than as a row of its own, and
     drawn only when the panel is not settled-healthy — so in the ordinary case
     it costs nothing at all. */
  /* One mark per line, and no separator between them. A gate fault and a hook
     fault are two independent facts needing two different fixes, so they get two
     lines; and a middot between wrapped flex items ends up dangling at a line
     end, which reads as a rendering bug rather than as punctuation. The tight
     line-height is deliberate: the inherited 1.58 opened a gap wide enough to
     look like a missing row. */
  .panels .pmarks {
    margin: 1px 0 3px 0; display: flex; flex-direction: column;
    font-family: var(--mono); font-size: 9.5px; line-height: 1.45;
    letter-spacing: .01em; color: var(--ink-3);
  }
  /* `pmark`, not `mark`: app.css:139 defines `.jerico-ui .mark { margin-bottom:
     18px }`, and the card renders inside `.jerico-ui`, so a span called `mark`
     picked up 18pt of margin and double-spaced these lines — measured at 63.5px
     for two 13.8px lines. The same shape of collision the popover already hit
     with `.btn`. */
  .panels .pmarks .pmark.warn { color: var(--hold); }
  .panels .pmarks .pmark.bad { color: var(--down); }

  /* The tail the row cap folded away. By construction it is all settled-healthy,
     which is why it can be one quiet line instead of N rows. */
  .panels .more-p {
    margin-top: 4px; font-family: var(--mono); font-size: 9.5px; color: var(--ink-ghost);
  }

  /* What pays for the silence: a constant-size account of the whole population,
     including the rows the cap hid. Without it, the absence of a gate or hook
     word would have to be taken on faith. */
  /* What is left of the heartbeat when the strip is shed: the number, without
     the 54px of canvas. Losing the plot must not read as losing the reading. */
  .rtt-only {
    padding: 2px 15px 9px; font-family: var(--mono); font-size: 10px;
    letter-spacing: .02em; color: var(--ink-ghost);
  }
  .rtt-only b { color: var(--ink-2); font-weight: 400; }

  .cover {
    margin-top: 9px; font-family: var(--mono); font-size: 9.5px;
    letter-spacing: .02em; color: var(--ink-ghost);
  }

  /* ── limits register (design/05-agent-limits.html, layout `cells`) ──── */

  .lim { display: flex; flex-direction: column; gap: 4px; }

  /* One line per agent in the approved layout. The gauge column is the only
     thing that varies, which is what let three layouts be compared fairly. */
  .lim .a {
    display: grid; align-items: center; gap: 0 10px;
    grid-template-columns: 92px 1fr 46px 62px;
    font-family: var(--mono); font-size: 11px; letter-spacing: .01em;
  }
  /* A model-scoped window's name can be long (`gpt-5.3-codex-spark`), and the
     column is 92px. Ellipsis rather than overflow: a row that pushes its own
     gauge off the card is worse than a truncated name, and the full string is on
     the row's title. */
  .lim .a .who {
    color: var(--ink); white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
  }
  /* The scoped window's model, when that is the constrained one. */
  .lim .a .who i {
    font-style: normal; color: var(--ink-ghost); font-size: 9.5px;
    letter-spacing: .05em; margin-left: 5px;
  }
  .lim .a .pct { color: var(--ink-2); text-align: right; font-variant-numeric: tabular-nums; }
  .lim .a .pct b { font-weight: 500; }
  .lim .a .rst { color: var(--ink-ghost); text-align: right; font-variant-numeric: tabular-nums; }
  .lim .a[data-tone='warn'] .pct b { color: var(--hold); }
  .lim .a[data-tone='bad'] .pct b { color: var(--down); }
  /* A reading nothing is refreshing is drawn quieter than a live one. Not
     hidden — it is still true — but it must not compete with a current number. */
  .lim .a.stale { opacity: .62; }

  .cells { display: flex; gap: 1.5px; align-items: center; height: 11px; }
  .cells i { display: block; width: 4px; height: 7px; background: var(--rule-2); border-radius: .5px; }
  .cells i.on { background: var(--ink-3); }
  .lim .a[data-tone='warn'] .cells i.on { background: var(--hold); }
  .lim .a[data-tone='bad'] .cells i.on { background: var(--down); }

  /* Unknown NEVER renders as an empty gauge: an empty gauge reads as "plenty
     left", which is the most expensive misreading this register can produce. */
  .nodata {
    display: block; height: 1px; margin-right: 6px;
    background: repeating-linear-gradient(90deg, var(--rule-2) 0 4px, transparent 4px 7px);
  }
  /* A FAULT is not the same as never-measured. Both lack a number and only one
     is actionable, so the actionable one gets a word and a colour. */
  .faulttxt {
    display: block; color: var(--hold); font-size: 10px; letter-spacing: .02em;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  /* Not amber: nothing is wrong yet. */
  .reading { display: block; color: var(--ink-ghost); font-size: 10px; letter-spacing: .02em; }

  .limbtn {
    display: block; width: 100%; margin-top: 10px; padding: 9px 14px;
    font-family: var(--mono); font-size: 10.5px; font-weight: 500;
    letter-spacing: .09em; text-transform: uppercase;
    background: transparent; color: var(--ink-2);
    border: 1px solid var(--edge); border-radius: 2px; cursor: pointer;
    transition: color .16s var(--ease), border-color .16s var(--ease), background .16s var(--ease);
  }
  .limbtn:hover { color: var(--ink); border-color: var(--ink-3); background: rgba(255, 255, 255, .03); }
  .limbtn:focus-visible { outline: 1px solid var(--ink-3); outline-offset: 3px; }

  /* activity is folded by default — three lines is enough to notice a problem;
     the full tail is one click away and the log file is in the foot. */
  .disc {
    margin-left: auto; font: inherit; font-family: var(--mono); font-size: 10px;
    color: var(--ink-ghost); background: none; border: 0; padding: 0; cursor: pointer;
    transition: color .14s var(--ease);
  }
  .disc:hover { color: var(--ink-2); }
  .disc:focus-visible { outline: 1px solid var(--ink-3); outline-offset: 2px; }

  /* max-height, not height: the newest lines pin to the bottom, but a register
     with one line in it must be one line tall. A fixed 52px band left 35px of
     air under a single event on a fresh launch, which reads as something
     failing to render rather than as nothing having happened yet. */
  .log {
    display: flex; flex-direction: column; gap: 1px; overflow: hidden;
    justify-content: flex-end; max-height: 52px;
    transition: max-height .22s var(--ease);
  }
  .log[data-open='1'] {
    max-height: 209px;
    -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 20px);
    mask-image: linear-gradient(180deg, transparent 0, #000 20px);
  }
  .log .ln {
    display: flex; gap: 8px; white-space: nowrap;
    font-family: var(--mono); font-size: 10.5px; line-height: 1.56;
  }
  .log .ln .t { color: var(--ink-ghost); flex: none; }
  .log .ln .e { color: var(--ink-3); flex: none; }
  .log .ln .v { color: var(--ink-ghost); overflow: hidden; text-overflow: ellipsis; }
  .log .ln:last-child .e { color: var(--ink); }
  .log .ln:last-child .v { color: var(--ink-3); }
  .log .ln.warn .e { color: var(--hold); }
  .log .ln.bad .e { color: var(--down); }

  /* ── actions: verbs, no icons, no shortcut chips ───────────────────── */

  .acts { padding: 11px 15px 12px; display: flex; flex-direction: column; align-items: stretch; gap: 0; }
  .verbs { display: flex; flex-direction: column; align-items: flex-start; }

  .go {
    align-self: stretch;
    display: inline-flex; align-items: center; justify-content: center;
    margin-bottom: 8px; padding: 10px 14px;
    font-family: var(--mono); font-size: 11px; font-weight: 500;
    letter-spacing: .09em; text-transform: uppercase;
    background: var(--ink); color: var(--bg);
    border: 1px solid var(--ink); border-radius: 2px; cursor: pointer;
    transition: background .18s var(--ease), box-shadow .18s var(--ease), transform .12s var(--ease);
  }
  .go:hover:not(:disabled) { background: #fff; border-color: #fff; box-shadow: 0 8px 30px -14px rgba(255, 255, 255, .5); }
  .go:active:not(:disabled) { transform: scale(.985); background: var(--ink); }
  .go:focus-visible { outline: 1px solid var(--ink-3); outline-offset: 3px; }
  .go:disabled { background: transparent; color: var(--ink-ghost); border-color: var(--edge); cursor: default; box-shadow: none; }

  .verb {
    position: relative; padding: 5px 0 5px 13px; margin-left: -13px;
    font-family: var(--display); font-size: 13.5px; font-weight: 400;
    letter-spacing: -.008em; color: var(--ink-2);
    background: none; border: 0; cursor: pointer; text-align: left;
    transition: color .14s var(--ease);
  }
  .verb::before {
    content: ""; position: absolute; left: 0; top: 50%; width: 5px; height: 1px;
    background: currentColor; transform: translateY(-50%) scaleX(0); transform-origin: left;
    transition: transform .16s var(--ease);
  }
  .verb:hover:not(:disabled) { color: var(--ink); }
  .verb:hover:not(:disabled)::before { transform: translateY(-50%) scaleX(1); }
  .verb:focus-visible { outline: 1px solid var(--ink-3); outline-offset: 2px; }
  .verb.warn:hover:not(:disabled) { color: var(--hold); }
  .verb.bad:hover:not(:disabled) { color: var(--down); }
  .verb:disabled { color: var(--ink-ghost); cursor: default; }

  /* ── foot ──────────────────────────────────────────────────────────── */

  .foot {
    display: flex; align-items: baseline; gap: 11px;
    padding: 9px 15px 11px; border-top: 1px solid rgba(255, 255, 255, .06);
    font-family: var(--mono); font-size: 10px; letter-spacing: .06em;
  }
  .foot .v { color: var(--ink-ghost); flex: 1; }
  .foot button {
    font: inherit; color: var(--ink-3); background: none; border: 0; padding: 2px 0; cursor: pointer;
    transition: color .14s var(--ease);
  }
  .foot button:hover { color: var(--ink); }
  .foot button:focus-visible { outline: 1px solid var(--ink-3); outline-offset: 2px; }
  .foot .d { color: var(--ink-ghost); opacity: .55; }
</style>
