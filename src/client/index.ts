/**
 * Browser half of dsh-session-shell: registers a per-session "Shell" tab in
 * the conversation view ring (`'conversation.view'` slot, order 20 — after
 * Chat and Trajectory) and mounts the `sessionShell` Remote so the host PTY
 * can be driven from the terminal component.
 *
 * The Remote contribution is mounted lazily: `$mount` starts here (so its
 * effect is fiber-owned and unwinds with the plugin), but its rejection is
 * contained and only surfaced through the controller's error branch — a mount
 * failure must not take down the session view, it only disables the tab body.
 *
 * Export discipline (packages/client/AGENTS.md): the ./client entry exports
 * only `apply`/`inject` and shared types; components stay internal.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the 'conversation.view' SlotMap row (declared by the slot's
// owning package) in for the register call to type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: ctx.slots and the SlotMap types.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import {
  SHELL_DESCRIPTORS, classifyControlError,
  type KillShellRequest, type KillShellResult,
  type ReadShellRequest, type ReadShellResult,
  type ResizeShellRequest, type ResizeShellResult,
  type SpawnShellRequest, type SpawnShellResult,
  type WriteShellRequest, type WriteShellResult,
} from '../shared/remote.ts'
import {
  ShellTerminalView,
  type SessionShellController,
  type SessionShellViewInjected,
  type ShellSpawnOutcome,
} from './ShellTerminalView.tsx'
import { XTERM_CSS } from './xterm-css.ts'

export type {
  SessionShellController, SessionShellViewInjected,
  ShellPollOutcome, ShellSpawnOutcome,
} from './ShellTerminalView.tsx'
export { classifyControlError } from '../shared/remote.ts'
export type {
  SpawnShellRequest, SpawnShellResult, ReadShellRequest, ReadShellResult,
} from '../shared/remote.ts'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'remote']

/** The mounted sessionShell namespace, resolved through the service store. */
interface SessionShellRemote {
  spawn(request: SpawnShellRequest): Promise<RemoteResult<SpawnShellResult>>
  read(request: ReadShellRequest): Promise<RemoteResult<ReadShellResult>>
  write(request: WriteShellRequest): Promise<RemoteResult<WriteShellResult>>
  resize(request: ResizeShellRequest): Promise<RemoteResult<ResizeShellResult>>
  kill(request: KillShellRequest): Promise<RemoteResult<KillShellResult>>
}

const CSS_TAG_ID = 'dsh-session-shell-xterm'

