const originalEmit = process.emit;
process.emit = function (name, warning, ...args) {
  if (
    name === 'warning' &&
    warning?.name === 'DeprecationWarning' &&
    warning?.message?.includes('util._extend')
  ) return false;
  return originalEmit.call(this, name, warning, ...args);
};

import express from 'express';
import zlib from 'zlib';
import https from 'https';
import http from 'http';

const app = express();
const PORT = 3000;
app.use(express.static('public'));
const cookieJar = new Map();
function serverFetch(targetUrl, reqHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const headers = Object.fromEntries(
      Object.entries(reqHeaders).filter(([k]) =>
        !['host', 'connection', 'transfer-encoding', 'te'].includes(k.toLowerCase())
      )
    );
    headers['host'] = url.host;

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
  const encodedBase = targetBase.replace('://', '/');

  return html
    .replace(/(href|src|action|data-src)="(https?:\/\/[^"]+)"/g, (_, attr, url) =>
      `${attr}="/proxy/${url.replace('://', '/')}"`
    )
    .replace(/(href|src|action|data-src)="(\/\/[^"]+)"/g, (_, attr, rest) =>
      `${attr}="/proxy/https${rest}"`
    )
    .replace(/(href|src|action|data-src)="(\/[^/"][^"]*)"/g, (_, attr, path) =>
      `${attr}="/proxy/${encodedBase}${path}"`
    )
    .replace(/srcset="([^"]+)"/g, (_, srcset) => {
      const rewritten = srcset.replace(/(https?:\/\/[^\s,]+)/g, url =>
        '/proxy/' + url.replace('://', '/')
      );
      return `srcset="${rewritten}"`;
    })
    .replace(/<link[^>]+rel="preload"[^>]*>/gi, '')
    .replace(/<head([^>]*)>/i, `<head$1><script src="/__inject.js"></script>`);
}

