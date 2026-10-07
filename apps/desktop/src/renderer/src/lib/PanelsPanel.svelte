<script lang="ts">
  import type { PopoverState } from '../../../preload/types.d.ts'

  /* ── what this is ──────────────────────────────────────────────────────
     The full panel roster, rendered INSIDE the popover as a third view — the
     same call UsagePanel already made, and for the same reason: a menu-bar
     surface that spawns a window to answer a question asked from the menu bar
     has lost the thread. Manage is not the place either; it is a deliberately
     opened window about the installation, and live panel state is a different
     subject.

     This is where the two deleted registers went. The main card now draws a
     gate or hook reading only when it is NOT settled-healthy; everything —
     including every boring `ready` / `configured`, the full cwd, and the
     refusal string that was unreadable ellipsised into 290pt of 10px mono —
     is here, at full width, for every panel.                                */

  const UNKNOWN = '—'

  export let panels: PopoverState['panels']
  export let onBack: () => void

  function gateLabel(panel: PopoverState['panels'][number]): { text: string; tone: '' | 'warn' | 'bad' } {
    const g = panel.startupGate
    if (!g) return { text: 'not reported', tone: '' }
    if (g.phase === 'blocked') return { text: 'TRUST BLOCKED', tone: 'bad' }
    if (g.phase === 'attention') return { text: 'ATTENTION', tone: 'warn' }
    if (g.phase === 'checking') return { text: 'checking', tone: '' }
    return { text: 'ready', tone: '' }
  }

  function hookLabel(panel: PopoverState['panels'][number]): { text: string; tone: '' | 'warn' | 'bad' } {
    const state = panel.hook?.configState
    if (state === undefined) return { text: 'not reported', tone: '' }
    if (state === 'present_ok') return { text: 'configured', tone: '' }
    if (state === 'absent') return { text: 'not configured', tone: 'warn' }
    if (state === 'malformed') return { text: 'malformed config', tone: 'bad' }
    if (state === 'unknown') return { text: 'could not determine', tone: '' }
    // The `unsupported_*` variants each name their own reason, and the reason is
    // the useful half: "unsupported" alone reads as a defect rather than as a
    // shell panel having no turn hooks to configure.
    return { text: state.replace(/^unsupported_/, 'n/a — ').replace(/_/g, ' '), tone: '' }
  }

  /** The string that could not be read where it used to live. */
  function refusal(panel: PopoverState['panels'][number]): string | null {
    const r = panel.hook?.hookInstallRefused
    if (!r) return null
    return `${r.status} · ${new Date(r.at).toISOString().slice(0, 16).replace('T', ' ')}`
  }

  function ctx(pct: number | null): string {
    return pct === null ? UNKNOWN : `${pct}%`
  }

  /**
   * The roster, under the same headings the card draws — so arriving here from
   * a project row lands on that project rather than on an undifferentiated
   * list. Grouped on the full cwd, not the leaf: two checkouts can share a leaf
   * name and merging them would show one project that does not exist.
   */
  interface Group { project: string | null; cwd: string | null; panels: PopoverState['panels'] }

  function groupByProject(list: PopoverState['panels']): Group[] {
    const NONE = '\u0000none'
    const map = new Map<string, PopoverState['panels']>()
    for (const panel of list) {
      const key = panel.cwd ?? NONE
      const got = map.get(key)
      if (got) got.push(panel)
      else map.set(key, [panel])
    }
    const out = [...map.entries()].map(([key, ps]) => ({
      project: key === NONE ? null : (ps[0]?.project ?? key),
      cwd: key === NONE ? null : key,
      panels: ps,
    }))
    // Same ordering rule as the card: more panels first, and the group with no
    // reported directory last, because it is the least navigable heading here.
    out.sort((a, b) => {
      if (a.panels.length !== b.panels.length) return b.panels.length - a.panels.length
      if ((a.project === null) !== (b.project === null)) return a.project === null ? 1 : -1
      return (a.project ?? '').localeCompare(b.project ?? '')
    })
    return out
  }

  $: groups = groupByProject(panels)
</script>

<div class="bar">
  <button type="button" class="back" on:click={onBack} aria-label="Back to the popover">
    <span aria-hidden="true">←</span> panels
  </button>
  <span class="name">panel detail</span>
</div>

