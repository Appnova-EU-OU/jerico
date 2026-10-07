/**
 * The /dev/ptmx leak, and the version pin that fixes it.
 *
 * node-pty 1.1.0 leaked exactly one /dev/ptmx descriptor per panel LIFECYCLE —
 * not per live panel. Measured independently twice (codex's controlled experiment
 * and mine), perfectly linear: 20 lifecycles, 20 retained descriptors, on both
 * the natural-exit path and the manager's group-kill plus destroy(). Against
 * macOS's `kern.tty.ptmx_max` of 511 that meant a daemon stopped being able to
 * spawn after roughly 500 panels, whatever the concurrency was — and this
 * codebase's panel cap never constrained it, because a concurrency limit cannot
 * bound a per-lifetime cost.
 *
 * The mitigation at `pty/manager.ts:435` took it from two to one. The remaining
 * one lived in the native layer: destroying the JS socket does NOT release it
 * (tested), so no patch to the shipped JavaScript could reach it.
 *
 * 1.2.0-beta.15 fixes it outright — 40 lifecycles, zero retained descriptors.
 */
import { describe, expect, test } from 'bun:test'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)

describe('pty descriptor lifecycle', () => {
  test('node-pty is pinned to a version without the per-lifecycle leak', () => {
    const version = (require_('node-pty/package.json') as { version: string }).version
    // Pinned exactly rather than a range: 1.1.0 is still the `latest` dist-tag,
    // so a caret would silently resolve back to the leaking version.
    expect(version).toBe('1.2.0-beta.15')
  })

  /**
   * There is no runtime companion to the assertion above, and that is deliberate
   * rather than an omission.
   *
   * node-pty does not work under bun: it spawns and returns a pid, but neither
   * `onData` nor `onExit` ever fires, so a lifecycle loop waits forever. That was
   * learned the hard way earlier in this work, when a bun-hosted pty harness
   * produced a false failure for unrelated code. The daemon runs under node, so
   * runtime behaviour is unaffected — but it cannot be asserted from this suite,
   * and a `.skip` would be a silently disabled test, which this repo forbids
   * outright and is right to.
   *
   * The measurement that verifies it, run under node:
   *
   *   node -e "const pty=require('node-pty'),{execSync}=require('child_process');
   *   const n=()=>{try{return +execSync(`lsof -nP -p ${process.pid}|grep -c ptmx`)}catch{return 0}};
   *   (async()=>{for(let i=0;i<40;i++){const p=pty.spawn('/bin/sh',['-c','exit 0'],{name:'xterm',cols:80,rows:24});
   *   await new Promise(r=>p.onExit(()=>r()))}setTimeout(()=>console.log('ptmx:',n()),300)})()"
   *
   * Result on 1.1.0: 40 retained. On 1.2.0-beta.15: 0. The version pin above is
   * what keeps it that way.
   */
})
