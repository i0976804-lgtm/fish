// 최소 정적 파일 서버 (빌드 의존성 없음 · 로컬 미리보기 전용)
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8779;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json'
};

http.createServer((req, res) => {
  // 미리보기 검증용: 브라우저가 렌더한 PNG 를 디스크에 저장 (개발 전용)
  if (req.method === 'POST' && req.url.startsWith('/_save')) {
    const name = (new URL(req.url, 'http://x')).searchParams.get('name') || 'out.png';
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const b64 = Buffer.concat(chunks).toString('utf8').replace(/^data:image\/png;base64,/, '');
      fs.writeFile(path.join(__dirname, '_dbg_' + name), Buffer.from(b64, 'base64'), (e) => {
        res.writeHead(e ? 500 : 200); res.end(e ? 'err' : 'ok');
      });
    });
    return;
  }
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}).listen(PORT, () => console.log('serving on http://localhost:' + PORT));
