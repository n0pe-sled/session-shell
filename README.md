# dsh-session-shell

A dsh bundle that adds a **Shell** tab to every session in the web GUI: an
interactive PTY terminal that runs in the session's working directory, with
keys sent to the shell on the host exactly like a real terminal.

## What it does

- New tab in each session's view ring (`'conversation.view'` slot, after Chat
  and Trajectory).
- On first open of the tab, the host spawns **one interactive shell per
  session** (node-pty, `TERM=xterm-256color`) in the session's canonical
  project directory (`SessionHeader.cwd`).
- The shell keeps running while you switch tabs; returning to the tab replays
  the retained scrollback. Each session gets its own shell.
- Input is delivered verbatim, so Ctrl-C, arrows, job control, and full-screen
  TUIs behave normally.
- Killing or restarting is one click (top-right of the tab); a closed session
  (or plugin unload) terminates its shell automatically.

## Install

```sh
dsh plugin --profile web add /path/to/session-shell
# restart the GUI: dsh web
```

The bundle uses `@deepseek-ai` peers (cordis, dsh-session, dsh-subprocess,
`dsh-typert-protocol/registry`) resolved through the profile fallback, and
`node-pty` as a peer (already present via `dsh-subprocess-local`). xterm.js
is bundled into `lib/client.js`, so no extra browser assets are served.

## Configuration

| key       | default | meaning                                          |
|-----------|---------|--------------------------------------------------|
| `enabled` | `true`  | host-side switch; `false` refuses `spawn`        |
| `shell`   | `''`    | shell binary (absolute path or PATH name); empty = `$SHELL` / `/bin/bash` |

Example profile layer override (`$DSH_HOME/cordis.patch.yml`):

```yaml
- id: session-shell
  name: dsh-session-shell
  config:
    shell: /bin/zsh
```

## Architecture

- **Host half** (`src/index.ts`, `src/shell-manager.ts`): a Typert receiver
  (`sessionShell`) registered with `ctx.typert` — the web gateway dispatches
  `/api/sessionShell/{spawn,read,write,resize,kill}` to it. PTYs live in a
  per-session registry keyed by session id; output accumulates into a bounded
  buffer read cursor-style (`read(cursor)`); a trim at ~1 MiB asks the browser
  to replay from a reset.
- **Browser half** (`src/client/`): registers the tab and mounts the
  descriptors with `ctx.remote.$mount`; the component renders `@xterm/xterm`
  (bundled) and polls `read` every 120 ms while mounted.
- Environment hygiene: the shell inherits the subprocess seam's
  **scrubbed** parent environment (`scrubbedParentEnv`) plus `TERM`,
  `COLORTERM`, `DSH_SHELL`, `DSH_SESSION_ID` — LLM credentials never reach the
  interactive shell.

## Security notes

The shell runs as the dsh host process user with full filesystem and network
access on the host (it is a human terminal, not a model tool — it bypasses
`dsh-bash-sandbox` confinement). Only people who already have access to the
web GUI can use it. Disable globally with `enabled: false` if that is too
broad for a deployment.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm run build
node tests/smoke.mjs
node tests/integration.mjs   # real node-pty shell round-trip
```

To regenerate the vendored xterm stylesheet after upgrading `@xterm/xterm`:
remit `src/client/xterm-css.ts` from `node_modules/@xterm/xterm/css/xterm.css`
(backtick-free template literal).
