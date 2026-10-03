import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

function pythonCandidates(explicit) {
  return [explicit,
    resolve(process.env.USERPROFILE || '', '.platformio/penv/Scripts/python.exe'),
    'python', 'py'].filter(Boolean);
}

export class PythonSerialTransport extends EventEmitter {
  constructor({ port, baud = 115200, python, bridgePath = resolve('scripts/serial_bridge.py'),
    reconnectMs = 2000, spawnImpl = spawn } = {}) {
    super();
    if (!port) throw new Error('USB 串口模式需要 PARTGO_SERIAL_PORT');
    this.port = port;
    this.baud = baud;
    this.python = python;
    this.bridgePath = bridgePath;
    this.reconnectMs = reconnectMs;
    this.spawnImpl = spawnImpl;
    this.ready = false;
    this.stopped = true;
    this.lastError = null;
  }

  info() {
    return { bridge_connected: this.ready, serial_port: this.port, baud: this.baud,
      bridge_error: this.lastError };
  }

  start() {
    this.stopped = false;
    this.#launch();
  }

  #launch() {
    if (this.stopped || this.child) return;
    const candidates = pythonCandidates(this.python);
    const launchNext = index => {
      if (this.stopped || this.child) return;
      if (index >= candidates.length) {
        this.lastError = '未找到可运行 pyserial 的 Python';
        this.emit('offline', new Error(this.lastError));
        this.retryTimer = setTimeout(() => this.#launch(), this.reconnectMs);
        return;
      }
      const executable = candidates[index];
      if (executable.includes('\\') && !existsSync(executable)) return launchNext(index + 1);
      const args = executable === 'py'
        ? ['-3', '-u', this.bridgePath, '--port', this.port, '--baud', String(this.baud)]
        : ['-u', this.bridgePath, '--port', this.port, '--baud', String(this.baud)];
      let child;
      try {
        child = this.spawnImpl(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch {
        launchNext(index + 1);
        return;
      }
      this.child = child;
      let stderr = '';
      let opened = false;
      child.stdout.on('data', chunk => this.emit('data', chunk));
      child.stderr.on('data', chunk => {
        stderr += chunk.toString('utf8');
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
        if (!opened && stderr.includes('PARTGO_BRIDGE_READY')) {
          opened = true;
          this.ready = true;
          this.lastError = null;
          this.emit('open');
        }
      });
      child.on('error', error => {
        this.lastError = error.message;
        if (!opened) {
          this.child = null;
          launchNext(index + 1);
        } else this.emit('error', error);
      });
      child.on('exit', (code, signal) => {
        if (this.child !== child) return;
        this.child = null;
        const wasReady = this.ready;
        this.ready = false;
        const diagnostic = stderr.trim().split(/\r?\n/).at(-1);
        this.lastError = diagnostic || `串口桥退出 (${code ?? signal ?? 'unknown'})`;
        if (wasReady) this.emit('close');
        if (!this.stopped) this.retryTimer = setTimeout(() => this.#launch(), this.reconnectMs);
      });
    };
    launchNext(0);
  }

  write(data) {
    if (!this.ready || !this.child?.stdin?.writable) throw new Error('USB 串口未连接');
    this.child.stdin.write(data);
  }

  close() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.ready = false;
    if (this.child) {
      this.child.stdin.end();
      this.child.kill();
      this.child = null;
    }
  }
}
