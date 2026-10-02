import { atom, read, update } from 'claude-code'
import type { EngineInterface, Next, Register, ToolCallInput, ToolCallResult } from 'claude-code'

import type { Device, Pair } from '../types'

const pairs = atom({ plugin: 'mirror-pane', key: 'pairs' } as const, [])
const cursor = atom({ plugin: 'mirror-pane', key: 'cursor' } as const, -1)
const isOn = atom({ plugin: 'mirror-pane', key: 'isOn' } as const, true)
const warned = atom({ plugin: 'mirror-pane', key: 'warned' } as const, [])
const quietUntil = atom({ plugin: 'mirror-pane', key: 'quietUntil' } as const, 0)

const PANE = 'mirror-pane'
const DEVICE_KEY = 'device'
const CAPTURE_MS = 6000
const MAX_DELAY = 5000
// How long a UI edit waits for another capture of the same device before skipping its shots: tries of
// 100ms sleeps, counted rather than timed so the wait never depends on the hook's clock.
const LOCK_TRIES = 40
// A lock whose owner token hasn't been refreshed for this long belongs to a session that died mid-capture.
const LOCK_STALE_MS = 30000
// How often a held lock's token is refreshed, for as long as the capture (edit included) runs.
const LOCK_HEARTBEAT_MS = 5000
// Screenshots older than this are deleted the next time Mirror Pane runs.
const KEEP_MINUTES = 7 * 24 * 60
// After a device stops answering, skip shots for this long.
const QUIET_MS = 5 * 60 * 1000

// Files whose edit can change what a screen looks like.
const UI_EXT = /\.(tsx|jsx|swift|css|scss|sass|less|vue|svelte|dart|storyboard|xib)$/i
const NOT_UI = /(\.(test|spec|stories|story)\.[^/]+$|\/(__tests__|__mocks__|tests?|e2e)\/|\/Package\.swift$|\/(app|pages)\/api\/|\/(route|actions?|middleware|instrumentation)\.(ts|js|mjs)$|\.server\.(ts|js|mjs)$|\/server\/)/i
// UI sources that only take effect after a native rebuild, not a hot reload.
const NEEDS_REBUILD = /\.(swift|storyboard|xib|kt)$|\/res\/[^/]+\/[^/]+\.xml$/i
const UI_DIRS = /\/(components|screens|app|ui|views|pages|widgets|layouts?)\//i
const SCRIPT_EXT = /\.(ts|js|mjs)$/i
const ANDROID_RES = /\/res\/(layout[^/]*|drawable[^/]*|values[^/]*\/(colors|themes?|styles|dimens)[^/]*)\b.*\.xml$|\/res\/(layout|drawable)[^/]*\/[^/]+\.xml$/i
const COMPOSE = /\.kt$/i

const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i
const SERIAL = /^[\w.:-]{1,64}$/
const EMULATOR = /^emulator-\d+$/

type Options = { delayMs: number; noteToModel: boolean; extraPatterns: string; historySize: number }
type Run = { exitCode: number; stdout: string; stderr: string }

// Folder hints are read below the project root, so a checkout living in ~/app/ doesn't make every file UI.
export function isUiFile(path: string, extra: string, root = ''): boolean {
  const extras = extra.split(',').map(s => s.trim()).filter(s => s.length > 0)
  if (extras.some(s => path.includes(s))) return true
  const inside = root !== '' && path.startsWith(`${root}/`) ? path.slice(root.length) : path
  if (NOT_UI.test(inside)) return false
  if (UI_EXT.test(path) || ANDROID_RES.test(path)) return true
  if (COMPOSE.test(path)) return /\/(ui|compose|screens?|components)\//i.test(inside)
  return SCRIPT_EXT.test(path) && UI_DIRS.test(inside)
}

export function parseDevice(arg: string): Device | null {
  const id = arg.trim()
  if (UDID.test(id)) return { kind: 'ios', id }
  if (SERIAL.test(id) && id.length > 0) return { kind: 'android', id }
  return null
}

export function bootedIos(json: string): string[] | null {
  try {
    const data = JSON.parse(json) as { devices?: Record<string, Array<{ udid?: string; state?: string }>> }
    if (data.devices === undefined) return null
    const out: string[] = []
    for (const list of Object.values(data.devices)) {
      for (const d of list) if (d.state === 'Booted' && typeof d.udid === 'string') out.push(d.udid)
    }
    return out
  } catch {
    return null
  }
}

