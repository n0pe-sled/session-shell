/**
 * Wire contract between the two halves of dsh-session-shell: the spawn/read/
 * write/resize/kill descriptor set, its payload types, and boundary
 * validators.
 *
 * This module is deliberately dependency-free at runtime (pure JSON-safe data
 * plus tiny hand-rolled validators), because it is bundled into BOTH halves:
 * the node half (hot receiver) and the browser half (client `$mount`). The
 * client's Remote `$mount` requires strict codecs, so every descriptor uses
 * `{ mode: 'strict', schema }` with these validators.
 *
 * @module dsh-session-shell/remote
 */

import type {
  InvocationDescriptor,
  RemoteResult,
  TypertSchema,
} from '@deepseek-ai/dsh-typert-protocol'

/** Cordis service key of the shell receiver, also the wire namespace. */
export const SHELL_SERVICE = 'sessionShell'
/** Wire namespace of every shell invocation. */
export const SHELL_NAMESPACE = SHELL_SERVICE

/** One shell's lifecycle state as observed by the host PTY driver. */
export type ShellState =
  | { readonly kind: 'running' }
  | { readonly kind: 'exited'; readonly code: number | null; readonly signal: number | null }

/** Spawn request: lazily create (or reuse) one PTY for the session. */
export interface SpawnShellRequest {
  /** The dsh session whose working directory the shell runs in. */
  readonly sessionId: string
  /** Initial terminal columns. */
  readonly cols: number
  /** Initial terminal rows. */
  readonly rows: number
}

/** Spawn outcome. */
export interface SpawnShellResult {
  /** The shell handle id (== sessionId; one shell per session by design). */
  readonly shellId: string
  /** OS process id of the shell's top-level process. */
  readonly pid: number
  /** The session's working directory the shell runs in. */
  readonly cwd: string
  /** Lifecycle state after spawn. */
  readonly state: ShellState
}

/** Read request: everything after `cursor` in the shell's output buffer. */
export interface ReadShellRequest {
  readonly shellId: string
  /** Buffer offset last consumed by the client; 0 replays the whole scrollback. */
  readonly cursor: number
}

/** Read outcome. */
export interface ReadShellResult {
  /** Output bytes after `cursor` in delivery order (already UTF-8 decoded). */
  readonly text: string
  /** New buffer offset; pass back as the next `cursor`. */
  readonly cursor: number
  /** True when the host dropped older scrollback to bound memory: the client must clear and replay. */
  readonly truncated: boolean
  /** Lifecycle state after this read. */
  readonly state: ShellState
}

/** Write request: deliver raw input bytes to the shell's stdin (PTY). */
export interface WriteShellRequest {
  readonly shellId: string
  /** Input text delivered verbatim, no newline conversion. */
  readonly data: string
}

/** Write outcome (does not reject on an exited shell). */
export interface WriteShellResult {
  readonly state: ShellState
}

/** Resize request: change the PTY dimensions. */
export interface ResizeShellRequest {
  readonly shellId: string
  readonly cols: number
  readonly rows: number
}

/** Resize outcome. */
export interface ResizeShellResult {
  readonly state: ShellState
}

/** Kill request: terminate the shell (idempotent). */
export interface KillShellRequest {
  readonly shellId: string
}

/** Kill outcome. */
export interface KillShellResult {
  readonly state: ShellState
}

/** Client-visible outcome of one control action, carrying a stable error surface. */
export type ShellControlError =
  | { readonly kind: 'session-not-found'; readonly message: string }
  | { readonly kind: 'shell-disabled'; readonly message: string }
  | { readonly kind: 'cwd-unavailable'; readonly message: string }
  | { readonly kind: 'spawn-failed'; readonly message: string }
  | { readonly kind: 'shell-not-found'; readonly message: string }
  | { readonly kind: 'remote-error'; readonly message: string }

/** Convert a raw failure message into the typed client control error. */
export function classifyControlError(message: string): ShellControlError {
  const match = /(session-not-found|shell-disabled|cwd-unavailable|spawn-failed|shell-not-found)/.exec(message)
  if (match !== null) {
    const kind = match[1]
    switch (kind) {
      case 'session-not-found': return { kind: 'session-not-found', message }
      case 'shell-disabled': return { kind: 'shell-disabled', message }
      case 'cwd-unavailable': return { kind: 'cwd-unavailable', message }
      case 'spawn-failed': return { kind: 'spawn-failed', message }
      case 'shell-not-found': return { kind: 'shell-not-found', message }
      default: break
    }
  }
  return { kind: 'remote-error', message }
}

// --- Boundary validators -----------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/** Valid non-empty short identifier (session/shell id). */
function isId(value: unknown): value is string {
  return isString(value) && value.length > 0 && value.length <= 256 && !value.includes('\u0000')
}

/** Positive integer within a sane terminal dimension. */
function isDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 512
}

/** Non-negative safe cursor. */
function isCursor(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0x7fffffff
}

