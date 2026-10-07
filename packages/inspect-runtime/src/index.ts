import { finder } from '@medv/finder';

const STYLE_PROPS = [
  'display', 'position', 'width', 'height', 'margin', 'padding',
  'color', 'backgroundColor', 'border', 'borderRadius', 'fontFamily',
  'fontSize', 'fontWeight', 'lineHeight', 'textAlign', 'zIndex', 'boxShadow',
  'flex', 'gridTemplate'
];

const SAFE_ATTR_PATTERNS = [
  /^id$/, /^class$/, /^role$/, /^href$/, /^src$/, /^alt$/, /^type$/, /^name$/, /^placeholder$/,
  /^aria-/, /^data-/
];

const SECRET_REGEX = /token|secret|api[-_]?key|password|csrf|auth|bearer/i;

function containsSecret(val: string): boolean {
  return SECRET_REGEX.test(val);
}

// Strip spoofed trusted-directive markers from any page-derived string so a
// previewed element's text/attr can never inject a `[BRIDGE-ORCH]`/`[BRIDGE-INSPECT]`
// line into the agent PTY (branch-review F1). The daemon re-applies this as a
// backstop for raw-WS payloads; the leading framing is added by the daemon, not
// stored in any page field, so this never nukes it.
function stripBridgeMarkers(val: string): string {
  if (!val) return val;
  return val.replace(/\[BRIDGE-(ORCH|INSPECT)\][^\n]*/gi, '');
}

// True if the element itself carries a secret-looking id / class / attribute NAME.
function hasSecretAttrOrClass(el: Element): boolean {
  if (el.id && SECRET_REGEX.test(el.id)) return true;
  const cls = el.getAttribute && el.getAttribute('class');
  if (cls && SECRET_REGEX.test(cls)) return true;
  if (el.attributes) {
    for (let i = 0; i < el.attributes.length; i++) {
      if (SECRET_REGEX.test(el.attributes[i].name)) return true;
    }
  }
  return false;
}

// Ancestor-context secret check: the element OR any ancestor is secret-labelled.
// Used to redact rendered TEXT (branch-review F2) — a value-agnostic word-regex on
// free text would over-redact prose ("author") and under-redact bare tokens
// (`sk-live-…`), so we key on the container's secret-labelled id/class/attr instead.
function hasSecretContext(el: HTMLElement): boolean {
  let cur: Element | null = el;
  while (cur && cur !== document.body && cur !== document.documentElement) {
    if (hasSecretAttrOrClass(cur)) return true;
    cur = cur.parentElement;
  }
  return false;
}

// Redact direct text-node children of any element inside a secret-labelled subtree.
function redactSecretText(node: Element, inherited: boolean): void {
  const secret = inherited || hasSecretAttrOrClass(node);
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      if (secret && (child.textContent || '').trim()) child.textContent = '[redacted]';
    } else if (child.nodeType === 1) {
      redactSecretText(child as Element, secret);
    }
  }
}

// A `finder(el)` selector like `input#db-api-key-token` can embed a secret token
// (e.g. "token"/"api-key"). Redact such selectors so the injected payload never
// leaks a credential-bearing id/class (jerico-orch-preview-IMPL-BRIEF PART B #6).
function redactSelector(selector: string): string {
  if (!selector) return selector;
  if (containsSecret(selector)) return '[redacted]';
  return stripBridgeMarkers(selector);
}

function sanitizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl, window.location.href);
    if (url.protocol === 'about:') {
      return url.toString() === 'about:blank' ? 'about:blank' : '';
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'file:') {
      return '';
    }
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function getCuratedStyles(el: HTMLElement): Record<string, string> {
  const cs = window.getComputedStyle(el);
  const result: Record<string, string> = {};
  for (const prop of STYLE_PROPS) {
    const cssName = prop.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
    result[prop] = cs.getPropertyValue(cssName) || '';
  }
  return result;
}

