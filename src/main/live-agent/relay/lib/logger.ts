/**
 * Tagged logger for the relay. It runs in a worker thread, where console
 * output is lost: warnings and errors go to the sink the worker sets (posted
 * to the main process, which writes them to the app log); info lines are only
 * kept while debugging.
 */

type LogLevel = 'info' | 'warn' | 'error'
type LogSink = (level: LogLevel, message: string) => void

let sink: LogSink = () => {}

/** Where log lines go (see relay-worker.ts) */
export function setLogSink(next: LogSink) {
  sink = next
}

function format(args: unknown[]): string {
  return args.map(arg => arg instanceof Error ? arg.message : typeof arg === 'string' ? arg : String(arg)).join(' ')
}

/** Create a tagged logger for a specific module */
export function createLogger(tag: string) {
  const prefix = `[LiveAgent:${tag}]`
  return {
    info(...args: unknown[]) { sink('info', `${prefix} ${format(args)}`) },
    warn(...args: unknown[]) { sink('warn', `${prefix} ${format(args)}`) },
    error(...args: unknown[]) { sink('error', `${prefix} ${format(args)}`) },
  }
}
