/**
 * Issue #577 — a launchd label loaded from a registration we do not manage.
 *
 * launchd does not re-read the plist FILE of an already-bootstrapped label, so
 * `setupLaunchd()` + `kickstart` re-kicks the stale program forever. The facts
 * needed to notice this were already in the `launchctl list <label>` output
 * startOrKickstartDaemon has always fetched — `Program` / `ProgramArguments` and
 * `LastExitStatus` — and were discarded in favour of the `PID` match alone.
 *
 * Everything here is pure: parsing, the mismatch predicate (with injected exists /
 * canonicalize), and source-structure assertions on the one branch allowed to
 * unload. No launchctl command is run — the unsuffixed com.jerico.bridge-agent on
 * this machine is a live production daemon.
 */
import { describe, test, expect } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseLaunchctlList,
  classifyLaunchdRegistration,
  canonicalizeLaunchdPath,
  describeLastExitStatus,
  humanStartFailure,
  type LaunchdRegistrationProbe,
} from '../commands/start.js'


const WRAPPER = '/Users/me/.bridge/bridge-agent-wrapper.sh'

/** Measured on a healthy live label (see #577 correction). */
const HEALTHY_LIST_OUTPUT = `{
	"StandardOutPath" = "/Users/me/bridge-daemon.log";
	"StandardErrorPath" = "/Users/me/bridge-daemon.err.log";
	"Label" = "com.jerico.bridge-agent";
	"LastExitStatus" = 0;
	"PID" = 72032;
	"Program" = "${WRAPPER}";
	"ProgramArguments" = (
		"${WRAPPER}";
	);
};`

/** A pre-2026-05-01 (commit 48c6cde8) registration: no wrapper, the daemon entry
 *  itself as argv[0]. getDaemonEntry() realpaths argv[1], which under nvm resolves
 *  into a node-version-scoped directory that disappears when node is upgraded. */
const PRE_WRAPPER_LIST_OUTPUT = `{
	"Label" = "com.jerico.bridge-agent";
	"LastExitStatus" = 19968;
	"PID" = 0;
	"ProgramArguments" = (
		"/Users/me/.nvm/versions/node/v22.22.3/lib/node_modules/bridge-agent/dist/index.js";
		"start";
	);
};`

const listed = (out: string): LaunchdRegistrationProbe => ({
  state: 'listed',
  registration: parseLaunchctlList(out),
})
const registered = (program: string | null, lastExitStatus: number | null = 0): LaunchdRegistrationProbe => ({
  state: 'listed',
  registration: { program, lastExitStatus, programUndecodable: false },
})

const alwaysExists = { exists: () => true }
const neverExists = { exists: () => false }
/** Identity canonicalizer — keeps the predicate tests off the real filesystem. */
const identity = { canonicalize: (p: string) => p }

describe('#577 parseLaunchctlList', () => {
  test('reads Program and LastExitStatus from a healthy label', () => {
    expect(parseLaunchctlList(HEALTHY_LIST_OUTPUT)).toEqual({
      program: WRAPPER,
      lastExitStatus: 0,
      programUndecodable: false,
    })
  })

  test('falls back to ProgramArguments argv[0] when there is no Program key', () => {
    expect(parseLaunchctlList(PRE_WRAPPER_LIST_OUTPUT)).toEqual({
      program: '/Users/me/.nvm/versions/node/v22.22.3/lib/node_modules/bridge-agent/dist/index.js',
      lastExitStatus: 19968,
      programUndecodable: false,
    })
  })

  test('absent fields parse to null rather than throwing or guessing', () => {
    expect(parseLaunchctlList('{\n\t"Label" = "com.jerico.bridge-agent";\n};')).toEqual({
      program: null,
      lastExitStatus: null,
      programUndecodable: false,
    })
  })
})

/**
 * The DANGEROUS direction. Every test above asks "does the predicate still agree
 * when it should?"; these ask "can the parser INVENT a disagreement?" — because a
 * manufactured mismatch on a stopped job is the branch that boots a healthy daemon
 * out. A reviewer reproduced exactly that with an escaped quote in the path.
 */