function getSafeAttributes(el: HTMLElement): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!el.attributes) return attrs;
  for (let i = 0; i < el.attributes.length; i++) {
    const attr = el.attributes[i];
    const name = attr.name.toLowerCase();
    
    const isAllowed = SAFE_ATTR_PATTERNS.some(p => p.test(name));
    if (!isAllowed) continue;
    
    const value = attr.value;
    if (containsSecret(value) || containsSecret(name)) {
      attrs[name] = '[redacted]';
    } else if ((name === 'href' || name === 'src') && value) {
      attrs[name] = sanitizeUrl(value);
    } else if (name === 'class') {
      attrs[name] = stripBridgeMarkers(value.slice(0, 200));
    } else {
      attrs[name] = stripBridgeMarkers(value.slice(0, 500));
    }
  }
  return attrs;
}

function getHtmlSnippet(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;
  const scripts = clone.querySelectorAll('script');
  scripts.forEach(s => s.remove());

  // Redact attributes and on* handlers in clone and all its descendants
  const allElements = [clone, ...Array.from(clone.querySelectorAll('*'))];
  allElements.forEach(item => {
    if (!item.attributes) return;
    
    const attrsToRemove: string[] = [];
    const attrsToSet: { name: string; value: string }[] = [];

    for (let i = 0; i < item.attributes.length; i++) {
      const attr = item.attributes[i];
      const name = attr.name;
      const val = attr.value;

      // 1. Strip inline on* handlers
      if (name.toLowerCase().startsWith('on')) {
        attrsToRemove.push(name);
        continue;
      }

      // 2. Redact name/value matches SECRET_REGEX
      if (SECRET_REGEX.test(name) || SECRET_REGEX.test(val)) {
        attrsToSet.push({ name, value: '[redacted]' });
        continue;
      }

      // 3. Redact value= on input/textarea/select
      const tagName = item.tagName.toLowerCase();
      if (name.toLowerCase() === 'value' && (tagName === 'input' || tagName === 'textarea' || tagName === 'select')) {
        attrsToSet.push({ name, value: '[redacted]' });
      }
    }

    attrsToRemove.forEach(name => item.removeAttribute(name));
    attrsToSet.forEach(({ name, value }) => item.setAttribute(name, value));
  });

  // F2: redact rendered TEXT inside a secret-labelled subtree (including an ancestor
  // above el that is outside the clone). Keeps benign markup, drops leaked values.
  const rootInherited = el.parentElement ? hasSecretContext(el.parentElement) : false;
  redactSecretText(clone, rootInherited);

  // F1: strip any spoofed [BRIDGE-*] directive text that survived in rendered content.
  const html = stripBridgeMarkers(clone.outerHTML || '');
  if (html.length <= 4096) return html;
  return html.slice(0, 4096) + ' (truncated)';
}

function getSourceFile(el: HTMLElement): string | null {
  if (!el.attributes) return null;
  for (let i = 0; i < el.attributes.length; i++) {
    const name = el.attributes[i].name;
    if (name === 'data-inspector-path' || name === 'data-v-inspector' || name.startsWith('data-inspector-')) {
      const val = el.attributes[i].value;
      if (val) return val;
    }
  }
  let parent = el.parentElement;
  while (parent && parent !== document.body) {
    for (let i = 0; i < parent.attributes.length; i++) {
      const name = parent.attributes[i].name;
      if (name === 'data-inspector-path' || name === 'data-v-inspector' || name.startsWith('data-inspector-')) {
        const val = parent.attributes[i].value;
        if (val) return val;
      }
    }
    parent = parent.parentElement;
  }
  return null;
}

const REGION_MIN_DRAG_PX = 5
const REGION_MAX_ELEMENTS = 15
const REGION_SNIPPET_CAP = 256
const REGION_GIANT_RATIO = 1.5

class JericoInspect {
  private host: HTMLDivElement | null = null
  private shadow: ShadowRoot | null = null
  private overlay: HTMLDivElement | null = null
  private highlightBox: HTMLDivElement | null = null
  private hoverLabel: HTMLDivElement | null = null
  private currentEl: HTMLElement | null = null
  private nonce: string = ''
  private isArmed: boolean = false
  private allowedOrigin: string = ''
  private mode: 'element' | 'region' = 'element'

