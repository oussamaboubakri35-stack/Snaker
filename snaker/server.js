'use strict';

/**
 * Snaker — portfolio backend.
 * Zero dependencies: only Node's built-in modules. Run with `node server.js`.
 *
 * Environment variables (all optional):
 *   PORT              default 3000
 *   ADMIN_PASSWORD    default "snaker123"  (CHANGE THIS)
 *   SESSION_SECRET    default: generated once and stored in data/secret.key
 *   NOTIFY_WEBHOOK    Discord/Slack-style webhook URL, pinged on new contact messages
 *   NODE_ENV          set to "production" when deployed behind HTTPS
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Transform, pipeline } = require('stream');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const UPLOADS = path.join(PUBLIC, 'uploads');
const DATA = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA, 'db.json');
const SECRET_FILE = path.join(DATA, 'secret.key');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'snaker123';
const NOTIFY_WEBHOOK = process.env.NOTIFY_WEBHOOK || '';
const MAX_UPLOAD = 500 * 1024 * 1024; // 500 MB
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const CATEGORIES = ['design', 'video', 'motion', 'branding'];
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const VID_EXT = new Set(['.mp4', '.webm', '.mov']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const newId = () => crypto.randomBytes(6).toString('hex');

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { tooBig = true; return; } // keep draining, don't store
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) return reject(httpError(413, 'Request too large'));
      if (!chunks.length) return resolve({});
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(data && typeof data === 'object' ? data : {});
      } catch {
        reject(httpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

/* Tiny in-memory rate limiter */
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || entry.reset < now) {
    hits.set(key, { count: 1, reset: now + windowMs });
    return false;
  }
  entry.count += 1;
  return entry.count > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
}, 10 * 60 * 1000).unref();

/* ------------------------------------------------------------------ */
/* Storage (single JSON file, atomic writes)                           */
/* ------------------------------------------------------------------ */

const defaultProfile = () => ({
  name: 'Snaker',
  headline: 'I design and edit stories that move.',
  subheadline:
    'Graphic designer and video editor. Clean visuals, sharp cuts and motion that sticks.',
  about:
    'I’m Snaker — a designer and video editor who cares about the details people feel but rarely notice: spacing, rhythm, timing, contrast.\n\nFrom brand identities and social content to full video edits and motion graphics, I build work that’s clear, modern and made to be remembered. Edit this text from the admin panel.',
  email: '',
  location: '',
  availability: 'Available for new projects',
  tools: ['Photoshop', 'Illustrator', 'Premiere Pro', 'After Effects', 'DaVinci Resolve', 'Figma'],
  socials: [],
});

const seedProjects = () => {
  const now = Date.now();
  const year = new Date().getFullYear();
  const mk = (i, title, category, description, tags) => ({
    id: newId(),
    title,
    category,
    year,
    description,
    tags,
    cover: '',
    video: '',
    embed: '',
    sample: true,
    createdAt: new Date(now - i * 1000).toISOString(),
  });
  return [
    mk(0, 'Sample: Brand launch film', 'video',
      'This is a placeholder. Upload a cover and your video (or paste a YouTube / Vimeo link) from the admin panel, then delete this sample.',
      ['Editing', 'Color']),
    mk(1, 'Sample: Identity system', 'branding',
      'This is a placeholder. Replace it with a real branding project.',
      ['Logo', 'Guidelines']),
    mk(2, 'Sample: Social motion pack', 'motion',
      'This is a placeholder. Replace it with a real motion project.',
      ['After Effects']),
    mk(3, 'Sample: Poster series', 'design',
      'This is a placeholder. Replace it with a real design project.',
      ['Poster', 'Typography']),
  ];
};

let db;
let writeQueue = Promise.resolve();

function loadDb() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(UPLOADS, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
      console.error('data/db.json is not valid JSON. Fix or delete it, then restart.');
      process.exit(1);
    }
  } else {
    db = { profile: defaultProfile(), projects: seedProjects(), messages: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  }
  db.profile = { ...defaultProfile(), ...(db.profile || {}) };
  db.projects = Array.isArray(db.projects) ? db.projects : [];
  db.messages = Array.isArray(db.messages) ? db.messages : [];
}

function saveDb() {
  writeQueue = writeQueue.then(async () => {
    const tmp = DB_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(db, null, 2));
    await fsp.rename(tmp, DB_FILE);
  });
  return writeQueue;
}

