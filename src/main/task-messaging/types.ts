/**
 * Task messaging types: messages between parallel tasks and Workbench notices.
 */

/** Who wrote a message */
export interface MessageSender {
  kind: 'task' | 'workbench' | 'user';
  /** kind task: the sending task */
  specId?: string;
  title?: string;
  sessionName?: string;
}

/** A message for a task, as its inbox (`<specDir>/task_inbox.json`) keeps it */
export interface TaskMessage {
  /** `wbm-<hex>`; also the marker id of the stdin message that carries it */
  id: string;
  /** ISO time it was sent */
  at: string;
  from: MessageSender;
  text: string;
  /**
   * queued: waits for the task's next step; sent: written to the running session, not read yet;
   * read: the session read it
   */
  status: 'queued' | 'sent' | 'read';
  readAt?: string;
  /**
   * What a Workbench notice is about, so it can be dropped once it is out of date (a "started"
   * notice for a task that has finished since). Absent on older inbox files and on other messages.
   */
  about?: MessageAbout;
}

/** The task event a notice announces */
export interface MessageAbout {
  specId: string;
  event: 'started';
}

/** What happened to a message, in plain words for the sender */
export interface DeliveryOutcome {
  status: 'delivered' | 'queued' | 'refused';
  /** "delivered: ...", "queued: ...", "not sent: ..." */
  detail: string;
  messageId?: string;
}

/** Workbench MCP server entry of a phase's `--mcp-config` */
export type MessagingMcpServer =
  | { type: 'http'; url: string; headers: Record<string, string> }
  | { type: 'stdio'; command: string; args: string[]; env: Record<string, string> };

/**
 * A task run's link to the broker (created by the AgentManager, used by ClaudeTaskRun). Every
 * phase whose process keeps stdin open attaches while it runs.
 */
export interface TaskRunMessaging {
  /** The session's `--name` */
  sessionName: string;
  /** The Workbench MCP server for a phase (support files go in `tempDir`); undefined: no tools */
  mcpServer: (tempDir: string) => Promise<MessagingMcpServer | undefined>;
  /** Messages the task got while it was not running, for the phase's first prompt */
  takeInbox: () => Promise<TaskMessage[]>;
  /** The phase's first prompt (with those messages) was read */
  markRead: (ids: string[]) => void;
  /**
   * A phase process with open stdin started: messages for the task go to `send` from now on, as
   * do messages queued since `takeInbox` that are not in `inPrompt` (the ids its prompt carries).
   * Returns the function to call when the process ended, with the ids it never read.
   */
  attach: (send: (text: string, id: string) => string | false, inPrompt?: string[]) => (unreadIds: string[]) => void;
  /** The session read a message written to its stdin */
  inputRead: (id: string) => void;
  /** A native message from another session (`origin.kind === 'peer'`) showed up in the stream */
  peerMessage: (msgId: string | undefined) => void;
  /** The session used native SendMessage (`toolResult`: the tool's `tool_use_result`) */
  nativeSend: (to: string, text: string, toolResult: unknown, isError: boolean) => void;
  /** The run ended: its tools stop working */
  dispose: () => void;
}