describe('#577 parseLaunchctlList escapes — no manufactured mismatch', () => {
  const QUOTED = '/Volumes/Relocated/A"B/.bridge/bridge-agent-wrapper.sh'
  const QUOTED_OUTPUT = '{\n\t"Program" = "/Volumes/Relocated/A\\"B/.bridge/bridge-agent-wrapper.sh";\n};'

  test('an escaped quote decodes to the real path, not a truncated fragment', () => {
    const parsed = parseLaunchctlList(QUOTED_OUTPUT)
    expect(parsed.program).toBe(QUOTED)
    expect(parsed.programUndecodable).toBe(false)
  })

  test('REGRESSION GUARD: a quote-bearing path that IS ours is not a mismatch', () => {
    const verdict = classifyLaunchdRegistration(listed(QUOTED_OUTPUT), QUOTED, {
      ...alwaysExists,
      ...identity,
    })
    expect(verdict.mismatch).toBe(false)
    expect(verdict.reason).toBe('matches')
  })

  test('an escape we cannot decode is unparseable — never a mismatch', () => {
    const parsed = parseLaunchctlList('{\n\t"Program" = "/Users/me/\\q/wrapper.sh";\n};')
    expect(parsed.programUndecodable).toBe(true)
    expect(parsed.program).toBeNull()
    const verdict = classifyLaunchdRegistration(
      { state: 'listed', registration: parsed },
      WRAPPER,
      { ...alwaysExists, ...identity },
    )
    expect(verdict.mismatch).toBe(false)
    expect(verdict.reason).toBe('unparseable')
  })

  test('an unterminated Program value is unparseable, not a truncated path', () => {
    const parsed = parseLaunchctlList('{\n\t"Program" = "/Users/me/.bridge/wrapper.sh\n};')
    expect(parsed.programUndecodable).toBe(true)
    expect(classifyLaunchdRegistration({ state: 'listed', registration: parsed }, WRAPPER, identity).mismatch).toBe(false)
  })

  test('an undecodable Program does NOT fall through to ProgramArguments argv[0]', () => {
    // Program wins over the array when both are present (launchd.plist(5)); if we
    // cannot read Program we must not silently compare a different value instead.
    const parsed = parseLaunchctlList(
      '{\n\t"Program" = "/Users/me/\\q/wrapper.sh";\n\t"ProgramArguments" = (\n\t\t"/somewhere/else.sh";\n\t);\n};',
    )
    expect(parsed.programUndecodable).toBe(true)
    expect(parsed.program).toBeNull()
  })

  test('escapes launchd does emit decode: backslash, tab, octal, \\Uxxxx', () => {
    expect(parseLaunchctlList('{\n\t"Program" = "/a\\\\b/w.sh";\n};').program).toBe('/a\\b/w.sh')
    expect(parseLaunchctlList('{\n\t"Program" = "/a\\011b/w.sh";\n};').program).toBe('/a\tb/w.sh')
    expect(parseLaunchctlList('{\n\t"Program" = "/a\\U00e7b/w.sh";\n};').program).toBe('/açb/w.sh')
  })

  test('a spaced or non-ASCII path still survives the decoder untouched', () => {
    expect(parseLaunchctlList('{\n\t"Program" = "/Users/mé/My Apps/w.sh";\n};').program)
      .toBe('/Users/mé/My Apps/w.sh')
  })
})

