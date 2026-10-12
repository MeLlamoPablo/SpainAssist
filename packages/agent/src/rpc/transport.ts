import { spawn } from 'node:child_process';
import type { AgentLaunch } from '../launch';

/**
 * How PiRpcClient talks to an agent host. The default spawns a child process and speaks JSONL
 * over stdio. Kept behind this interface so a hardened build (Electron `runAsNode` fuse off) can
 * plug in a `utilityProcess.fork` transport without touching the client.
 */
export interface RpcTransport {
  readonly pid?: number;
  /** Write raw protocol text (one or more JSONL records). */
  write(data: string): void;
  /** Close the host's input: pi shuts down gracefully when stdin ends. */
  closeInput(): void;
  kill(signal?: NodeJS.Signals): void;
  onStdout(listener: (chunk: string) => void): void;
  onStderr(listener: (chunk: string) => void): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  onError(listener: (error: Error) => void): void;
}

export type RpcTransportFactory = (launch: AgentLaunch) => RpcTransport;

export const spawnTransport: RpcTransportFactory = (launch) => {
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const errorListeners: ((error: Error) => void)[] = [];
  // Writes after the child died raise EPIPE on stdin: report, never crash the app.
  child.stdin.on('error', (error) => {
    for (const listener of errorListeners) listener(error);
  });
  return {
    get pid() {
      return child.pid;
    },
    write(data) {
      if (child.stdin.writable) child.stdin.write(data);
    },
    closeInput() {
      if (!child.stdin.destroyed) child.stdin.end();
    },
    kill(signal = 'SIGTERM') {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    },
    onStdout(listener) {
      child.stdout.on('data', listener);
    },
    onStderr(listener) {
      child.stderr.on('data', listener);
    },
    onExit(listener) {
      child.on('exit', (code, signal) => listener(code, signal));
    },
    onError(listener) {
      errorListeners.push(listener);
      child.on('error', listener);
    },
  };
};
