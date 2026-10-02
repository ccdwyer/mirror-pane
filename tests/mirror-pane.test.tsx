import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { bootedIos, changedPercent, isUiFile, noteFor, onlineAndroid, parseDevice, pct } from '../hooks/register'

const UDID = '0A1B2C3D-4E5F-6789-ABCD-EF0123456789'
const OTHER = 'FFFFFFFF-4E5F-6789-ABCD-EF0123456789'
const NOW = { options: { delayMs: 0, noteToModel: true, extraPatterns: '', historySize: 10 } }

type Out = { value: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean } }
const out = (stdout: string, exitCode = 0, stderr = ''): Out => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})
const simList = (...ids: string[]) =>
  JSON.stringify({ devices: { 'iOS-18': ids.map(udid => ({ udid, state: 'Booted' })) } })

// A machine: booted devices, ImageMagick's answer, the device lock (owner token and overlap mark), and a log
// of every command run.
type Setup = {
  ios?: string[]; android?: string[]; changed?: number | null; compareErr?: string; captureFails?: boolean
  lockHeld?: 'fresh' | 'stale'; overlapDuringEdit?: boolean
}
const T0 = 1_700_000_000_000

function machine(on: On, setup: Setup = {}) {
  const runs: string[][] = []
  const store = new Map<string, unknown>()
  const lock = { held: setup.lockHeld !== undefined, owner: setup.lockHeld !== undefined ? 'dead-token' : '', overlap: false }
  mock.clock(on, { now: T0 })
  on('env.get', () => ({ value: '/Users/me' }))
  on('session.cwd', () => ({ value: '/Users/me/app' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('ui.status', () => ({ value: undefined }))
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('fs.stat', (_$, e) => {
    if (String(e.path).endsWith('/overlap')) {
      if (!lock.overlap) throw new Error('ENOENT')
      return { value: { mtimeMs: T0, size: 0, kind: 'file' as const, isLink: false } }
    }
    return { value: { mtimeMs: setup.lockHeld === 'stale' ? 0 : T0, size: 0, kind: 'file' as const, isLink: false } }
  })
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    const [cmd, ...rest] = argv
    if (cmd === '/bin/sh' && String(rest[1]).includes('printf')) {
      lock.owner = String(rest[4])
      return out('')
    }
    if (cmd === '/bin/sh' && String(rest[1]).includes('rmdir')) {
      if (lock.owner === String(rest[4])) Object.assign(lock, { held: false, owner: '', overlap: false })
      return out('')
    }
    if (cmd === '/bin/sh') return out('/usr/bin/x')
    if (cmd === 'cat') return lock.owner === '' ? out('', 1) : out(lock.owner)
    if (cmd === 'touch') {
      if (String(rest[0]).endsWith('/overlap') && lock.held) lock.overlap = true
      return out('')
    }
    if (cmd === 'sleep' || cmd === 'chmod' || cmd === 'find') return out('')
    if (cmd === 'mkdir' && rest[0] !== '-p') {
      if (lock.held) return out('', 1)
      lock.held = true
      return out('')
    }
    if (cmd === 'xcrun' && rest[0] === 'simctl' && rest[1] === 'list') return out(simList(...(setup.ios ?? [])))
    if (cmd === 'xcrun' && rest[1] === 'io') return out('', setup.captureFails ? 1 : 0)
    if (cmd === 'adb' && rest[0] === 'devices') {
      return out(['List of devices attached', ...(setup.android ?? []).map(s => `${s}\tdevice`)].join('\n'))
    }
    if (cmd === 'adb') return out('')
    if (cmd === 'compare') {
      if (setup.changed === null) return out('', 2)
      if (setup.compareErr !== undefined) return out('', 1, setup.compareErr)
      // ImageMagick 7: the count, then the fraction of the frame.
      const fraction = (setup.changed ?? 12) / 100
      return out('', setup.changed === 0 ? 0 : 1, `${Math.round(fraction * 1000 * 2000)} (${fraction})`)
    }
    if (cmd === 'identify') return out('1000 2000')
    return out('')
  })
  // Another session's edit landing in the middle of this capture.
  const overlap = () => {
    if (lock.held) lock.overlap = true
  }
  return { runs, store, overlap }
}

const released = (runs: string[][], token?: string) =>
  runs.some(r => r[0] === '/bin/sh' && String(r[2]).includes('rmdir') && (token === undefined || r[5] === token))

const edit = (file = '/Users/me/app/src/components/Button.tsx') => ({ tool: 'Edit' as const, file_path: file, old_string: 'a', new_string: 'b' })
const ok = () => ({ result: { staged: false } })
const mirror = (args: string) => ({ command: 'mirror', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } })
const note = (ran: { context?: readonly string[] }) => (ran.context ?? []).join('\n')

