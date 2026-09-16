import Schema from "@deepseek-ai/schemastery";
import { RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
import { Context } from "@deepseek-ai/cordis";
//#region src/shared/remote.d.ts
/** One shell's lifecycle state as observed by the host PTY driver. */
type ShellState = {
  readonly kind: 'running';
} | {
  readonly kind: 'exited';
  readonly code: number | null;
  readonly signal: number | null;
};
/** Spawn request: lazily create (or reuse) one PTY for the session. */
interface SpawnShellRequest {
  /** The dsh session whose working directory the shell runs in. */
  readonly sessionId: string;
  /** Initial terminal columns. */
  readonly cols: number;
  /** Initial terminal rows. */
  readonly rows: number;
}
/** Spawn outcome. */
interface SpawnShellResult {
  /** The shell handle id (== sessionId; one shell per session by design). */
  readonly shellId: string;
  /** OS process id of the shell's top-level process. */
  readonly pid: number;
  /** The session's working directory the shell runs in. */
  readonly cwd: string;
  /** Lifecycle state after spawn. */
  readonly state: ShellState;
}
/** Read request: everything after `cursor` in the shell's output buffer. */
interface ReadShellRequest {
  readonly shellId: string;
  /** Buffer offset last consumed by the client; 0 replays the whole scrollback. */
  readonly cursor: number;
}
/** Read outcome. */
interface ReadShellResult {
  /** Output bytes after `cursor` in delivery order (already UTF-8 decoded). */
  readonly text: string;
  /** New buffer offset; pass back as the next `cursor`. */
  readonly cursor: number;
  /** True when the host dropped older scrollback to bound memory: the client must clear and replay. */
  readonly truncated: boolean;
  /** Lifecycle state after this read. */
  readonly state: ShellState;
}
/** Write request: deliver raw input bytes to the shell's stdin (PTY). */
interface WriteShellRequest {
  readonly shellId: string;
  /** Input text delivered verbatim, no newline conversion. */
  readonly data: string;
}
/** Write outcome (does not reject on an exited shell). */
interface WriteShellResult {
  readonly state: ShellState;
}
/** Resize request: change the PTY dimensions. */
interface ResizeShellRequest {
  readonly shellId: string;
  readonly cols: number;
  readonly rows: number;
}
/** Resize outcome. */
interface ResizeShellResult {
  readonly state: ShellState;
}
/** Kill request: terminate the shell (idempotent). */
interface KillShellRequest {
  readonly shellId: string;
}
/** Kill outcome. */
interface KillShellResult {
  readonly state: ShellState;
}
/** Client-visible outcome of one control action, carrying a stable error surface. */
type ShellControlError = {
  readonly kind: 'session-not-found';
  readonly message: string;
} | {
  readonly kind: 'shell-disabled';
  readonly message: string;
} | {
  readonly kind: 'cwd-unavailable';
  readonly message: string;
} | {
  readonly kind: 'spawn-failed';
  readonly message: string;
} | {
  readonly kind: 'shell-not-found';
  readonly message: string;
} | {
  readonly kind: 'remote-error';
  readonly message: string;
};
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'sessionShell/spawn'(request: SpawnShellRequest): Promise<RemoteResult<SpawnShellResult>>;
    'sessionShell/read'(request: ReadShellRequest): Promise<RemoteResult<ReadShellResult>>;
    'sessionShell/write'(request: WriteShellRequest): Promise<RemoteResult<WriteShellResult>>;
    'sessionShell/resize'(request: ResizeShellRequest): Promise<RemoteResult<ResizeShellResult>>;
    'sessionShell/kill'(request: KillShellRequest): Promise<RemoteResult<KillShellResult>>;
  }
  interface TypertRemoteNamespaceMap {
    sessionShell: {
      spawn(request: SpawnShellRequest): Promise<RemoteResult<SpawnShellResult>>;
      read(request: ReadShellRequest): Promise<RemoteResult<ReadShellResult>>;
      write(request: WriteShellRequest): Promise<RemoteResult<WriteShellResult>>;
      resize(request: ResizeShellRequest): Promise<RemoteResult<ResizeShellResult>>;
      kill(request: KillShellRequest): Promise<RemoteResult<KillShellResult>>;
    };
  }
}
//#endregion
//#region src/shell-manager.d.ts
/** Error category for user-visible spawn failures. */
declare class ShellSpawnError extends Error {
  /** Stable machine category ('shell-disabled' | 'session-not-found' | 'cwd-unavailable' | 'spawn-failed' | 'shell-not-found'). */
  readonly kind: string;
  /** @param kind - machine category. @param message - user-facing message. */
  constructor(kind: string, message: string);
}
/** Resolve the interactive shell executable; PATH search for bare names. */
declare function resolveShellExecutable(requested: string): Promise<string>;
/**
 * Live PTY registry: spawn/reuse one shell per session, bounded output
 * buffer, cursor reads, idempotent kill, and full disposal.
 */
declare class SessionShellManager {
  private readonly ctx;
  private readonly shell;
  private readonly entries;
  /**
   * @param ctx - owning host context (session store access + lifecycle listen).
   * @param shell - the resolved shell executable (absolute path or PATH name).
   */
  constructor(ctx: Context, shell: string);
  /** Reuse the running shell or spawn one in the session's working directory. */
  spawn(request: SpawnShellRequest): SpawnShellResult;
  /** Return output after `cursor` and the new cursor; full replay after a trim. */
  read(request: ReadShellRequest): ReadShellResult;
  /** Deliver raw input; an exited shell answers with its state instead of throwing. */
  write(request: WriteShellRequest): WriteShellResult;
  /** Change PTY dimensions; an exited shell answers with its state. */
  resize(request: ResizeShellRequest): ResizeShellResult;
  /** Idempotently terminate one shell. */
  kill(request: KillShellRequest): KillShellResult;
  /** Dispose one session's shell (session teardown). */
  dispose(sessionId: string): void;
  /** Dispose every live shell (plugin unload / host shutdown). */
  disposeAll(): void;
  private entryOf;
  private describe;
}
//#endregion
//#region src/index.d.ts
declare const name = "session-shell";
/** Services that must be mounted before this plugin runs. */
declare const inject: string[];
/** Config: surface switch and the interactive shell binary. */
interface Config {
  enabled: boolean;
  shell: string;
}
declare const Config: Schema<Config>;
/**
 * Mount the session-shell plugin.
 * @param ctx - the host context.
 * @param config - resolved plugin config (the loader passes the fully resolved value).
 */
declare function apply(ctx: Context, config: Config): Promise<void>;
//#endregion
export { Config, type KillShellRequest, type KillShellResult, type ReadShellRequest, type ReadShellResult, type ResizeShellRequest, type ResizeShellResult, SessionShellManager, type ShellControlError, ShellSpawnError, type ShellState, type SpawnShellRequest, type SpawnShellResult, type WriteShellRequest, type WriteShellResult, apply, inject, name, resolveShellExecutable };