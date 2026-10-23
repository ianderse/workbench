// Workbench task tools bridge (stdio MCP server <-> Workbench's local HTTP MCP server)
//
// Claude Code inside WSL2 with NAT networking can't reach the app's task tools server on the
// Windows 127.0.0.1 (see task-tools-server.ts), but it can start Windows programs (WSL interop).
// So it starts Workbench's own executable as Node (ELECTRON_RUN_AS_NODE=1) with this script as
// a stdio MCP server: a Windows process, which reaches 127.0.0.1 and relays every JSON-RPC
// message between its stdin/stdout (newline-delimited, MCP stdio transport) and the server
// (MCP Streamable HTTP: JSON or SSE responses, 202 for notifications).
//
// WORKBENCH_TASK_TOOLS_URL: the server's URL; WORKBENCH_TASK_TOOLS_TOKEN: the chat turn's
// bearer token (in the environment, so it isn't in the process list). Plain Node, no packages.
'use strict';
const http = require('http');

const target = process.env.WORKBENCH_TASK_TOOLS_URL || '';
const token = process.env.WORKBENCH_TASK_TOOLS_TOKEN || '';

/** Mcp-Session-Id and MCP-Protocol-Version, sent back once the server gave them */
let sessionId = '';
let protocolVersion = '';
/** POSTs not answered yet, and whether stdin ended: the bridge exits once both are done */
let pending = 0;
let inputEnded = false;

function exitWhenIdle() {
  if (inputEnded && pending <= 0) process.exit(0);
}

function write(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

/** The requests (not notifications or responses) among the messages of one POST */
function requestsOf(payload) {
  return (Array.isArray(payload) ? payload : [payload])
    .filter((m) => m && typeof m === 'object' && typeof m.method === 'string' && m.id !== undefined && m.id !== null);
}

/** Answer each request of a failed POST with a JSON-RPC error, so Claude Code isn't left waiting */
function fail(payload, text) {
  for (const request of requestsOf(payload)) {
    write({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: text } });
  }
}

/** Write one message (or batch) from the server; note the protocol version initialize agreed on */
function deliver(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
    const result = message && message.result;
    if (result && typeof result.protocolVersion === 'string' && result.serverInfo) protocolVersion = result.protocolVersion;
    write(message);
  }
}

/** Server-sent events: the data lines of each event make up one JSON-RPC message */
function readEventStream(response, done) {
  let buffer = '';
  const flush = (block) => {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data) deliver(data);
  };
  response.setEncoding('utf8');
  response.on('data', (chunk) => {
    buffer += chunk;
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      flush(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
    }
  });
  response.on('end', () => {
    if (buffer.trim()) flush(buffer);
    done();
  });
  response.on('error', done);
}

function post(line, payload) {
  const body = Buffer.from(line, 'utf8');
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'Content-Length': body.length,
    Authorization: `Bearer ${token}`,
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion;

  pending += 1;
  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    pending -= 1;
    exitWhenIdle();
  };
  const unreachable = (error) => {
    if (!settled) fail(payload, `Workbench task tools are unreachable (${error.message})`);
    done();
  };

  let request;
  try {
    request = http.request(target, { method: 'POST', headers });
  } catch (error) {
    unreachable(error);
    return;
  }
  request.on('response', (response) => {
    const id = response.headers['mcp-session-id'];
    if (typeof id === 'string' && id) sessionId = id;
    const status = response.statusCode || 0;
    const ok = status >= 200 && status < 300;
    if (ok && String(response.headers['content-type'] || '').includes('text/event-stream')) {
      readEventStream(response, done);
      return;
    }
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (ok) {
        if (text.trim()) deliver(text);
      } else {
        fail(payload, `Workbench task tools answered ${status}${text ? `: ${text.slice(0, 500)}` : ''}`);
      }
      done();
    });
    response.on('error', done);
  });
  request.on('error', unreachable);
  request.end(body);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf('\n')) !== -1) {
    const line = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (!line) continue;
    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    post(line, payload);
  }
});
// Claude Code closes stdin when the session ends; answers still on their way are written first
process.stdin.on('end', () => {
  inputEnded = true;
  exitWhenIdle();
});