test('pure helpers: UI files, device ids, simctl/adb parsing, percentages', async () => {
  expect(isUiFile('/a/src/components/Card.tsx', '')).toBe(true)
  expect(isUiFile('/a/ios/App/ContentView.swift', '')).toBe(true)
  expect(isUiFile('/a/android/app/src/main/res/layout/main.xml', '')).toBe(true)
  expect(isUiFile('/a/src/screens/Home.ts', '')).toBe(true)
  expect(isUiFile('/a/src/utils/date.ts', '')).toBe(false)
  expect(isUiFile('/a/server/api.ts', '')).toBe(false)
  expect(isUiFile('/a/src/widgets/x.ts', 'src/widgets/')).toBe(true)
  expect(isUiFile('/Users/me/app/src/utils/date.ts', '', '/Users/me/app')).toBe(false)
  expect(isUiFile('/Users/me/app/app/(tabs)/index.ts', '', '/Users/me/app')).toBe(true)
  expect(parseDevice(UDID)?.kind).toBe('ios')
  expect(parseDevice('emulator-5554')?.kind).toBe('android')
  expect(parseDevice('rm -rf /')).toBeNull()
  expect(bootedIos(simList(UDID))).toEqual([UDID])
  expect(bootedIos('not json')).toBeNull()
  expect(onlineAndroid('List of devices attached\nemulator-5554\tdevice\nR58M\tunauthorized\n')).toEqual({ emulators: ['emulator-5554'], phones: [] })
  expect(onlineAndroid('List of devices attached\nR58M1234\tdevice\n').phones).toEqual(['R58M1234'])
  expect(changedPercent('compare: warning 12 something\n240000', '1000 2000')).toBe(12)
  // ImageMagick 7 prints the count and the fraction: a full-frame change is 100%, not 1%.
  expect(changedPercent('100 (1)', '10 10')).toBe(100)
  expect(changedPercent('2962345 (1)', '1170 2532')).toBe(100)
  expect(changedPercent('240000 (0.12)', '1000 2000')).toBe(12)
  expect(changedPercent('1.2e+06 (0.6)', '1000 2000')).toBe(60)
  expect(changedPercent('compare: warning\n0 (0)', '1000 2000')).toBe(0)
  // A size mismatch is no comparison, not a tiny change.
  expect(changedPercent('compare: image widths or heights differ (1170x2532 vs 1179x2556) @ error/compare.c/CompareImageCommand/1141', '1179 2556')).toBeNull()
  for (const f of ['src/components/Button.test.tsx', 'src/components/Card.stories.tsx', 'Package.swift', 'app/api/route.ts', 'android/app/src/main/res/values/strings.xml', 'app/dashboard/route.ts', 'app/actions.ts', 'app/page.server.ts']) {
    expect(isUiFile(`/Users/me/app/${f}`, '', '/Users/me/app')).toBe(false)
  }
  expect(isUiFile('/Users/me/app/android/app/src/main/res/values/colors.xml', '', '/Users/me/app')).toBe(true)
  expect(isUiFile('/Users/me/app/lib/screens/home.dart', '', '/Users/me/app')).toBe(true)
  expect(changedPercent('240000', '1000 2000')).toBe(12)
  expect(changedPercent('garbage', '1000 2000')).toBeNull()
  // A tiny change is still a change: 500 pixels of 2,000,000.
  const tiny = changedPercent('500', '1000 2000')
  expect(tiny).not.toBe(0)
  expect(pct(tiny)).toBe('<0.1%')
  expect(pct(0)).toBe('0%')
  expect(noteFor('ios', true, tiny, null)).toMatch(/about <0\.1% of pixels differ/)
  expect(noteFor('ios', false, null, null)).toMatch(/only an after-shot/)
  expect(noteFor('ios', true, null, null)).toMatch(/no comparison was available/)
  expect(noteFor('ios', true, 0, null)).toMatch(/no pixels differed beyond a small colour tolerance/)
  expect(noteFor('ios', true, 5, null)).toMatch(/had not painted/)
  expect(noteFor('ios', true, 0, null, true)).toMatch(/native rebuild/)
  expect(noteFor('ios', true, 0, null, true)).not.toMatch(/no pixels differed/)
  expect(noteFor('ios', true, 3, null, false, true)).toMatch(/not attributable/)
})