// Online adb devices, split into emulators (safe to pick) and physical phones (never auto-picked).
export function onlineAndroid(text: string): { emulators: string[]; phones: string[] } {
  const online = text
    .split('\n')
    .slice(1)
    .map(line => line.trim().split(/\s+/))
    .filter(parts => parts.length >= 2 && parts[1] === 'device' && SERIAL.test(parts[0] ?? ''))
    .map(parts => parts[0] as string)
  return { emulators: online.filter(s => EMULATOR.test(s)), phones: online.filter(s => !EMULATOR.test(s)) }
}

// ImageMagick `compare -metric AE` ends stderr with the metric (warnings may come first). ImageMagick 7 prints
// the differing-pixel count and then the fraction of the frame, `240000 (0.12)`; ImageMagick 6 prints the count
// alone. Any other last line (a size mismatch, an error) means no comparison. 0 means no pixel differed beyond
// the colour tolerance.
export function changedPercent(stderr: string, size: string): number | null {
  const lines = stderr.split('\n').map(l => l.trim()).filter(l => l !== '')
  const m = (lines[lines.length - 1] ?? '').match(/^(\d+(?:\.\d+)?(?:e[+-]?\d+)?)(?:\s*\((\d+(?:\.\d+)?(?:e[+-]?\d+)?)\))?$/i)
  if (m === null) return null
  if (m[2] !== undefined) {
    const fraction = Number.parseFloat(m[2])
    return Number.isFinite(fraction) && fraction >= 0 ? Math.min(100, fraction * 100) : null
  }
  const count = Number.parseFloat(m[1] as string)
  const [w, hgt] = size.trim().split(/\s+/).map(Number)
  if (!Number.isFinite(count) || count < 0 || !w || !hgt) return null
  return Math.min(100, (count / (w * hgt)) * 100)
}

export const pct = (n: number | null) =>
  n === null ? '?' : n === 0 ? '0%' : n < 0.1 ? '<0.1%' : `${Math.round(n * 10) / 10}%`

export function noteFor(
  kind: 'ios' | 'android',
  hasBefore: boolean,
  changed: number | null,
  drift: number | null,
  rebuild = false,
  overlapped = false,
): string {
  const screen = kind === 'ios' ? 'iOS simulator' : 'Android'
  const vs = drift === null ? '' : ` Against the pinned baseline, ${pct(drift)} of pixels differ.`
  const caveat = rebuild
    ? ' This file type usually needs a native rebuild, so the after-shot is probably from before the edit took effect: it is not evidence either way.'
    : ' Status-bar clocks, spinners or a reload that had not painted yet can affect this; no change does not prove the edit has no visual effect.'
  if (!hasBefore) return `Mirror Pane: only an after-shot of the ${screen} screen was taken (the before-shot failed), so there is no comparison.${vs} The user can review it with /mirror.`
  if (overlapped) return `Mirror Pane: another edit to the same device landed while this one's screenshots were taken, so the comparison is not attributable to this edit.${vs} The user can review it with /mirror.`
  if (changed === null) return `Mirror Pane: the ${screen} screen was captured before and after this edit, but no comparison was available.${vs} The user can review it with /mirror.`
  const what =
    changed === 0
      ? rebuild
        ? 'the screen has not changed yet'
        : 'no pixels differed beyond a small colour tolerance'
      : `about ${pct(changed)} of pixels differ`
  return `Mirror Pane: between the ${screen} screenshots taken just before and ${'after'} this edit, ${what}.${caveat}${vs} The user can review it with /mirror.`
}

const base = (path: string) => path.split('/').pop() ?? path
const clampDelay = (n: number) => Math.max(0, Math.min(MAX_DELAY, Number.isFinite(n) ? n : 2000))
const uniqueId = () => crypto.randomUUID().slice(0, 8)

// A rejection (timeout, spawn failure) comes back as null, distinct from a non-zero exit.
async function run($: EngineInterface, argv: string[], timeoutMs = CAPTURE_MS): Promise<Run | null> {
  try {
    return await $.process.run(argv, { timeoutMs })
  } catch {
    return null
  }
}

// Waits that must not count against the hook's own time budget run as processes.
async function pause($: EngineInterface, ms: number) {
  if (ms > 0) await run($, ['sleep', (ms / 1000).toFixed(2)], ms + 2000)
}

