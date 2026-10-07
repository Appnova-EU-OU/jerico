import { contextBridge, ipcRenderer } from 'electron'
import type { FirstRunAPI } from '../main/first-run-policy.js'

/**
 * The intro window's entire surface area: one message, one direction.
 *
 * It is deliberately not part of the main preload. That one exposes token
 * validation, config writes and daemon lifecycle control, and the intro is the
 * only window in the app that renders before the permission gate has run — it
 * has no business being able to reach any of that.
 */
const introApi: FirstRunAPI = {
  tourReady(): void {
    ipcRenderer.send('intro:tour-ready')
  },
  done(): void {
    ipcRenderer.send('intro:done')
  },
}

contextBridge.exposeInMainWorld('introApi', introApi)