app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.send(`
    self.addEventListener('fetch', event => {
      const url = event.request.url;
      const origin = self.location.origin;

      // Skip anything going to our own server
      if (url.startsWith(origin)) return;
      if (url.indexOf('http') !== 0) return;

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

    const proxyBase = window.location.origin + '/proxy/';
    const absPattern = /^https?:\\/\\//;
    const protoRelPattern = /^\\/\\//;

    function proxyUrl(url) {
      if (!url || typeof url !== 'string') return url;
      if (url.startsWith(proxyBase)) return url;
      if (url.startsWith('javascript:') || url.startsWith('data:') || url.startsWith('#')) return url;
      if (absPattern.test(url)) return proxyBase + url.replace('://', '/');
      if (protoRelPattern.test(url)) return proxyBase + 'https' + url;
      if (url.startsWith('/')) {
        // Extract current proxied origin from pathname e.g. /proxy/https/duckduckgo.com/...
        const match = window.location.pathname.match(/^\\/proxy\\/(https?[/][^/]+)/);
        const origin = match ? match[1] : 'https/duckduckgo.com';
        return proxyBase + origin + url;
      }
      return url;
    }

    // Patch fetch
    const origFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (typeof input === 'string') input = proxyUrl(input);
      else if (input instanceof Request) input = new Request(proxyUrl(input.url), input);
      return origFetch(input, init);
    };

    // Patch XHR
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      return origOpen.call(this, method, proxyUrl(String(url)), ...rest);
    };

    // Patch history — guard against double-proxying
    const origPush = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);
    history.pushState = (s, t, url) => {
      if (url) url = proxyUrl(url);
      return origPush(s, t, url);
    };
    history.replaceState = (s, t, url) => {
      if (url) url = proxyUrl(url);
      return origReplace(s, t, url);
    };

    // Patch location
    const origAssign = window.location.assign.bind(window.location);
    const origLocReplace = window.location.replace.bind(window.location);
    window.location.assign = url => origAssign(proxyUrl(url));
    window.location.replace = url => origLocReplace(proxyUrl(url));
    try {
      Object.defineProperty(window.location, 'href', {
        set(url) { origAssign(proxyUrl(url)); },
        get() { return window.location.toString(); }
      });
    } catch(e) {}

    // Intercept dynamically created elements
    const origCreateElement = document.createElement.bind(document);
    document.createElement = function(tag, ...args) {
      const el = origCreateElement(tag, ...args);
      const lower = tag.toLowerCase();
      const srcAttr = lower === 'link' ? 'href' : 'src';
      if (lower === 'link' || lower === 'script' || lower === 'img') {
        const proto = Object.getPrototypeOf(el);
        const descriptor = Object.getOwnPropertyDescriptor(proto, srcAttr);
        if (descriptor && descriptor.set) {
          Object.defineProperty(el, srcAttr, {
            set(val) { descriptor.set.call(el, proxyUrl(val)); },
            get() { return descriptor.get.call(el); },
            configurable: true,
          });
        }
      }
      return el;
    };

    // Intercept setAttribute
    const origSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value) {
      if ((name === 'href' || name === 'src' || name === 'action') && typeof value === 'string') {
        value = proxyUrl(value);
      }
      return origSetAttribute.call(this, name, value);
    };

    // Link clicks
    document.addEventListener('click', e => {
      const a = e.target.closest('a[href]');
      if (!a) return;
      const href = a.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
      if (absPattern.test(href) || protoRelPattern.test(href)) {
        e.preventDefault();
        e.stopPropagation();
        window.location.assign(proxyUrl(href));
      }
    }, true);

    // Form submissions
    document.addEventListener('submit', e => {
      const form = e.target;
      const action = form.action || window.location.href;
      try {
        const url = new URL(action);
        if (url.origin !== window.location.origin) {
          e.preventDefault();
          e.stopPropagation();
          const params = new URLSearchParams(new FormData(form)).toString();
          const sep = action.includes('?') ? '&' : '?';
          window.location.assign(proxyUrl(action + sep + params));
        }
      } catch(e) {}
    }, true);
  `);
});

app.use('/proxy', async (req, res) => {
  const raw = req.url.slice(1); // strip leading /
  const normalized = raw.replace(/^(https?)\/(?!\/)/, '$1://');

  let targetUrl;
  try {
    new URL(normalized);
    targetUrl = normalized;
  } catch {
    return res.status(400).send('Invalid proxy URL');
  }

  // Guard: if the resolved target contains /proxy/https/ it got double-encoded
  // Strip the extra wrapping and redirect cleanly
  const doubleProxy = targetUrl.match(/^https?:\/\/[^/]+\/proxy\/(https?\/.*)/);
  if (doubleProxy) {
    const cleaned = '/proxy/' + doubleProxy[1];
    console.log(`[DOUBLE-PROXY FIX] ${targetUrl} → ${cleaned}`);
    return res.redirect(302, cleaned);
  }

  console.log(`[PROXY] ${req.method} ${targetUrl}`);

  try {
    const proxyRes = await serverFetch(targetUrl, req.headers);
    const headers = { ...proxyRes.headers };

    delete headers['content-security-policy'];
    delete headers['x-frame-options'];
    delete headers['x-content-type-options'];

    if (headers['location']) {
      const loc = headers['location'];
      const absolute = /^https?:\/\//.test(loc)
        ? loc
        : loc.startsWith('/')
          ? `${new URL(targetUrl).origin}${loc}`
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



// Update catch-all to not assume duckduckgo
app.use((req, res) => {
  const path = req.url;
  if (
    path.startsWith('/proxy') ||
    path === '/sw.js' ||
    path === '/__inject.js' ||
    path === '/'
  ) {
    return res.status(404).send('Not found');
  }
  // Don't redirect bare paths anymore — just 404
  res.status(404).send('Not found');
});

app.listen(PORT, () => console.log(`Proxy running on http://localhost:${PORT}`));