/**
 * Host-side PTY session manager for dsh-session-shell.
 *
 * One interactive shell per dsh session (keyed by session id), created on
 * demand with node-pty in the session's canonical working directory
 * (`SessionHeader.cwd`). Output is accumulated into a bounded string buffer
 * read cursor-wise by the browser through the `sessionShell/read` Remote;
 * input is delivered verbatim through `write` (PTY semantics — Ctrl-C etc.
 * behave exactly like a real terminal).
 *
 * Environment: the subprocess seam's scrubbed parent environment (so LLM
 * credentials never leak into an interactive shell) overlaid with terminal
 * facts (TERM=xterm-256color) and `DSH_SESSION_ID`.
 *
 * @module dsh-session-shell/shell-manager
 */

import * as nodePty from 'node-pty'
import type { IPty, IPtyForkOptions } from 'node-pty'
import { access, constants } from 'node:fs/promises'
import { delimiter } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type {
  KillShellRequest,
  KillShellResult,
  ReadShellRequest,
  ReadShellResult,
  ResizeShellRequest,
  ResizeShellResult,
  ShellState,
  SpawnShellRequest,
  SpawnShellResult,
  WriteShellRequest,
  WriteShellResult,
} from './shared/remote.ts'

/** Retained output cap; beyond it the oldest bytes are dropped and the client replays. */
const MAX_BUFFER = 1_048_576
/** Post-trim retained tail. */
const TRIM_TO = 512 * 1024

/** One live PTY plus its client-visible facts. */
interface ShellEntry {
  readonly sessionId: string
  readonly pty: IPty
  /** Complete retained output since spawn (trimmed at the cap). */
  buffer: string
  /** Lifecycle state mirrored from the PTY driver. */
  state: ShellState
  /** The buffer was trimmed: the next read must return the whole buffer and ask the client to reset. */
  pendingReset: boolean
}

/** Error category for user-visible spawn failures. */
export class ShellSpawnError extends Error {
  /** Stable machine category ('shell-disabled' | 'session-not-found' | 'cwd-unavailable' | 'spawn-failed' | 'shell-not-found'). */
  readonly kind: string

  /** @param kind - machine category. @param message - user-facing message. */
  constructor(kind: string, message: string) {
    super(message)
    this.name = 'ShellSpawnError'
    this.kind = kind
  }
}

/** Resolve the interactive shell executable; PATH search for bare names. */
export async function resolveShellExecutable(requested: string): Promise<string> {
  if (requested !== '') {
    const resolved = await resolveOnPath(requested)
    if (resolved !== undefined) return resolved
    throw new ShellSpawnError('spawn-failed', `spawn-failed: configured shell ${JSON.stringify(requested)} was not found`)
  }
  const preferred = process.env.SHELL
  if (preferred !== undefined && preferred !== '') {
    const resolved = await resolveOnPath(preferred)
    if (resolved !== undefined) return resolved
  }
  return process.platform === 'win32' ? (process.env.COMSPEC ?? 'powershell.exe') : '/bin/bash'
}