  // Region drag state
  private dragStart: { x: number; y: number } | null = null
  private regionScroll: { x: number; y: number } | null = null
  private dragMoved: boolean = false
  private regionBox: HTMLDivElement | null = null
  private regionDimLabel: HTMLDivElement | null = null
  private annotationBar: HTMLDivElement | null = null
  private hintChip: HTMLDivElement | null = null

  constructor() {
    this.handleMessage = this.handleMessage.bind(this)
    this.onPointerMove = this.onPointerMove.bind(this)
    this.onClick = this.onClick.bind(this)
    this.onKeyDown = this.onKeyDown.bind(this)
    this.onScrollResize = this.onScrollResize.bind(this)
    this.onPointerDown = this.onPointerDown.bind(this)
    this.onPointerUp = this.onPointerUp.bind(this)
  }

  public init() {
    window.addEventListener('message', this.handleMessage);
  }

  public destroy() {
    window.removeEventListener('message', this.handleMessage);
    this.teardown();
  }

  private handleMessage(event: MessageEvent) {
    const data = event.data;
    if (!data || data.source !== 'jerico-inspect') return;
    
    if (event.source !== window.parent) return;

    if (data.type === 'arm') {
      this.nonce = data.nonce;
      this.allowedOrigin = event.origin;
      this.mode = data.mode === 'region' ? 'region' : 'element';
      this.arm();
    } else if (data.type === 'cancel' || data.arm === false) {
      this.teardown();
    }
  }

  private arm() {
    if (this.isArmed) {
      this.teardown();
    }
    this.isArmed = true;

    this.host = document.createElement('div');
    this.host.id = '__jerico-inspect-host';
    this.host.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647;pointer-events:auto;cursor:crosshair;';
    document.documentElement.appendChild(this.host);

    this.shadow = this.host.attachShadow({ mode: 'closed' });

    this.overlay = document.createElement('div');
    this.overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;';
    this.shadow.appendChild(this.overlay);

    this.highlightBox = document.createElement('div');
    this.highlightBox.style.cssText = `
      position: fixed;
      border: 2px solid rgba(99, 102, 241, 0.85);
      border-radius: 4px;
      pointer-events: none;
      transition: all 0.05s ease-out;
      display: none;
      background: rgba(99, 102, 241, 0.05);
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.2), 0 0 12px rgba(99, 102, 241, 0.4);
    `;
    this.overlay.appendChild(this.highlightBox);

    this.hoverLabel = document.createElement('div');
    this.hoverLabel.style.cssText = `
      position: fixed;
      padding: 4px 8px;
      background: rgba(15, 17, 23, 0.95);
      color: #f3f4f6;
      font: 11px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 6px;
      pointer-events: none;
      white-space: nowrap;
      display: none;
      max-width: 320px;
      overflow: hidden;
      text-overflow: ellipsis;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
    `;
    this.overlay.appendChild(this.hoverLabel);

    if (this.mode === 'region') {
      this.host.addEventListener('mousedown', this.onPointerDown, true);
      this.host.addEventListener('mousemove', this.onPointerMove);
      this.host.addEventListener('mouseup', this.onPointerUp, true);
    } else {
      this.host.addEventListener('mousemove', this.onPointerMove);
      this.host.addEventListener('click', this.onClick, true);
    }
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('scroll', this.onScrollResize, true);
    window.addEventListener('resize', this.onScrollResize, true);

    this.showHintChip();
  }

  // Onboarding hint on arm: a top-center chip telling the user how to use the current
  // mode. Auto-fades after 4.5s and is dismissed on first interaction.
  private showHintChip() {
    if (!this.shadow) return;
    const chip = document.createElement('div');
    const text = this.mode === 'region'
      ? 'Drag a box to select an area, then describe the change  ·  Esc to cancel'
      : 'Click an element to inspect  ·  Esc to cancel';
    chip.textContent = text;
    chip.style.cssText = `
      position: fixed;
      top: 14px;
      left: 50%;
      transform: translateX(-50%);
      padding: 7px 14px;
      background: rgba(15, 17, 23, 0.95);
      color: #f3f4f6;
      font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      border: 1px solid rgba(99, 102, 241, 0.5);
      border-radius: 999px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
      z-index: 2147483647;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.2s ease;
      white-space: nowrap;
      max-width: 92vw;
      overflow: hidden;
      text-overflow: ellipsis;
    `;
    this.shadow.appendChild(chip);
    this.hintChip = chip;
    requestAnimationFrame(() => { if (this.hintChip === chip) chip.style.opacity = '1'; });
    setTimeout(() => { if (this.hintChip === chip) this.hideHintChip(); }, 4500);
  }