describe('#577 classifyLaunchdRegistration', () => {
  test('a foreign program is a provable mismatch → bootout', () => {
    const verdict = classifyLaunchdRegistration(listed(PRE_WRAPPER_LIST_OUTPUT), WRAPPER, {
      ...alwaysExists,
      ...identity,
    })
    expect(verdict.mismatch).toBe(true)
    expect(verdict.reason).toBe('foreign_program')
    expect(verdict.detail).toContain('v22.22.3')
  })

  test('our program, missing on disk, is a provable mismatch', () => {
    const verdict = classifyLaunchdRegistration(listed(HEALTHY_LIST_OUTPUT), WRAPPER, {
      ...neverExists,
      ...identity,
    })
    expect(verdict.mismatch).toBe(true)
    expect(verdict.reason).toBe('program_missing')
  })

  test('REGRESSION GUARD: a matching, running registration is never a mismatch', () => {
    const verdict = classifyLaunchdRegistration(listed(HEALTHY_LIST_OUTPUT), WRAPPER, {
      ...alwaysExists,
      ...identity,
    })
    expect(verdict.mismatch).toBe(false)
    expect(verdict.reason).toBe('matches')
  })

  test('a non-zero exit from OUR program is not a mismatch — it is a real failure to report', () => {
    const verdict = classifyLaunchdRegistration(registered(WRAPPER, 19968), WRAPPER, {
      ...alwaysExists,
      ...identity,
    })
    expect(verdict.mismatch).toBe(false)
    expect(verdict.reason).toBe('matches')
  })

  test('a failed launchctl list proves nothing → today\'s behaviour', () => {
    const verdict = classifyLaunchdRegistration(
      { state: 'unavailable', error: 'spawnSync /bin/sh ETIMEDOUT' },
      WRAPPER,
    )
    expect(verdict.mismatch).toBe(false)
    expect(verdict.reason).toBe('probe_unavailable')
    expect(verdict.detail).toContain('ETIMEDOUT')
  })

  test('unparseable output proves nothing → today\'s behaviour', () => {
    const verdict = classifyLaunchdRegistration(listed('Could not find service'), WRAPPER)
    expect(verdict.mismatch).toBe(false)
    expect(verdict.reason).toBe('unparseable')
  })

  test('an unresolvable path proves nothing → today\'s behaviour, no bootout', () => {
    const verdict = classifyLaunchdRegistration(registered('/somewhere/else.sh'), WRAPPER, {
      canonicalize: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) },
    })
    expect(verdict.mismatch).toBe(false)
    expect(verdict.reason).toBe('unresolvable_path')
  })
})