async function installed($: EngineInterface, tool: string): Promise<boolean> {
  const found = await run($, ['/bin/sh', '-c', `command -v ${tool}`], 3000)
  return found !== null && found.exitCode === 0
}

async function cacheRoot($: EngineInterface): Promise<string | null> {
  const home = await $.env.get('HOME')
  return typeof home === 'string' && home.length > 0 ? `${home}/.cache/mirror-pane` : null
}

// Screenshots of this session live in a folder of their own, readable only by the user.
async function shotDir($: EngineInterface, sub: 'session' | 'baselines' | 'locks'): Promise<string | null> {
  const root = await cacheRoot($)
  if (root === null) return null
  const session = await $.session.id()
  const dir = sub === 'session' ? `${root}/sessions/${session}` : `${root}/${sub}`
  const made = await run($, ['mkdir', '-p', '-m', '700', dir])
  if (made === null || made.exitCode !== 0) return null
  await run($, ['chmod', '700', root])
  return dir
}

// The chosen device, or the only booted simulator/emulator. A physical phone is only ever used when chosen
// explicitly ('phone' when it is the only thing attached); a discovery tool that is installed but fails leaves
// the count unknown.
async function pickDevice($: EngineInterface): Promise<Device | 'several' | 'phone' | null> {
  const stored = parseDevice(String((await $.store.get(DEVICE_KEY)) ?? ''))
  if (stored !== null) return stored
  const found: Device[] = []
  let unsure = false
  let phones = 0
  if (await installed($, 'xcrun')) {
    const ios = await run($, ['xcrun', 'simctl', 'list', 'devices', 'booted', '-j'])
    const ids = ios !== null && ios.exitCode === 0 ? bootedIos(ios.stdout) : null
    if (ids === null) unsure = true
    for (const id of ids ?? []) found.push({ kind: 'ios', id })
  }
  if (await installed($, 'adb')) {
    const adb = await run($, ['adb', 'devices'])
    if (adb === null || adb.exitCode !== 0) unsure = true
    else {
      const online = onlineAndroid(adb.stdout)
      phones = online.phones.length
      for (const id of online.emulators) found.push({ kind: 'android', id })
    }
  }
  if (found.length === 0) return phones > 0 && !unsure ? 'phone' : null
  if (found.length === 1 && !unsure && phones === 0) return found[0] as Device
  return 'several'
}

async function capture($: EngineInterface, device: Device, file: string): Promise<boolean> {
  if (device.kind === 'ios') {
    const shot = await run($, ['xcrun', 'simctl', 'io', device.id, 'screenshot', '--type=png', file])
    return shot !== null && shot.exitCode === 0
  }
  // screencap to the device, then pull: stdout is text here, so PNG bytes can't come back through it.
  const remote = `/data/local/tmp/mirror-pane-${uniqueId()}.png`
  try {
    const cap = await run($, ['adb', '-s', device.id, 'shell', 'screencap', '-p', remote])
    if (cap === null || cap.exitCode !== 0) return false
    const pull = await run($, ['adb', '-s', device.id, 'pull', remote, file])
    return pull !== null && pull.exitCode === 0
  } finally {
    await run($, ['adb', '-s', device.id, 'shell', 'rm', '-f', remote], 3000)
  }
}

async function compare($: EngineInterface, a: string, b: string): Promise<number | null> {
  const diff = await run($, ['compare', '-metric', 'AE', '-fuzz', '3%', a, b, 'null:'])
  if (diff === null || diff.exitCode > 1) return null
  const size = await run($, ['identify', '-format', '%w %h', b])
  if (size === null || size.exitCode !== 0) return null
  return changedPercent(diff.stderr, size.stdout)
}

async function forget($: EngineInterface, paths: string[]) {
  if (paths.length > 0) await run($, ['rm', '-f', '--', ...paths], 3000)
}

type Lock = { path: string; token: string; beat: { cancel: () => void } }

const OWNER = 'owner'
const OVERLAP = 'overlap'

// Remove a lock only if its owner token still reads `token`; the check and the removal are one shell run.
async function releaseIf($: EngineInterface, path: string, token: string) {
  await run($, ['/bin/sh', '-c', '[ "$(cat "$1/owner" 2>/dev/null)" = "$2" ] && rm -f "$1/owner" "$1/overlap" && rmdir "$1"', 'sh', path, token], 3000)
}