async function resolveOnPath(candidate: string): Promise<string | undefined> {
  if (candidate.includes('/') || (process.platform === 'win32' && candidate.includes('\\'))) {
    return (await isExecutable(candidate)) ? candidate : undefined
  }
  const path = process.env.PATH ?? ''
  for (const directory of path.split(delimiter)) {
    if (directory === '') continue
    const joined = directory.endsWith('/') || directory.endsWith('\\') ? `${directory}${candidate}` : `${directory}/${candidate}`
    if (await isExecutable(joined)) return joined
  }
  return undefined
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Live PTY registry: spawn/reuse one shell per session, bounded output
 * buffer, cursor reads, idempotent kill, and full disposal.
 */
export class SessionShellManager {
  private readonly entries = new Map<string, ShellEntry>()

  /**
   * @param ctx - owning host context (session store access + lifecycle listen).
   * @param shell - the resolved shell executable (absolute path or PATH name).
   */
  constructor(
    private readonly ctx: Context,
    private readonly shell: string,
  ) {}

  /** Reuse the running shell or spawn one in the session's working directory. */
  spawn(request: SpawnShellRequest): SpawnShellResult {
    const existing = this.entries.get(request.sessionId)
    if (existing !== undefined) {
      if (existing.state.kind === 'running') {
        return this.describe(existing, request.sessionId)
      }
      // An exited shell is replaced: a tab (re)mount must never be pinned to
      // a dead PTY. Drop the old entry and terminate whatever remains.
      this.entries.delete(request.sessionId)
      try {
        existing.pty.kill()
      } catch (error) {
        // Best-effort: the PTY already reported exit.
      }
    }
    const session = this.ctx.sessions.get(request.sessionId as SessionId)
    if (session === undefined) {
      throw new ShellSpawnError('session-not-found', `session-not-found: session ${JSON.stringify(request.sessionId)} not found`)
    }
    const cwd = session.header.cwd
    if (cwd === undefined || cwd === '') {
      throw new ShellSpawnError('cwd-unavailable', `cwd-unavailable: session ${JSON.stringify(request.sessionId)} has no working directory`)
    }
    const env = {
      ...scrubbedParentEnv(),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      DSH_SHELL: '1',
      DSH_SESSION_ID: request.sessionId,
    }
    const options: IPtyForkOptions = {
      name: 'xterm-256color',
      cols: request.cols,
      rows: request.rows,
      cwd,
      env,
    }
    let pty: IPty
    try {
      pty = nodePty.spawn(this.shell, [], options)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new ShellSpawnError('spawn-failed', `spawn-failed: unable to start shell ${JSON.stringify(this.shell)}: ${message}`)
    }
    const entry: ShellEntry = {
      sessionId: request.sessionId,
      pty,
      buffer: '',
      state: { kind: 'running' },
      pendingReset: false,
    }
    pty.onData((data: string) => {
      entry.buffer += data
      if (entry.buffer.length > MAX_BUFFER) {
        entry.buffer = entry.buffer.slice(entry.buffer.length - TRIM_TO)
        entry.pendingReset = true
      }
    })
    pty.onExit(({ exitCode, signal }) => {
      entry.state = { kind: 'exited', code: exitCode, signal: signal ?? null }
    })
    this.entries.set(request.sessionId, entry)
    return this.describe(entry, request.sessionId)
  }

  /** Return output after `cursor` and the new cursor; full replay after a trim. */
  read(request: ReadShellRequest): ReadShellResult {
    const entry = this.entryOf(request.shellId)
    if (entry.pendingReset) {
      entry.pendingReset = false
      return {
        text: entry.buffer,
        cursor: entry.buffer.length,
        truncated: true,
        state: entry.state,
      }
    }
    const end = entry.buffer.length
    const start = Math.min(Math.max(request.cursor, 0), end)
    return {
      text: entry.buffer.slice(start),
      cursor: end,
      truncated: false,
      state: entry.state,
    }
  }

  /** Deliver raw input; an exited shell answers with its state instead of throwing. */
  write(request: WriteShellRequest): WriteShellResult {
    const entry = this.entryOf(request.shellId)
    if (entry.state.kind === 'exited') return { state: entry.state }
    try {
      entry.pty.write(request.data)
    } catch (error) {
      // A racing exit (or already-dead PTY) is a state answer, not a failure.
      entry.state = { kind: 'exited', code: null, signal: null }
    }
    return { state: entry.state }
  }

  /** Change PTY dimensions; an exited shell answers with its state. */
  resize(request: ResizeShellRequest): ResizeShellResult {
    const entry = this.entryOf(request.shellId)
    if (entry.state.kind === 'exited') return { state: entry.state }
    try {
      entry.pty.resize(request.cols, request.rows)
    } catch (error) {
      entry.state = { kind: 'exited', code: null, signal: null }
    }
    return { state: entry.state }
  }

  /** Idempotently terminate one shell. */
  kill(request: KillShellRequest): KillShellResult {
    const entry = this.entries.get(request.shellId)
    if (entry === undefined) {
      return { state: { kind: 'exited', code: null, signal: null } }
    }
    if (entry.state.kind === 'running') {
      try {
        entry.pty.kill()
      } catch (error) {
        // Already gone: mark exited so the client converges.
        entry.state = { kind: 'exited', code: null, signal: null }
      }
    }
    return { state: entry.state }
  }

  /** Dispose one session's shell (session teardown). */
  dispose(sessionId: string): void {
    const entry = this.entries.get(sessionId)
    if (entry === undefined) return
    this.entries.delete(sessionId)
    try {
      entry.pty.kill()
    } catch (error) {
      // Nothing left to clean; the PTY is process-pinned regardless.
    }
  }

  /** Dispose every live shell (plugin unload / host shutdown). */
  disposeAll(): void {
    for (const entry of [...this.entries.values()]) {
      try {
        entry.pty.kill()
      } catch (error) {
        // Ignore: disposal is best-effort at shutdown.
      }
    }
    this.entries.clear()
  }

  private entryOf(shellId: string): ShellEntry {
    const entry = this.entries.get(shellId)
    if (entry === undefined) {
      throw new ShellSpawnError('shell-not-found', `shell-not-found: shell ${JSON.stringify(shellId)} is not running`)
    }
    return entry
  }

  private describe(entry: ShellEntry, shellId: string): SpawnShellResult {
    const session = this.ctx.sessions.get(shellId as SessionId)
    return {
      shellId,
      pid: entry.pty.pid,
      cwd: session?.header.cwd ?? '',
      state: entry.state,
    }
  }
}
