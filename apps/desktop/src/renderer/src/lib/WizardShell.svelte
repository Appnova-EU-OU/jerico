<script lang="ts">
  import { RAIL, railState, type RailKey } from './rail.js'
  import WindowShell from './WindowShell.svelte'

  /** Which rail entry is current. `null` means no rail at all — the gate is a
   *  block, not a step, and showing it as step zero of six would imply it sits
   *  on the path through setup when it is a stop sign across it. */
  export let step: RailKey | null = null
  /** Right-aligned label in the title bar. */
  export let name = 'Setup'
  /** Lay the footer actions in a row instead of a stack. */
  export let row = false

  $: index = step === null ? -1 : RAIL.findIndex((r) => r.key === step)
</script>

<!-- The chrome, the scroll region, the footer and the focus handling all live
     in WindowShell, shared with the update and manage windows. The only thing
     the wizard adds is the ledger. -->
<WindowShell {name} {row}>
  <svelte:fragment slot="aside">
    {#if index >= 0}
      <!-- An ordered list, not a row of spans. It IS a sequence, and a screen
           reader can only say "step 3 of 6" and offer list navigation if the
           markup says so; aria-current on a bare span announces "current" with
           nothing to be current within. The bullets and numbering are removed
           in CSS — the ordinals are drawn, because they are content. -->
      <nav aria-label="Setup progress">
        <ol class="rail">
          {#each RAIL as item, i (item.key)}
            <li
              class="it"
              data-s={railState(i, index)}
              aria-current={i === index ? 'step' : undefined}
            >
              <span class="n">{item.n}</span>
              <span class="t">{item.label}</span>
              <!-- said, not drawn: the tick and the dim are visual only -->
              <span class="sr">
                {railState(i, index) === 'done' ? '— done' : railState(i, index) === 'current' ? '— current step' : ''}
              </span>
            </li>
          {/each}
        </ol>
        <p class="foot-note">macOS 12+<br />Apple Silicon</p>
      </nav>
    {/if}
  </svelte:fragment>

  <slot />

  <svelte:fragment slot="actions">
    <slot name="actions" />
  </svelte:fragment>
</WindowShell>

<style>
  /* ── the ledger ──────────────────────────────────────────────────── */

  nav[aria-label='Setup progress'] {
    width: 116px; flex: none;
    padding: 6px 0 20px 16px;
    border-right: 1px solid var(--rule);
    display: flex; flex-direction: column;
  }
  .rail {
    list-style: none; margin: 0; padding: 0;
    display: flex; flex-direction: column; gap: 1px;
  }
  /* announced, never shown */
  .sr {
    position: absolute; width: 1px; height: 1px;
    padding: 0; margin: -1px; overflow: hidden;
    clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }
  .rail .it {
    display: flex; align-items: baseline; gap: 8px;
    padding: 5px 10px 5px 0;
    font-family: var(--mono); font-size: 10px; letter-spacing: .05em;
    color: var(--ink-ghost); position: relative;
  }
  .rail .it .n { font-size: 9.5px; opacity: .8; }
  .rail .it .t { line-height: 1.3; }
  .rail .it[data-s='done'] { color: var(--ink-3); }
  .rail .it[data-s='current'] { color: var(--ink); }
  .rail .it[data-s='current']::before {
    content: ""; position: absolute; left: -16px; top: 50%; margin-top: -3px;
    width: 5px; height: 5px; background: var(--ink);
  }
  /* a finished step keeps a small live tick, not a checkmark graphic */
  .rail .it[data-s='done'] .n::after { content: "·"; margin-left: 3px; color: var(--live); }

  .foot-note {
    margin-top: auto; margin-bottom: 0; padding-right: 12px;
    font-family: var(--mono); font-size: 9px; letter-spacing: .08em;
    color: var(--ink-ghost); line-height: 1.5;
  }
</style>