  private hideHintChip() {
    const chip = this.hintChip;
    if (!chip) return;
    this.hintChip = null;
    chip.style.opacity = '0';
    setTimeout(() => { try { chip.remove(); } catch {} }, 220);
  }

  private teardown() {
    if (!this.isArmed) return;
    this.isArmed = false;

    if (this.host) {
      this.host.removeEventListener('mousemove', this.onPointerMove);
      this.host.removeEventListener('click', this.onClick, true);
      this.host.removeEventListener('mousedown', this.onPointerDown, true);
      this.host.removeEventListener('mouseup', this.onPointerUp, true);
      try {
        this.host.remove();
      } catch {}
      this.host = null;
    }

    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('scroll', this.onScrollResize, true);
    window.removeEventListener('resize', this.onScrollResize, true);

    this.shadow = null;
    this.overlay = null;
    this.highlightBox = null;
    this.hoverLabel = null;
    this.regionBox = null;
    this.regionDimLabel = null;
    this.hintChip = null;
    this.annotationBar = null;
    this.currentEl = null;
    this.dragStart = null;
    this.dragMoved = false;
  }

  private onPointerMove(e: MouseEvent) {
    if (this.mode === 'region') {
      if (this.dragStart) {
        this.drawRegionRect(this.dragStart.x, this.dragStart.y, e.clientX, e.clientY);
      }
      return;
    }
    if (!this.host || !this.highlightBox || !this.hoverLabel) return;
    
    this.host.style.pointerEvents = 'none';
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    this.host.style.pointerEvents = 'auto';

    if (el && el !== document.documentElement && el !== document.body) {
      this.hideHintChip();
      this.currentEl = el;
      this.updateHighlight();
    } else {
      this.currentEl = null;
      this.highlightBox.style.display = 'none';
      this.hoverLabel.style.display = 'none';
    }
  }

  private updateHighlight() {
    if (!this.currentEl || !this.highlightBox || !this.hoverLabel) return;
    
    const rect = this.currentEl.getBoundingClientRect();
    this.highlightBox.style.left = `${rect.left}px`;
    this.highlightBox.style.top = `${rect.top}px`;
    this.highlightBox.style.width = `${rect.width}px`;
    this.highlightBox.style.height = `${rect.height}px`;
    this.highlightBox.style.display = 'block';

    const tag = this.currentEl.tagName.toLowerCase();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    
    let text = (this.currentEl.innerText || this.currentEl.textContent || '').trim().slice(0, 30);
    if (text.length > 30) text = text.slice(0, 27) + '...';
    
    const labelParts = [tag];
    if (text) labelParts.push(`"${text}"`);
    labelParts.push(`${w}x${h}`);
    
    this.hoverLabel.textContent = labelParts.join('  ');
    this.hoverLabel.style.display = 'block';

    let labelY = rect.bottom + 6;
    if (labelY + 28 > window.innerHeight) {
      labelY = rect.top - 28;
    }
    this.hoverLabel.style.left = `${Math.max(4, rect.left)}px`;
    this.hoverLabel.style.top = `${labelY}px`;
  }

  private onScrollResize() {
    if (this.currentEl) {
      this.updateHighlight();
    }
  }

