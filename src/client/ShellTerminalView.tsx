/**
 * ShellTerminalView: the per-session Shell conversation-view tab.
 *
 * Renders one @xterm/xterm terminal bound to the browser-side controller
 * ({@link SessionShellController}): lazy spawn on mount, 120ms output polling,
 * PTY input verbatim, fit-to-container resize, and a status strip (cwd, state,
 * restart). The PTY itself (and its output buffer) lives host-side, so the
 * shell survives tab switches: a remount replays from cursor 0 and the host
 * returns the retained scrollback.
 */

import { useEffect, useRef, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { ShellControlError, ShellState } from '../shared/remote.ts'

/** One ensure/spawn outcome as the component sees it. */
export type ShellSpawnOutcome =
  | { readonly ok: true; readonly cwd: string; readonly state: ShellState }
  | { readonly ok: false; readonly error: ShellControlError }

/** One poll outcome as the component sees it. */
export type ShellPollOutcome =
  | {
    readonly ok: true
    readonly text: string
    readonly cursor: number
    readonly truncated: boolean
    readonly state: ShellState
  }
  | { readonly ok: false; readonly error: ShellControlError }

/** Browser-side control face for one session's shell (host-backed). */
export interface SessionShellController {
  /** Spawn (or reuse) the session's shell; returns its state and cwd. */
  ensure(cols: number, rows: number): Promise<ShellSpawnOutcome>
  /** Kill the current shell, if any, then spawn a fresh one. */
  restart(cols: number, rows: number): Promise<ShellSpawnOutcome>
  /** Deliver raw PTY input (chunked and fire-and-forget safe). */
  write(data: string): void
  /** Read output after `cursor`; returns the new cursor. */
  poll(cursor: number): Promise<ShellPollOutcome>
  /** Resize the PTY (best-effort; only after a successful spawn). */
  resize(cols: number, rows: number): void
}

/** Inject face the conversation-view slot binds per session. */
export interface SessionShellViewInjected {
  control: SessionShellController
}

export type SessionShellViewProps = ConvViewProps & InjectFace<SessionShellViewInjected>

/** Terminal status strip states. */
type ShellViewStatus = 'connecting' | 'running' | 'exited' | 'error'

const POLL_MS = 120
const TERMINAL_OPTIONS = {
  cursorBlink: true,
  fontSize: 13,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  scrollback: 10_000,
  theme: {
    background: '#101418',
    foreground: '#d4d4d4',
    cursor: '#d4d4d4',
    selectionBackground: '#2f5b8c66',
  },
} as const

/**
 * Render the Shell tab for one session.
 * @param props - composed slot props (session kit + this plugin's inject face).
 */
export function ShellTerminalView({ control }: SessionShellViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const cursorRef = useRef(0)
  const timerRef = useRef<number | null>(null)
  const bootRef = useRef<(() => void) | null>(null)
  const startedRef = useRef(false)
  const [status, setStatus] = useState<ShellViewStatus>('connecting')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [cwd, setCwd] = useState<string | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    let alive = true

    const term = new Terminal({ ...TERMINAL_OPTIONS })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    termRef.current = term
    fit.fit()
    term.focus()

    // The first fit can land at a stale width: the container can still be
    // laying out and the font faces may not be loaded yet (a fallback font
    // measures a different advance). xterm only re-fits on a container resize
    // event, which may never come if the size is already final — leaving the
    // grid pinned narrower than the container (long prompts then wrap and
    // readline redraws them as confusing mid-prompt fragments). Refit once
    // the font set settles, after the next frame, and after layout settles.
    const refit = (): void => { if (alive) fit.fit() }
    if (typeof document !== 'undefined' && document.fonts !== undefined) {
      void document.fonts.ready.then(refit).catch(() => {})
    }
    const frame = window.requestAnimationFrame(refit)
    const settle = window.setTimeout(refit, 250)

    const stopPolling = (): void => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
    const startPolling = (): void => {
      stopPolling()
      timerRef.current = window.setInterval(() => { void tick() }, POLL_MS)
    }
    const tick = async (): Promise<void> => {
      if (!alive) return
      const result = await control.poll(cursorRef.current)
      if (!alive) return
      if (!result.ok) {
        stopPolling()
        setErrorMessage(result.error.message)
        setStatus('error')
        return
      }
      if (result.truncated) term.reset()
      term.write(result.text)
      cursorRef.current = result.cursor
      if (result.state.kind === 'exited') {
        stopPolling()
        setStatus('exited')
      }
    }

    const boot = async (restart: boolean): Promise<void> => {
      stopPolling()
      setErrorMessage(null)
      setCwd(null)
      setStatus('connecting')
      const outcome = restart
        ? await control.restart(term.cols, term.rows)
        : await control.ensure(term.cols, term.rows)
      if (!alive) return
      if (!outcome.ok) {
        setErrorMessage(outcome.error.message)
        setStatus('error')
        return
      }
      startedRef.current = true
      setCwd(outcome.cwd)
      cursorRef.current = 0
      term.reset()
      term.focus()
      if (outcome.state.kind === 'exited') {
        setStatus('exited')
        return
      }
      setStatus('running')
      startPolling()
    }
    bootRef.current = () => { void boot(true) }
    void boot(false)

    const dataSubscription = term.onData(data => { control.write(data) })
    const resizeSubscription = term.onResize(size => {
      if (!startedRef.current) return
      control.resize(size.cols, size.rows)
    })
    const observer = new ResizeObserver(() => {
      if (alive) fit.fit()
    })
    observer.observe(container)

    return () => {
      alive = false
      stopPolling()
      observer.disconnect()
      window.cancelAnimationFrame(frame)
      window.clearTimeout(settle)
      dataSubscription.dispose()
      resizeSubscription.dispose()
      term.dispose()
      termRef.current = null
      startedRef.current = false
      bootRef.current = null
    }
  }, [control])

  return (
    <div style={styles.root} data-conversation-composer-hidden="">
      <div style={styles.statusBar}>
        <span style={styles.statusText}>
          {cwd !== null ? cwd : status === 'connecting' ? 'Connecting…' : 'Session shell'}
        </span>
        <span style={status === 'running' ? styles.running : styles.stopped}>
          {status === 'running' ? '●' : status === 'exited' ? '■' : status === 'error' ? '!' : '…'}
        </span>
        {status === 'error' || status === 'exited' ? (
          <button
            type="button"
            style={styles.restartButton}
            onClick={() => { bootRef.current?.() }}
          >
            Restart
          </button>
        ) : null}
      </div>
      {errorMessage !== null ? (
        <div style={styles.error} title={errorMessage}>{errorMessage}</div>
      ) : null}
      <div ref={containerRef} style={styles.terminal} />
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    background: '#101418',
  },
  statusBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '4px 10px',
    fontSize: 12,
    color: '#9aa4b2',
    borderBottom: '1px solid #232a33',
    userSelect: 'none',
  },
  statusText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: '1 1 auto',
  },
  running: { color: '#4caf50' },
  stopped: { color: '#9aa4b2' },
  restartButton: {
    background: '#232a33',
    color: '#d4d4d4',
    border: '1px solid #39424e',
    borderRadius: 4,
    padding: '2px 10px',
    fontSize: 12,
    cursor: 'pointer',
  },
  error: {
    padding: '4px 10px',
    fontSize: 12,
    color: '#f2b8b5',
    background: '#2b1416',
  },
  terminal: {
    flex: '1 1 auto',
    minHeight: 0,
    padding: '6px 8px',
  },
}
