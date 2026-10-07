<script lang="ts">
  import { onMount } from 'svelte'

  /** Right-aligned label in the title bar. */
  export let name = 'Jerico'
  /** Lay the footer actions in a row instead of a stack. */
  export let row = false

  /* Each screen replaces the whole subtree, which destroys whatever was
     focused and drops focus to <body>. A sighted user follows the change
     visually; a screen-reader user is left on nothing. Moving focus to the
     heading announces the screen and starts the next Tab from the top of it —
     unless the screen already claimed focus for itself. */
  let root: HTMLDivElement

  onMount(() => {
    if (root && root.contains(document.activeElement)) return
    root?.querySelector<HTMLElement>('h2')?.focus()
  })
</script>

<!-- `jerico-ui` is the design system's scope root. It is intentionally never
     referenced in a component's own style block, so Svelte leaves it unhashed
     and app.css can reach it. Every screen renders inside one of these. -->
<div class="win jerico-ui" bind:this={root}>
  <!-- titleBarStyle: 'hiddenInset' means macOS draws the real traffic lights
       over this strip. Nothing is drawn here but the label; the rest is drag
       region, and the label itself must not be, or the window cannot be moved
       by its widest empty area. -->
  <div class="chrome">
    <span class="name">{name}</span>
  </div>

  <div class="body">
    <!-- The wizard puts its ledger here. Every other window leaves it empty. -->
    <slot name="aside" />

    <div class="col">
      <div class="scroll">
        <slot />
      </div>
      <div class="actions" class:row>
        <slot name="actions" />
      </div>
    </div>
  </div>
</div>

<style>
  .win {
    /* fixed, not just 100vh: an absolutely-positioned descendant that escapes
       its own container can extend the document and let focus() scroll the
       whole window out of view. Pinning the shell to the viewport means the
       worst such a bug can do is misplace one invisible element, instead of
       sliding the entire UI under its own title bar. */
    position: fixed; inset: 0;
    display: flex; flex-direction: column;
    background: var(--win);
    overflow: hidden;
  }

  .chrome {
    height: 38px; flex: none;
    display: flex; align-items: center; padding: 0 13px;
    -webkit-app-region: drag;
  }
  .chrome .name {
    margin-left: auto;
    font-family: var(--mono); font-size: 9.5px;
    letter-spacing: .14em; text-transform: uppercase; color: var(--ink-ghost);
    -webkit-app-region: no-drag;
  }

  .body { flex: 1; display: flex; min-height: 0; }

  /* min-height: 0 is load-bearing, not decoration. A flex item's default
     min-height is auto, meaning it refuses to shrink below its content — so
     without this .col grows to the full height of a long screen, .scroll never
     becomes the thing that scrolls, and the whole window slides under its own
     title bar instead. The wizard never showed it because its screens are
     short; Manage is long enough to prove it. */
  .col { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }

  .scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 26px 4px; }
  .scroll::-webkit-scrollbar { width: 9px; }
  .scroll::-webkit-scrollbar-thumb {
    background: var(--rule-2); border-radius: 9px; border: 3px solid var(--win);
  }
  /* -1 keeps the heading out of the tab order while still allowing focus() —
     it is a landing point, not a control. */
  .scroll :global(h2) { outline: none; }

  .actions {
    padding: 14px 26px 20px;
    display: flex; flex-direction: column; gap: 8px; align-items: stretch;
  }
  .actions.row { flex-direction: row; align-items: center; flex-wrap: wrap; }
  /* Two mono uppercase buttons do not fit a 352pt column, so the row wraps —
     and a wrapped row of auto-width buttons is a ragged stack. Letting the
     real actions grow makes both cases deliberate. .btn-text is excluded
     because it is a way out, not an action. */
  .actions.row :global(.btn-primary),
  .actions.row :global(.btn-ghost),
  .actions.row :global(.btn-danger) { flex: 1 1 auto; }
  .actions.row :global(.btn-text) { flex: 0 0 auto; }
  .actions:empty { display: none; }
</style>