  private onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.teardown();
    }
  }

  private onPointerDown(e: MouseEvent) {
    if (this.mode !== 'region') return
    e.preventDefault()
    e.stopPropagation()
    this.hideHintChip()
    this.dragStart = { x: e.clientX, y: e.clientY }
    this.dragMoved = false
    this.drawRegionRect(e.clientX, e.clientY, e.clientX, e.clientY)
  }

  private onPointerUp(e: MouseEvent) {
    if (this.mode !== 'region' || !this.dragStart) return
    e.preventDefault()
    e.stopPropagation()
    const start = this.dragStart
    this.dragStart = null

    const dx = Math.abs(e.clientX - start.x)
    const dy = Math.abs(e.clientY - start.y)
    // Treat a near-zero drag on EITHER axis as a click (not a region) — a
    // single-axis drag produced a flat 0-height marquee + phantom annotation
    // bar (jerico-orch-preview-IMPL-BRIEF PART B #5).
    if (dx < REGION_MIN_DRAG_PX || dy < REGION_MIN_DRAG_PX) {
      if (this.regionBox) this.regionBox.style.display = 'none'
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
      if (el && el !== document.documentElement && el !== document.body) {
        void this.handleElementClick(el)
      } else {
        this.teardown()
      }
      return
    }
    const rect = this.normalizeRect(start.x, start.y, e.clientX, e.clientY)
    // Snapshot scroll at drag-end so a scroll that happens while the annotation
    // bar is open can be compensated in sendRegion (jerico-orch-preview-FIX2 #10).
    this.regionScroll = { x: window.scrollX, y: window.scrollY }
    this.showAnnotationBar(rect)
  }

  private normalizeRect(x1: number, y1: number, x2: number, y2: number) {
    const left = Math.min(x1, x2)
    const top = Math.min(y1, y2)
    return { x: left, y: top, width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) }
  }

  private drawRegionRect(x1: number, y1: number, x2: number, y2: number) {
    if (!this.overlay) return
    const rect = this.normalizeRect(x1, y1, x2, y2)
    if (!this.regionBox) {
      this.regionBox = document.createElement('div')
      this.regionBox.style.cssText = `
        position: fixed;
        border: 2px solid rgba(99, 102, 241, 0.9);
        border-radius: 4px;
        pointer-events: none;
        background: rgba(99, 102, 241, 0.1);
        box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.25), 0 0 16px rgba(99, 102, 241, 0.45);
        z-index: 2147483647;
      `
      // Live dimension badge (W × H) pinned to the bottom-right of the marquee.
      this.regionDimLabel = document.createElement('div')
      this.regionDimLabel.style.cssText = `
        position: absolute;
        right: 0;
        bottom: -22px;
        padding: 2px 6px;
        background: rgba(99, 102, 241, 0.95);
        color: #fff;
        font: 11px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        border-radius: 4px;
        white-space: nowrap;
        box-shadow: 0 2px 6px rgba(0,0,0,0.35);
      `
      this.regionBox.appendChild(this.regionDimLabel)
      this.overlay.appendChild(this.regionBox)
    }
    this.regionBox.style.left = `${rect.x}px`
    this.regionBox.style.top = `${rect.y}px`
    this.regionBox.style.width = `${rect.width}px`
    this.regionBox.style.height = `${rect.height}px`
    this.regionBox.style.display = 'block'
    if (this.regionDimLabel) {
      this.regionDimLabel.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`
    }
  }

  private showAnnotationBar(rect: { x: number; y: number; width: number; height: number }) {
    if (!this.shadow) return
    if (!this.annotationBar) {
      this.annotationBar = document.createElement('div')
      this.annotationBar.style.cssText = `
        position: fixed;
        display: flex;
        flex-direction: column;
        gap: 6px;
        width: 280px;
        max-width: 90vw;
        padding: 10px;
        background: rgba(15, 17, 23, 0.97);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 10px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6);
        z-index: 2147483647;
        font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        color: #f3f4f6;
      `
      this.shadow.appendChild(this.annotationBar)
    }
    const bar = this.annotationBar
    bar.innerHTML = ''

    // Live element count so the user knows what the box captured before sending.
    const matched = this.selectRegionElements(rect)
    const shown = Math.min(matched.length, REGION_MAX_ELEMENTS)

    const label = document.createElement('div')
    label.textContent = 'Describe what to do with this region:'
    label.style.cssText = 'font-weight: 600; color: rgba(243,244,246,0.9);'
    bar.appendChild(label)

    const count = document.createElement('div')
    count.textContent = matched.length === 0
      ? 'No elements in the selection — try a larger box'
      : `${shown} element${shown === 1 ? '' : 's'} selected${matched.length > REGION_MAX_ELEMENTS ? ` (capped at ${REGION_MAX_ELEMENTS})` : ''}`
    count.style.cssText = `font-size: 11px; color: ${matched.length === 0 ? 'rgba(251,191,36,0.9)' : 'rgba(129,140,248,0.95)'};`
    bar.appendChild(count)

    const textarea = document.createElement('textarea')
    textarea.placeholder = 'e.g. make this a card'
    textarea.style.cssText = `
      width: 100%;
      min-height: 60px;
      resize: vertical;
      box-sizing: border-box;
      padding: 6px 8px;
      background: rgba(255,255,255,0.06);
      color: #f3f4f6;
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 6px;
      outline: none;
      font: inherit;
    `
    // Cmd/Ctrl+Enter submits (faster than reaching for the Send button).
    textarea.addEventListener('keydown', (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
        ev.preventDefault()
        ev.stopPropagation()
        void this.sendRegion(rect, textarea.value)
      }
    })
    bar.appendChild(textarea)

    const actions = document.createElement('div')
    actions.style.cssText = 'display: flex; gap: 6px; align-items: center; justify-content: flex-end;'
    bar.appendChild(actions)

    const hint = document.createElement('span')
    hint.textContent = `${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'}↵ Send · Esc Cancel`
    hint.style.cssText = 'margin-right: auto; font-size: 10px; color: rgba(243,244,246,0.4);'
    actions.appendChild(hint)

    const cancelBtn = document.createElement('button')
    cancelBtn.textContent = 'Cancel'
    cancelBtn.style.cssText = `
      padding: 5px 12px; border-radius: 6px; cursor: pointer;
      background: rgba(255,255,255,0.08); color: #f3f4f6;
      border: 1px solid rgba(255,255,255,0.12);
    `
    cancelBtn.addEventListener('click', (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      this.teardown()
    })

    const sendBtn = document.createElement('button')
    sendBtn.textContent = 'Send'
    sendBtn.style.cssText = `
      padding: 5px 12px; border-radius: 6px; cursor: pointer;
      background: rgba(99, 102, 241, 0.9); color: #fff;
      border: 1px solid rgba(99, 102, 241, 1); font-weight: 600;
    `
    sendBtn.addEventListener('click', (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      const annotation = textarea.value
      void this.sendRegion(rect, annotation)
    })

    actions.appendChild(cancelBtn)
    actions.appendChild(sendBtn)

    const bw = 280
    const bh = 200
    let bx = rect.x + rect.width + 8
    let by = rect.y
    if (bx + bw > window.innerWidth) bx = rect.x - bw - 8
    if (bx < 4) bx = 4
    if (by + bh > window.innerHeight) by = Math.max(4, window.innerHeight - bh - 4)
    bar.style.left = `${bx}px`
    bar.style.top = `${by}px`
    bar.style.display = 'flex'

    setTimeout(() => textarea.focus(), 0)
  }

  private async sendRegion(rect: { x: number; y: number; width: number; height: number }, annotation: string) {
    if (!this.host) return
    this.host.style.pointerEvents = 'none'
    try {
      // Compensate for any scroll between drag-end and Send: the stored rect is
      // in the drag-end viewport frame, but element rects are read live. Shift
      // the stored rect by the scroll delta so they intersect in the same frame
      // (jerico-orch-preview-FIX2 #10).
      const dx = window.scrollX - (this.regionScroll?.x ?? window.scrollX)
      const dy = window.scrollY - (this.regionScroll?.y ?? window.scrollY)
      const adjusted = { x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height }
      const payload = await this.extractRegionPayload(adjusted, annotation)
      window.parent.postMessage({
        source: 'jerico-inspect',
        type: 'result',
        nonce: this.nonce,
        payload
      }, this.allowedOrigin)
    } catch (err) {
      console.error('[JERICO-INSPECT] Failed to extract region:', err)
    } finally {
      this.teardown()
    }
  }

  /**
   * Region -> elements via viewport getBoundingClientRect() intersection walk
   * (jerico-design item 2, CONSENSUS S1). Membership = INTERSECTING the drawn
   * rect; excludes the overlay host + html/body; drops giant containers and
   * pure wrappers. Lean per-element descriptor, no computedStyles.
   */
  // Region intersection walk + de-noise, shared by the annotation-bar count and the
  // final payload extract (so "N elements selected" always matches what gets sent).
  private selectRegionElements(rect: { x: number; y: number; width: number; height: number }): { el: HTMLElement; r: DOMRect }[] {
    const rectRight = rect.x + rect.width
    const rectBottom = rect.y + rect.height

    const all = Array.from(document.querySelectorAll('*')) as HTMLElement[]
    const selected: { el: HTMLElement; r: DOMRect }[] = []

    for (const el of all) {
      if (el.id === '__jerico-inspect-host') continue
      const tag = el.tagName.toLowerCase()
      if (tag === 'html' || tag === 'body') continue

      const r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) continue
      // Skip invisible decoys (jerico-orch-preview-IMPL-BRIEF PART B #3): a page
      // can plant a visibility:hidden / opacity:0 element in the dragged region
      // and harvest its snippet unseen.
      const cs = window.getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse' || cs.opacity === '0') continue
      // Walk the ancestor chain: a decoy hidden by an opacity:0 / visibility:hidden
      // PARENT slips through the own-element check (not inherited in computed
      // style). Skip if any ancestor up to body is hidden (jerico-orch-preview-FIX2 #4).
      let ancestor = el.parentElement
      let ancestorHidden = false
      while (ancestor && ancestor.tagName.toLowerCase() !== 'body') {
        const acs = window.getComputedStyle(ancestor)
        if (acs.visibility === 'hidden' || acs.visibility === 'collapse' || acs.opacity === '0') {
          ancestorHidden = true
          break
        }
        ancestor = ancestor.parentElement
      }
      if (ancestorHidden) continue
      const intersects = r.left < rectRight && r.right > rect.x && r.top < rectBottom && r.bottom > rect.y
      if (!intersects) continue
      selected.push({ el, r })
    }

    // De-noise: drop giant containers (>~1.5x the rect in both dims).
    const filtered = selected.filter(({ r }) => {
      const tooWide = r.width > rect.width * REGION_GIANT_RATIO
      const tooTall = r.height > rect.height * REGION_GIANT_RATIO
      return !(tooWide && tooTall)
    })

    // Drop pure wrappers whose only meaningful child is also selected.
    const candidateEls = new Set(filtered.map(f => f.el))
    return filtered.filter(({ el }) => {
      const directSelectedChildren = Array.from(el.children).filter(c =>
        candidateEls.has(c as HTMLElement)
      )
      // Count only DIRECT child text nodes (nodeType === 3) — el.textContent
      // includes ALL descendant text, so ownText.length === 0 was almost never
      // true and wrappers were never dropped (PART B #4).
      let ownText = ''
      for (const child of Array.from(el.childNodes)) {
        if (child.nodeType === 3) ownText += child.textContent || ''
      }
      ownText = ownText.trim()
      if (directSelectedChildren.length === 1 && ownText.length === 0) {
        return false
      }
      return true
    })
  }

  private async extractRegionPayload(rect: { x: number; y: number; width: number; height: number }, annotation: string) {
    const cleanAnnotation = this.sanitizeAnnotation(annotation)

    const deNoised = this.selectRegionElements(rect)
    const capped = deNoised.slice(0, REGION_MAX_ELEMENTS)

    const elements = capped.map(({ el, r }) => {
      let selector = ''
      try {
        selector = finder(el)
      } catch {
        selector = el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '')
      }
      selector = redactSelector(selector)
      const roleAttr = el.getAttribute('role')
      let htmlSnippet = getHtmlSnippet(el)
      if (htmlSnippet.length > REGION_SNIPPET_CAP) {
        htmlSnippet = htmlSnippet.slice(0, REGION_SNIPPET_CAP) + ' (truncated)'
      }
      return {
        selector,
        tagName: el.tagName.toLowerCase(),
        role: roleAttr && roleAttr.length <= 64 ? stripBridgeMarkers(roleAttr) : null,
        htmlSnippet,
        rectViewport: {
          x: Math.round(r.left),
          y: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height)
        }
      }
    })

    const rectPage = {
      x: rect.x + window.scrollX,
      y: rect.y + window.scrollY,
      width: rect.width,
      height: rect.height
    }

    return {
      kind: 'region' as const,
      rectViewport: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      rectPage,
      annotation: cleanAnnotation,
      elements,
      devicePixelRatio: window.devicePixelRatio || 1
    }
  }

  private sanitizeAnnotation(raw: string): string {
    // Strip null bytes + prompt-injection markers from free-text annotation.
    const nullByte = String.fromCharCode(0)
    const cleaned = (raw || '')
      .split(nullByte).join('')
      .replace(/JERICO_DONE_[A-Z0-9_-]*/gi, '')
      // Strip spoofed trusted-directive markers (jerico-orch-preview-IMPL-BRIEF PART B #2).
      .replace(/\[BRIDGE-(ORCH|INSPECT)\][^\n]*/gi, '')
    return cleaned.slice(0, 2000)
  }

  private async onClick(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const el = this.currentEl;
    if (!el) {
      this.teardown();
      return;
    }
    await this.handleElementClick(el);
  }

  private async handleElementClick(el: HTMLElement) {
    if (this.host) {
      this.host.style.pointerEvents = 'none';
      this.host.style.cursor = 'default';
    }

    try {
      const payload = await this.extractPayload(el);
      window.parent.postMessage({
        source: 'jerico-inspect',
        type: 'result',
        nonce: this.nonce,
        payload
      }, this.allowedOrigin);
    } catch (err) {
      console.error('[JERICO-INSPECT] Failed to extract element:', err);
    } finally {
      this.teardown();
    }
  }

  private async extractPayload(el: HTMLElement) {
    let selector = '';
    try {
      selector = finder(el);
    } catch {
      selector = el.tagName.toLowerCase();
      if (el.id) selector += `#${el.id}`;
    }
    selector = redactSelector(selector);

    const computedStyles = getCuratedStyles(el);
    const attributes = getSafeAttributes(el);
    const htmlSnippet = getHtmlSnippet(el);
    // F2: redact rendered text when el/ancestor is secret-labelled; F1: strip markers.
    const rawText = (el.innerText || el.textContent || '').trim().slice(0, 200);
    const textSnippet = hasSecretContext(el) ? '[redacted]' : stripBridgeMarkers(rawText);

    const rect = el.getBoundingClientRect();
    const rectViewport = {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height
    };
    const rectPage = {
      x: rect.left + window.scrollX,
      y: rect.top + window.scrollY,
      width: rect.width,
      height: rect.height
    };

    const sourceFileRaw = getSourceFile(el);
    const sourceFile = sourceFileRaw ? stripBridgeMarkers(sourceFileRaw) : sourceFileRaw;

    // F2: element screenshot dropped — snapdom rasterizes rendered pixels (incl.
    // visible secrets) with no possible redaction path; nothing consumes it.

    return {
      selector,
      tagName: el.tagName.toLowerCase(),
      id: el.id ? (containsSecret(el.id) ? '[redacted]' : stripBridgeMarkers(el.id)) : '',
      classes: Array.from(el.classList).filter(c => !containsSecret(c)).map(stripBridgeMarkers),
      htmlSnippet,
      computedStyles,
      attributes,
      textSnippet,
      rectViewport,
      rectPage,
      devicePixelRatio: window.devicePixelRatio || 1,
      sourceFile
    };
  }
}

interface WindowWithInspect extends Window {
  __jericoInspect?: JericoInspect;
}

const win = window as unknown as WindowWithInspect;
if (win.__jericoInspect) {
  win.__jericoInspect.destroy();
}
win.__jericoInspect = new JericoInspect();
win.__jericoInspect.init();