/** Inject the vendored xterm stylesheet once per page. */
function ensureXtermCss(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${CSS_TAG_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-session-shell'
  tag.dataset.pluginCss = CSS_TAG_ID
  tag.textContent = XTERM_CSS
  document.head.appendChild(tag)
}

/**
 * Register the Shell tab for every session and mount the shell Remote.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ensureXtermCss()

  // Mount the shell Remote for this plugin's fiber. Not awaited: a mount
  // failure (endpoint collision, carrier offline) only disables the tab body.
  const mount = ctx.remote.$mount({
    package: 'dsh-session-shell',
    descriptors: SHELL_DESCRIPTORS,
  })
  mount.catch(() => {})

  const controls = new Map<string, SessionShellController>()

  /** Resolve the mounted namespace, or undefined when the mount failed. */
  const namespace = async (): Promise<SessionShellRemote | undefined> => {
    try {
      await mount
    } catch (error) {
      return undefined
    }
    return ctx.get('remote.sessionShell') as SessionShellRemote | undefined
  }

  /** One per-session controller: owns the shellId handle and error classification. */
  const makeControl = (sessionId: SessionId): SessionShellController => {
    let shellId: string | null = null

    const spawn = async (rem: SessionShellRemote, request: SpawnShellRequest): Promise<RemoteResult<SpawnShellResult>> => {
      try {
        return await rem.spawn(request)
      } catch (error) {
        // Assembly faults (unmounted method) surface as a rejection;
        // normalize to the error branch consumed below.
        return { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} } }
      }
    }

    const spawnOutcome = async (restart: boolean, cols: number, rows: number): Promise<ShellSpawnOutcome> => {
      const rem = await namespace()
      if (rem === undefined) {
        return { ok: false, error: classifyControlError('remote-error: the shell remote is not mounted') }
      }
      if (restart && shellId !== null) {
        try {
          await rem.kill({ shellId })
        } catch (error) {
          // A dead host-side handle is fine: the spawn below recreates it.
        }
        shellId = null
      }
      const request: SpawnShellRequest = { sessionId, cols, rows }
      const result = await spawn(rem, request)
      if (!result.ok) {
        shellId = null
        return { ok: false, error: classifyControlError(result.error.message) }
      }
      shellId = result.value.shellId
      return { ok: true, cwd: result.value.cwd, state: result.value.state }
    }

    // The boundary validator caps a chunk at 4096 characters; split without
    // breaking a UTF-16 surrogate pair across chunks.
    const writeChunks = async (rem: SessionShellRemote, id: string, data: string): Promise<void> => {
      for (let offset = 0; offset < data.length;) {
        let end = Math.min(offset + 4000, data.length)
        if (end < data.length && end > offset) {
          const last = data.charCodeAt(end - 1)
          const next = data.charCodeAt(end)
          if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
            end -= 1
          }
        }
        const chunk = data.slice(offset, end)
        offset = end
        try {
          await rem.write({ shellId: id, data: chunk })
        } catch (error) {
          // Fire-and-forget input; the poll loop surfaces dead-shell state.
        }
      }
    }

    return {
      ensure: (cols, rows) => spawnOutcome(false, cols, rows),
      restart: (cols, rows) => spawnOutcome(true, cols, rows),
      write: (data) => {
        if (shellId === null || data.length === 0) return
        const idAtWrite = shellId
        void (async () => {
          const rem = await namespace()
          if (rem === undefined) return
          if (idAtWrite !== shellId) return
          await writeChunks(rem, idAtWrite, data)
        })()
      },
      poll: async (cursor) => {
        const rem = await namespace()
        if (rem === undefined) {
          return { ok: false, error: classifyControlError('remote-error: the shell remote is not mounted') }
        }
        if (shellId === null) {
          return { ok: false, error: classifyControlError('shell-not-found: no shell started for this session') }
        }
        try {
          const result = await rem.read({ shellId, cursor })
          if (!result.ok) {
            if (classifyControlError(result.error.message).kind === 'shell-not-found') shellId = null
            return { ok: false, error: classifyControlError(result.error.message) }
          }
          return {
            ok: true,
            text: result.value.text,
            cursor: result.value.cursor,
            truncated: result.value.truncated,
            state: result.value.state,
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { ok: false, error: classifyControlError(message) }
        }
      },
      resize: (cols, rows) => {
        if (shellId === null) return
        const idAtResize = shellId
        void (async () => {
          const rem = await namespace()
          if (rem === undefined) return
          if (idAtResize !== shellId) return
          try {
            await rem.resize({ shellId, cols, rows })
          } catch (error) {
            // Best-effort resize; no user-facing error for a racing exit.
          }
        })()
      },
    }
  }

  const controlFor = (sessionId: SessionId): SessionShellController => {
    let control = controls.get(sessionId)
    if (control === undefined) {
      control = makeControl(sessionId)
      controls.set(sessionId, control)
    }
    return control
  }

  // Register the tab. The inject factory closes over the per-session control
  // and its lifecycle is tied to this plugin fiber, not the component mount,
  // so the PTY survives tab switches (the view ring renders one-at-a-time).
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'shell',
    order: 20,
    label: () => 'Shell',
    inject: (sessionId: SessionId): SessionShellViewInjected => ({
      control: controlFor(sessionId),
    }),
  }, ShellTerminalView))
}
