/**
 * Real-PTY integration check for dsh-session-shell (no framework): drives the
 * actual shell manager against a real node-pty shell (`/bin/sh`) in a temp
 * directory, asserting spawn, output streaming through cursor reads, input
 * delivery, exit detection, disposal, and the trim-to-exit read path.
 *
 * Run with: node tests/integration.mjs (after `pnpm build`).
 */

import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionShellManager, ShellSpawnError } from '../lib/index.js'

const dir = await mkdtemp(join(tmpdir(), 'dsh-shell-'))
const session = {
  id: 'session-integration',
  header: { cwd: dir },
}
const fakeCtx = {
  sessions: {
    get: (id) => (id === session.id ? session : undefined),
  },
}
const manager = new SessionShellManager(fakeCtx, '/bin/sh')

// Spawn in the session cwd.
const spawn = manager.spawn({ sessionId: session.id, cols: 80, rows: 24 })
assert.equal(spawn.shellId, session.id)
assert.equal(spawn.cwd, dir)
assert.ok(Number.isSafeInteger(spawn.pid) && spawn.pid > 0)
assert.equal(spawn.state.kind, 'running')

// Reuse is idempotent: a second spawn returns the same shell.
const again = manager.spawn({ sessionId: session.id, cols: 80, rows: 24 })
assert.equal(again.pid, spawn.pid)

// Write a command, then poll until exit; the marker must appear.
manager.write({ shellId: session.id, data: 'echo hello-from-pty\nexit\n' })
let cursor = 0
let text = ''
let state = spawn.state
const deadline = Date.now() + 10_000
while (state.kind !== 'exited') {
  if (Date.now() > deadline) {
    manager.dispose(session.id)
    assert.fail('shell did not exit within 10s')
  }
  const read = manager.read({ shellId: session.id, cursor })
  text += read.text
  cursor = read.cursor
  state = read.state
  await new Promise(resolve => setTimeout(resolve, 50))
}
assert.ok(text.includes('hello-from-pty'), `expected marker in output, got: ${JSON.stringify(text.slice(-200))}`)

// After exit, reads are stable and write answers with the exited state.
const after = manager.read({ shellId: session.id, cursor })
assert.equal(after.text, '')
assert.equal(after.state.kind, 'exited')
const writeAfter = manager.write({ shellId: session.id, data: 'still here' })
assert.equal(writeAfter.state.kind, 'exited')
assert.equal(manager.resize({ shellId: session.id, cols: 100, rows: 40 }).state.kind, 'exited')

// A fresh spawn replaces the exited shell.
const respawn = manager.spawn({ sessionId: session.id, cols: 100, rows: 40 })
assert.equal(respawn.state.kind, 'running')
assert.notEqual(respawn.pid, spawn.pid)

// Kill is idempotent and metadata errors keep their categories.
manager.kill({ shellId: session.id })
assert.doesNotThrow(() => manager.kill({ shellId: session.id }))
assert.throws(
  () => manager.spawn({ sessionId: 'missing', cols: 80, rows: 24 }),
  (error) => error instanceof ShellSpawnError && error.kind === 'session-not-found',
)

// Dispose removes live shells.
const cleanup = manager.spawn({ sessionId: session.id, cols: 80, rows: 24 })
assert.equal(cleanup.state.kind, 'running')
manager.dispose(session.id)
assert.throws(
  () => manager.read({ shellId: session.id, cursor: 0 }),
  (error) => error instanceof ShellSpawnError && error.kind === 'shell-not-found',
)

// Dispose-all is safe with nothing live.
manager.disposeAll()

console.log('integration: ok')