describe('#577 canonicalizeLaunchdPath', () => {
  // The #577 machine saw the wrapper registered under /private/tmp and resolved
  // under /tmp: two names for one directory through a symlinked ancestor. macOS
  // has that alias built in. Elsewhere the test makes the same shape itself — a
  // real directory and a symlink to it — so the property runs on every OS.
  function aliasPair(): { viaAlias: string; viaReal: string; realRoot: string; cleanup: () => void } {
    if (process.platform === 'darwin') {
      const dir = fs.mkdtempSync('/tmp/jerico-577-canon-')
      return {
        viaAlias: dir,
        viaReal: path.join('/private', dir.replace(/^\//, '')),
        realRoot: '/private/tmp/',
        cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
      }
    }
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jerico-577-canon-')))
    const real = path.join(base, 'real')
    const alias = path.join(base, 'alias')
    fs.mkdirSync(real)
    fs.symlinkSync(real, alias)
    return {
      viaAlias: alias,
      viaReal: real,
      realRoot: real + '/',
      cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
    }
  }

  test('/tmp and /private/tmp are the same file → no mismatch', () => {
    const pair = aliasPair()
    const viaTmp = path.join(pair.viaAlias, 'bridge-agent-wrapper.sh')
    try {
      fs.writeFileSync(viaTmp, '#!/bin/bash --norc\n', { mode: 0o755 })
      const viaPrivate = path.join(pair.viaReal, 'bridge-agent-wrapper.sh')
      expect(viaPrivate.startsWith(pair.realRoot)).toBe(true)
      expect(viaPrivate).not.toBe(viaTmp)
      expect(canonicalizeLaunchdPath(viaTmp)).toBe(canonicalizeLaunchdPath(viaPrivate))

      const verdict = classifyLaunchdRegistration(registered(viaPrivate), viaTmp)
      expect(verdict.mismatch).toBe(false)
      expect(verdict.reason).toBe('matches')
    } finally {
      pair.cleanup()
    }
  })

  test('resolves a path whose leaf does not exist (the #577 machine had neither side)', () => {
    const pair = aliasPair()
    try {
      const missing = path.join(pair.viaAlias, '.bridge', 'bridge-agent-wrapper.sh')
      const resolved = canonicalizeLaunchdPath(missing)
      expect(resolved.startsWith(pair.realRoot)).toBe(true)
      expect(resolved.endsWith('/.bridge/bridge-agent-wrapper.sh')).toBe(true)
    } finally {
      pair.cleanup()
    }
  })
})

describe('#577 describeLastExitStatus', () => {
  test('a clean or absent status says nothing', () => {
    expect(describeLastExitStatus(0)).toBeNull()
    expect(describeLastExitStatus(null)).toBeNull()
  })

  test('decodes both spellings of the raw wait status, keeping the raw number', () => {
    expect(describeLastExitStatus(19968)).toBe('previous launchd run exited with status 19968 (exit code 78)')
    expect(describeLastExitStatus(78)).toBe('previous launchd run exited with status 78 (exit code 78)')
  })

  test('an unrecognised status is reported raw rather than decoded wrongly', () => {
    expect(describeLastExitStatus(-1)).toBe('previous launchd run exited with status -1')
  })

  test('says PREVIOUS run — a non-zero status can sit next to a live, healthy PID', () => {
    // Measured by the reproducer: "LastExitStatus" = 15 alongside a running PID 15743.
    // Nothing this string is pasted into may read as a claim about that process.
    for (const status of [15, 19968, 78, -1]) {
      const note = describeLastExitStatus(status)
      expect(note).toStartWith('previous launchd run ')
      expect(note).not.toContain('the daemon')
      expect(note).not.toContain('is ')
    }
  })

  test('a raw status below 32 is the SIGNAL that killed it, not an exit code', () => {
    // Reproduced with `kill -TERM` on a throwaway label: "LastExitStatus" = 15.
    // stop.ts SIGTERMs and escalates to SIGKILL, so with KeepAlive{SuccessfulExit:false}
    // EVERY stopped daemon on EVERY machine sits at 15 or 9 — calling that "exit code
    // 15" made humanStartFailure tell those users their service was registered
    // against a path that no longer exists.
    expect(describeLastExitStatus(15)).toBe('previous launchd run was killed by signal 15 (SIGTERM)')
    expect(describeLastExitStatus(9)).toBe('previous launchd run was killed by signal 9 (SIGKILL)')
    // 31 named SIGUSR2 here, from `kill -l` on this host — the table now covers all
    // 31 Darwin signals, so the top of the range no longer prints bare.
    expect(describeLastExitStatus(31)).toBe('previous launchd run was killed by signal 31 (SIGUSR2)')
    // The signal lives in the LOW bits — a set core flag does not move it.
    expect(describeLastExitStatus(0x80 | 30))
      .toBe('previous launchd run was killed by signal 30 (SIGUSR1) and dumped core')
    for (const signal of [9, 15, 31]) {
      expect(describeLastExitStatus(signal)).not.toContain('exit code')
    }
  })

  test('the exit-code boundary keeps 32..255 and the shifted spelling as exit codes', () => {
    expect(describeLastExitStatus(32)).toBe('previous launchd run exited with status 32 (exit code 32)')
    expect(describeLastExitStatus(78)).toContain('(exit code 78)')
    expect(describeLastExitStatus(19968)).toContain('(exit code 78)')
  })

  test('a signal WITH the core-dump flag is still a signal, not exit code 139', () => {
    // 139 = 11 | 0x80. The `< 32` split sent it to the 32..255 branch, which called a
    // segfault "exit code 139" — and that is the branch humanStartFailure turns into
    // the "path that no longer exists" diagnosis. Verified against this host's own
    // macros: WIFSIGNALED(139), WTERMSIG 11, WCOREFLAG set.
    expect(describeLastExitStatus(139)).toBe('previous launchd run was killed by signal 11 (SIGSEGV) and dumped core')
    expect(describeLastExitStatus(139)).not.toContain('exit code')
    // Without the flag, the same signal, without the claim about a core file.
    expect(describeLastExitStatus(11)).toBe('previous launchd run was killed by signal 11 (SIGSEGV)')
  })

  test('the stopped and continued sentinels are not exits at all', () => {
    // Both were falling through to the raw-number branch, which says nothing useful.
    //
    // Which value is which was measured, not assumed: Darwin spells WIFSTOPPED as
    // `_WSTATUS(x) == 0x7F && WSTOPSIG(x) != 0x13`, reserving 0x13 for WIFCONTINUED.
    // Compiling <sys/wait.h> against these values on this host gives
    // WIFSTOPPED(4479) with WSTOPSIG 17 (SIGSTOP), and WIFCONTINUED(4991) — so
    // 4991 is NOT the SIGSTOP-stopped sentinel it is often taken for.
    expect(describeLastExitStatus(4479))
      .toBe('previous launchd run was stopped by signal 17 (SIGSTOP) (status 4479) and did not report an exit')
    expect(describeLastExitStatus(4991))
      .toBe('previous launchd run was continued after a stop (status 4991) and did not report an exit')
    for (const status of [4479, 4991]) {
      // Neither may reach humanStartFailure's exit-code diagnosis.
      expect(describeLastExitStatus(status)).not.toContain('exit code')
      expect(humanStartFailure(`kickstarted_job_never_became_ready — ${describeLastExitStatus(status)}`))
        .not.toContain('path that no longer exists')
    }
  })

  test('every decoded status still speaks about the PREVIOUS run', () => {
    for (const status of [9, 11, 15, 31, 32, 78, 139, 4479, 4991, 19968, -1]) {
      expect(describeLastExitStatus(status)).toStartWith('previous launchd run ')
    }
  })
})

describe('#577 humanStartFailure', () => {
  test('a signal note never becomes the "path that no longer exists" diagnosis', () => {
    const note = describeLastExitStatus(15) ?? ''
    const human = humanStartFailure(`running_job_never_became_ready — ${note}; inspect with: launchctl print …`)
    expect(human).not.toContain('path that no longer exists')
    expect(human).toContain('signal 15')
    expect(human).toContain('previous run')
  })

  test('an exit-code note still gets the registration diagnosis', () => {
    const note = describeLastExitStatus(19968) ?? ''
    expect(humanStartFailure(`kickstarted_job_never_became_ready — ${note}`))
      .toContain('path that no longer exists')
  })

  test('a signal note does not outrank a branch that names the real fault', () => {
    const note = describeLastExitStatus(15) ?? ''
    expect(humanStartFailure(`kickstart_failed: spawnSync /bin/sh ETIMEDOUT — ${note}`))
      .toContain('launchd did not answer in time')
  })

  test('the fail-closed bootout reason has its own sentence, not the raw code', () => {
    const human = humanStartFailure('foreign_registration_bootout_failed: launchd holds this label against "/old/w.sh", and it could not be unloaded. Re-register the login service with: bridge-agent restart')
    expect(human).toContain('bridge-agent restart')
    expect(human).not.toContain('foreign_registration_bootout_failed')
  })
})

describe('#577 startOrKickstartDaemon structure', () => {
  const source = fs.readFileSync(path.join(import.meta.dir, '..', 'commands', 'start.ts'), 'utf8')
  const mismatchBlock = source.slice(
    source.indexOf('if (verdict?.mismatch)'),
    source.indexOf('/** Wait for launchd to finish'),
  )

  test('bootout exists in exactly one place and only under a proven mismatch', () => {
    expect(source.match(/launchctl bootout/g)?.length).toBe(1)
    expect(source.match(/bootoutForeignRegistration\(uid, plistLabel\)/g)?.length).toBe(1)
    expect(mismatchBlock).toContain('bootoutForeignRegistration(uid, plistLabel)')
  })

  test('a running job is handled before the bootout and never reaches it', () => {
    const runningAt = mismatchBlock.indexOf("jobState === 'loaded_running'")
    const bootoutAt = mismatchBlock.indexOf('bootoutForeignRegistration(uid')
    expect(runningAt).toBeGreaterThan(-1)
    expect(runningAt).toBeLessThan(bootoutAt)
    expect(mismatchBlock).toContain('foreign_registration_running')
  })

  test('a successful bootout falls through to the not-loaded bootstrap path', () => {
    expect(mismatchBlock).toContain("jobState = 'not_loaded'")
  })

  test('a FAILED bootout fails closed instead of kicking the proven-foreign label', () => {
    // The fall-through was the silent success this issue exists to remove: the plist
    // file gets rewritten (launchd will not re-read it), the foreign registration is
    // kickstarted, and ok:true comes back if that old program answers.
    const failedBootout = mismatchBlock.slice(mismatchBlock.indexOf('} else {', mismatchBlock.indexOf('bootoutForeignRegistration(uid')))
    expect(failedBootout).toContain('foreign_registration_bootout_failed')
    expect(failedBootout).toContain('ok: false')
    expect(failedBootout).not.toContain('the stale program may be re-kicked')
  })

  test('only a confirmed "not found" counts as unloaded', () => {
    // A timeout or an unrelated launchctl error is not proof of absence.
    const probe = source.slice(
      source.indexOf('function probeLabelPresence'),
      source.indexOf('function bootoutForeignRegistration'),
    )
    expect(probe).toContain("return 'unknown'")
    expect(probe).toContain('Could not find')
    const loop = source.slice(
      source.indexOf('function bootoutForeignRegistration'),
      source.indexOf('* Idempotent, state-aware daemon start'),
    )
    expect(loop).toContain("lastPresence === 'gone'")
    expect(loop).toContain('bootout_not_confirmed_gone')
  })

  test('the probe log carries the registration facts the diagnosis needed', () => {
    const probeLog = source.slice(
      source.indexOf("logLifecycle('lifecycle.start.probe',"),
      source.indexOf('let lastExitNote'),
    )
    expect(probeLog).toContain('registeredProgram')
    expect(probeLog).toContain('lastExitStatus')
    expect(probeLog).toContain('registrationVerdict')
  })

  test('a non-zero LastExitStatus reaches the kickstart failure reason', () => {
    const stoppedBranch = source.slice(
      source.indexOf("if (jobState === 'loaded_stopped')"),
      source.indexOf('// ── Not loaded'),
    )
    expect(stoppedBranch).toContain('withExitNote(failure)')
    expect(stoppedBranch.match(/withExitNote\(/g)?.length).toBe(2)
  })

  test('every withExitNote call site is a failure return, never a success or a health claim', () => {
    // A non-zero LastExitStatus is not evidence about the CURRENT process (measured:
    // status 15 next to a live PID). Appending the note to anything other than a
    // reason we are already failing with would turn it into exactly that claim.
    const sites = [...source.matchAll(/withExitNote\(/g)].map((m) => m.index ?? 0)
    expect(sites.length).toBe(4)
    for (const at of sites) {
      // The note is consumed within a few lines of being built; that window must
      // resolve into a failure and must not carry a success alongside it.
      const window = source.slice(source.lastIndexOf('\n', at) + 1, at + 400)
      expect(window).toContain('ok: false')
      expect(window.slice(0, window.indexOf('ok: false'))).not.toContain('ok: true')
    }
    expect(source).toContain('const withExitNote = (reason: string): string')
  })

  test('the human-facing exit-code message is phrased as the previous run', () => {
    const branch = source.slice(
      source.indexOf('const exitCode = reason.match('),
      source.indexOf("if (reason.includes('daemon_readiness_unobservable'))"),
    )
    expect(branch).toContain("launchd's previous run")
    expect(branch).not.toContain('launchd could not run the daemon')
  })

  test('the silent-staleness case is cited as measured, not inferred', () => {
    const runningFork = source.slice(
      source.indexOf('DESIGN FORK, decided'),
      source.indexOf('foreign_registration_running:'),
    )
    expect(runningFork).toContain('service.install.ok')
    expect(runningFork).toContain('MEASURED')
  })

  test('the running-branch comment does not claim update reports a false success', () => {
    // update.ts:327 requires /health to report the NEW version and rolls back
    // loudly on mismatch — it cannot succeed on such a machine, but it does not lie.
    const runningFork = source.slice(
      source.indexOf('DESIGN FORK, decided'),
      source.indexOf('foreign_registration_running:'),
    )
    expect(runningFork).not.toContain('claiming the new version')
    expect(runningFork.replace(/\s*\n\s*\/\/\s*/g, ' ')).toContain('never succeed')
  })
})

describe('#577 restart unloads a foreign registration', () => {
  const source = fs.readFileSync(path.join(import.meta.dir, '..', 'commands', 'restart.ts'), 'utf8')

  // Anchored on the call inside runRestart, not on whichever mention comes first in
  // the file: the verification helper also calls detectForeignRegistration(), and an
  // index-of-anything test would keep passing while measuring the wrong call.
  const runRestartBody = source.slice(source.indexOf('export async function runRestart'))

  test('the registration is checked BEFORE the stop it has to change', () => {
    const checkAt = runRestartBody.indexOf('detectForeignRegistration()')
    const stopAt = runRestartBody.indexOf('stopDaemon(')
    expect(checkAt).toBeGreaterThan(-1)
    expect(checkAt).toBeLessThan(stopAt)
  })

  test('stop unloads only on a proven mismatch — a plain restart is unchanged', () => {
    // A plain stop leaves the job loaded for the pre-2026-05-01 unconditional
    // KeepAlive to respawn, which makes the repair racy on the exact population it
    // targets. bootout is deterministic; unconditional bootout is not acceptable.
    expect(source).toContain('stopDaemon(registrationCheck.foreign ? { unload: true } : undefined)')
    expect(source.match(/stopDaemon\(/g)?.length).toBe(1)
  })

  test('the remedy re-reads the REGISTRATION before claiming it repaired one', () => {
    // The /health version check cannot see this: an npm install and an app install of
    // the same version report the same version, so a same-version cross-distribution
    // registration passed Phase 4 while launchd still held the foreign program.
    const versionCheckAt = runRestartBody.indexOf('awaitHealthVersion(')
    const recheckAt = runRestartBody.indexOf('verifyRegistrationIsOurs()')
    const completeAt = runRestartBody.indexOf("logLifecycle('lifecycle.restart.complete'")
    expect(recheckAt).toBeGreaterThan(versionCheckAt)
    expect(recheckAt).toBeLessThan(completeAt)
    const tail = runRestartBody.slice(recheckAt, completeAt)
    expect(tail).toContain('foreign_registration_persists')
    expect(tail).toContain('process.exit(1)')
  })

  test('an INCONCLUSIVE re-probe fails the restart instead of claiming a repair', () => {
    // `foreign: false` covers both "checked, it is ours" and "could not check"
    // (probe_unavailable / unparseable / unresolvable_path). Exiting 0 on the second
    // reintroduced the fail-open shape round 2 removed from start.ts and stop.ts:
    // restart.complete prints, the desktop clears the foreignregistration fault, and
    // launchd may still hold the stale registration.
    const recheckAt = runRestartBody.indexOf('verifyRegistrationIsOurs()')
    const completeAt = runRestartBody.indexOf("logLifecycle('lifecycle.restart.complete'")
    const tail = runRestartBody.slice(recheckAt, completeAt)
    // Success is gated on the POSITIVE verdict, not on the absence of a mismatch.
    expect(tail).toContain("afterCheck.reason !== 'matches'")
    // And not-proven is its own reason code — telling the desktop "persists" would
    // assert the opposite of what is known.
    expect(tail).toContain('registration_not_verified')
    expect(tail.match(/process\.exit\(1\)/g)?.length).toBe(2)
  })

  test('the inconclusive verdict is retried, briefly and boundedly, before it fails', () => {
    // launchctl can answer before a freshly bootstrapped job's Program is queryable,
    // and failing a repair that worked is its own bug. Bounded so it cannot hang.
    const helper = source.slice(
      source.indexOf('async function verifyRegistrationIsOurs'),
      source.indexOf('export async function runRestart'),
    )
    expect(helper).toContain("last.reason === 'matches'")
    expect(helper).toContain('REGISTRATION_VERIFY_ATTEMPTS')
    expect(source).toMatch(/REGISTRATION_VERIFY_ATTEMPTS = \d+/)
    expect(source).toMatch(/REGISTRATION_VERIFY_DELAY_MS = \d+/)
    // No unbounded loop: the attempt counter is the only exit other than a match.
    expect(helper).not.toContain('while (true)')
    expect(helper).not.toContain('for (;;)')
  })
})

describe('#577 stop --unload cannot report an unload it did not do', () => {
  const source = fs.readFileSync(path.join(import.meta.dir, '..', 'commands', 'stop.ts'), 'utf8')

  test('a bootout error is a failure, not a skip', () => {
    expect(source).not.toContain('lifecycle.stop.bootout_skip')
    expect(source).toContain('lifecycle.stop.bootout_failed')
    expect(source).toContain('unloadFailure')
  })

  test('the failure reaches the caller instead of stopped_unloaded', () => {
    const tail = source.slice(source.indexOf('// Final status'))
    const failAt = tail.indexOf('bootout_failed:')
    const okAt = tail.indexOf("reason: unload ? 'stopped_unloaded'")
    expect(failAt).toBeGreaterThan(-1)
    expect(failAt).toBeLessThan(okAt)
  })

  test('only a confirmed "not found" counts as unloaded here too', () => {
    const probe = source.slice(source.indexOf('function probeLabelPresence'))
    expect(probe).toContain("return 'unknown'")
    expect(source).toContain("presence === 'listed'")
  })
})
