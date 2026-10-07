import {
  FIRST_RUN_INTRO_END_SECONDS,
  FIRST_RUN_REDUCED_INTRO_HOLD_MS,
  canSkipFirstRun,
} from '../../main/first-run-policy'
import type { FirstRunAPI } from '../../main/first-run-policy'

interface SceneBeat {
  key: string
  fromReal: number
  toReal: number
}

interface SceneDescription {
  durReal: number
  beats: SceneBeat[]
}

interface SceneWindow extends Window {
  JERICO_SCENE?: SceneDescription
  __fadeOut?: (seconds: number) => void
}

declare global {
  interface Window {
    introApi?: FirstRunAPI
  }
}

const FILES = [
  './first-run/07-first-run-tour.html',
  './first-run/08-first-run-orchestrator.html',
  './first-run/09-first-run-close.html',
]

const REDUCED_INTRO_HOLD_AT = 11.6
const REDUCED_HOLD_MS = FIRST_RUN_REDUCED_INTRO_HOLD_MS
const REDUCED_07_PRODUCT_HOLDS = [18.6, 24.3]
const RENDERER_TIMEOUT_MS = 90_000

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) {
    window.introApi?.done()
    throw new Error(`first-run renderer is missing #${id}`)
  }
  return element as T
}

const host = requiredElement<HTMLDivElement>('host')
const skipButton = requiredElement<HTMLButtonElement>('skip-tour')
const announcement = requiredElement<HTMLDivElement>('announcement')

function safeInset(name: string, fallback: number): number {
  const raw = Number(new URLSearchParams(window.location.search).get(name))
  return Number.isFinite(raw) ? Math.min(240, Math.max(fallback, raw)) : fallback
}

skipButton.style.setProperty('--skip-safe-bottom', `${safeInset('skipBottom', 20)}px`)
skipButton.style.setProperty('--skip-safe-right', `${safeInset('skipRight', 22)}px`)

let currentFrame: HTMLIFrameElement | null = null
let currentPoll: ReturnType<typeof setInterval> | null = null
let currentTimer: ReturnType<typeof setTimeout> | null = null
let skipUnlocked = false
let finished = false

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

function clearClock(): void {
  if (currentPoll) clearInterval(currentPoll)
  if (currentTimer) clearTimeout(currentTimer)
  currentPoll = null
  currentTimer = null
}

function finish(): void {
  if (finished) return
  finished = true
  clearClock()
  try {
    const scene = currentFrame?.contentWindow as SceneWindow | null
    scene?.__fadeOut?.(0.2)
  } catch {
    // The independent main-process timeout still owns the final escape hatch.
  }
  document.body.classList.add('leaving')
  setTimeout(() => window.introApi?.done(), reducedMotion ? 0 : 220)
}

function unlockSkip(): void {
  if (skipUnlocked) return
  skipUnlocked = true
  skipButton.hidden = false
  announcement.textContent = 'Introduction complete. Skip tour is now available.'
  window.introApi?.tourReady()
}

function sceneWindow(frame: HTMLIFrameElement): SceneWindow | null {
  return frame.contentWindow as SceneWindow | null
}

function sceneDocument(frame: HTMLIFrameElement): Document | null {
  try {
    return frame.contentDocument
  } catch {
    return null
  }
}

function removeOutgoing(outgoing: HTMLIFrameElement | null): void {
  if (!outgoing) return
  try {
    sceneWindow(outgoing)?.__fadeOut?.(0.8)
  } catch {
    // A scene without audio has nothing to fade.
  }
  // Incoming scenes are deliberately transparent over the live desktop. Keep
  // only the outgoing AudioContext for its fade; its picture must not ghost
  // behind the next scene until the iframe is removed.
  outgoing.style.visibility = 'hidden'
  setTimeout(() => outgoing.remove(), 860)
}

function prepareScene(frame: HTMLIFrameElement, index: number): Document | null {
  const doc = sceneDocument(frame)
  if (!doc) return null

  const appStyle = doc.createElement('style')
  appStyle.dataset['jericoApp'] = 'true'
  appStyle.textContent = `
    .hud, .gate { display: none !important; }
    ${index <= 1 ? `
      html, body.present { background: transparent !important; }
      body.present .stage { background: transparent !important; }
      .desk-bar, .desk-win { display: none !important; }
    ` : ''}
    ${index === 0 ? `
      html, body { cursor: none !important; }
    ` : ''}
  `
  doc.head.appendChild(appStyle)

  const spoken = doc.querySelector<HTMLElement>('.stage > .sr')
  if (spoken) {
    spoken.textContent = index === 0 && !skipUnlocked
      ? 'Jerico is starting. The opening film completes before the tour can be skipped.'
      : 'Jerico first-run tour. Press Escape to skip the remaining tour.'
  }

  // Key events inside an iframe do not bubble to the runner. Capture Escape
  // here before the design sheet's own handler can turn it into a scene-local
  // jump. Before the lockup it is intentionally a no-op; afterwards it exits
  // the complete tour.
  doc.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (skipUnlocked) finish()
  }, true)

  return doc
}

