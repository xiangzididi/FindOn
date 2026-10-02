import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Cabinet, AppError } from './lib/cabinet.js';

const root = dirname(fileURLToPath(import.meta.url));
const staticFiles = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/models-preview.svg': ['../docs/models-preview.svg', 'image/svg+xml'] };

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
        if (path.startsWith('/api/tasks/')) return json(200, cabinet.getTask(path.slice('/api/tasks/'.length)));
        if (staticFiles[path]) {
          const [name, contentType] = staticFiles[path];
          res.writeHead(200, { 'Content-Type': `${contentType}; charset=utf-8`, 'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
          return res.end(await readFile(resolve(root, 'public', name)));
        }
        throw new AppError('接口不存在', 404);
      }
      if (!['POST', 'PATCH'].includes(req.method)) throw new AppError('不支持的请求方法', 405);
      if (req.headers['x-cabinet-token'] !== token || (req.headers.origin && req.headers.origin !== `http://${host}`)) throw new AppError('请刷新本机页面后重试', 403);
      if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new AppError('请使用 JSON 请求', 415);
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8192) throw new AppError('请求过大', 413);
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new AppError('JSON 格式错误'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('请求需为 JSON 对象');
      if (req.method === 'PATCH' && /^\/api\/boxes\/B0[1-6]$/.test(path)) return json(200, cabinet.editBox(path.split('/').at(-1), body));
      if (req.method === 'POST') {
        if (/^\/api\/tasks\/[\w-]+\/confirm$/.test(path)) return json(200, cabinet.confirmTask(path.split('/')[3], body));
        if (path === '/api/tasks') return json(202, cabinet.submit(body));
        if (path === '/api/interpret') return json(200, cabinet.interpret(body.text));
        if (path === '/api/device/home') return json(202, cabinet.submit({ action: 'HOME', request_id: body.request_id }));
        if (path === '/api/device/stop') return json(200, cabinet.stop());
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await mkdir(resolve(root, 'data'), { recursive: true });
  const cabinet = new Cabinet(resolve(root, 'data/cabinet.sqlite'));
  const server = createServer(cabinet);
  const port = Number(process.env.PORT || 3210);
  server.on('error', async error => { console.error(error.message); await cabinet.close(); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`零件柜 Demo：http://127.0.0.1:${port}\n模式：模拟设备（未连接电机）\nCtrl+C 停止服务`));
  const shutdown = async () => { server.close(); await cabinet.close(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
