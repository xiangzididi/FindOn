import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const colors = [[117, 146, 122], [195, 151, 92]];
const files = ['架子.stl', '盒子及钩件.stl'];
const meshes = files.map((file, index) => {
  const data = readFileSync(resolve(root, 'models', file));
  const count = data.readUInt32LE(80);
  if (data.length !== 84 + 50 * count) throw new Error(`${file}: 需要标准二进制 STL`);
  const triangles = [];
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    const vertices = [];
    for (let j = 0; j < 3; j++) {
      const p = [0, 1, 2].map(k => data.readFloatLE(84 + 50 * i + 12 + j * 12 + k * 4));
      p.forEach((v, k) => { minimum[k] = Math.min(minimum[k], v); maximum[k] = Math.max(maximum[k], v); });
      vertices.push(p);
    }
    triangles.push({ vertices, color: colors[index] });
  }
  return { file, count, minimum, maximum, size: maximum.map((v, k) => v - minimum[k]), triangles };
});
const report = { units: 'STL does not encode units; millimetres are an unconfirmed interpretation',
  models: meshes.map(({ triangles, ...model }) => model),
  notes: ['Original meshes preserved. No second box or motion assembly invented.', 'Bounds include protrusions; they are not internal cavity sizes.'] };
const views = [
  { name: 'Front · looking along +Y', right: [1, 0, 0], up: [0, 0, 1], depth: [0, -1, 0] },
  { name: 'Side · looking along -X', right: [0, -1, 0], up: [0, 0, 1], depth: [1, 0, 0] },
  { name: 'Top · looking along -Z', right: [1, 0, 0], up: [0, 1, 0], depth: [0, 0, 1] },
  { name: 'Perspective · original placement', right: [.866, .5, 0], up: [-.25, .433, .866], depth: [.433, -.75, .5] },
];
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const panel = (view, index) => {
  const triangles = meshes.flatMap(m => m.triangles).map(triangle => {
    const p = triangle.vertices.map(v => [dot(v, view.right), -dot(v, view.up), dot(v, view.depth)]);
    const a = triangle.vertices[0], b = triangle.vertices[1], c = triangle.vertices[2];
    const u = b.map((v, i) => v - a[i]), v = c.map((n, i) => n - a[i]);
    const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(...normal) || 1;
    const light = .55 + .45 * Math.abs(dot(normal.map(v => v / length), [.25, -.55, .8]));
    return { p, depth: p.reduce((s, v) => s + v[2], 0) / 3, color: triangle.color.map(v => Math.round(v * light)) };
  }).sort((a, b) => a.depth - b.depth);
  const points = triangles.flatMap(t => t.p);
  const minX = Math.min(...points.map(p => p[0])), maxX = Math.max(...points.map(p => p[0]));
  const minY = Math.min(...points.map(p => p[1])), maxY = Math.max(...points.map(p => p[1]));
  const scale = Math.min(480 / (maxX - minX), 260 / (maxY - minY));
  const x0 = index % 2 * 560 + 30, y0 = Math.floor(index / 2) * 380 + 80;
  const polygons = triangles.map(t => `<polygon points="${t.p.map(p => `${((p[0] - minX) * scale).toFixed(2)},${((p[1] - minY) * scale).toFixed(2)}`).join(' ')}" fill="rgb(${t.color.join(',')})"/>`).join('');
  return `<g transform="translate(${x0},${y0})"><text y="0" font-size="16" fill="#314838">${view.name}</text><g transform="translate(12,36)">${polygons}</g></g>`;
};
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="850" viewBox="0 0 1120 850"><rect width="1120" height="850" fill="#f3f5f1"/><g font-family="Arial,sans-serif"><text x="30" y="35" font-size="23" fill="#314838">STL inspection · one rack + original box/hook mesh</text><text x="30" y="59" font-size="13" fill="#65756b">Green: rack / amber: box. Orthographic views; STL units unspecified. Original files unchanged.</text>${views.map(panel).join('')}<text x="30" y="820" font-size="13" fill="#65756b">Rack bounds: 157 × 49.90 × 62.90 | Box + hook bounds: 70 × 51.40 × 53 | XYZ file coordinates</text></g></svg>`;
mkdirSync(resolve(root, 'docs'), { recursive: true });
writeFileSync(resolve(root, 'docs/models-analysis.json'), JSON.stringify(report, null, 2) + '\n');
writeFileSync(resolve(root, 'docs/models-preview.svg'), svg);
console.log(JSON.stringify(report, null, 2));
