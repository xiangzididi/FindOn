import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, extname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Cabinet, AppError } from './lib/cabinet.js';
import { SimulatedDevice, UsbSerialDevice } from './lib/device.js';
import { PythonSerialTransport } from './lib/serial-transport.js';

const root = dirname(fileURLToPath(import.meta.url));
const publicRoot = resolve(root, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.png': 'image/png', '.woff2': 'font/woff2' };

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new AppError('请求过大', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function multipartFile(contentType, body) {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) throw new AppError('上传格式无效', 400);
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  let cursor = 0;
  while ((cursor = body.indexOf(boundary, cursor)) >= 0) {
    cursor += boundary.length;
    if (body.slice(cursor, cursor + 2).toString() === '--') break;
    if (body.slice(cursor, cursor + 2).toString() === '\r\n') cursor += 2;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), cursor);
    if (headerEnd < 0) break;
    const headers = body.slice(cursor, headerEnd).toString('utf8');
    const disposition = headers.match(/content-disposition:\s*form-data;[^\r\n]*/i)?.[0] || '';
    const field = disposition.match(/name="([^"]+)"/i)?.[1];
    const filename = disposition.match(/filename="([^"]*)"/i)?.[1];
    const next = body.indexOf(boundary, headerEnd + 4);
    if (next < 0) break;
    let dataEnd = next;
    if (body.slice(dataEnd - 2, dataEnd).toString() === '\r\n') dataEnd -= 2;
    if (field === 'file' && filename) return { filename: basename(filename), data: body.slice(headerEnd + 4, dataEnd) };
    cursor = next;
  }
  throw new AppError('没有找到上传文件', 400);
}

function pythonCandidates() {
  return [process.env.PARTGO_PYTHON,
    resolve(process.env.USERPROFILE || '', '.platformio/penv/Scripts/python.exe'),
    'python', 'py'].filter(Boolean);
}

function parseBom(filename, data) {
  const script = resolve(root, 'scripts/parse_bom.py');
  const candidates = pythonCandidates();
  const attempt = index => new Promise((resolvePromise, rejectPromise) => {
    if (index >= candidates.length) return rejectPromise(new AppError('本机未找到 BOM 解析器', 503));
    const executable = candidates[index];
    if (executable.includes('\\') && !existsSync(executable)) return resolvePromise(attempt(index + 1));
    const args = executable === 'py' ? ['-3', '-u', script, filename] : ['-u', script, filename];
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const stdout = [], stderr = [];
    let outputSize = 0, stderrSize = 0;
    child.stdout.on('data', chunk => { outputSize += chunk.length; if (outputSize <= 1024 * 1024) stdout.push(chunk); });
    child.stderr.on('data', chunk => { stderrSize += chunk.length; if (stderrSize <= 8192) stderr.push(chunk); });
    child.on('error', error => error.code === 'ENOENT' ? resolvePromise(attempt(index + 1)) : rejectPromise(error));
    child.on('exit', () => {
      try {
        const result = JSON.parse(Buffer.concat(stdout).toString('utf8'));
        if (result.error) throw new AppError(result.error, result.error === 'spreadsheet_parser_unavailable' ? 503 : 422);
        resolvePromise(result);
      } catch (error) {
        rejectPromise(error instanceof AppError ? error : new AppError(Buffer.concat(stderr).toString('utf8') || '清单解析失败', 422));
      }
    });
    child.stdin.end(data);
  });
  return attempt(0);
}

function staticTarget(pathname) {
  const aliases = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js',
    '/styles.css': 'styles.css', '/style.css': 'styles.css', '/models-preview.svg': '../docs/models-preview.svg' };
  if (aliases[pathname]) return resolve(publicRoot, aliases[pathname]);
  if (!pathname.startsWith('/assets/')) return null;
  let decoded;
  try { decoded = decodeURIComponent(pathname.slice(1)); } catch { return null; }
  const target = resolve(publicRoot, decoded);
  return target.startsWith(`${publicRoot}${sep}`) ? target : null;
}

