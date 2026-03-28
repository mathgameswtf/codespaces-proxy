// server.js
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import zlib from 'zlib';

const app = express();
const PORT = 3000;

// Serve the service worker at root scope
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.send(`
    self.addEventListener('fetch', event => {
      const url = event.request.url;
      const proxyBase = self.location.origin + '/proxy/';

      // Don't re-proxy requests already going through /proxy/
      if (url.startsWith(proxyBase)) return;

      // Don't proxy same-origin non-proxy requests (sw.js, __inject.js, etc.)
      if (url.startsWith(self.location.origin)) return;

      // Reroute everything else through the proxy
      const proxiedUrl = proxyBase + url;
      const newRequest = new Request(proxiedUrl, {
        method: event.request.method,
        headers: event.request.headers,
        body: event.request.method !== 'GET' && event.request.method !== 'HEAD'
          ? event.request.body
          : undefined,
        redirect: 'follow',
      });

      event.respondWith(fetch(newRequest));
    });
  `);
});

// Inject service worker registration into every HTML page
app.get('/__inject.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(reg => {
        // If SW was just installed, reload so it can intercept immediately
        if (reg.installing) {
          reg.installing.addEventListener('statechange', e => {
            if (e.target.state === 'activated') location.reload();
          });
        }
      });
    }
  `);
});

function rewriteHtml(html, targetBase) {
  // Rewrite static URLs as a first pass (helps before SW activates)
  let rewritten = html
    .replace(/(href|src|action|data-src)="(https?:\/\/[^"]+)"/g, (_, attr, url) => {
      return `${attr}="/proxy/${url}"`;
    })
    .replace(/(href|src|action|data-src)="(\/\/[^"]+)"/g, (_, attr, rest) => {
      return `${attr}="/proxy/https:${rest}"`;
    })
    .replace(/(href|src|action|data-src)="(\/[^/"][^"]*)"/g, (_, attr, path) => {
      return `${attr}="/proxy/${targetBase}${path}"`;
    });

  // Inject service worker script into <head>
  rewritten = rewritten.replace(
    /<head([^>]*)>/i,
    `<head$1><script src="/__inject.js"></script>`
  );

  return rewritten;
}

function makeProxy(targetBase, targetPath) {
  return createProxyMiddleware({
    target: targetBase,
    changeOrigin: true,
    selfHandleResponse: true,
    pathFilter: () => true,
    on: {
      proxyReq: (proxyReq) => {
        proxyReq.path = targetPath;
      },
      proxyRes: (proxyRes, req, res) => {
        delete proxyRes.headers['content-security-policy'];
        delete proxyRes.headers['x-frame-options'];
        delete proxyRes.headers['x-content-type-options'];

        // Follow redirects: if the upstream redirects, rewrite Location header
        if (proxyRes.headers['location']) {
          const loc = proxyRes.headers['location'];
          if (/^https?:\/\//.test(loc)) {
            proxyRes.headers['location'] = `/proxy/${loc}`;
          } else if (loc.startsWith('/')) {
            proxyRes.headers['location'] = `/proxy/${targetBase}${loc}`;
          }
        }

        const contentType = proxyRes.headers['content-type'] || '';
        const isHtml = contentType.includes('text/html');
        const encoding = proxyRes.headers['content-encoding'];

        if (!isHtml) {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
          return;
        }

        delete proxyRes.headers['content-encoding'];
        delete proxyRes.headers['content-length'];
        res.writeHead(proxyRes.statusCode, proxyRes.headers);

        const chunks = [];
        proxyRes.on('data', chunk => chunks.push(chunk));
        proxyRes.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const decompress = (buf, cb) => {
            if (encoding === 'gzip') zlib.gunzip(buf, cb);
            else if (encoding === 'br') zlib.brotliDecompress(buf, cb);
            else if (encoding === 'deflate') zlib.inflate(buf, cb);
            else cb(null, buf);
          };
          decompress(buffer, (err, decoded) => {
            if (err) { res.end(buffer); return; }
            res.end(rewriteHtml(decoded.toString('utf8'), targetBase));
          });
        });
      }
    }
  });
}

app.use('/proxy', (req, res, next) => {
  const raw = req.url.slice(1);
  let targetBase, targetPath;

  if (/^https?:\/\//.test(raw)) {
    try {
      const url = new URL(raw);
      targetBase = `${url.protocol}//${url.host}`;
      targetPath = url.pathname + url.search;
    } catch {
      return res.status(400).send('Invalid proxy URL');
    }
  } else {
    targetBase = 'https://duckduckgo.com';
    targetPath = '/' + raw;
  }

  makeProxy(targetBase, targetPath)(req, res, next);
});

app.get('/', (req, res) => {
  res.redirect('/proxy/https://duckduckgo.com');
});

app.listen(PORT, () => {
  console.log(`Proxy server running on http://localhost:${PORT}`);
});