/** Lifecycle state boundary validator. */
const stateSchema: TypertSchema<ShellState> = {
  parse(value: unknown): ShellState {
    if (!isRecord(value)) throw new TypeError('shell state must be a plain object')
    if (value.kind === 'running') return { kind: 'running' }
    if (value.kind === 'exited') {
      const code = value.code
      const signal = value.signal
      if (code !== null && typeof code !== 'number') throw new TypeError('exited state code must be a number or null')
      if (signal !== null && typeof signal !== 'number') throw new TypeError('exited state signal must be a number or null')
      return { kind: 'exited', code: code as number | null, signal: signal as number | null }
    }
    throw new TypeError('shell state kind must be "running" or "exited"')
  },
}

/** Spawn result boundary validator. */
const spawnResultSchema: TypertSchema<SpawnShellResult> = {
  parse(value: unknown): SpawnShellResult {
    if (!isRecord(value)) throw new TypeError('spawn result must be a plain object')
    const { shellId, pid, cwd, state } = value
    if (!isId(shellId)) throw new TypeError('spawn result shellId must be a non-empty id string')
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid)) throw new TypeError('spawn result pid must be a safe integer')
    if (!isString(cwd) || cwd.length === 0) throw new TypeError('spawn result cwd must be a non-empty string')
    return { shellId, pid, cwd, state: stateSchema.parse(state) }
  },
}

/** Read result boundary validator. */
const readResultSchema: TypertSchema<ReadShellResult> = {
  parse(value: unknown): ReadShellResult {
    if (!isRecord(value)) throw new TypeError('read result must be a plain object')
    const { text, cursor, truncated, state } = value
    if (!isString(text)) throw new TypeError('read result text must be a string')
    if (!isCursor(cursor)) throw new TypeError('read result cursor must be a non-negative integer')
    if (typeof truncated !== 'boolean') throw new TypeError('read result truncated must be a boolean')
    return { text, cursor, truncated, state: stateSchema.parse(state) }
  },
}

/** Small state-only result boundary validator (write/resize/kill). */
const stateResultSchema: TypertSchema<{ state: ShellState }> = {
  parse(value: unknown): { state: ShellState } {
    if (!isRecord(value)) throw new TypeError('result must be a plain object')
    return { state: stateSchema.parse(value.state) }
  },
}

/** Spawn request validator. */
const spawnRequestSchema: TypertSchema<SpawnShellRequest> = {
  parse(value: unknown): SpawnShellRequest {
    if (!isRecord(value)) throw new TypeError('spawn request must be a plain object')
    const { sessionId, cols, rows } = value
    if (!isId(sessionId)) throw new TypeError('spawn request sessionId must be a non-empty id string')
    if (!isDimension(cols)) throw new TypeError('spawn request cols must be an integer in 1..512')
    if (!isDimension(rows)) throw new TypeError('spawn request rows must be an integer in 1..512')
    return { sessionId, cols, rows }
  },
}

/** Read request validator. */
const readRequestSchema: TypertSchema<ReadShellRequest> = {
  parse(value: unknown): ReadShellRequest {
    if (!isRecord(value)) throw new TypeError('read request must be a plain object')
    const { shellId, cursor } = value
    if (!isId(shellId)) throw new TypeError('read request shellId must be a non-empty id string')
    if (!isCursor(cursor)) throw new TypeError('read request cursor must be a non-negative integer')
    return { shellId, cursor }
  },
}

/** Write request validator (bounded chunk size). */
const writeRequestSchema: TypertSchema<WriteShellRequest> = {
  parse(value: unknown): WriteShellRequest {
    if (!isRecord(value)) throw new TypeError('write request must be a plain object')
    const { shellId, data } = value
    if (!isId(shellId)) throw new TypeError('write request shellId must be a non-empty id string')
    if (!isString(data)) throw new TypeError('write request data must be a string')
    if (data.length > 4096) throw new TypeError('write request data chunk exceeds 4096 characters')
    return { shellId, data }
  },
}

/** Resize request validator. */
const resizeRequestSchema: TypertSchema<ResizeShellRequest> = {
  parse(value: unknown): ResizeShellRequest {
    if (!isRecord(value)) throw new TypeError('resize request must be a plain object')
    const { shellId, cols, rows } = value
    if (!isId(shellId)) throw new TypeError('resize request shellId must be a non-empty id string')
    if (!isDimension(cols)) throw new TypeError('resize request cols must be an integer in 1..512')
    if (!isDimension(rows)) throw new TypeError('resize request rows must be an integer in 1..512')
    return { shellId, cols, rows }
  },
}

/** Kill request validator. */
const killRequestSchema: TypertSchema<KillShellRequest> = {
  parse(value: unknown): KillShellRequest {
    if (!isRecord(value)) throw new TypeError('kill request must be a plain object')
    const { shellId } = value
    if (!isId(shellId)) throw new TypeError('kill request shellId must be a non-empty id string')
    return { shellId }
  },
}