<div class="scroll">
  {#if panels.length === 0}
    <p class="msg">No panels are open.</p>
  {:else}
    {#each groups as group (group.cwd ?? '\u0000none')}
      <div class="grp">
        <h2 class="gname" title={group.cwd ?? 'these panels reported no working directory'}>
          {group.project ?? 'no project reported'}
        </h2>
        <span class="gcount">{group.panels.length} {group.panels.length === 1 ? 'panel' : 'panels'}</span>
      </div>
      <!-- The full path lives here once per project rather than on every row. -->
      {#if group.cwd}<p class="gpath">{group.cwd}</p>{/if}
      {#each group.panels as panel (panel.key)}
      {@const gate = gateLabel(panel)}
      {@const hook = hookLabel(panel)}
      {@const ref = refusal(panel)}
      <section class="row">
        <h2>
          {panel.agent ?? panel.key.slice(0, 8)}
          <span class="ctx" class:warn={panel.contextPct !== null && panel.contextPct >= 85}>ctx {ctx(panel.contextPct)}</span>
        </h2>
        <dl>
          <dt>startup gate</dt>
          <dd class:warn={gate.tone === 'warn'} class:bad={gate.tone === 'bad'}>{gate.text}</dd>
          {#if panel.startupGate?.reason}
            <dt>reason</dt>
            <dd class="wrap">{panel.startupGate.reason}</dd>
          {/if}
          <dt>turn hook</dt>
          <dd class:warn={hook.tone === 'warn'} class:bad={hook.tone === 'bad'}>{hook.text}</dd>
          {#if ref}
            <dt>install refused</dt>
            <dd class="wrap warn">{ref}</dd>
          {/if}
        </dl>
      </section>
      {/each}
      <div class="rule"></div>
    {/each}
  {/if}
</div>

<style>
  /* The appbar and the scroll region are the same primitives UsagePanel uses —
     deliberately, so the two nested views are one pattern and not two. */
  .bar {
    display: flex; align-items: center; gap: 10px; height: 38px; flex: none;
    padding: 0 13px; border-bottom: 1px solid rgba(255, 255, 255, .06);
  }
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

  /* Bounded for the reason UsagePanel states: resizeTo clamps the card to the
     work area, and a clamp CLIPS. A ceiling here means the overflow scrolls
     instead of vanishing, and the card is the same height on every display. */
  .scroll { max-height: 430px; overflow-y: auto; overscroll-behavior: contain; }
  .scroll::-webkit-scrollbar { width: 9px; }
  .scroll::-webkit-scrollbar-thumb {
    background: var(--rule-2); border-radius: 9px; border: 3px solid var(--win);
  }

  .msg {
    padding: 22px 15px; font-family: var(--mono); font-size: 10.5px;
    line-height: 1.7; color: var(--ink-3);
  }
  .rule { height: 1px; background: rgba(255, 255, 255, .06); }

  /* The project heading, and its panel count on the same line — the card's row,
     restated here so the two surfaces read as one thing. */
  .grp {
    display: flex; align-items: baseline; gap: 9px;
    padding: 13px 15px 0;
  }
  .grp .gname {
    margin: 0; font-family: var(--mono); font-size: 11px; font-weight: 400;
    letter-spacing: .01em; color: var(--ink);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .grp .gcount { margin-left: auto; font-family: var(--mono); font-size: 10px; color: var(--ink-3); }
  .gpath {
    margin: 3px 0 0; padding: 0 15px; font-family: var(--mono); font-size: 9px;
    line-height: 1.5; color: var(--ink-ghost); word-break: break-all;
  }

  .row { padding: 9px 15px 11px 26px; }
  .row h2 {
    margin: 0; display: flex; align-items: baseline; gap: 9px;
    font-family: var(--mono); font-size: 10.5px; font-weight: 400;
    letter-spacing: .01em; color: var(--ink);
  }
  .row h2 .ctx { margin-left: auto; font-size: 10px; color: var(--ink-ghost); }
  .row h2 .ctx.warn { color: var(--hold); }
  dl {
    margin: 0; display: grid; grid-template-columns: 86px 1fr;
    gap: 3px 10px; font-family: var(--mono); font-size: 10px;
  }
  dt { color: var(--ink-ghost); }
  dd { margin: 0; color: var(--ink-2); }
  dd.wrap { word-break: break-word; }
  dd.warn { color: var(--hold); }
  dd.bad { color: var(--down); }
</style>