export function createServer(cabinet) {
  const token = randomUUID();
  return http.createServer(async (req, res) => {
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };
    try {
      const host = req.headers.host;
      if (!host || !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) throw new AppError('只接受本机请求', 403);
      const url = new URL(req.url, `http://${host}`);
      const path = url.pathname;
      if (req.method === 'GET') {
        if (path === '/api/state') return json(200, { ...cabinet.snapshot(), token });
        if (path === '/api/health') return json(200, { ok: true, mode: cabinet.device.mode });
        if (path === '/api/device/status') return json(200, cabinet.snapshot().device);
        if (path.startsWith('/api/tasks/')) return json(200, cabinet.getTask(path.slice('/api/tasks/'.length)));
        const target = staticTarget(path);
        if (target) {
          const data = await readFile(target).catch(error => { if (error.code === 'ENOENT') throw new AppError('页面资源不存在', 404); throw error; });
          res.writeHead(200, { 'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy': "default-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
          return res.end(data);
        }
        throw new AppError('接口不存在', 404);
      }
      if (!['POST', 'PATCH'].includes(req.method)) throw new AppError('不支持的请求方法', 405);
      if (req.headers['x-cabinet-token'] !== token || (req.headers.origin && req.headers.origin !== `http://${host}`)) throw new AppError('请刷新本机页面后重试', 403);

      const contentType = req.headers['content-type'] || '';
      if (req.method === 'POST' && path === '/api/bom/import') {
        if (!contentType.startsWith('multipart/form-data')) throw new AppError('请上传清单文件', 415);
        const { filename, data } = multipartFile(contentType, await readBody(req, 5 * 1024 * 1024 + 256 * 1024));
        if (data.length > 5 * 1024 * 1024) throw new AppError('upload_too_large', 413);
        const result = await parseBom(filename, data);
        return json(200, { file: { name: filename, size: data.length, extension: extname(filename).toLowerCase() }, ...result });
      }

      if (!contentType.startsWith('application/json')) throw new AppError('请使用 JSON 请求', 415);
      let body;
      try { body = JSON.parse((await readBody(req, 8192)).toString('utf8')); }
      catch { throw new AppError('JSON 格式错误'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('请求需为 JSON 对象');
      if (req.method === 'PATCH' && /^\/api\/boxes\/B0[1-9]\d*$/.test(path)) return json(200, cabinet.editBox(path.split('/').at(-1), body));
      if (req.method === 'POST') {
        if (/^\/api\/tasks\/[\w-]+\/confirm$/.test(path)) return json(200, cabinet.confirmTask(path.split('/')[3], body));
        if (path === '/api/tasks') return json(202, cabinet.submit(body));
        if (path === '/api/interpret') return json(200, cabinet.interpret(body.text));
        if (path === '/api/device/reference' || path === '/api/device/home') return json(202, cabinet.submit({
          action: 'HOME', request_id: body.request_id, area_clear: body.area_clear,
          manual_reference_confirmed: body.manual_reference_confirmed }));
        if (path === '/api/device/stop') return json(200, cabinet.stop());
        if (path === '/api/device/recover') return json(200, cabinet.recoverHardware(body));
        if (path === '/api/simulation/reset') return json(200, cabinet.resetSimulation(body));
      }
      throw new AppError('接口不存在', 404);
    } catch (error) {
      if (!error.status) console.error(error);
      if (!res.headersSent) json(error.status || 500, { error: error.status ? error.message : '服务错误，请查看终端日志' });
      else res.end();
    }
  });
}

function runtimeDevice() {
  const mode = String(process.env.PARTGO_DEVICE_MODE || 'simulation').toLowerCase();
  if (!['hardware', 'usb', 'serial'].includes(mode)) return new SimulatedDevice();
  const transport = new PythonSerialTransport({
    port: process.env.PARTGO_SERIAL_PORT,
    baud: Number(process.env.PARTGO_SERIAL_BAUD || 115200),
    python: process.env.PARTGO_PYTHON,
    bridgePath: resolve(root, 'scripts/serial_bridge.py'),
  });
  const device = new UsbSerialDevice(transport);
  device.start();
  return device;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await mkdir(resolve(root, 'data'), { recursive: true });
  const device = runtimeDevice();
  const cabinet = new Cabinet(resolve(root, 'data/cabinet.sqlite'), { device,
    timeoutMs: device.mode === 'hardware' ? 240000 : 30000 });
  const server = createServer(cabinet);
  const port = Number(process.env.PORT || 3210);
  server.on('error', async error => { console.error(error.message); await cabinet.close(); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(
    `PartGo：http://127.0.0.1:${port}\n模式：${device.mode === 'hardware' ? `USB 串口 ${process.env.PARTGO_SERIAL_PORT}` : '安全模拟'}\nCtrl+C 停止服务`));
  const shutdown = async () => { server.close(); await cabinet.close(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
