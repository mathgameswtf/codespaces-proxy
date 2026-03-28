import express from 'express';
import zlib from 'zlib';
import https from 'https';
import http from 'http';

const app = express();
const PORT = 3000;

// Cache of cookies per domain for session persistence
const cookieJar = new Map();

function serverFetch(targetUrl, reqHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    // Forward useful headers but strip host/connection
    const headers = Object.fromEntries(
      Object.entries(reqHeaders).filter(([k]) =>
        !['host', 'connection', 'transfer-encoding', 'te'].includes(k.toLowerCase())
      )
    );
    headers['host'] = url.host;

    // Attach stored cookies for this domain
    const stored = cookieJar.get(url.host);
    if (stored) headers['cookie'] = stored;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers,
      timeout: 10000,
    };

    const proxyReq = lib.request(options, (proxyRes) => {
      // Store cookies
      const setCookie = proxyRes.headers['set-cookie'];
      if (setCookie) {
        const existing = cookieJar.get(url.host) || '';
        const newCookies = setCookie.map(c => c.split(';')[0]).join('; ');
        cookieJar.set(url.host, existing ? `${existing}; ${newCookies}` : newCookies);
      }

      resolve(proxyRes);
    });

    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('Timeout')); });
    proxyReq.end();
  });
}

function rewriteHtml(html, targetBase) {
  return html
    .replace(/(href|src|action|data-src)="(https?:\/\/[^"]+)"/g, (_, attr, url) => {
      return `${attr}="/proxy/${url.replace('://', '/')}"`;
    })
    .replace(/(href|src|action|data-src)="(\/\/[^"]+)"/g, (_, attr, rest) => {
      return `${attr}="/proxy/https${rest}"`;
    })
    .replace(/(href|src|action|data-src)="(\/[^/"][^"]*)"/g, (_, attr, path) => {
      return `${attr}="/proxy/${targetBase.replace('://', '/')}${path}"`;
    })
    .replace(/<head([^>]*)>/i, `<head$1><script src="/__inject.js"></script>`);
}

app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.send(`
    self.addEventListener('fetch', event => {
      const url = event.request.url;
      const origin = self.location.origin;

      // Only intercept requests that are NOT already going to our server
      if (url.startsWith(origin)) return;
      if (!url.startsWith('http')) return;

      // Rewrite to go through our proxy (server does the actual fetch)
      const proxied = origin + '/proxy/' + url.replace('://', '/');

      event.respondWith(
        fetch(proxied, {
          method: event.request.method,
          headers: event.request.headers,
          body: event.request.method !== 'GET' && event.request.method !== 'HEAD'
            ? event.request.body
            : undefined,
          redirect: 'follow',
        })
      );
    });
  `);
});

app.get('/__inject.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(reg => {
        if (reg.installing) {
          reg.installing.addEventListener('statechange', e => {
            if (e.target.state === 'activated') location.reload();
          });
        }
      });
    }
  `);
});

app.use('/proxy', async (req, res) => {
  const raw = req.url.slice(1);
  const normalized = raw.replace(/^(https?)\/(?!\/)/, '$1://');

  let targetUrl;
  try {
    new URL(normalized); // validate
    targetUrl = normalized;
  } catch {
    return res.status(400).send('Invalid proxy URL');
  }

  try {
    const proxyRes = await serverFetch(targetUrl, req.headers);

    // Rewrite redirect location headers
    const headers = { ...proxyRes.headers };
    delete headers['content-security-policy'];
    delete headers['x-frame-options'];
    delete headers['x-content-type-options'];

    if (headers['location']) {
      const loc = headers['location'];
      const absolute = /^https?:\/\//.test(loc) ? loc
        : loc.startsWith('/') ? `${new URL(targetUrl).origin}${loc}`
        : loc;
      headers['location'] = `/proxy/${absolute.replace('://', '/')}`;
    }

    const contentType = headers['content-type'] || '';
    const isHtml = contentType.includes('text/html');
    const encoding = headers['content-encoding'];

    if (!isHtml) {
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
      return;
    }

    delete headers['content-encoding'];
    delete headers['content-length'];
    res.writeHead(proxyRes.statusCode, headers);

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
        const targetBase = new URL(targetUrl).origin;
        res.end(rewriteHtml(decoded.toString('utf8'), targetBase));
      });
    });

  } catch (err) {
    console.error(`[PROXY ERROR] ${targetUrl}:`, err.message);
    res.status(502).send(`Proxy error: ${err.message}`);
  }
});

app.get('/', (req, res) => res.redirect('/proxy/https/duckduckgo.com'));

app.listen(PORT, () => console.log(`Proxy running on http://localhost:${PORT}`));