/* ------------------------------------------------------------------ */
/* Auth (signed, expiring cookie)                                      */
/* ------------------------------------------------------------------ */

function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  try {
    return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } catch {
    const s = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
    return s;
  }
}
const SECRET = loadSecret();

const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');

function makeToken() {
  const exp = String(Date.now() + SESSION_MS);
  return exp + '.' + sign(exp);
}

function validToken(token) {
  if (!token || typeof token !== 'string') return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(exp));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Number(exp) > Date.now();
}

const isAdmin = (req) => validToken(parseCookies(req).snaker_session);

function requireAdmin(req) {
  if (!isAdmin(req)) throw httpError(401, 'Please log in');
  // CSRF defence on top of SameSite=Strict: mutating calls need a custom header.
  if (req.method !== 'GET' && req.headers['x-snaker'] !== '1') {
    throw httpError(403, 'Forbidden');
  }
}

function cookieHeader(req, value, maxAgeSec) {
  const secure =
    process.env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https';
  return (
    `snaker_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}` +
    (secure ? '; Secure' : '')
  );
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function cleanUpload(value, allowedExt) {
  const v = str(value, 100);
  if (!v) return '';
  if (!/^\/uploads\/[a-f0-9]{24}\.[a-z0-9]{2,5}$/.test(v)) throw httpError(400, 'Invalid media path');
  if (!allowedExt.has(path.extname(v))) throw httpError(400, 'Wrong media type');
  return v;
}

function normalizeEmbed(input) {
  if (!input) return '';
  let url;
  try {
    url = new URL(input);
  } catch {
    throw httpError(400, 'That video link is not a valid URL');
  }
  const host = url.hostname.replace(/^www\./, '');
  let id = '';
  if (host === 'youtu.be') id = url.pathname.slice(1);
  else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v') || '';
    else if (/^\/(embed|shorts)\//.test(url.pathname)) id = url.pathname.split('/')[2] || '';
  }
  if (id && /^[\w-]{6,15}$/.test(id)) return 'https://www.youtube-nocookie.com/embed/' + id;

  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = url.pathname.match(/^\/(?:video\/)?(\d+)/);
    if (m) return 'https://player.vimeo.com/video/' + m[1];
  }
  throw httpError(400, 'Only YouTube or Vimeo links are supported');
}

function cleanProject(b) {
  const title = str(b.title, 120);
  if (!title) throw httpError(400, 'Title is required');
  if (!CATEGORIES.includes(b.category)) throw httpError(400, 'Pick a category');
  const year = Number(b.year);
  return {
    title,
    category: b.category,
    year: Number.isInteger(year) && year >= 1990 && year <= 2100 ? year : new Date().getFullYear(),
    description: str(b.description, 2000),
    tags: Array.isArray(b.tags) ? b.tags.map((t) => str(t, 24)).filter(Boolean).slice(0, 8) : [],
    cover: cleanUpload(b.cover, IMG_EXT),
    video: cleanUpload(b.video, VID_EXT),
    embed: normalizeEmbed(str(b.embed, 300)),
  };
}

function cleanProfile(b) {
  const socials = Array.isArray(b.socials)
    ? b.socials
        .map((s) => ({ label: str(s && s.label, 30), url: str(s && s.url, 300) }))
        .filter((s) => s.label && /^https?:\/\//i.test(s.url))
        .slice(0, 8)
    : [];
  const email = str(b.email, 120);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'Email looks invalid');
  return {
    name: str(b.name, 40) || 'Snaker',
    headline: str(b.headline, 120) || defaultProfile().headline,
    subheadline: str(b.subheadline, 240),
    about: str(b.about, 3000),
    email,
    location: str(b.location, 60),
    availability: str(b.availability, 60),
    tools: Array.isArray(b.tools) ? b.tools.map((t) => str(t, 30)).filter(Boolean).slice(0, 16) : [],
    socials,
  };
}

async function removeUpload(url) {
  if (typeof url === 'string' && url.startsWith('/uploads/')) {
    await fsp.unlink(path.join(UPLOADS, path.basename(url))).catch(() => {});
  }
}

const sortedProjects = () =>
  [...db.projects].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

/* ------------------------------------------------------------------ */
/* API handlers                                                        */
/* ------------------------------------------------------------------ */

