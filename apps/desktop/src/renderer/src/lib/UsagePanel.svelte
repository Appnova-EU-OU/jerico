<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import type { UsageDetail } from '../../../preload/types.d.ts'
  import { ago } from './freshness.js'
  import { isUsageWindowExpired } from './usage-window-freshness.js'

  /* ── what this is ──────────────────────────────────────────────────────
     design/06-agent-usage.html, rendered INSIDE the popover as a second view
     rather than in its own window. The window version was built first and was
     wrong: a menu-bar surface that spawns a window to answer a question the user
     asked from the menu bar has lost the thread.

     The one thing that made a window tempting is real, and is solved here
     instead: at 368pt this content runs to ~950pt, and PopoverWindow.resizeTo
     clamps the card to the display's work area — which CLIPS rather than
     scrolls. So the register list scrolls inside a bounded region and the card
     stays a predictable height on every display.                            */

  const UNKNOWN = '—'
  /** Slow on purpose: the daemon itself only refreshes every five minutes, and a
   *  five-hour window does not move inside thirty seconds. */
  const POLL_MS = 30_000

  let usage: UsageDetail[] | null = null
  let daemonReachable = true
  /** A daemon answered on this port and it belongs to another profile. Its numbers
   *  are somebody else's; "not running" would be the wrong sentence for it. */
  let foreign = false
  let loaded = false
  let selected: string | null = null
  let refreshing = false
  let poll: ReturnType<typeof setInterval> | null = null
  /** Ticks so countdowns move without another round-trip. */
  let now = Date.now()
  let clock: ReturnType<typeof setInterval> | null = null

  export let onBack: () => void

  /**
   * `force` re-reads every provider at the source; without it this reads the
   * daemon's cache.
   *
   * The button and the first open force, because the daemon's scheduled cycle
   * refuses to touch the Keychain — so on a Keychain-only install the cache has no
   * Claude reading until somebody asks, and asking is exactly what opening this
   * view is. The 30-second poll does NOT force: quota moves slowly and a prompt
   * every half minute would be the behaviour the policy exists to prevent.
   */
  async function load(force = false): Promise<void> {
    refreshing = true
    try {
      const res = force ? await window.bridge.refreshUsage() : await window.bridge.getUsageDetail()
      usage = res.usage
      daemonReachable = res.daemonReachable
      foreign = res.foreign === true
      loaded = true
      // Keep the selection when it still exists; otherwise lead with the agent
      // closest to a ceiling, which is why the view was opened.
      if (usage !== null && (selected === null || !usage.some((u) => u.agent === selected))) {
        selected = mostConstrainedAgent(usage)
      }
    } finally {
      refreshing = false
    }
  }

  function mostConstrainedAgent(list: UsageDetail[]): string | null {
    let best: { agent: string; pct: number } | null = null
    for (const u of list) {
      for (const w of u.windows) {
        if (best === null || w.usedPercent > best.pct) best = { agent: u.agent, pct: w.usedPercent }
      }
    }
    return best?.agent ?? list[0]?.agent ?? null
  }

  onMount(() => {
    void load(true)
    poll = setInterval(() => { void load() }, POLL_MS)
    clock = setInterval(() => { now = Date.now() }, 1000)
  })
  onDestroy(() => {
    if (poll !== null) clearInterval(poll)
    if (clock !== null) clearInterval(clock)
  })

  // ── readings ──────────────────────────────────────────────────────────

  type Win = UsageDetail['windows'][number]

  function tone(w: Win): '' | 'warn' | 'bad' {
    // The provider's own severity first; our threshold only when it gave none.
    if (w.severity === 'critical') return 'bad'
    if (w.severity === 'warning') return 'warn'
    if (w.usedPercent >= 90) return 'bad'
    if (w.usedPercent >= 80) return 'warn'
    return ''
  }

  function resetLabel(w: Win): string {
    if (w.resetsAt === null) return 'no reset reported'
    const ms = w.resetsAt - now
    // An expired countdown is not drawn as a countdown: it would be a claim
    // about the future made from a measurement in the past.
    if (ms <= 0) return 'reset has passed'
    const mins = Math.floor(ms / 60000)
    const d = Math.floor(mins / 1440)
    const h = Math.floor((mins % 1440) / 60)
    const m = mins % 60
    if (d > 0) return `resets in ${d}d ${String(h).padStart(2, '0')}h`
    if (h > 0) return `resets in ${h}h ${String(m).padStart(2, '0')}m`
    return `resets in ${m}m`
  }

  /** Arithmetic on two numbers the provider already gave, never a new
   *  measurement. null when there is no reset or no length — then there is no
   *  clock to compare against and a pace would be invented. */
  function pace(w: Win): { text: string; over: boolean } | null {
    if (w.resetsAt === null || w.windowMinutes === null || w.windowMinutes <= 0) return null
    const windowMs = w.windowMinutes * 60000
    const remaining = w.resetsAt - now
    if (remaining <= 0 || remaining > windowMs) return null
    const elapsed = (windowMs - remaining) / windowMs
    const gap = Math.round(w.usedPercent - elapsed * 100)
    if (Math.abs(gap) < 5) return { text: 'on pace · lasts to reset', over: false }
    if (gap > 0) return { text: `ahead of pace by ${gap}% · will not last to reset`, over: true }
    return { text: `behind pace by ${Math.abs(gap)}% · lasts to reset`, over: false }
  }

  // `ago` lives in lib/freshness.ts so the clock arithmetic can be tested.

  /** Each fault gets its own sentence and its own remedy. One generic "could not
   *  load" would send a user to retry the very thing retrying cannot fix. */
  function faultCopy(code: string | null, detail: string | null, agent: string): { title: string; lines: string[] } {
    const extra = detail !== null && detail.length > 0 ? [detail] : []
    switch (code) {
      case 'scope_insufficient':
        return { title: 'This token cannot read usage', lines: [...extra, 'sign in to the agent again — Jerico picks it up on the next refresh'] }
      case 'no_credentials':
        return { title: 'Not signed in', lines: [...extra, 'Jerico reads what the agent already stored — it never asks for a password'] }
      case 'no_usage_token':
        return { title: 'No usage token available', lines: extra }
      case 'unauthorized':
        // The sign-in is usually FINE. What lapsed is the short-lived access
        // token some CLIs store — kimi's lasts ~15 minutes, agy's about an hour —
        // and the agent renews it whenever it runs.
        return { title: 'The access token expired', lines: extra }
      case 'token_lapsed':
        return { title: 'Reading paused', lines: agent === 'kimi' ? [...extra, 'Kimi API key: add `kimiApiKey` in the profile settings for a reading that never pauses'] : extra }
      case 'keychain_locked':
        return { title: 'The credential is locked', lines: [...extra, 'a background refresh never raises a prompt — unlock the keychain, then refresh'] }
      case 'keychain_deferred':
        return { title: 'Open usage to read the credential', lines: extra }
      case 'interactive_deferred':
        return { title: 'Open usage to refresh agy', lines: extra }
      case 'no_limits':
        return { title: 'Nothing to meter on this plan', lines: [...extra, 'every quota this provider reports is unlimited'] }
      case 'network':
        return { title: 'Could not reach the provider', lines: extra }
      case 'malformed':
        return { title: 'The provider’s answer could not be read', lines: [...extra, 'a wire change, not something to fix here'] }
      default:
        return { title: 'No reading', lines: extra }
    }
  }

  function money(v: number, currency: string): string {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(v)
    } catch {
      // An unknown ISO code must not take the view down with it.
      return `${v.toFixed(2)} ${currency}`
    }
  }

  /** The tab strip's mini bar tracks the MOST CONSTRAINED window, not the
   *  session: an agent is limited by whichever ceiling it reaches first. */
  function worstOf(u: UsageDetail): Win | null {
    let worst: Win | null = null
    for (const w of u.windows) if (worst === null || w.usedPercent > worst.usedPercent) worst = w
    return worst
  }

  $: current = usage === null ? null : (usage.find((u) => u.agent === selected) ?? usage[0] ?? null)
  $: parents = current === null ? [] : current.windows.filter((w) => w.scopedUnder === null)
  $: orphans =
    current === null
      ? []
      : current.windows.filter((w) => w.scopedUnder !== null && !parents.some((p) => p.id === w.scopedUnder))

  function childrenOf(id: string): Win[] {
    return current === null ? [] : current.windows.filter((w) => w.scopedUnder === id)
  }
