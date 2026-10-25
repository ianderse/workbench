// Waits until nothing listens on a local TCP port, so a dev restart does not start Electron while
// the previous instance (still stopping its agents) holds the remote debugging port: Chromium then
// starts without it, silently. Gives up after a while and lets the launch go on anyway.
// Usage: node scripts/wait-for-free-port.mjs <port> [timeoutSeconds]
import net from 'node:net';

const port = Number(process.argv[2]);
const timeoutMs = Number(process.argv[3] ?? 30) * 1000;

const inUse = () =>
  new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

const deadline = Date.now() + timeoutMs;
let told = false;
while (await inUse()) {
  if (Date.now() > deadline) {
    console.warn(`[dev] Port ${port} is still in use; starting anyway, so remote debugging may be off`);
    break;
  }
  if (!told) {
    console.log(`[dev] Waiting for port ${port} (a previous instance is still stopping)...`);
    told = true;
  }
  await new Promise((r) => setTimeout(r, 500));
}