function handleUpload(req, res, url) {
  return new Promise((resolve, reject) => {
    const ext = path.extname(url.searchParams.get('filename') || '').toLowerCase();
    if (!IMG_EXT.has(ext) && !VID_EXT.has(ext)) {
      return reject(httpError(400, 'Allowed files: JPG, PNG, WebP, GIF, MP4, WebM, MOV'));
    }
    if (Number(req.headers['content-length'] || 0) > MAX_UPLOAD) {
      return reject(httpError(413, 'File too large (max 500 MB)'));
    }
    const name = crypto.randomBytes(12).toString('hex') + ext;
    const dest = path.join(UPLOADS, name);
    let size = 0;
    const limiter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > MAX_UPLOAD) return cb(httpError(413, 'File too large (max 500 MB)'));
        cb(null, chunk);
      },
    });
    pipeline(req, limiter, fs.createWriteStream(dest), (err) => {
      if (err || size === 0) {
        fsp.unlink(dest).catch(() => {});
        return reject(err && err.status ? err : httpError(400, size === 0 ? 'Empty file' : 'Upload failed'));
      }
      json(res, 201, { url: '/uploads/' + name, size });
      resolve();
    });
  });
}

async function handleContact(req, res) {
  if (limited('contact:' + clientIp(req), 5, 60 * 60 * 1000)) {
    throw httpError(429, 'Too many messages. Please try again later.');
  }
  const b = await readJson(req, 20 * 1024);
  if (str(b.website, 100)) return json(res, 200, { ok: true }); // honeypot: pretend success
  const name = str(b.name, 80);
  const email = str(b.email, 120);
  const message = str(b.message, 3000);
  if (!name) throw httpError(400, 'Please enter your name');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'Please enter a valid email');
  if (message.length < 5) throw httpError(400, 'Please write a short message');

  const entry = { id: newId(), name, email, message, createdAt: new Date().toISOString() };
  db.messages.unshift(entry);
  db.messages = db.messages.slice(0, 500);
  await saveDb();

  if (NOTIFY_WEBHOOK && typeof fetch === 'function') {
    const text = `New message on Snaker from ${name} <${email}>:\n${message.slice(0, 500)}`;
    fetch(NOTIFY_WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: text, text }),
    }).catch(() => {});
  }
  json(res, 201, { ok: true });
}

async function handleLogin(req, res) {
  if (limited('login:' + clientIp(req), 10, 15 * 60 * 1000)) {
    throw httpError(429, 'Too many attempts. Try again in a few minutes.');
  }
  const b = await readJson(req, 4 * 1024);
  const a = crypto.createHash('sha256').update(String(b.password || '')).digest();
  const expected = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, expected)) throw httpError(401, 'Wrong password');
  res.setHeader('Set-Cookie', cookieHeader(req, makeToken(), SESSION_MS / 1000));
  json(res, 200, { ok: true });
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  // ---- public ----
  if (method === 'GET' && pathname === '/api/profile') return json(res, 200, db.profile);
  if (method === 'GET' && pathname === '/api/projects') return json(res, 200, sortedProjects());
  if (method === 'GET' && pathname === '/api/me') return json(res, 200, { admin: isAdmin(req) });
  if (method === 'POST' && pathname === '/api/contact') return handleContact(req, res);
  if (method === 'POST' && pathname === '/api/login') return handleLogin(req, res);
  if (method === 'POST' && pathname === '/api/logout') {
    res.setHeader('Set-Cookie', cookieHeader(req, '', 0));
    return json(res, 200, { ok: true });
  }

  // ---- admin only ----
  const isAdminRoute =
    pathname === '/api/upload' ||
    pathname === '/api/messages' ||
    pathname.startsWith('/api/messages/') ||
    pathname === '/api/projects' ||
    pathname.startsWith('/api/projects/') ||
    pathname === '/api/profile';
  if (!isAdminRoute) throw httpError(404, 'Not found');
  requireAdmin(req);

  if (method === 'POST' && pathname === '/api/upload') return handleUpload(req, res, url);

  if (method === 'POST' && pathname === '/api/projects') {
    const project = {
      id: newId(),
      ...cleanProject(await readJson(req)),
      createdAt: new Date().toISOString(),
    };
    db.projects.push(project);
    await saveDb();
    return json(res, 201, project);
  }

  let m = pathname.match(/^\/api\/projects\/([a-f0-9]+)$/);
  if (m) {
    const idx = db.projects.findIndex((p) => p.id === m[1]);
    if (idx === -1) throw httpError(404, 'Project not found');
    const old = db.projects[idx];
    if (method === 'PUT') {
      const next = { ...old, ...cleanProject(await readJson(req)), sample: false };
      db.projects[idx] = next;
      await saveDb();
      if (old.cover !== next.cover) await removeUpload(old.cover);
      if (old.video !== next.video) await removeUpload(old.video);
      return json(res, 200, next);
    }
    if (method === 'DELETE') {
      db.projects.splice(idx, 1);
      await saveDb();
      await removeUpload(old.cover);
      await removeUpload(old.video);
      return json(res, 200, { ok: true });
    }
  }

  if (method === 'PUT' && pathname === '/api/profile') {
    db.profile = cleanProfile(await readJson(req));
    await saveDb();
    return json(res, 200, db.profile);
  }

  if (method === 'GET' && pathname === '/api/messages') return json(res, 200, db.messages);

  m = pathname.match(/^\/api\/messages\/([a-f0-9]+)$/);
  if (m && method === 'DELETE') {
    db.messages = db.messages.filter((x) => x.id !== m[1]);
    await saveDb();
    return json(res, 200, { ok: true });
  }

  throw httpError(405, 'Method not allowed');
}