test('a UI edit is shot before and after, compared, and noted for the model', NOW, async ($, on) => {
  const { runs } = machine(on, { ios: [UDID], changed: 12 })
  const order: string[] = []
  on('tool.call', () => {
    order.push(`edit after ${runs.filter(r => r[1] === 'simctl' && r[2] === 'io').length} shots`)
    return ok()
  })
  const ran = await $.tool.call(edit())
  const shots = runs.filter(r => r[0] === 'xcrun' && r[2] === 'io')
  expect(shots.length).toBe(2)
  expect(shots[0]).toContain(UDID)
  expect(String(shots[0]?.at(-1))).toMatch(/before\.png$/)
  expect(String(shots[1]?.at(-1))).toMatch(/after\.png$/)
  expect(order).toEqual(['edit after 1 shots'])
  expect(note(ran)).toMatch(/about 12% of pixels differ/)
  expect(note(ran)).not.toMatch(/base64|png;/)
})

test('a non-UI file, a failed edit, and a staged edit take no after-shot', NOW, async ($, on) => {
  const { runs } = machine(on, { ios: [UDID] })
  let mode: 'ok' | 'error' | 'staged' = 'ok'
  on('tool.call', () => {
    if (mode === 'error') return { isError: true as const, result: 'nope', text: 'nope' }
    if (mode === 'staged') return { result: { staged: true } }
    return ok()
  })
  await $.tool.call(edit('/Users/me/app/src/utils/math.ts'))
  expect(runs.filter(r => r[2] === 'io').length).toBe(0)
  mode = 'error'
  const failed = await $.tool.call(edit())
  expect(note(failed)).toBe('')
  mode = 'staged'
  const staged = await $.tool.call(edit())
  expect(note(staged)).toBe('')
  expect(runs.filter(r => r[2] === 'io' && String(r.at(-1)).endsWith('after.png')).length).toBe(0)
})

test('several booted devices and none chosen: never guesses, warns once', NOW, async ($, on) => {
  const { runs } = machine(on, { ios: [UDID, OTHER], android: ['emulator-5554'] })
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('tool.call', ok)
  const ran = await $.tool.call(edit())
  await $.tool.call(edit())
  expect(runs.filter(r => r[2] === 'io' || r[2] === 'screencap').length).toBe(0)
  expect(note(ran)).toBe('')
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toMatch(/\/mirror device/)
})

test('/mirror device picks one explicitly, even with several booted', NOW, async ($, on) => {
  const { runs } = machine(on, { ios: [UDID, OTHER], changed: 0 })
  on('tool.call', ok)
  on('command.run', () => ({ text: 'fallback' }))
  const answer = await $.command.run(mirror(`device ${OTHER}`))
  expect(String(answer.text)).toMatch(/iOS simulator/)
  const ran = await $.tool.call(edit())
  const shots = runs.filter(r => r[2] === 'io')
  expect(shots.every(r => r.includes(OTHER))).toBe(true)
  expect(note(ran)).toMatch(/no pixels differed/)
})

test('Android captures go through the device, never through stdout', NOW, async ($, on) => {
  const { runs } = machine(on, { android: ['emulator-5554'], changed: 5 })
  on('tool.call', ok)
  await $.tool.call(edit('/Users/me/app/android/app/src/main/res/layout/home.xml'))
  expect(runs.some(r => r[0] === 'adb' && r.includes('screencap') && !r.includes('exec-out'))).toBe(true)
  expect(runs.some(r => r[0] === 'adb' && r[3] === 'pull')).toBe(true)
  // the device-side temp file is unique and removed after the pull
  const remote = runs.find(r => r.includes('screencap'))?.at(-1) ?? ''
  expect(String(remote)).toMatch(/mirror-pane-[0-9a-f]{8}\.png$/)
  expect(runs.some(r => r[0] === 'adb' && r.includes('rm') && r.includes(String(remote)))).toBe(true)
})

test('no device, or a failed capture, never breaks the edit', NOW, async ($, on) => {
  machine(on, { captureFails: true, ios: [UDID] })
  on('tool.call', ok)
  const ran = await $.tool.call(edit())
  expect(ran.isError).toBeUndefined()
  expect(note(ran)).toBe('')
})

test('/mirror off stops captures', NOW, async ($, on) => {
  const { runs } = machine(on, { ios: [UDID] })
  on('tool.call', ok)
  on('command.run', () => ({ text: 'fallback' }))
  await $.command.run(mirror('off'))
  await $.tool.call(edit())
  expect(runs.length).toBe(0)
})

