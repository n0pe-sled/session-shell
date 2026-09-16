/**
 * Host (Node) half of dsh-session-shell.
 *
 * Registers the `sessionShell` Typert receiver behind `ctx.typert`, so the
 * gateway claims `/api/sessionShell/<method>` and dispatches to it: spawn one
 * interactive PTY per dsh session in the session's canonical working
 * directory (SessionHeader.cwd), then stream output through cursor reads.
 *
 * The browser half mounts the same descriptors and drives the PTY through
 * the client Remote; nothing here requires a model tool or prompt — the shell
 * is a human-controlled workspace terminal, one per session.
 *
 * Configuration: `enabled` (default true) turns the whole surface off at the
 * host; `shell` overrides the interactive shell binary (absolute path or PATH
 * name; default `$SHELL` on POSIX, `%COMSPEC%`/powershell on Windows).
 */

import Schema from '@deepseek-ai/schemastery'
import type z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pull the ctx.sessions Context merge (SessionStore).
import type {} from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: the ctx.typert.register() augmentation and TypertContribution.
import type {} from '@deepseek-ai/dsh-typert-registry'
import type { TypertContribution, TypertPackageModel } from '@deepseek-ai/dsh-typert-registry'
import { bindTypertRemote, type TypertGatewayBinding } from '@deepseek-ai/dsh-typert-protocol'
import { SessionShellManager, ShellSpawnError, resolveShellExecutable } from './shell-manager.ts'
import {
  SHELL_DESCRIPTORS, SHELL_SERVICE,
  type KillShellRequest, type KillShellResult,
  type ReadShellRequest, type ReadShellResult,
  type ResizeShellRequest, type ResizeShellResult,
  type SpawnShellRequest, type SpawnShellResult,
  type WriteShellRequest, type WriteShellResult,
} from './shared/remote.ts'

export { resolveShellExecutable, SessionShellManager, ShellSpawnError } from './shell-manager.ts'
export type {
  SpawnShellRequest, SpawnShellResult, ReadShellRequest, ReadShellResult,
  WriteShellRequest, WriteShellResult, ResizeShellRequest, ResizeShellResult,
  KillShellRequest, KillShellResult, ShellState, ShellControlError,
} from './shared/remote.ts'

export const name = 'session-shell'

/** Services that must be mounted before this plugin runs. */
export const inject = ['sessions', 'typert']

/** Config: surface switch and the interactive shell binary. */
export interface Config {
  enabled: boolean
  shell: string
}
export const Config: z<Config> = Schema.object({
  enabled: Schema.boolean().default(true),
  shell: Schema.string().default(''),
})

/** Empty model for the Typert contribution: no generated reflection is claimed. */
const EMPTY_MODEL: TypertPackageModel = { services: [], events: [], objects: [] }

/** The live receiver object the gateway dispatches `/api/sessionShell/<method>` to. */
interface SessionShellReceiver {
  /** Set after construction — the binding must reference the receiver itself. */
  typertRemote: TypertGatewayBinding<SessionShellReceiver>
  spawn(request: SpawnShellRequest): SpawnShellResult
  read(request: ReadShellRequest): ReadShellResult
  write(request: WriteShellRequest): WriteShellResult
  resize(request: ResizeShellRequest): ResizeShellResult
  kill(request: KillShellRequest): KillShellResult
}

/**
 * Mount the session-shell plugin.
 * @param ctx - the host context.
 * @param config - resolved plugin config (the loader passes the fully resolved value).
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const shell = await resolveShellExecutable(config.shell)
  const manager = new SessionShellManager(ctx, shell)

  // Kill every session's shell when its dsh session goes away, and all of
  // them when this plugin unloads or the host shuts down.
  ctx.on('session/disposed', (session: Session) => {
    manager.dispose(session.id)
  })
  ctx.effect(() => () => manager.disposeAll(), 'dsh-session-shell: dispose shells')

  const receiver: SessionShellReceiver = {
    // The binding is assigned below — it must reference the receiver itself,
    // which does not exist until the object literal completes.
    typertRemote: undefined as unknown as TypertGatewayBinding<SessionShellReceiver>,
    spawn(request: SpawnShellRequest): SpawnShellResult {
      if (!config.enabled) {
        throw new ShellSpawnError('shell-disabled', 'shell-disabled: the session shell is disabled in plugin configuration')
      }
      return manager.spawn(request)
    },
    read: (request: ReadShellRequest) => manager.read(request),
    write: (request: WriteShellRequest) => manager.write(request),
    resize: (request: ResizeShellRequest) => manager.resize(request),
    kill: (request: KillShellRequest) => manager.kill(request),
  }
  receiver.typertRemote = bindTypertRemote(receiver, SHELL_SERVICE, { namespace: SHELL_SERVICE })
  ctx.provide(SHELL_SERVICE, receiver)

  // Register the endpoints so the gateway claims `/api/sessionShell/<method>`
  // and dispatches to the receiver above.
  const contribution: TypertContribution = {
    package: 'dsh-session-shell',
    face: 'host',
    schemas: [],
    model: EMPTY_MODEL,
    invocations: SHELL_DESCRIPTORS,
  }
  ctx.typert.register(contribution)
}