</script>

<!-- The appbar. Deliberately the mirror of the window chrome in Manage and
     Software update — same 38px band, same hairline, same right-aligned
     uppercase mono name — with a back control where a window would carry its
     traffic lights. Nothing new is introduced; an existing pattern is reused
     with the one element that differs. -->
<div class="bar">
  <button type="button" class="back" on:click={onBack} aria-label="Back to limits">
    <span aria-hidden="true">←</span> limits
  </button>
  <span class="name">agent usage</span>
</div>

<div class="scroll">
  {#if !loaded}
    <div class="msg">reading…</div>
  {:else if usage === null}
    <div class="msg">
      {foreign
        ? 'a daemon from another profile is answering on this port — its readings are not this profile’s to show'
        : daemonReachable
          ? 'this daemon does not report provider limits — update it to see them here'
          : 'the daemon is not running, so nothing can be read right now'}
    </div>
  {:else if usage.length === 0}
    <!-- Nothing reported is a state, not an error, and it is the honest default
         until an agent has a fetcher. -->
    <div class="msg">no agent on this machine reports provider limits yet</div>
  {:else}
    {#if usage.length > 1}
      <div class="tabs" role="tablist">
        {#each usage as u (u.agent)}
          {@const worst = worstOf(u)}
          <button
            class="tab"
            role="tab"
            aria-selected={u.agent === selected}
            data-tone={worst === null ? '' : tone(worst)}
            on:click={() => (selected = u.agent)}
          >
            <span>{u.agent}</span>
            {#if worst === null}
              <span class="mini nodata"></span>
            {:else}
              <span class="mini"><i style="width:{worst.usedPercent}%"></i></span>
            {/if}
          </button>
        {/each}
      </div>
      <div class="rule"></div>
    {/if}

    {#if current !== null}
      <div class="who">
        <h2>{current.agent}</h2>
        {#if current.plan}<span class="plan">{current.plan}</span>{/if}
      </div>
      <div class="src">
        {#if current.fetchedAt === null}
          never fetched
        {:else}
          updated <b>{ago(current.fetchedAt, now)}</b>{#if current.source} · {current.source}{/if}
        {/if}
        {#if current.stale && current.faultDetail}
          <br />{current.faultCode === 'keychain_deferred' || current.faultCode === 'interactive_deferred' ? 'updates when usage is opened' : 'last refresh failed'}: {current.faultDetail}
        {/if}
      </div>

      {#if current.windows.length === 0}
        {@const f = faultCopy(current.faultCode, current.faultDetail, current.agent)}
        <div class="rule"></div>
        <div class="fault">
          <div class="h"><span class="w"></span><span class="t">{f.title}</span></div>
          {#each f.lines as line (line)}<p>{line}</p>{/each}
        </div>
      {:else}
        <div class="stack" class:stale={current.stale}>
          {#each parents as p (p.id)}
            <div class="rule"></div>
            <section class="win" data-tone={tone(p)}>
              <h3>{p.title}<span class="k">{p.id}</span></h3>
              {#if isUsageWindowExpired(p, now)}
                <div class="absent"><span class="hair"></span>expired — refresh usage</div>
              {:else}
              <div class="bar2"><i style="width:{p.usedPercent}%"></i></div>
              <!-- `isActive` is the provider's own statement about which of its
                   limits is currently binding — Anthropic reports the session
                   inactive while weekly is what will stop you. It was parsed,
                   published in /health and validated on this side, and then drawn
                   by nothing at all; either use it or stop carrying it. -->
              {#if !p.isActive}<div class="notbinding">not currently binding</div>{/if}
              <div class="line">
                <!-- The counts when the provider gave them: "139 of 200 requests"
                     is more actionable than "70%", and dropping it would throw
                     away the more useful of the two facts. -->
                <span class="u">
                  {#if p.counts}{p.counts.used} of {p.counts.limit}{:else}{Math.round(p.usedPercent)}% used{/if}
                </span>
                {#if p.counts}<span class="pc">{Math.round(p.usedPercent)}%</span>{/if}
                <span class="r">{resetLabel(p)}</span>
              </div>
              {#if pace(p)}
                {@const pc = pace(p)}
                <div class="pace" class:over={pc?.over}><b>{pc?.text}</b></div>
              {/if}
              {/if}
              {#if childrenOf(p.id).length > 0}
                <!-- Scoped windows nest: a model-scoped weekly limit is a
                     sub-limit of weekly, not a fourth budget. -->
                <div class="scoped">
                  {#each childrenOf(p.id) as c (c.id)}
                    <div class="s" data-tone={tone(c)}>
                      <span class="nm">{c.title}</span>
                      {#if isUsageWindowExpired(c, now)}
                        <span class="nr">expired — refresh usage</span>
                      {:else}
                      <span class="sb"><i style="width:{c.usedPercent}%"></i></span>
                      <span class="sv">{Math.round(c.usedPercent)}%</span>
                      {#if !c.isActive}<span class="nr">not binding</span>{/if}
                      {#if c.resetsAt === null}<span class="nr">no reset</span>{/if}
                      {/if}
                    </div>
                  {/each}
                </div>
              {/if}
            </section>
          {/each}

          {#if orphans.length > 0}
            <div class="rule"></div>
            <section class="win">
              <h3>scoped limits<span class="k">parent not reported</span></h3>
              <div class="scoped">
                {#each orphans as c (c.id)}
                  <div class="s" data-tone={tone(c)}>
                    <span class="nm">{c.title}</span>
                    {#if isUsageWindowExpired(c, now)}
                      <span class="nr">expired — refresh usage</span>
                    {:else}
                    <span class="sb"><i style="width:{c.usedPercent}%"></i></span>
                    <span class="sv">{Math.round(c.usedPercent)}%</span>
                    {/if}
                  </div>
                {/each}
              </div>
            </section>
          {/if}

          {#if current.cost !== null}
            <div class="rule"></div>
            <section class="win">
              <h3>extra usage<span class="k">{current.cost.period ?? 'monthly'}</span></h3>
              {#if !current.cost.enabled}
                <!-- Never a zero balance: no arrangement is not an exhausted
                     arrangement, and a 0-of-0 gauge says the opposite. -->
                <div class="absent"><span class="hair"></span>not enabled on this account</div>
              {:else}
                <div class="bar2">
                  <i style="width:{current.cost.limit === null || current.cost.limit === 0
                    ? 0
                    : Math.min(100, (current.cost.used / current.cost.limit) * 100)}%"></i>
                </div>
                <div class="line">
                  <span class="u">{money(current.cost.used, current.cost.currency)}</span>
                  <span class="r">
                    {current.cost.limit === null ? UNKNOWN : `of ${money(current.cost.limit, current.cost.currency)}`}
                  </span>
                </div>
              {/if}
            </section>
          {/if}
        </div>
      {/if}
    {/if}
  {/if}
</div>

<div class="actbar">
  <button type="button" class="rf" disabled={refreshing} on:click={() => void load(true)}>
    {refreshing ? 'refreshing…' : 'refresh'}
  </button>
</div>

<style>
  /* ── the appbar ─────────────────────────────────────────────────────── */

  .bar {
    display: flex; align-items: center; gap: 10px; height: 38px; flex: none;
    padding: 0 13px; border-bottom: 1px solid rgba(255, 255, 255, .06);
  }
  /* Same primitive as the popover's other quiet controls, with the arrow as a
     separate element so it never wraps away from its label. */
  .back {
    display: inline-flex; align-items: center; gap: 6px;
    font: inherit; font-family: var(--mono); font-size: 10px;
    letter-spacing: .06em; color: var(--ink-3);
    background: none; border: 0; padding: 3px 0; cursor: pointer;
    transition: color .14s var(--ease);
  }
  .back:hover { color: var(--ink); }
  .back:focus-visible { outline: 1px solid var(--ink-3); outline-offset: 2px; }
  .bar .name {
    margin-left: auto; font-family: var(--mono); font-size: 9.5px;
    letter-spacing: .14em; text-transform: uppercase; color: var(--ink-ghost);
  }

  /* ── the scroll region ──────────────────────────────────────────────── */
  /* Bounded, and that bound is the whole reason this can live in the popover:
     PopoverWindow.resizeTo clamps the card to the work area, and a clamp CLIPS.
     A fixed ceiling here keeps the card the same predictable height on a 13"
     laptop and a 32" display, with the overflow scrolling instead of vanishing. */
  .scroll {
    max-height: 430px; overflow-y: auto; overscroll-behavior: contain;
  }
  .scroll::-webkit-scrollbar { width: 9px; }
  .scroll::-webkit-scrollbar-thumb {
    background: var(--rule-2); border-radius: 9px; border: 3px solid var(--win);
  }

  .msg {
    padding: 22px 15px; font-family: var(--mono); font-size: 10.5px;
    line-height: 1.7; color: var(--ink-3);
  }
  .rule { height: 1px; background: rgba(255, 255, 255, .06); }

  /* ── tab strip ──────────────────────────────────────────────────────── */
  /* Hidden entirely with one agent: a tab strip of one is a label pretending to
     be a choice. No vendor logos — six providers' marks would import six
     brands' colour into a surface whose rule is that colour is never
     decoration. */

  .tabs { display: flex; padding: 9px 8px 0; gap: 2px; }
  .tab {
    flex: 1; min-width: 0; background: none; border: 0; padding: 5px 3px 9px;
    cursor: pointer; display: flex; flex-direction: column; align-items: stretch; gap: 5px;
    font-family: var(--mono); font-size: 10px; letter-spacing: .02em; color: var(--ink-3);
    transition: color .14s var(--ease);
  }
  .tab span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center; }
  .tab .mini { height: 2px; background: var(--rule); border-radius: 1px; overflow: hidden; }
  .tab .mini i { display: block; height: 2px; background: var(--ink-3); }
  .tab .mini.nodata {
    background: repeating-linear-gradient(90deg, var(--rule-2) 0 3px, transparent 3px 6px);
  }
  .tab:hover { color: var(--ink-2); }
  .tab[aria-selected='true'] { color: var(--ink); }
  .tab[aria-selected='true'] .mini i { background: var(--ink); }
  .tab[data-tone='warn'] .mini i { background: var(--hold); }
  .tab[data-tone='bad'] .mini i { background: var(--down); }
  .tab:focus-visible { outline: 1px solid var(--ink-3); outline-offset: 2px; }

  /* ── identity ───────────────────────────────────────────────────────── */

  .who { display: flex; align-items: baseline; gap: 10px; padding: 12px 15px 0; }
  .who h2 {
    margin: 0; font-size: 22px; font-weight: 300; font-stretch: 115%;
    letter-spacing: -.02em; color: var(--ink);
  }
  /* The plan is a READING, from the provider. This is what replaced the
     hand-set claudeTier in ~/.jerico/settings.json. */
  .who .plan {
    margin-left: auto; font-family: var(--mono); font-size: 10px;
    letter-spacing: .08em; color: var(--ink-2);
  }
  .src {
    padding: 1px 15px 11px; font-family: var(--mono); font-size: 10px;
    line-height: 1.6; letter-spacing: .03em; color: var(--ink-ghost);
  }
  .src b { font-weight: 400; color: var(--ink-3); }

  /* A stale reading is drawn quieter than a live one. Not hidden — still true. */
  .stack.stale { opacity: .62; }

  /* ── a window ───────────────────────────────────────────────────────── */

  .win { padding: 10px 15px 11px; }
  .win > h3 {
    margin: 0 0 7px; font-family: var(--mono); font-size: 10px; font-weight: 400;
    letter-spacing: .06em; color: var(--ink-ghost);
    display: flex; align-items: baseline; gap: 8px;
  }
  .win > h3 .k { margin-left: auto; opacity: .8; }

  .bar2 { height: 3px; background: var(--rule); border-radius: 1.5px; overflow: hidden; }
  .bar2 i {
    display: block; height: 3px; background: var(--ink-2); border-radius: 1.5px;
    transition: width .3s var(--ease);
  }
  .win[data-tone='warn'] .bar2 i { background: var(--hold); }
  .win[data-tone='bad'] .bar2 i { background: var(--down); }

  .line {
    display: flex; align-items: baseline; gap: 10px; margin-top: 6px;
    font-family: var(--mono); font-size: 11px; letter-spacing: .01em;
  }
  .line .u { color: var(--ink); font-weight: 500; font-variant-numeric: tabular-nums; }
  .line .pc { color: var(--ink-3); font-variant-numeric: tabular-nums; }
  .line .r { margin-left: auto; color: var(--ink-3); font-variant-numeric: tabular-nums; }
  .win[data-tone='warn'] .line .u { color: var(--hold); }
  .win[data-tone='bad'] .line .u { color: var(--down); }

  /* Colour ONLY where there is something to act on. "Behind pace" is good news,
     and two reassuring coloured lines in a row is the decoration this palette
     forbids. */
  .notbinding {
    margin: 0 0 5px; font-family: var(--mono); font-size: 9.5px;
    letter-spacing: .04em; color: var(--ink-ghost);
  }
  .pace {
    margin-top: 4px; font-family: var(--mono); font-size: 10px;
    letter-spacing: .03em; color: var(--ink-ghost);
  }
  .pace b { font-weight: 400; }
  .pace.over b { color: var(--hold); }

  .scoped {
    margin: 9px 0 0; display: flex; flex-direction: column; gap: 5px;
    padding-left: 11px; border-left: 1px solid var(--rule);
  }
  .scoped .s { display: flex; align-items: center; gap: 9px; font-family: var(--mono); font-size: 10.5px; }
  .scoped .s .nm { color: var(--ink-3); min-width: 48px; }
  .scoped .s .sb { flex: 1; height: 2px; background: var(--rule); border-radius: 1px; overflow: hidden; }
  .scoped .s .sb i { display: block; height: 2px; background: var(--ink-3); }
  .scoped .s .sv { color: var(--ink-2); font-variant-numeric: tabular-nums; min-width: 30px; text-align: right; }
  .scoped .s .nr { color: var(--ink-ghost); font-size: 9.5px; }
  /* A scoped window carries its OWN tone: without this the card's most
     constrained reading gets drawn as the calmest thing on it. */
  .scoped .s[data-tone='warn'] .sb i { background: var(--hold); }
  .scoped .s[data-tone='warn'] .sv { color: var(--hold); }
  .scoped .s[data-tone='bad'] .sb i { background: var(--down); }
  .scoped .s[data-tone='bad'] .sv { color: var(--down); }

  .absent { font-family: var(--mono); font-size: 10.5px; color: var(--ink-ghost); padding: 2px 0 1px; }
  .absent .hair {
    display: block; height: 1px; margin-bottom: 6px;
    background: repeating-linear-gradient(90deg, var(--rule-2) 0 4px, transparent 4px 7px);
  }

  /* ── a fault ────────────────────────────────────────────────────────── */
  /* The shape the popover already uses for endpointrejected: the fault's own
     sentence, then what repairs it. No retry button — for the commonest fault
     here, retrying is exactly what will not work. */

  .fault { padding: 12px 15px 13px; }
  .fault .h { display: flex; align-items: baseline; gap: 9px; margin-bottom: 5px; }
  .fault .w { width: 7px; height: 7px; background: var(--hold); flex: none; align-self: center; }
  .fault .t { font-family: var(--display); font-size: 14px; color: var(--ink); }
  .fault p {
    margin: 0 0 6px; padding-left: 16px; font-family: var(--mono); font-size: 10.5px;
    line-height: 1.62; letter-spacing: .02em; color: var(--ink-3);
  }

  /* ── refresh ────────────────────────────────────────────────────────── */

  .actbar {
    display: flex; align-items: center; padding: 8px 15px 10px;
    border-top: 1px solid rgba(255, 255, 255, .06);
  }
  .rf {
    font: inherit; font-family: var(--mono); font-size: 10px; letter-spacing: .06em;
    color: var(--ink-3); background: none; border: 0; padding: 2px 0; cursor: pointer;
    transition: color .14s var(--ease);
  }
  .rf:hover:not(:disabled) { color: var(--ink); }
  .rf:disabled { color: var(--ink-ghost); cursor: default; }
  .rf:focus-visible { outline: 1px solid var(--ink-3); outline-offset: 2px; }
</style>