// A lock per device shared by every session on the machine: mkdir is atomic, and an owner token inside it is
// refreshed every few seconds for as long as the capture runs, the edit's own wait (a permission prompt, say)
// included. Only a token that stopped being refreshed is broken, and only by matching its exact value. A
// waiter that gives up marks the lock so the holder knows another edit landed during its shots.
async function lockDevice($: EngineInterface, device: Device, next: Next<'tool.call'>): Promise<Lock | null> {
  const locks = await shotDir($, 'locks')
  if (locks === null) return null
  const path = `${locks}/${device.id}`
  const token = `${await $.clock.now()}-${uniqueId()}`
  for (let tries = 0; ; tries += 1) {
    const took = await run($, ['mkdir', path], 3000)
    if (took !== null && took.exitCode === 0) {
      await run($, ['/bin/sh', '-c', 'printf %s "$2" > "$1/owner"', 'sh', path, token], 3000)
      const beat = $.clock.every(LOCK_HEARTBEAT_MS, () => {
        void run($, ['touch', `${path}/${OWNER}`], 3000)
      })
      return { path, token, beat }
    }
    try {
      const owner = await $.fs.stat(`${path}/${OWNER}`)
      if ((await $.clock.now()) - owner.mtimeMs > LOCK_STALE_MS) {
        const stale = await run($, ['cat', `${path}/${OWNER}`], 3000)
        if (stale !== null && stale.exitCode === 0) await releaseIf($, path, stale.stdout)
      }
    } catch {
      // No owner token yet (just made) or gone: try again.
    }
    if (next.signal.aborted || tries >= LOCK_TRIES) {
      await run($, ['touch', `${path}/${OVERLAP}`], 3000)
      return null
    }
    await pause($, 100)
  }
}

async function unlockDevice($: EngineInterface, lock: Lock) {
  lock.beat.cancel()
  await releaseIf($, lock.path, lock.token)
}

async function sawOverlap($: EngineInterface, lock: Lock): Promise<boolean> {
  try {
    await $.fs.stat(`${lock.path}/${OVERLAP}`)
    return true
  } catch {
    return false
  }
}

async function baselineFor($: EngineInterface, device: Device, file: string): Promise<string | null> {
  const path = await $.store.get(`baseline:${device.id}:${file}`)
  return typeof path === 'string' ? path : null
}

async function pinBaseline($: EngineInterface): Promise<string> {
  const list = await read($, pairs)
  const at = await read($, cursor)
  const pair = list[at < 0 ? list.length - 1 : at]
  if (pair === undefined) return 'Mirror Pane: nothing captured yet. Edit a UI file first.'
  const dir = await shotDir($, 'baselines')
  if (dir === null) return 'Mirror Pane: could not find a folder for the baseline.'
  const target = `${dir}/${pair.device}-${pair.id}-${uniqueId()}.png`
  const copied = await run($, ['cp', pair.after, target])
  if (copied === null || copied.exitCode !== 0) return 'Mirror Pane: could not copy that screenshot.'
  const key = `baseline:${pair.device}:${pair.file}`
  const old = await $.store.get(key)
  await $.store.set(key, target)
  if (typeof old === 'string' && old !== target) await forget($, [old])
  return `Mirror Pane: pinned the current ${base(pair.file)} screen as its baseline. Later edits show drift against it.`
}

async function pinAndToast($: EngineInterface) {
  $.ui.toast(await pinBaseline($))
}

async function commandText($: EngineInterface, args: string): Promise<string> {
  const [verb = '', rest = ''] = args.trim().split(/\s+(.*)/s)
  switch (verb) {
    case '':
      await $.ui.open({ id: PANE, title: 'Mirror Pane' })
      return 'Mirror Pane opened.'
    case 'on':
    case 'off':
      await update($, isOn, () => verb === 'on')
      await update($, quietUntil, () => 0)
      return `Mirror Pane is ${verb}.`
    case 'device': {
      await update($, quietUntil, () => 0)
      await update($, warned, () => [])
      if (rest === '' || rest === 'auto') {
        await $.store.delete(DEVICE_KEY)
        return 'Mirror Pane: device cleared; it will use the only booted simulator or emulator (never a physical phone).'
      }
      const device = parseDevice(rest)
      if (device === null) return 'Mirror Pane: give an iOS simulator UDID or an adb serial.'
      await $.store.set(DEVICE_KEY, device.id)
      return `Mirror Pane: capturing from ${device.kind === 'ios' ? 'iOS simulator' : 'Android device'} ${device.id}.`
    }
    case 'baseline':
      return pinBaseline($)
    default:
      return 'Usage: /mirror [on | off | device <udid|serial|auto> | baseline]'
  }
}

