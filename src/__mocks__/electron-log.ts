/**
 * electron-log stand-in for tests.
 *
 * electron-log's main entry requires the real `electron` package, which resolves to the
 * installed Electron binary. CI installs with `npm ci --ignore-scripts`, so that binary isn't
 * there and the require throws ("Electron failed to install correctly"), taking down every
 * test whose imports reach `app-logger`. Vitest aliases `electron-log/main.js` here, so logging
 * through `appLog` works in tests without Electron installed. A test that asserts on log calls
 * still mocks `electron-log/main.js` itself.
 */

type LogFn = (...args: unknown[]) => void;

const noop: LogFn = () => undefined;

export default {
  initialize: noop,
  transports: {
    file: {
      maxSize: 10 * 1024 * 1024,
      format: '',
      fileName: 'main.log',
      level: 'info',
      getFile: () => ({ path: '' })
    },
    console: {
      level: 'warn',
      format: '',
      writeFn: noop
    }
  },
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  verbose: noop,
  silly: noop,
  log: noop
};