function sceneUrl(index: number, from?: number, to?: number): string {
  const params = new URLSearchParams({ present: '1', app: '1' })
  if (from !== undefined) params.set('from', from.toFixed(2))
  if (to !== undefined) params.set('to', to.toFixed(2))
  if (index < FILES.length - 1) params.set('handover', '1')
  return `${FILES[index]}?${params.toString()}`
}

function playScene(index: number, from?: number, knownTo?: number): void {
  if (finished) return
  if (index >= FILES.length) {
    currentTimer = setTimeout(finish, 420)
    return
  }

  clearClock()
  const outgoing = currentFrame
  const frame = document.createElement('iframe')
  // The scene is a picture, not a second document the keyboard has to enter.
  // Keep the runner's Skip action as the first and only focus stop.
  frame.tabIndex = -1
  frame.style.visibility = 'hidden'
  currentFrame = frame
  frame.title = index === 0 ? 'Jerico introduction' : 'Jerico first-run tour'
  frame.src = sceneUrl(index, from, knownTo)
  frame.addEventListener('error', finish, { once: true })
  frame.addEventListener('load', () => {
    if (finished || frame !== currentFrame) return
    const doc = prepareScene(frame, index)
    const scene = sceneWindow(frame)?.JERICO_SCENE
    const range = doc?.getElementById('range') as HTMLInputElement | null
    const play = doc?.getElementById('play') as HTMLButtonElement | null
    if (!doc || !scene || !range || !play) {
      finish()
      return
    }

    if (index > 0) unlockSkip()
    play.click()
    frame.style.visibility = 'visible'
    requestAnimationFrame(() => requestAnimationFrame(() => removeOutgoing(outgoing)))

    const start = from ?? 0
    const end = knownTo ?? scene.durReal
    currentPoll = setInterval(() => {
      const elapsed = Number(range.value) / 100
      if (index === 0 && canSkipFirstRun(elapsed)) unlockSkip()
      if (elapsed >= end - 0.06) {
        clearClock()
        currentTimer = setTimeout(() => playScene(index + 1), 340)
      } else if (elapsed < start - 0.05 || !Number.isFinite(elapsed)) {
        finish()
      }
    }, 100)
  }, { once: true })
  host.appendChild(frame)
}

function showReducedFirstScene(): void {
  clearClock()
  const frame = document.createElement('iframe')
  frame.tabIndex = -1
  frame.style.visibility = 'hidden'
  currentFrame = frame
  frame.title = 'Jerico introduction'
  frame.src = `${FILES[0]}?present=1&app=1#t=${REDUCED_INTRO_HOLD_AT.toFixed(2)}`
  frame.addEventListener('error', finish, { once: true })
  frame.addEventListener('load', () => {
    if (finished || frame !== currentFrame) return
    const doc = prepareScene(frame, 0)
    const scene = sceneWindow(frame)?.JERICO_SCENE
    const range = doc?.getElementById('range') as HTMLInputElement | null
    if (!doc || !scene || !range) {
      finish()
      return
    }
    frame.style.visibility = 'visible'

    const holds = [REDUCED_INTRO_HOLD_AT, ...REDUCED_07_PRODUCT_HOLDS]
    let holdIndex = 0
    const advance = (): void => {
      if (finished) return
      holdIndex += 1
      if (holdIndex === 1) unlockSkip()
      if (holdIndex >= holds.length) {
        playScene(1)
        return
      }
      const at = holds[holdIndex]
      if (at === undefined) {
        finish()
        return
      }
      range.value = String(Math.round(at * 100))
      range.dispatchEvent(new Event('input', { bubbles: true }))
      currentTimer = setTimeout(advance, REDUCED_HOLD_MS)
    }
    currentTimer = setTimeout(advance, REDUCED_HOLD_MS)
  }, { once: true })
  host.appendChild(frame)
}

skipButton.addEventListener('click', () => {
  if (skipUnlocked) finish()
})

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && skipUnlocked) {
    event.preventDefault()
    finish()
  }
})

window.addEventListener('pagehide', clearClock)
setTimeout(finish, RENDERER_TIMEOUT_MS)

if (reducedMotion) showReducedFirstScene()
else playScene(0)

export {}