// One toast per kind of problem, shown again only after that problem went away and came back.
async function warnOnce($: EngineInterface, kind: string, text: string) {
  if ((await read($, warned)).includes(kind)) return
  await update($, warned, list => [...list.filter(k => k !== kind), kind])
  $.ui.toast(text)
}

async function clearWarning($: EngineInterface, kind: string) {
  if ((await read($, warned)).includes(kind)) await update($, warned, list => list.filter(k => k !== kind))
}

async function sweepOld($: EngineInterface) {
  const root = await cacheRoot($)
  if (root === null) return
  await run($, ['find', `${root}/sessions`, '-type', 'f', '-name', '*.png', '-mmin', `+${KEEP_MINUTES}`, '-delete'])
  await run($, ['find', `${root}/sessions`, '-mindepth', '1', '-type', 'd', '-empty', '-delete'])
}

// One capture cycle: before-shot, the edit, the reload wait, after-shot. Every path that does not
// keep the pair deletes both files, and the edit's own result or exception always passes through.
async function cycle(
  $: EngineInterface,
  opts: Options,
  e: ToolCallInput,
  next: Next<'tool.call'>,
  device: Device,
  dir: string,
  file: string,
  lock: Lock,
): Promise<ToolCallResult> {
  const id = await $.clock.now()
  const tag = `${id}-${uniqueId()}`
  const before = `${dir}/${tag}-before.png`
  const after = `${dir}/${tag}-after.png`
  let kept = false
  try {
    const hasBefore = await capture($, device, before)
    if (!hasBefore) await quiet($, device)

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    if ((ran.result as { staged?: boolean } | undefined)?.staged === true) return ran
    if (!hasBefore) return ran

    await pause($, clampDelay(Number(opts.delayMs)))
    if (!(await capture($, device, after))) {
      await quiet($, device)
      return ran
    }
    await clearWarning($, 'quiet')
    const mixed = await sawOverlap($, lock)
    const changed = await compare($, before, after)
    const pinned = await baselineFor($, device, file)
    const drift = pinned !== null ? await compare($, pinned, after) : null
    const pair: Pair = { id, file, device: device.id, before, after, changed, drift, ...(mixed ? { overlapped: true } : {}), at: id }
    const keep = Math.max(1, Math.min(30, Number(opts.historySize) || 10))
    let dropped: Pair[] = []
    await update($, pairs, list => {
      const all = [...list, pair]
      dropped = all.slice(0, Math.max(0, all.length - keep))
      return all.slice(-keep)
    })
    kept = true
    await update($, cursor, () => -1)
    await forget($, dropped.flatMap(p => (p.before === null ? [p.after] : [p.before, p.after])))
    await sweepOld($)
    $.ui.status(`🪞 ${base(file)} ${mixed ? 'changed (another edit overlapped)' : `${pct(changed)} of pixels changed`}`)

    if (opts.noteToModel === false) return ran
    return { ...ran, context: [...(ran.context ?? []), noteFor(device.kind, true, changed, drift, NEEDS_REBUILD.test(file), mixed)] }
  } finally {
    if (!kept) await forget($, [before, after])
  }
}

// A device that stopped answering is left alone for a while, with one hint.
async function quiet($: EngineInterface, device: Device) {
  const now = await $.clock.now()
  await update($, quietUntil, () => now + QUIET_MS)
  $.ui.status('🪞 mirror-pane: device did not answer')
  await warnOnce($, 'quiet', `Mirror Pane: ${device.id} did not answer, so screenshots are paused for 5 minutes. Pick another with /mirror device <udid|serial>, or /mirror device auto.`)
}