// --- Invocation descriptors --------------------------------------------------

/** The spawn invocation, registered by the host and mounted by the client. */
export const SPAWN_DESCRIPTOR: InvocationDescriptor = {
  id: 'dsh-session-shell#sessionShell.spawn',
  service: SHELL_SERVICE,
  namespace: SHELL_NAMESPACE,
  method: 'spawn',
  invocation: { kind: 'direct' },
  parameters: [{
    name: 'request',
    wire: 'request',
    source: 'json',
    codec: { mode: 'strict', typeSymbol: 'dsh-session-shell#SpawnShellRequest', schema: spawnRequestSchema },
  }],
  result: { mode: 'strict', typeSymbol: 'dsh-session-shell#SpawnShellResult', schema: spawnResultSchema },
}

/** The read invocation. */
export const READ_DESCRIPTOR: InvocationDescriptor = {
  id: 'dsh-session-shell#sessionShell.read',
  service: SHELL_SERVICE,
  namespace: SHELL_NAMESPACE,
  method: 'read',
  invocation: { kind: 'direct' },
  parameters: [{
    name: 'request',
    wire: 'request',
    source: 'json',
    codec: { mode: 'strict', typeSymbol: 'dsh-session-shell#ReadShellRequest', schema: readRequestSchema },
  }],
  result: { mode: 'strict', typeSymbol: 'dsh-session-shell#ReadShellResult', schema: readResultSchema },
}

/** The write invocation. */
export const WRITE_DESCRIPTOR: InvocationDescriptor = {
  id: 'dsh-session-shell#sessionShell.write',
  service: SHELL_SERVICE,
  namespace: SHELL_NAMESPACE,
  method: 'write',
  invocation: { kind: 'direct' },
  parameters: [{
    name: 'request',
    wire: 'request',
    source: 'json',
    codec: { mode: 'strict', typeSymbol: 'dsh-session-shell#WriteShellRequest', schema: writeRequestSchema },
  }],
  result: { mode: 'strict', typeSymbol: 'dsh-session-shell#ShellState', schema: stateResultSchema },
}

/** The resize invocation. */
export const RESIZE_DESCRIPTOR: InvocationDescriptor = {
  id: 'dsh-session-shell#sessionShell.resize',
  service: SHELL_SERVICE,
  namespace: SHELL_NAMESPACE,
  method: 'resize',
  invocation: { kind: 'direct' },
  parameters: [{
    name: 'request',
    wire: 'request',
    source: 'json',
    codec: { mode: 'strict', typeSymbol: 'dsh-session-shell#ResizeShellRequest', schema: resizeRequestSchema },
  }],
  result: { mode: 'strict', typeSymbol: 'dsh-session-shell#ShellState', schema: stateResultSchema },
}

/** The kill invocation. */
export const KILL_DESCRIPTOR: InvocationDescriptor = {
  id: 'dsh-session-shell#sessionShell.kill',
  service: SHELL_SERVICE,
  namespace: SHELL_NAMESPACE,
  method: 'kill',
  invocation: { kind: 'direct' },
  parameters: [{
    name: 'request',
    wire: 'request',
    source: 'json',
    codec: { mode: 'strict', typeSymbol: 'dsh-session-shell#KillShellRequest', schema: killRequestSchema },
  }],
  result: { mode: 'strict', typeSymbol: 'dsh-session-shell#ShellState', schema: stateResultSchema },
}

/** The full descriptor set, registered by the host and mounted by the client. */
export const SHELL_DESCRIPTORS: readonly InvocationDescriptor[] = [
  SPAWN_DESCRIPTOR,
  READ_DESCRIPTOR,
  WRITE_DESCRIPTOR,
  RESIZE_DESCRIPTOR,
  KILL_DESCRIPTOR,
]

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'sessionShell/spawn'(request: SpawnShellRequest): Promise<RemoteResult<SpawnShellResult>>
    'sessionShell/read'(request: ReadShellRequest): Promise<RemoteResult<ReadShellResult>>
    'sessionShell/write'(request: WriteShellRequest): Promise<RemoteResult<WriteShellResult>>
    'sessionShell/resize'(request: ResizeShellRequest): Promise<RemoteResult<ResizeShellResult>>
    'sessionShell/kill'(request: KillShellRequest): Promise<RemoteResult<KillShellResult>>
  }
  interface TypertRemoteNamespaceMap {
    sessionShell: {
      spawn(request: SpawnShellRequest): Promise<RemoteResult<SpawnShellResult>>
      read(request: ReadShellRequest): Promise<RemoteResult<ReadShellResult>>
      write(request: WriteShellRequest): Promise<RemoteResult<WriteShellResult>>
      resize(request: ResizeShellRequest): Promise<RemoteResult<ResizeShellResult>>
      kill(request: KillShellRequest): Promise<RemoteResult<KillShellResult>>
    }
  }
}