/* ------------------------------------------------------------------ */
/* Static files (with Range support so videos can seek)                */
/* ------------------------------------------------------------------ */

async function notFound(req, res) {
  try {
    const page = await fsp.readFile(path.join(PUBLIC, '404.html'));
    res.writeHead(404, { 'Content-Type': MIME['.html'], 'Content-Length': page.length });
    return res.end(req.method === 'HEAD' ? undefined : page);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
}

async function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    throw httpError(400, 'Bad request');
  }
  if (rel.includes('\0')) throw httpError(400, 'Bad request');

  let full = path.normalize(path.join(PUBLIC, rel));
  if (full !== PUBLIC && !full.startsWith(PUBLIC + path.sep)) throw httpError(403, 'Forbidden');

  let st;
  try {
    st = await fsp.stat(full);
  } catch {
    return notFound(req, res);
  }
  if (st.isDirectory()) {
    if (!pathname.endsWith('/')) {
      res.writeHead(301, { Location: pathname + '/' });
      return res.end();
    }
    full = path.join(full, 'index.html');
    try {
      st = await fsp.stat(full);
    } catch {
      return notFound(req, res);
    }
  }

  const ext = path.extname(full).toLowerCase();
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    ETag: etag,
    'Last-Modified': st.mtime.toUTCString(),
    'Accept-Ranges': 'bytes',
    'Cache-Control': rel.startsWith('/uploads/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }

  let start = 0;
  let end = st.size - 1;
  let status = 200;
  const range = req.headers.range;
  if (range) {
    const r = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (r && (r[1] || r[2])) {
      if (r[1] === '') {
        start = Math.max(0, st.size - Number(r[2]));
      } else {
        start = Number(r[1]);
        if (r[2] !== '') end = Math.min(Number(r[2]), st.size - 1);
      }
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(full, { start, end })
    .on('error', () => res.destroy())
    .pipe(res);
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "media-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "script-src 'self'",
  "connect-src 'self'",
  'frame-src https://www.youtube-nocookie.com https://player.vimeo.com',
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

loadDb();

const server = http.createServer(async (req, res) => {
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(405, 'Method not allowed');
    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    if (res.headersSent) return res.destroy();
    const status = err.status || 500;
    if (status === 500) console.error(err);
    const isApi = req.url.startsWith('/api/');
    if (isApi) return json(res, status, { error: status === 500 ? 'Server error' : err.message });
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(status === 500 ? 'Server error' : err.message);
  }
});

server.listen(PORT, () => {
  console.log(`\n  Snaker is running  →  http://localhost:${PORT}`);
  console.log(`  Admin panel        →  http://localhost:${PORT}/admin/\n`);
  if (!process.env.ADMIN_PASSWORD) {
    console.log('  ⚠  Using the default admin password "snaker123".');
    console.log('     Set your own:  ADMIN_PASSWORD="something-strong" node server.js\n');
  }
});