async function onToolCall($: EngineInterface, opts: Options, e: ToolCallInput, next: Next<'tool.call'>): Promise<ToolCallResult> {
  if (e.tool !== 'Edit' && e.tool !== 'Write') return next(e)
  const file = String((e as { file_path?: unknown }).file_path ?? '')
  const root = await $.session.cwd()
  if (!isUiFile(file, String(opts.extraPatterns ?? ''), root) || !(await read($, isOn))) return next(e)
  if ((await $.clock.now()) < (await read($, quietUntil))) return next(e)

  const device = await pickDevice($)
  if (device === 'several') {
    await warnOnce($, 'several', 'Mirror Pane: more than one simulator/device is running (or a physical phone is attached), so it will not guess. Pick one with /mirror device <udid|serial>.')
    return next(e)
  }
  if (device === 'phone') {
    await warnOnce($, 'phone', 'Mirror Pane: only a physical phone is attached. It never picks a phone on its own (its screen can show notifications or codes); opt in with /mirror device <serial>.')
    return next(e)
  }
  if (device === null) return next(e)
  await clearWarning($, 'several')
  await clearWarning($, 'phone')
  const dir = await shotDir($, 'session')
  if (dir === null) return next(e)

  const lock = await lockDevice($, device, next)
  if (lock === null) return next(e)
  try {
    return await cycle($, opts, e, next, device, dir, file, lock)
  } finally {
    await unlockDevice($, lock)
  }
}

async function onStart($: EngineInterface) {
  await $.command.register({
    name: 'mirror',
    description: 'Mirror Pane: before/after screenshots of UI edits',
    argumentHint: '[on|off|device <id>|baseline]',
    immediate: true,
  })
  await sweepOld($)
}

export const register: Register = (on, options) => {
  const opts = options as Options

  on('session.start', async ($, e, next) => {
    await onStart($)
    return next(e)
  })

  on('command.run', { command: 'mirror' }, async ($, e) => ({ text: await commandText($, e.args) }))

  on('tool.call', async ($, e, next) => onToolCall($, opts, e, next))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, pairs)
    const at = await read($, cursor)
    const { Box, Text, Button } = $.ui.resolve(e)
    if (list.length === 0) {
      return <Text dimColor>No screenshots yet. Edit a UI file with a simulator or emulator running.</Text>
    }
    const index = at < 0 || at >= list.length ? list.length - 1 : at
    const pair = list[index] as Pair
    // An Image takes 1 to 255 columns.
    const width = Math.max(10, Math.min(255, Math.floor(((e.props.bodyColumns ?? 80) - 3) / 2)))
    const tall = Math.max(6, Math.min(60, (e.viewport?.rows ?? 30) - 8))
    const header = `${base(pair.file)} · ${pair.overlapped === true ? 'changed while another edit overlapped' : `${pct(pair.changed)} of pixels changed`}${pair.drift === null ? '' : ` · ${pct(pair.drift)} vs baseline`} · ${index + 1}/${list.length}`
    const step = (by: number) => () => update($, cursor, cur => {
      const from = cur < 0 ? list.length - 1 : cur
      return Math.max(0, Math.min(list.length - 1, from + by))
    })
    const controls = (
      <Box>
        <Button key="prev" label="◀ prev" onPress={step(-1)} />
        <Text> </Text>
        <Button key="next" label="next ▶" onPress={step(1)} />
        <Text> </Text>
        <Button key="pin" label="pin baseline" onPress={() => pinAndToast($)} />
      </Box>
    )
    if (e.surface !== 'terminal') {
      return (
        <Box flexDirection="column">
          <Text>{header}</Text>
          <Text dimColor>Before: {pair.before ?? 'not captured'}</Text>
          <Text dimColor>After: {pair.after}</Text>
          {controls}
        </Box>
      )
    }
    const { Image } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text>{header}</Text>
        <Box flexDirection="row">
          <Box flexDirection="column" width={width}>
            <Text dimColor>before</Text>
            {pair.before === null ? (
              <Text dimColor>(no before-shot)</Text>
            ) : (
              <Image key="before" source={{ file: pair.before, format: 'png' }} columns={width} rows={tall} alt={`before: ${base(pair.file)}`} />
            )}
          </Box>
          <Text> </Text>
          <Box flexDirection="column" width={width}>
            <Text dimColor>after</Text>
            <Image key="after" source={{ file: pair.after, format: 'png' }} columns={width} rows={tall} alt={`after: ${base(pair.file)}`} />
          </Box>
        </Box>
        {controls}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, pairs)
    const last = list[list.length - 1]
    if (last === undefined || e.props.hasSurvey || !(await read($, isOn))) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const below = await next(e)
    return (
      <Box flexDirection="column">
        <Text dimColor>🪞 {base(last.file)} {pct(last.changed)} of pixels changed · /mirror</Text>
        {below}
      </Box>
    )
  })
}
