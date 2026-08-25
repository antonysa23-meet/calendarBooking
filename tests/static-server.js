// Minimal static file server for local review of frontend/.
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', 'frontend');
const types = { '.html':'text/html', '.css':'text/css', '.js':'text/javascript',
                '.svg':'image/svg+xml', '.json':'application/json' };
http.createServer((req, res) => {
  let file = decodeURIComponent(req.url.split('?')[0]);
  if (file === '/') file = '/index.html';
  const full = path.join(root, file);
  if (!full.startsWith(root) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404, {'Content-Type':'text/html'});
    return res.end(fs.existsSync(path.join(root,'404.html')) ? fs.readFileSync(path.join(root,'404.html')) : 'not found');
  }
  res.writeHead(200, {'Content-Type': types[path.extname(full)] || 'application/octet-stream'});
  fs.createReadStream(full).pipe(res);
}).listen(8080, () => console.log('serving frontend/ on http://localhost:8080'));
