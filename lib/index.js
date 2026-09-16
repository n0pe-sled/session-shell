import Schema from "@deepseek-ai/schemastery";
import { bindTypertRemote } from "@deepseek-ai/dsh-typert-protocol";
import * as nodePty from "node-pty";
import { access, constants } from "node:fs/promises";
import { delimiter } from "node:path";
import { scrubbedParentEnv } from "@deepseek-ai/dsh-subprocess";
//#region src/shell-manager.ts
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
/** Retained output cap; beyond it the oldest bytes are dropped and the client replays. */
const MAX_BUFFER = 1048576;
/** Post-trim retained tail. */
const TRIM_TO = 524288;
/** Error category for user-visible spawn failures. */
var ShellSpawnError = class extends Error {
	/** Stable machine category ('shell-disabled' | 'session-not-found' | 'cwd-unavailable' | 'spawn-failed' | 'shell-not-found'). */
	kind;
	/** @param kind - machine category. @param message - user-facing message. */
	constructor(kind, message) {
		super(message);
		this.name = "ShellSpawnError";
		this.kind = kind;
	}
};
/** Resolve the interactive shell executable; PATH search for bare names. */
async function resolveShellExecutable(requested) {
	if (requested !== "") {
		const resolved = await resolveOnPath(requested);
		if (resolved !== void 0) return resolved;
		throw new ShellSpawnError("spawn-failed", `spawn-failed: configured shell ${JSON.stringify(requested)} was not found`);
	}
	const preferred = process.env.SHELL;
	if (preferred !== void 0 && preferred !== "") {
		const resolved = await resolveOnPath(preferred);
		if (resolved !== void 0) return resolved;
	}
	return process.platform === "win32" ? process.env.COMSPEC ?? "powershell.exe" : "/bin/bash";
}
async function resolveOnPath(candidate) {
	if (candidate.includes("/") || process.platform === "win32" && candidate.includes("\\")) return await isExecutable(candidate) ? candidate : void 0;
	const path = process.env.PATH ?? "";
	for (const directory of path.split(delimiter)) {
		if (directory === "") continue;
		const joined = directory.endsWith("/") || directory.endsWith("\\") ? `${directory}${candidate}` : `${directory}/${candidate}`;
		if (await isExecutable(joined)) return joined;
	}
}
async function isExecutable(path) {
	try {
		await access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
/**
* Live PTY registry: spawn/reuse one shell per session, bounded output
* buffer, cursor reads, idempotent kill, and full disposal.
*/
var SessionShellManager = class {
	ctx;
	shell;
	entries = /* @__PURE__ */ new Map();
	/**
	* @param ctx - owning host context (session store access + lifecycle listen).
	* @param shell - the resolved shell executable (absolute path or PATH name).
	*/
	constructor(ctx, shell) {
		this.ctx = ctx;
		this.shell = shell;
	}
	/** Reuse the running shell or spawn one in the session's working directory. */
	spawn(request) {
		const existing = this.entries.get(request.sessionId);
		if (existing !== void 0) {
			if (existing.state.kind === "running") return this.describe(existing, request.sessionId);
			this.entries.delete(request.sessionId);
			try {
				existing.pty.kill();
			} catch (error) {}
		}
		const session = this.ctx.sessions.get(request.sessionId);
		if (session === void 0) throw new ShellSpawnError("session-not-found", `session-not-found: session ${JSON.stringify(request.sessionId)} not found`);
		const cwd = session.header.cwd;
		if (cwd === void 0 || cwd === "") throw new ShellSpawnError("cwd-unavailable", `cwd-unavailable: session ${JSON.stringify(request.sessionId)} has no working directory`);
		const env = {
			...scrubbedParentEnv(),
			TERM: "xterm-256color",
			COLORTERM: "truecolor",
			DSH_SHELL: "1",
			DSH_SESSION_ID: request.sessionId
		};
		const options = {
			name: "xterm-256color",
			cols: request.cols,
			rows: request.rows,
			cwd,
			env
		};
		let pty;
		try {
			pty = nodePty.spawn(this.shell, [], options);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new ShellSpawnError("spawn-failed", `spawn-failed: unable to start shell ${JSON.stringify(this.shell)}: ${message}`);
		}
		const entry = {
			sessionId: request.sessionId,
			pty,
			buffer: "",
			state: { kind: "running" },
			pendingReset: false
		};
		pty.onData((data) => {
			entry.buffer += data;
			if (entry.buffer.length > MAX_BUFFER) {
				entry.buffer = entry.buffer.slice(entry.buffer.length - TRIM_TO);
				entry.pendingReset = true;
			}
		});
		pty.onExit(({ exitCode, signal }) => {
			entry.state = {
				kind: "exited",
				code: exitCode,
				signal: signal ?? null
			};
		});
		this.entries.set(request.sessionId, entry);
		return this.describe(entry, request.sessionId);
	}
	/** Return output after `cursor` and the new cursor; full replay after a trim. */
	read(request) {
		const entry = this.entryOf(request.shellId);
		if (entry.pendingReset) {
			entry.pendingReset = false;
			return {
				text: entry.buffer,
				cursor: entry.buffer.length,
				truncated: true,
				state: entry.state
			};
		}
		const end = entry.buffer.length;
		const start = Math.min(Math.max(request.cursor, 0), end);
		return {
			text: entry.buffer.slice(start),
			cursor: end,
			truncated: false,
			state: entry.state
		};
	}
	/** Deliver raw input; an exited shell answers with its state instead of throwing. */
	write(request) {
		const entry = this.entryOf(request.shellId);
		if (entry.state.kind === "exited") return { state: entry.state };
		try {
			entry.pty.write(request.data);
		} catch (error) {
			entry.state = {
				kind: "exited",
				code: null,
				signal: null
			};
		}
		return { state: entry.state };
	}
	/** Change PTY dimensions; an exited shell answers with its state. */
	resize(request) {
		const entry = this.entryOf(request.shellId);
		if (entry.state.kind === "exited") return { state: entry.state };
		try {
			entry.pty.resize(request.cols, request.rows);
		} catch (error) {
			entry.state = {
				kind: "exited",
				code: null,
				signal: null
			};
		}
		return { state: entry.state };
	}
	/** Idempotently terminate one shell. */
	kill(request) {
		const entry = this.entries.get(request.shellId);
		if (entry === void 0) return { state: {
			kind: "exited",
			code: null,
			signal: null
		} };
		if (entry.state.kind === "running") try {
			entry.pty.kill();
		} catch (error) {
			entry.state = {
				kind: "exited",
				code: null,
				signal: null
			};
		}
		return { state: entry.state };
	}
	/** Dispose one session's shell (session teardown). */
	dispose(sessionId) {
		const entry = this.entries.get(sessionId);
		if (entry === void 0) return;
		this.entries.delete(sessionId);
		try {
			entry.pty.kill();
		} catch (error) {}
	}
	/** Dispose every live shell (plugin unload / host shutdown). */
	disposeAll() {
		for (const entry of [...this.entries.values()]) try {
			entry.pty.kill();
		} catch (error) {}
		this.entries.clear();
	}
	entryOf(shellId) {
		const entry = this.entries.get(shellId);
		if (entry === void 0) throw new ShellSpawnError("shell-not-found", `shell-not-found: shell ${JSON.stringify(shellId)} is not running`);
		return entry;
	}
	describe(entry, shellId) {
		const session = this.ctx.sessions.get(shellId);
		return {
			shellId,
			pid: entry.pty.pid,
			cwd: session?.header.cwd ?? "",
			state: entry.state
		};
	}
};
//#endregion
//#region src/shared/remote.ts
/** Cordis service key of the shell receiver, also the wire namespace. */
const SHELL_SERVICE = "sessionShell";
/** Wire namespace of every shell invocation. */
const SHELL_NAMESPACE = SHELL_SERVICE;
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function isString(value) {
	return typeof value === "string";
}
/** Valid non-empty short identifier (session/shell id). */
function isId(value) {
	return isString(value) && value.length > 0 && value.length <= 256 && !value.includes("\0");
}
/** Positive integer within a sane terminal dimension. */
function isDimension(value) {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 512;
}
/** Non-negative safe cursor. */
function isCursor(value) {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2147483647;
}
/** Lifecycle state boundary validator. */
const stateSchema = { parse(value) {
	if (!isRecord(value)) throw new TypeError("shell state must be a plain object");
	if (value.kind === "running") return { kind: "running" };
	if (value.kind === "exited") {
		const code = value.code;
		const signal = value.signal;
		if (code !== null && typeof code !== "number") throw new TypeError("exited state code must be a number or null");
		if (signal !== null && typeof signal !== "number") throw new TypeError("exited state signal must be a number or null");
		return {
			kind: "exited",
			code,
			signal
		};
	}
	throw new TypeError("shell state kind must be \"running\" or \"exited\"");
} };
/** Spawn result boundary validator. */
const spawnResultSchema = { parse(value) {
	if (!isRecord(value)) throw new TypeError("spawn result must be a plain object");
	const { shellId, pid, cwd, state } = value;
	if (!isId(shellId)) throw new TypeError("spawn result shellId must be a non-empty id string");
	if (typeof pid !== "number" || !Number.isSafeInteger(pid)) throw new TypeError("spawn result pid must be a safe integer");
	if (!isString(cwd) || cwd.length === 0) throw new TypeError("spawn result cwd must be a non-empty string");
	return {
		shellId,
		pid,
		cwd,
		state: stateSchema.parse(state)
	};
} };
/** Read result boundary validator. */
const readResultSchema = { parse(value) {
	if (!isRecord(value)) throw new TypeError("read result must be a plain object");
	const { text, cursor, truncated, state } = value;
	if (!isString(text)) throw new TypeError("read result text must be a string");
	if (!isCursor(cursor)) throw new TypeError("read result cursor must be a non-negative integer");
	if (typeof truncated !== "boolean") throw new TypeError("read result truncated must be a boolean");
	return {
		text,
		cursor,
		truncated,
		state: stateSchema.parse(state)
	};
} };
/** Small state-only result boundary validator (write/resize/kill). */
const stateResultSchema = { parse(value) {
	if (!isRecord(value)) throw new TypeError("result must be a plain object");
	return { state: stateSchema.parse(value.state) };
} };
/** The full descriptor set, registered by the host and mounted by the client. */
const SHELL_DESCRIPTORS = [
	{
		id: "dsh-session-shell#sessionShell.spawn",
		service: SHELL_SERVICE,
		namespace: SHELL_NAMESPACE,
		method: "spawn",
		invocation: { kind: "direct" },
		parameters: [{
			name: "request",
			wire: "request",
			source: "json",
			codec: {
				mode: "strict",
				typeSymbol: "dsh-session-shell#SpawnShellRequest",
				schema: { parse(value) {
					if (!isRecord(value)) throw new TypeError("spawn request must be a plain object");
					const { sessionId, cols, rows } = value;
					if (!isId(sessionId)) throw new TypeError("spawn request sessionId must be a non-empty id string");
					if (!isDimension(cols)) throw new TypeError("spawn request cols must be an integer in 1..512");
					if (!isDimension(rows)) throw new TypeError("spawn request rows must be an integer in 1..512");
					return {
						sessionId,
						cols,
						rows
					};
				} }
			}
		}],
		result: {
			mode: "strict",
			typeSymbol: "dsh-session-shell#SpawnShellResult",
			schema: spawnResultSchema
		}
	},
	{
		id: "dsh-session-shell#sessionShell.read",
		service: SHELL_SERVICE,
		namespace: SHELL_NAMESPACE,
		method: "read",
		invocation: { kind: "direct" },
		parameters: [{
			name: "request",
			wire: "request",
			source: "json",
			codec: {
				mode: "strict",
				typeSymbol: "dsh-session-shell#ReadShellRequest",
				schema: { parse(value) {
					if (!isRecord(value)) throw new TypeError("read request must be a plain object");
					const { shellId, cursor } = value;
					if (!isId(shellId)) throw new TypeError("read request shellId must be a non-empty id string");
					if (!isCursor(cursor)) throw new TypeError("read request cursor must be a non-negative integer");
					return {
						shellId,
						cursor
					};
				} }
			}
		}],
		result: {
			mode: "strict",
			typeSymbol: "dsh-session-shell#ReadShellResult",
			schema: readResultSchema
		}
	},
	{
		id: "dsh-session-shell#sessionShell.write",
		service: SHELL_SERVICE,
		namespace: SHELL_NAMESPACE,
		method: "write",
		invocation: { kind: "direct" },
		parameters: [{
			name: "request",
			wire: "request",
			source: "json",
			codec: {
				mode: "strict",
				typeSymbol: "dsh-session-shell#WriteShellRequest",
				schema: { parse(value) {
					if (!isRecord(value)) throw new TypeError("write request must be a plain object");
					const { shellId, data } = value;
					if (!isId(shellId)) throw new TypeError("write request shellId must be a non-empty id string");
					if (!isString(data)) throw new TypeError("write request data must be a string");
					if (data.length > 4096) throw new TypeError("write request data chunk exceeds 4096 characters");
					return {
						shellId,
						data
					};
				} }
			}
		}],
		result: {
			mode: "strict",
			typeSymbol: "dsh-session-shell#ShellState",
			schema: stateResultSchema
		}
	},
	{
		id: "dsh-session-shell#sessionShell.resize",
		service: SHELL_SERVICE,
		namespace: SHELL_NAMESPACE,
		method: "resize",
		invocation: { kind: "direct" },
		parameters: [{
			name: "request",
			wire: "request",
			source: "json",
			codec: {
				mode: "strict",
				typeSymbol: "dsh-session-shell#ResizeShellRequest",
				schema: { parse(value) {
					if (!isRecord(value)) throw new TypeError("resize request must be a plain object");
					const { shellId, cols, rows } = value;
					if (!isId(shellId)) throw new TypeError("resize request shellId must be a non-empty id string");
					if (!isDimension(cols)) throw new TypeError("resize request cols must be an integer in 1..512");
					if (!isDimension(rows)) throw new TypeError("resize request rows must be an integer in 1..512");
					return {
						shellId,
						cols,
						rows
					};
				} }
			}
		}],
		result: {
			mode: "strict",
			typeSymbol: "dsh-session-shell#ShellState",
			schema: stateResultSchema
		}
	},
	{
		id: "dsh-session-shell#sessionShell.kill",
		service: SHELL_SERVICE,
		namespace: SHELL_NAMESPACE,
		method: "kill",
		invocation: { kind: "direct" },
		parameters: [{
			name: "request",
			wire: "request",
			source: "json",
			codec: {
				mode: "strict",
				typeSymbol: "dsh-session-shell#KillShellRequest",
				schema: { parse(value) {
					if (!isRecord(value)) throw new TypeError("kill request must be a plain object");
					const { shellId } = value;
					if (!isId(shellId)) throw new TypeError("kill request shellId must be a non-empty id string");
					return { shellId };
				} }
			}
		}],
		result: {
			mode: "strict",
			typeSymbol: "dsh-session-shell#ShellState",
			schema: stateResultSchema
		}
	}
];
//#endregion
//#region src/index.ts
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
const name = "session-shell";
/** Services that must be mounted before this plugin runs. */
const inject = ["sessions", "typert"];
const Config = Schema.object({
	enabled: Schema.boolean().default(true),
	shell: Schema.string().default("")
});
/** Empty model for the Typert contribution: no generated reflection is claimed. */
const EMPTY_MODEL = {
	services: [],
	events: [],
	objects: []
};
/**
* Mount the session-shell plugin.
* @param ctx - the host context.
* @param config - resolved plugin config (the loader passes the fully resolved value).
*/
async function apply(ctx, config) {
	const manager = new SessionShellManager(ctx, await resolveShellExecutable(config.shell));
	ctx.on("session/disposed", (session) => {
		manager.dispose(session.id);
	});
	ctx.effect(() => () => manager.disposeAll(), "dsh-session-shell: dispose shells");
	const receiver = {
		typertRemote: void 0,
		spawn(request) {
			if (!config.enabled) throw new ShellSpawnError("shell-disabled", "shell-disabled: the session shell is disabled in plugin configuration");
			return manager.spawn(request);
		},
		read: (request) => manager.read(request),
		write: (request) => manager.write(request),
		resize: (request) => manager.resize(request),
		kill: (request) => manager.kill(request)
	};
	receiver.typertRemote = bindTypertRemote(receiver, SHELL_SERVICE, { namespace: SHELL_SERVICE });
	ctx.provide(SHELL_SERVICE, receiver);
	const contribution = {
		package: "dsh-session-shell",
		face: "host",
		schemas: [],
		model: EMPTY_MODEL,
		invocations: SHELL_DESCRIPTORS
	};
	ctx.typert.register(contribution);
}
//#endregion
export { Config, SessionShellManager, ShellSpawnError, apply, inject, name, resolveShellExecutable };