test('the pane shows before and after; the band composes with other mods', NOW, async ($, on) => {
  machine(on, { ios: [UDID], changed: 12 })
  on('tool.call', ok)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>OTHER MOD</Text>
  })
  await $.tool.call(edit())
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({
      plugin: 'mirror-pane',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} },
    })
    expect(await band.find({ type: 'Text', text: /Button\.tsx 12% of pixels changed/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'OTHER MOD' })).toBeDefined()
    await band.unmount()
  }
  const pane = await $.ui.mount({
    plugin: 'mirror-pane',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'mirror-pane',
    props: { title: 'Mirror Pane', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  expect(await pane.find({ type: 'Image', key: 'before' })).toBeDefined()
  expect(await pane.find({ type: 'Image', key: 'after' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /12% of pixels changed/ })).toBeDefined()
  await pane.unmount()
  const desk = await $.ui.mount({
    plugin: 'mirror-pane',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'mirror-pane',
    props: { title: 'Mirror Pane', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  expect(await desk.find({ type: 'Text', text: /After:/ })).toBeDefined()
  await desk.unmount()
})

test('a pinned baseline makes later edits report drift', NOW, async ($, on) => {
  const { store } = machine(on, { ios: [UDID], changed: 7 })
  on('tool.call', ok)
  on('command.run', () => ({ text: 'fallback' }))
  await $.tool.call(edit())
  const pinned = await $.command.run(mirror('baseline'))
  expect(String(pinned.text)).toMatch(/pinned/)
  expect([...store.keys()].some(k => k.startsWith(`baseline:${UDID}:`))).toBe(true)
  const ran = await $.tool.call(edit())
  expect(note(ran)).toMatch(/pinned baseline, 7% of pixels differ/)
})

test('a discovery tool that fails means unknown: no auto-pick', NOW, async ($, on) => {
  const runs: string[][] = []
  mock.clock(on, { now: 1 })
  on('env.get', () => ({ value: '/Users/me' }))
  on('session.cwd', () => ({ value: '/Users/me/app' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    if (e.argv[0] === '/bin/sh') return out('/usr/bin/x')
    if (e.argv[0] === 'xcrun') return out('', 1, 'simctl timed out')
    if (e.argv[0] === 'adb' && e.argv[1] === 'devices') return out('List of devices attached\nemulator-5554\tdevice\n')
    return out('')
  })
  on('tool.call', ok)
  await $.tool.call(edit())
  expect(runs.filter(r => r.includes('screencap') || r.includes('io')).length).toBe(0)
})

test('a failed after-shot deletes its before-shot; names are unique per capture', NOW, async ($, on) => {
  const runs: string[][] = []
  let shots = 0
  mock.clock(on, { now: 42 })
  on('env.get', () => ({ value: '/Users/me' }))
  on('session.cwd', () => ({ value: '/Users/me/app' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    if (e.argv[0] === '/bin/sh') return out('/usr/bin/x')
    if (e.argv[1] === 'simctl' && e.argv[2] === 'list') return out(simList(UDID))
    if (e.argv[2] === 'io') return out('', (shots += 1) === 2 ? 1 : 0)
    return out('')
  })
  on('tool.call', ok)
  await $.tool.call(edit())
  const before = String(runs.find(r => r[2] === 'io')?.at(-1))
  const after = before.replace('before.png', 'after.png')
  expect(before).toMatch(/\/sessions\/sess-1\/42-[0-9a-f]{8}-before\.png$/)
  expect(runs.some(r => r[0] === 'rm' && r.includes(before) && r.includes(after))).toBe(true)
})

test('two edits at once never share a capture cycle', NOW, async ($, on) => {
  const { runs } = machine(on, { ios: [UDID], changed: 3 })
  const events: string[] = []
  on('tool.call', (_$, e) => {
    events.push(`edit ${String((e as { file_path?: string }).file_path).split('/').pop()}`)
    return ok()
  })
  await Promise.all([$.tool.call(edit('/Users/me/app/src/components/A.tsx')), $.tool.call(edit('/Users/me/app/src/components/B.tsx'))])
  const shots = runs.filter(r => r[2] === 'io').map(r => (String(r.at(-1)).endsWith('before.png') ? 'before' : 'after'))
  expect(shots).toEqual(['before', 'after', 'before', 'after'])
  expect(events.length).toBe(2)
})

test('a physical phone is never auto-picked', NOW, async ($, on) => {
  const { runs } = machine(on, { android: ['R58M1234'] })
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', ok)
  await $.tool.call(edit())
  expect(runs.filter(r => r.includes('screencap')).length).toBe(0)
})

test('a discovery run that throws means unknown, not absent', NOW, async ($, on) => {
  const runs: string[][] = []
  mock.clock(on, { now: 1 })
  on('env.get', () => ({ value: '/Users/me' }))
  on('session.cwd', () => ({ value: '/Users/me/app' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    if (e.argv[0] === '/bin/sh') return out('/usr/bin/x')
    if (e.argv[0] === 'xcrun') throw new Error('timed out')
    if (e.argv[0] === 'adb' && e.argv[1] === 'devices') return out('List of devices attached\nemulator-5554\tdevice\n')
    return out('')
  })
  on('tool.call', ok)
  await $.tool.call(edit())
  expect(runs.filter(r => r.includes('screencap')).length).toBe(0)
})

test('a device held by another session: the edit goes through without shots', NOW, async ($, on) => {
  const { runs } = machine(on, { ios: [UDID], lockHeld: 'fresh' })
  let edits = 0
  on('tool.call', () => {
    edits += 1
    return ok()
  })
  const ran = await $.tool.call(edit())
  expect(edits).toBe(1)
  expect(runs.filter(r => r[2] === 'io').length).toBe(0)
  expect(note(ran)).toBe('')
  // waiting is done with sleep processes, never the hook's own clock
  expect(runs.some(r => r[0] === 'sleep')).toBe(true)
})

test('a stale lock left by a dead session is broken, by its own token only', NOW, async ($, on) => {
  const { runs } = machine(on, { ios: [UDID], lockHeld: 'stale', changed: 4 })
  on('tool.call', ok)
  const ran = await $.tool.call(edit())
  expect(released(runs, 'dead-token')).toBe(true)
  expect(note(ran)).toMatch(/4% of pixels differ/)
})

test('a live lock is never broken, and the waiter marks the holder\'s shots as overlapped', NOW, async ($, on) => {
  const { runs } = machine(on, { ios: [UDID], lockHeld: 'fresh' })
  on('tool.call', ok)
  await $.tool.call(edit())
  expect(released(runs, 'dead-token')).toBe(false)
  expect(runs.some(r => r[0] === 'touch' && String(r[1]).endsWith('/overlap'))).toBe(true)
})

test('another edit landing during the shots makes the note say it is not attributable', NOW, async ($, on) => {
  const m = machine(on, { ios: [UDID], changed: 9 })
  on('tool.call', () => {
    m.overlap()
    return ok()
  })
  const ran = await $.tool.call(edit())
  expect(note(ran)).toMatch(/not attributable/)
  expect(note(ran)).not.toMatch(/9%/)
})

test('a native file edit is noted as needing a rebuild, never as "no visual effect"', NOW, async ($, on) => {
  machine(on, { ios: [UDID], changed: 0 })
  on('tool.call', ok)
  const ran = await $.tool.call(edit('/Users/me/app/ios/App/ContentView.swift'))
  expect(note(ran)).toMatch(/native rebuild/)
})

test('a phone alone says how to opt in; each kind of warning shows once on its own', NOW, async ($, on) => {
  machine(on, { android: ['R58M1234'] })
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('tool.call', ok)
  await $.tool.call(edit())
  await $.tool.call(edit())
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toMatch(/only a physical phone/)
})

test('a very wide pane still draws both images', NOW, async ($, on) => {
  machine(on, { ios: [UDID], changed: 12 })
  on('tool.call', ok)
  await $.tool.call(edit())
  const pane = await $.ui.mount({
    plugin: 'mirror-pane',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'mirror-pane',
    props: { title: 'Mirror Pane', isFocused: true, bodyColumns: 700, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  expect(await pane.find({ type: 'Image', key: 'after' })).toBeDefined()
  await pane.unmount()
})

test('the edit throwing still cleans up and unlocks', NOW, async ($, on) => {
  const { runs } = machine(on, { ios: [UDID] })
  on('tool.call', () => {
    throw new Error('disk full')
  })
  let threw = false
  try {
    await $.tool.call(edit())
  } catch {
    threw = true
  }
  const before = String(runs.find(r => r[2] === 'io')?.at(-1) ?? '')
  expect(before).toMatch(/before\.png$/)
  expect(runs.some(r => r[0] === 'rm' && r.includes(before))).toBe(true)
  expect(released(runs)).toBe(true)
  expect(threw).toBe(true)
})

test('a device that stops answering pauses shots instead of slowing every edit', NOW, async ($, on) => {
  const { runs } = machine(on, { ios: [UDID], captureFails: true })
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', ok)
  await $.tool.call(edit())
  const first = runs.filter(r => r[2] === 'io').length
  await $.tool.call(edit())
  expect(runs.filter(r => r[2] === 'io').length).toBe(first)
})
