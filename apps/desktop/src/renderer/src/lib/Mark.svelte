<script lang="ts">
  /** The Jerico mark: one input node fanning out to three. Same geometry as the
   *  tray glyph and the intro, drawn in currentColor so it takes the ink of
   *  whatever it sits in. */
  export let size = 38
</script>

<svg
  class="mark"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  aria-hidden="true"
  focusable="false"
>
  <g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
    <path d="M3 12 H7" />
    <path d="M7 12 C 10 12, 10 5, 13 5" />
    <path d="M7 12 C 10 12, 10 12, 13 12" />
    <path d="M7 12 C 10 12, 10 19, 13 19" />
  </g>
  <g fill="currentColor">
    <circle cx="3" cy="12" r="1.9" />
    <circle cx="15" cy="5" r="1.9" />
    <circle cx="15" cy="12" r="1.9" />
    <circle cx="15" cy="19" r="1.9" />
  </g>
</svg>
