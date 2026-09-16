/**
 * Host-half smoke check for dsh-session-shell (no test framework): stubs the
 * injected services, calls apply(), and asserts the Typert contribution
 * (five endpoints), the receiver surface, the session-disposed listener, the
 * disposal effect, and the spawn error categories.
 *
 * Run with: node tests/smoke.mjs (after `pnpm build`; imports lib/index.js)
 */

import assert from 'node:assert/strict'
import { apply, Config, inject, name, ShellSpawnError } from '../lib/index.js'

const calls = {
  contributions: [],
  provided: [],
  listeners: [],
  effects: [],
}

const fakeSessions = {
  get: () => undefined,
}

const fakeTypert = {
  register(contribution) {
    calls.contributions.push(contribution)
    return () => Promise.resolve()
  },
}

const ctx = {
  sessions: fakeSessions,
  typert: fakeTypert,
  provide(key, value) {
    calls.provided.push([key, value])
  },
  get: () => undefined,
  on(event, listener) {
    calls.listeners.push([event, listener])
  },
  effect(fn, label) {
    calls.effects.push([fn, label])
    // Do not run the effect: the disposer must only run at teardown.
  },
}

// Static plugin metadata.
assert.equal(name, 'session-shell')
assert.deepEqual(inject, ['sessions', 'typert'])
assert.equal(typeof Config, 'function') // the schemastery schema is callable
assert.equal(typeof apply, 'function')

// Schema defaults flow to the resolved config.
assert.deepEqual(Config({}), { enabled: true, shell: '' })
assert.deepEqual(Config({ enabled: false }), { enabled: false, shell: '' })
assert.deepEqual(Config({ shell: '/bin/bash' }), { enabled: true, shell: '/bin/bash' })

// Apply with resolved config.
await apply(ctx, Config({}))

// Exactly one Typert contribution with the five endpoints and an empty model.
assert.equal(calls.contributions.length, 1, 'exactly one typert contribution')
const [contribution] = calls.contributions
assert.equal(contribution.package, 'dsh-session-shell')
assert.equal(contribution.face, 'host')
assert.deepEqual(contribution.model, { services: [], events: [], objects: [] })
const endpoints = contribution.invocations.map(descriptor => `${descriptor.namespace}/${descriptor.method}`)
assert.deepEqual(endpoints, [
  'sessionShell/spawn',
  'sessionShell/read',
  'sessionShell/write',
  'sessionShell/resize',
  'sessionShell/kill',
])

// The receiver is provided under the service key with the five verbs.
const receiverEntry = calls.provided.find(([key]) => key === 'sessionShell')
assert.ok(receiverEntry, 'sessionShell receiver is provided')
const receiver = receiverEntry[1]
for (const verb of ['spawn', 'read', 'write', 'resize', 'kill']) {
  assert.equal(typeof receiver[verb], 'function', `receiver.${verb} is callable`)
}
assert.ok(receiver.typertRemote, 'receiver is bound to the typert gateway')

// The session-disposed listener is registered (shell cleanup on teardown).
assert.ok(calls.listeners.some(([event]) => event === 'session/disposed'), 'session/disposed listener registered')

// The disposal effect is registered (plugin-unload cleanup).
assert.equal(calls.effects.length, 1, 'one lifecycle effect')

// Error categories: unknown session -> session-not-found.
assert.throws(
  () => receiver.spawn({ sessionId: 'nope', cols: 80, rows: 24 }),
  (error) => error instanceof ShellSpawnError && error.kind === 'session-not-found',
)
// Unknown shell -> shell-not-found.
assert.throws(
  () => receiver.read({ shellId: 'nope', cursor: 0 }),
  (error) => error instanceof ShellSpawnError && error.kind === 'shell-not-found',
)
assert.throws(
  () => receiver.write({ shellId: 'nope', data: 'x' }),
  (error) => error instanceof ShellSpawnError && error.kind === 'shell-not-found',
)
// Kill on an absent shell is idempotent (exited state, no throw).
assert.deepEqual(receiver.kill({ shellId: 'nope' }), {
  state: { kind: 'exited', code: null, signal: null },
})

// Disabled config rejects spawn with the shell-disabled category.
calls.contributions.length = 0
calls.provided.length = 0
await apply(ctx, Config({ enabled: false }))
const disabledReceiver = calls.provided.find(([key]) => key === 'sessionShell')[1]
assert.throws(
  () => disabledReceiver.spawn({ sessionId: 'nope', cols: 80, rows: 24 }),
  (error) => error instanceof ShellSpawnError && error.kind === 'shell-disabled',
)

console.log('smoke: ok')
