/*
 * agent-bridge.js — Baidu Netdisk MCP bridge, v2 (client 8.9.7+).
 *
 * Injected into the Electron main process of the Baidu Netdisk macOS client
 * (dist/electron/entry.js), exposes the logged-in account's cloud drive to
 * local agents (e.g. Claude Code) through an MCP Streamable HTTP endpoint
 * bound to 127.0.0.1:8765/mcp.
 *
 * Key design points (the client obfuscates its bootstrap and has no
 * app.$xxx globals):
 *   - Credentials come from the Chromium session cookie jar (BDUSS/BDUSS_BFESS
 *     + STOKEN of the logged-in client session) instead of app.$Net.
 *   - All pan.baidu.com REST calls go through plain Node https with those
 *     cookies, the netdisk UA and web-style params. Mutating endpoints also
 *     carry the bdstoken (fetched + cached via gettemplatevariable).
 *   - Uploads and transfer counts use the client's native engine
 *     (libbrowserengine.dylib) loaded through the bundled koffi module with
 *     the exact ABI the client itself uses, so uploads land in the app's own
 *     transfer queue (pause/resume/UI identical to manual uploads).
 *   - Downloads resolve a dlink via the legacy /api/filemetas endpoint (web
 *     params) and stream it with plain Node https, size-checked.
 *
 * The endpoint requires a Bearer token from
 *   ~/Library/Application Support/baidunetdisk/agent-bridge-token
 * (shared with the v1 bridge so existing MCP registrations keep working).
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const querystring = require('querystring');
const { app, session } = require('electron');

const PORT = 8765;
const BIND_HOST = '127.0.0.1';
const PROTOCOL_VERSION = '2025-03-26';
const SERVER_NAME = 'baidupan-agent-bridge';
const SERVER_VERSION = '2.1.0';
const DOWNLOAD_SUBDIR = 'baidupan-mcp';
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const AUTH_CACHE_MS = 30 * 1000;
const BDSTOKEN_CACHE_MS = 10 * 60 * 1000;

// --------------------------------------------------------------------------
// Logging
// --------------------------------------------------------------------------

function logPath() {
  return path.join(app.getPath('userData'), 'agent-bridge.log');
}

function log(...args) {
  try {
    const line = `[${new Date().toISOString()}] [agent-bridge] ${args.join(' ')}\n`;
    const p = logPath();
    let size = 0;
    try { size = fs.statSync(p).size; } catch (e) { /* new file */ }
    if (size > 1024 * 1024) {
      const old = p + '.1';
      try { if (fs.existsSync(old)) fs.unlinkSync(old); } catch (e) { /* ignore */ }
      try { fs.renameSync(p, old); } catch (e) { /* ignore */ }
    }
    fs.appendFileSync(p, line);
    try {
      statusLog.push({ seq: ++statusLogSeq, ts: new Date().toTimeString().slice(0, 8), msg: args.join(' ') });
      if (statusLog.length > 200) statusLog.shift();
    } catch (e2) { /* in-memory only */ }
  } catch (e) { /* logging must never break the host app */ }
}

// --------------------------------------------------------------------------
// Auth token for the local MCP endpoint
// --------------------------------------------------------------------------

function tokenPath() {
  return path.join(app.getPath('userData'), 'agent-bridge-token');
}

function loadOrCreateToken() {
  const p = tokenPath();
  try {
    const existing = fs.readFileSync(p, 'utf8').trim();
    if (/^[0-9a-f]{32,}$/.test(existing)) return existing;
  } catch (e) { /* not created yet */ }
  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(p, token, { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch (e) { /* best effort */ }
  return token;
}

// --------------------------------------------------------------------------
// Credentials: the logged-in client session's cookies
// --------------------------------------------------------------------------

let authCache = { value: null, at: 0 };

function netdiskUA() {
  try {
    return `netdisk;${app.getVersion()};PC;PC-MacOS;${os.release()};AppleSilicon`;
  } catch (e) {
    return 'netdisk;PC;PC-MacOS;AppleSilicon';
  }
}

async function readSessionCookies() {
  const jars = [];
  try { jars.push(session.defaultSession); } catch (e) { /* ignore */ }
  // Some clients keep pan sessions in a persist partition; scan those too.
  try {
    const partsDir = path.join(app.getPath('userData'), 'Partitions');
    for (const name of fs.readdirSync(partsDir)) {
      try { jars.push(session.fromPartition('persist:' + name)); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* no Partitions dir */ }
  let bduss = '';
  let stoken = '';
  for (const jar of jars) {
    try {
      const all = await jar.cookies.get({});
      for (const c of all) {
        const domain = String(c.domain || '').replace(/^\./, '');
        if (!/(^|\.)baidu\.com$/.test(domain)) continue;
        if (c.name === 'BDUSS' && c.value && !bduss) bduss = c.value;
        if (c.name === 'BDUSS_BFESS' && c.value && !bduss) bduss = c.value;
        if (c.name === 'STOKEN' && c.value && !stoken) stoken = c.value;
      }
    } catch (e) { /* ignore jar */ }
    if (bduss && stoken) break;
  }
  return { bduss, stoken };
}

async function authHeaders() {
  const now = Date.now();
  if (authCache.value && now - authCache.at < AUTH_CACHE_MS) return authCache.value;
  const { bduss, stoken } = await readSessionCookies();
  if (!bduss) {
    // negative-cache briefly so a storm of tools/call does not scan all jars
    authCache = { value: null, at: now - AUTH_CACHE_MS + 5000, missing: true };
    return null;
  }
  const value = {
    cookie: `BDUSS=${bduss};STOKEN=${stoken}`,
    userAgent: netdiskUA(),
  };
  authCache = { value, at: now };
  return value;
}

async function requireLogin() {
  const auth = await authHeaders();
  if (!auth) {
    const err = new Error('Not logged in. Please log in to Baidu Netdisk first, then retry.');
    err.code = 'NOT_LOGGED_IN';
    throw err;
  }
  return auth;
}

// --------------------------------------------------------------------------
// HTTP helpers (plain Node https, cookie-authenticated)
// --------------------------------------------------------------------------

function parseJsonBody(data) {
  if (data == null) return {};
  if (typeof data === 'string') {
    try { return JSON.parse(data); } catch (e) { return {}; }
  }
  return data;
}

function checkErrno(data, context) {
  const body = parseJsonBody(data);
  const code = body && typeof body.errno === 'number' ? body.errno :
    (body && typeof body.error_code === 'number' ? body.error_code : 0);
  const msg = body && (body.errmsg || body.error_msg || body.show_msg);
  if (code !== 0) {
    if (Array.isArray(body.info) && body.info.length &&
        body.info.every((it) => it && it.errno === 0)) {
      return body;
    }
    const err = new Error(
      `${context} failed: errno=${code}` +
      (msg ? ` (${msg})` : '') +
      (Array.isArray(body.info) ? ` info: ${JSON.stringify(body.info).slice(0, 300)}` : '') +
      (code === -6 ? ' — login expired, please re-login in the Baidu Netdisk app.' : '')
    );
    err.code = 'API_ERRNO';
    err.errno = code;
    err.body = body;
    throw err;
  }
  return body;
}

function requestJson(urlStr, options) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(urlStr); } catch (e) { reject(e); return; }
    const mod = parsed.protocol === 'http:' ? http : https;
    const req = mod.request(parsed, options, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].indexOf(status) !== -1 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, parsed).toString();
        resolve(requestJson(next, options));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(text)); } catch (e) {
          reject(new Error(`Non-JSON response (HTTP ${status}): ${text.slice(0, 200)}`));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Request timed out')));
    if (options && options.__body) req.end(options.__body);
    else req.end();
  });
}

async function apiGet(urlWithQuery, auth) {
  auth = auth || await requireLogin();
  const data = await requestJson('https://pan.baidu.com' + urlWithQuery, {
    method: 'GET',
    headers: {
      'User-Agent': auth.userAgent,
      Cookie: auth.cookie,
      Referer: 'https://pan.baidu.com/disk/main',
    },
  });
  return checkErrno(data, `GET ${urlWithQuery.split('?')[0]}`);
}

// bdstoken: required by mutating web endpoints on this client version.
let bdstokenCache = { value: '', at: 0 };

async function getBdstoken(auth) {
  const now = Date.now();
  if (bdstokenCache.value && now - bdstokenCache.at < BDSTOKEN_CACHE_MS) {
    return bdstokenCache.value;
  }
  auth = auth || await requireLogin();
  const form = querystring.stringify({ fields: '["bdstoken"]' });
  const data = await requestJson(
    'https://pan.baidu.com/api/gettemplatevariable?clienttype=0&app_id=250528&web=1',
    {
      method: 'POST',
      headers: {
        'User-Agent': auth.userAgent,
        Cookie: auth.cookie,
        Referer: 'https://pan.baidu.com/disk/main',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(form),
      },
      __body: form,
    });
  const token = data && data.result && data.result.bdstoken;
  if (typeof token === 'string' && token.length >= 16) {
    bdstokenCache = { value: token, at: now };
    return token;
  }
  // Endpoint may refuse; continue without it (some writes still work).
  checkErrno(data, 'get bdstoken');
  bdstokenCache = { value: '', at: now };
  return '';
}

async function apiPostForm(urlWithQuery, form, opts) {
  const auth = await requireLogin();
  const payload = Object.assign({}, form || {});
  if (!(opts && opts.noBdstoken)) {
    const bt = await getBdstoken(auth);
    if (bt) payload.bdstoken = bt;
  }
  const body = querystring.stringify(payload);
  const data = await requestJson('https://pan.baidu.com' + urlWithQuery, {
    method: 'POST',
    headers: {
      'User-Agent': auth.userAgent,
      Cookie: auth.cookie,
      Referer: 'https://pan.baidu.com/disk/main',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
    __body: body,
  });
  return checkErrno(data, `POST ${urlWithQuery.split('?')[0]}`);
}

function httpStream(url, headers, redirectsLeft) {
  if (redirectsLeft == null) redirectsLeft = 10;
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { reject(e); return; }
    const mod = parsed.protocol === 'http:' ? http : https;
    const req = mod.get(parsed, { headers }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].indexOf(status) !== -1 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) { reject(new Error('Too many redirects')); return; }
        const next = new URL(res.headers.location, parsed).toString();
        resolve(httpStream(next, headers, redirectsLeft - 1));
        return;
      }
      if (status !== 200) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => reject(new Error(`HTTP ${status} while streaming: ` +
          Buffer.concat(chunks).toString('utf8').slice(0, 200))));
        res.on('error', reject);
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('Streaming request timed out')));
  });
}

// --------------------------------------------------------------------------
// Native engine (libbrowserengine.dylib via the bundled koffi FFI module)
// --------------------------------------------------------------------------

let engineCache; // undefined = not attempted yet; null = failed

function findAppEngineBinding() {
  // The client itself declares the full engine binding via koffi at startup.
  // Locate that binding object in the module cache and reuse its functions
  // (correct ABI for this exact client build) instead of guessing signatures.
  const seen = new Set();
  const scan = (obj, depth) => {
    if (!obj || typeof obj !== 'object' || seen.has(obj) || depth > 2) return null;
    seen.add(obj);
    if (typeof obj.browser_engine_get_task_count === 'function' &&
        typeof obj.browser_engine_upload_files === 'function') {
      return obj;
    }
    for (const k of Object.keys(obj)) {
      try {
        const found = scan(obj[k], depth + 1);
        if (found) return found;
      } catch (e) { /* getter traps */ }
    }
    return null;
  };
  for (const mod of Object.values(require.cache)) {
    let exp;
    try { exp = mod && mod.exports; } catch (e) { continue; }
    const found = scan(exp, 0);
    if (found) return found;
  }
  return null;
}

function getEngine() {
  if (engineCache !== undefined) return engineCache;
  const binding = findAppEngineBinding();
  if (binding) {
    engineCache = {
      uploadFiles: binding.browser_engine_upload_files,
      downloadSelfFiles: binding.browser_engine_download_self_files,
      getTaskCount: binding.browser_engine_get_task_count,
      fromApp: true,
    };
    log('native engine: reusing the client binding from module cache');
    return engineCache;
  }
  try {
    const koffi = require('koffi');
    const dylib = dylibPath();
    const lib = koffi.load(dylib);
    engineCache = {
      uploadFiles: lib.func('browser_engine_upload_files', 'uint32', ['string', 'string', 'string']),
      downloadSelfFiles: lib.func('browser_engine_download_self_files', 'uint32', ['string', 'string']),
      getTaskCount: lib.func('browser_engine_get_task_count', 'uint32',
        ['string', 'bool', 'uint32', koffi.inout('int32 *'), koffi.inout('int32 *'),
         koffi.inout('int32 *'), koffi.inout('int32 *')]),
    };
    log(`native engine loaded via koffi: ${dylib}`);
  } catch (e) {
    log(`native engine unavailable: ${e.message}`);
    engineCache = null;
  }
  return engineCache;
}

function dylibPath() {
  return path.join(process.resourcesPath, '..', 'Frameworks', 'libbrowserengine.dylib');
}

function engineTaskCount(isDownload) {
  const eng = getEngine();
  if (!eng) return null;
  const a = [0], b = [0], c = [0], d = [0];
  // Engine ABI: (listId "0", isDownloadFlag, groupNum, out counts...).
  const rc = eng.getTaskCount('0', !!isDownload, 0, a, b, c, d);
  if (rc !== 0) return { error: `engine rc=${rc}` };
  return { running: a[0], waiting: b[0], paused: c[0], failed: d[0] };
}

// --------------------------------------------------------------------------
// Path helpers
// --------------------------------------------------------------------------

function normalizeRemotePath(p) {
  let s = String(p || '');
  if (!s.startsWith('/')) s = '/' + s;
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

function splitRemotePath(p) {
  const norm = normalizeRemotePath(p);
  const idx = norm.lastIndexOf('/');
  const name = norm.slice(idx + 1);
  const parent = idx <= 0 ? '/' : norm.slice(0, idx);
  return { parent, name };
}

async function statByPath(remotePath, auth) {
  const norm = normalizeRemotePath(remotePath);
  if (norm === '/') throw new Error('Remote path is the root directory.');
  const { parent, name } = splitRemotePath(norm);
  const body = await apiGet(
    '/rest/2.0/xpan/file?method=list&dir=' + encodeURIComponent(parent) +
    '&order=name&start=0&limit=1000', auth);
  const entry = (body.list || []).find((f) => f.server_filename === name) || null;
  if (!entry) {
    const err = new Error(`Remote path not found: ${norm}`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  return entry;
}

function humanSize(n) {
  n = Number(n) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function uniqueLocalPath(target) {
  let candidate = target;
  let i = 1;
  const ext = path.extname(target);
  const base = target.slice(0, target.length - ext.length);
  while (fs.existsSync(candidate)) {
    candidate = `${base} (${i})${ext}`;
    i += 1;
  }
  return candidate;
}

function randomSharePwd() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 4; i += 1) out += chars[crypto.randomInt(chars.length)];
  return out;
}

// --------------------------------------------------------------------------
// Tool definitions
// --------------------------------------------------------------------------

const integerType = { type: 'integer' };
const stringType = { type: 'string' };

const TOOL_DEFINITIONS = [
  {
    name: 'baidu_status',
    description: 'Check login status, account info and quota of the Baidu Netdisk client. Run this first when unsure about login state.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'baidu_get_quota',
    description: 'Get cloud drive storage quota (total/used/free).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'baidu_list_files',
    description: 'List files in a remote directory of the Baidu Netdisk drive.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Remote directory path, e.g. "/" or "/docs".' },
        start: Object.assign({ description: 'Offset for pagination (default 0).' }, integerType),
        limit: Object.assign({ description: 'Max entries per page, 1-1000 (default 100).' }, integerType),
      },
      required: ['dir'],
    },
  },
  {
    name: 'baidu_search_files',
    description: 'Search files by keyword across the cloud drive.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Search keyword.' },
        dir: Object.assign({ description: 'Optional scope directory.' }, stringType),
      },
      required: ['key'],
    },
  },
  {
    name: 'baidu_download_file',
    description: 'Download a remote file to the local machine. Without local_path it goes to ~/Downloads/baidupan-mcp/.',
    inputSchema: {
      type: 'object',
      properties: {
        remote_path: { type: 'string', description: 'Remote file path, e.g. "/docs/a.pdf".' },
        local_path: { type: 'string', description: 'Optional local destination file path.' },
      },
      required: ['remote_path'],
    },
  },
  {
    name: 'baidu_upload_file',
    description: 'Upload a local file into a remote directory (queued in the app transfer manager).',
    inputSchema: {
      type: 'object',
      properties: {
        local_path: { type: 'string', description: 'Local file path.' },
        remote_dir: { type: 'string', description: 'Destination remote directory (default "/").' },
      },
      required: ['local_path'],
    },
  },
  {
    name: 'baidu_transfer_status',
    description: 'Show current upload/download task counts of the netdisk app.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'baidu_mkdir',
    description: 'Create a remote directory (parent directories are not auto-created).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Remote directory to create, e.g. "/docs/new".' } },
      required: ['path'],
    },
  },
  {
    name: 'baidu_rename',
    description: 'Rename a remote file or directory.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Existing remote path.' },
        new_name: { type: 'string', description: 'New bare name (no slashes).' },
      },
      required: ['path', 'new_name'],
    },
  },
  {
    name: 'baidu_move',
    description: 'Move remote files/directories into a destination directory.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'One or more remote paths.' },
        dest_dir: { type: 'string', description: 'Destination remote directory.' },
      },
      required: ['paths', 'dest_dir'],
    },
  },
  {
    name: 'baidu_delete',
    description: 'Delete remote files/directories (moved to cloud recycle bin).',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'One or more remote paths.' },
      },
      required: ['paths'],
    },
  },
  {
    name: 'baidu_create_share',
    description: 'Create a share link for a remote path (best-effort; may be rejected by server-side policy).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Remote file or directory to share.' },
        pwd: { type: 'string', description: 'Extraction code (4 chars). Defaults to a random one.' },
        period_days: Object.assign({ description: 'Days until expiry (0 = forever).' }, integerType),
      },
      required: ['path'],
    },
  },
];

// --------------------------------------------------------------------------
// Tool implementations
// --------------------------------------------------------------------------

const toolImplementations = {
  async baidu_status() {
    const auth = await requireLogin();
    const out = { logged_in: true, bridge_version: SERVER_VERSION };
    try {
      const info = await apiGet('/rest/2.0/xpan/nas?method=uinfo', auth);
      out.user = {
        uk: info.uk, baidu_name: info.baidu_name, netdisk_name: info.netdisk_name,
        vip: info.vip, avatar: info.avatar,
      };
    } catch (e) { out.user_error = e.message; }
    try {
      const q = await apiGet('/api/quota?checkfree=1&checkexpire=1', auth);
      out.quota = {
        total: q.total, used: q.used, free: q.free || (q.total - q.used),
      };
    } catch (e) { out.quota_error = e.message; }
    return out;
  },

  async baidu_get_quota() {
    const auth = await requireLogin();
    const q = await apiGet('/api/quota?checkfree=1&checkexpire=1', auth);
    return {
      total: q.total, used: q.used,
      free: q.free || (q.total - q.used),
      total_human: humanSize(q.total), used_human: humanSize(q.used),
    };
  },

  async baidu_list_files(args) {
    const auth = await requireLogin();
    const dir = normalizeRemotePath(args.dir);
    const start = Number.isFinite(args.start) ? Math.max(0, args.start | 0) : 0;
    let limit = Number.isFinite(args.limit) ? args.limit | 0 : 100;
    limit = Math.min(Math.max(limit, 1), 1000);
    const body = await apiGet(
      '/rest/2.0/xpan/file?method=list&dir=' + encodeURIComponent(dir) +
      `&order=name&start=${start}&limit=${limit}`, auth);
    const list = (body.list || []).map((f) => ({
      fs_id: f.fs_id,
      path: f.path,
      name: f.server_filename,
      is_dir: !!f.isdir,
      size: f.size || 0,
      size_human: humanSize(f.size || 0),
      category: f.category,
      modified: f.server_mtime || f.local_mtime,
    }));
    return { dir, start, limit, count: list.length, files: list };
  },

  async baidu_search_files(args) {
    const auth = await requireLogin();
    const key = String(args.key || '').trim();
    if (!key) throw new Error('Parameter "key" must not be empty.');
    let url = '/rest/2.0/xpan/file?method=search&key=' + encodeURIComponent(key) +
      '&recursion=1&start=0&limit=200';
    if (args.dir) url += '&dir=' + encodeURIComponent(normalizeRemotePath(args.dir));
    const body = await apiGet(url, auth);
    const list = (body.list || []).map((f) => ({
      fs_id: f.fs_id, path: f.path, name: f.server_filename,
      is_dir: !!f.isdir, size: f.size || 0, size_human: humanSize(f.size || 0),
    }));
    return { key, count: list.length, files: list };
  },

  async baidu_download_file(args) {
    const auth = await requireLogin();
    const remotePath = normalizeRemotePath(args.remote_path);
    const entry = await statByPath(remotePath, auth);
    if (entry.isdir) throw new Error(`Remote path is a directory: ${remotePath}`);

    // Legacy /api/filemetas with web params returns a dlink usable with the
    // plain netdisk UA + cookies.
    const fsids = JSON.stringify([Number(entry.fs_id)]);
    const meta = await apiGet(
      '/api/filemetas?web=1&clienttype=0&app_id=250528&dlink=1&fsids=' +
      encodeURIComponent(fsids), auth);
    const m = meta && meta.info && meta.info[0];
    if (!m || !m.dlink) throw new Error('Failed to resolve download link (dlink).');
    const dlink = typeof m.dlink === 'string' && m.dlink.startsWith('//')
      ? 'https:' + m.dlink : m.dlink;

    let localPath;
    if (args.local_path) {
      localPath = path.resolve(os.homedir(), String(args.local_path));
      const dir = path.dirname(localPath);
      fs.mkdirSync(dir, { recursive: true });
    } else {
      const dir = path.join(os.homedir(), 'Downloads', DOWNLOAD_SUBDIR);
      fs.mkdirSync(dir, { recursive: true });
      localPath = path.join(dir, entry.server_filename || path.basename(remotePath));
    }
    localPath = uniqueLocalPath(localPath);

    // pcs download servers reject some cookie shapes ("sign error"), so try
    // progressively narrower cookies: full cookie, then BDUSS-only.
    const cookieVariants = [auth.cookie];
    const bduss = /(?:^|;\s*)BDUSS=([^;]+)/.exec(auth.cookie);
    if (bduss) cookieVariants.push(`BDUSS=${bduss[1]}`);
    let stream = null;
    let lastErr = null;
    for (const cookie of cookieVariants) {
      try {
        stream = await httpStream(dlink, {
          'User-Agent': auth.userAgent,
          Cookie: cookie,
        });
        break;
      } catch (e) { lastErr = e; log(`download attempt failed: ${e.message}`); }
    }
    if (!stream) throw lastErr;
    const expected = Number(entry.size) || 0;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(localPath);
      let received = 0;
      stream.on('data', (chunk) => { received += chunk.length; });
      stream.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => {
        if (expected && received !== expected) {
          reject(new Error(`Size mismatch: expected ${expected} bytes, got ${received}.`));
        } else resolve();
      });
      stream.pipe(out);
    });
    log(`downloaded ${remotePath} -> ${localPath} (${expected} bytes)`);
    return {
      remote_path: remotePath,
      local_path: localPath,
      size: expected,
      size_human: humanSize(expected),
    };
  },

  async baidu_upload_file(args) {
    await requireLogin(); // engine uploads need a logged-in client anyway
    const localPath = path.resolve(os.homedir(), String(args.local_path));
    let st;
    try { st = fs.statSync(localPath); } catch (e) {
      throw new Error(`Local file not found: ${localPath}`);
    }
    if (st.isDirectory()) throw new Error('Uploading directories is not supported; upload files one by one.');
    const remoteDir = normalizeRemotePath(args.remote_dir || '/');
    const eng = getEngine();
    if (!eng || typeof eng.uploadFiles !== 'function') {
      throw new Error('Native upload engine is unavailable in this client build.');
    }
    // Exact call shape the client itself uses for manual uploads:
    // browser_engine_upload_files(cid, JSON list, serverPath)
    const list = JSON.stringify([{ local_path: localPath, is_dir: 0, server_path: remoteDir }]);
    const rc = eng.uploadFiles('0', list, remoteDir);
    if (rc !== 0) throw new Error(`Engine rejected the upload task (rc=${rc}).`);
    log(`upload queued: ${localPath} -> ${remoteDir}`);
    return {
      local_path: localPath,
      remote_dir: remoteDir,
      queued: true,
      hint: 'The file was added to the app upload queue. Poll baidu_transfer_status to confirm completion.',
    };
  },

  async baidu_transfer_status() {
    await requireLogin();
    const out = { upload: engineTaskCount(false), download: engineTaskCount(true) };
    const eng = getEngine();
    if (!eng) out.note = 'Native engine unavailable; counts unknown.';
    return out;
  },

  async baidu_mkdir(args) {
    await requireLogin();
    const dirPath = normalizeRemotePath(args.path);
    if (dirPath === '/') throw new Error('Cannot create the root directory.');
    const variants = [
      // The legacy create API treats `path` as the full target path.
      ['legacy', '/api/create?a=commit&channel=chunlei&web=1&clienttype=0',
        { path: dirPath, isdir: 1, rtype: 0 }],
      ['xpan', '/rest/2.0/xpan/file?method=creates&app_id=250528&web=1&clienttype=0',
        { path: dirPath, isdir: 1, rtype: 0 }],
    ];
    const errors = [];
    for (const [label, url, form] of variants) {
      try {
        const body = await apiPostForm(url, form);
        return { path: dirPath, created: true, via: label, raw: body };
      } catch (e) { errors.push(`${label}: ${e.message.slice(0, 150)}`); }
    }
    throw new Error('mkdir failed — ' + errors.join('; ').slice(0, 400));
  },

  async baidu_rename(args) {
    await requireLogin();
    const oldPath = normalizeRemotePath(args.path);
    const newName = String(args.new_name || '').trim();
    if (!newName || newName.includes('/')) {
      throw new Error('Parameter "new_name" must be a bare file name without "/".');
    }
    await statByPath(oldPath);
    const filelist = JSON.stringify([{ path: oldPath, newname: newName }]);
    const variants = [
      ['xpan', '/rest/2.0/xpan/file?method=filemanager&opera=rename&async=0', { filelist }],
      ['legacy', '/api/filemanager?opera=rename&async=0&web=1&clienttype=0&channel=chunlei', { filelist }],
    ];
    const errors = [];
    let body = null;
    for (const [label, url, form] of variants) {
      try {
        body = await apiPostForm(url, form);
        break;
      } catch (e) { errors.push(`${label}: ${e.message.slice(0, 150)}`); }
    }
    if (!body) throw new Error('rename failed — ' + errors.join('; ').slice(0, 400));
    return { path: oldPath, new_name: newName, renamed: true };
  },

  async baidu_move(args) {
    await requireLogin();
    const paths = (Array.isArray(args.paths) ? args.paths : [args.paths])
      .map(normalizeRemotePath).filter(Boolean);
    if (!paths.length) throw new Error('Parameter "paths" must be a non-empty path or array.');
    const dest = normalizeRemotePath(args.dest_dir);
    const errors = [];
    let body = null;
    // xpan move wants per-item objects {path, dest, newname, ondup}; the
    // legacy web API wants plain paths plus a top-level dest param.
    const variants = [
      ['xpan', '/rest/2.0/xpan/file?method=filemanager&opera=move&async=2', {
        filelist: JSON.stringify(paths.map((p) => ({
          path: p, dest, newname: path.posix.basename(p), ondup: 'fail',
        }))),
      }],
      ['legacy', '/api/filemanager?opera=move&async=2&web=1&clienttype=0&channel=chunlei', {
        filelist: JSON.stringify(paths), dest,
      }],
    ];
    for (const [label, url, form] of variants) {
      try {
        body = await apiPostForm(url, form);
        break;
      } catch (e) { errors.push(`${label}: ${e.message.slice(0, 150)}`); }
    }
    if (!body) throw new Error('move failed — ' + errors.join('; ').slice(0, 400));
    return { moved: paths, dest_dir: dest, raw: body };
  },

  async baidu_delete(args) {
    await requireLogin();
    const paths = (Array.isArray(args.paths) ? args.paths : [args.paths])
      .map(normalizeRemotePath).filter(Boolean);
    if (!paths.length) throw new Error('Parameter "paths" must be a non-empty path or array.');
    const body = await apiPostForm(
      '/rest/2.0/xpan/file?method=filemanager&opera=delete&async=0',
      { filelist: JSON.stringify(paths) });
    return { deleted: paths, note: 'Deleted files go to the cloud recycle bin.', raw: body };
  },

  async baidu_create_share(args) {
    await requireLogin();
    const remotePath = normalizeRemotePath(args.path);
    await statByPath(remotePath);
    // Best-effort: the share/set web endpoint; some accounts require extra
    // verification, in which case the server returns a non-zero errno.
    const body = await apiPostForm(
      '/share/set?channel=chunlei&web=1&clienttype=0',
      {
        schannel: 4,
        channel_list: '[]',
        web: 1,
        pwd: String(args.pwd || randomSharePwd()),
        period: Number.isFinite(args.period_days) ? args.period_days : 0, // 0 = forever
        path_list: JSON.stringify([remotePath]),
      });
    const pwdMatch = /[?&]pwd=([^&]+)/.exec(String(body.qrcodeurl || ''));
    return {
      path: remotePath,
      link: body.link || body.shorturl || null,
      shareid: body.shareid,
      pwd: body.pwd || (pwdMatch ? decodeURIComponent(pwdMatch[1]) : null),
      expires_at: body.expiretime || null,
      raw: body,
    };
  },
};

// --------------------------------------------------------------------------
// JSON-RPC / MCP server
// --------------------------------------------------------------------------

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleRpc(msg) {
  // Notifications (no id) get no response body per JSON-RPC 2.0.
  if (msg.id === undefined || msg.id === null) return null;

  if (msg.method === 'initialize') {
    return jsonRpcResult(msg.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (msg.method === 'ping') {
    return jsonRpcResult(msg.id, {});
  }
  if (msg.method === 'tools/list') {
    return jsonRpcResult(msg.id, { tools: TOOL_DEFINITIONS });
  }
  if (msg.method === 'tools/call') {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    const impl = toolImplementations[name];
    if (!impl) return jsonRpcError(msg.id, -32602, `Unknown tool: ${name}`);
    log(`tools/call ${name}`);
    try {
      const result = await impl(args);
      return jsonRpcResult(msg.id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: false,
      });
    } catch (e) {
      return jsonRpcResult(msg.id, {
        content: [{ type: 'text', text: `Error: ${e.message}` }],
        isError: true,
      });
    }
  }
  return jsonRpcError(msg.id, -32601, `Method not found: ${msg.method}`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createMcpServer(token) {
  const server = http.createServer(async (req, res) => {
    try {
      // Anti DNS-rebinding: only accept requests addressed to the local host.
      const host = String(req.headers.host || '');
      if (host !== `${BIND_HOST}:${PORT}` && host !== `localhost:${PORT}`) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden host' }));
        return;
      }
      if (!req.url || req.url.split('?')[0] !== '/mcp') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      if (req.method === 'GET') {
        // Stateless server: no server-initiated SSE stream.
        res.writeHead(405, { Allow: 'POST' });
        res.end();
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST, GET' });
        res.end();
        return;
      }
      const contentType = String(req.headers['content-type'] || '');
      if (!contentType.toLowerCase().startsWith('application/json')) {
        res.writeHead(415, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Content-Type must be application/json' }));
        return;
      }
      const authHeader = String(req.headers.authorization || '');
      if (authHeader !== `Bearer ${token}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      const bodyText = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(bodyText); } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const messages = Array.isArray(parsed) ? parsed : [parsed];
      const isBatch = Array.isArray(parsed);
      const responses = [];
      for (const msg of messages) {
        const resp = await handleRpc(msg);
        if (resp) responses.push(resp);
      }
      // Pure notifications: acknowledge with 202 and empty body.
      if (!responses.length) { res.writeHead(202); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(isBatch ? responses : responses[0]));
    } catch (e) {
      log(`request error: ${e && e.message}`);
      try {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e && e.message }));
      } catch (e2) { /* socket already gone */ }
    }
  });
  return server;
}

// --------------------------------------------------------------------------
// Startup
// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// Sidebar status badge (bottom-left, click to show recent access log)
// --------------------------------------------------------------------------

const statusLog = []; // ring buffer of recent log entries for the badge panel
let statusLogSeq = 0;

function setupStatusBar() {
  const { BrowserWindow } = require('electron');
  const userCache = { at: 0, name: '', ok: false };

  async function badgeText() {
    let main = 'Agent Bridge';
    try {
      const auth = await requireLogin();
      if (Date.now() - userCache.at > 300000) {
        userCache.at = Date.now();
        try {
          const info = await apiGet('/rest/2.0/xpan/nas?method=uinfo', auth);
          userCache.name = (info.netdisk_name || info.baidu_name || '').trim();
          userCache.ok = true;
        } catch (e) { userCache.ok = false; }
      }
      main += ' · ' + (userCache.ok && userCache.name ? userCache.name : '已登录');
      const up = engineTaskCount(false), down = engineTaskCount(true);
      const arrow = [];
      if (up && !up.error) {
        const n = (up.running || 0) + (up.waiting || 0);
        if (n) arrow.push('↑' + n + ((up.failed || 0) ? '!' : ''));
      }
      if (down && !down.error) {
        const n = (down.running || 0) + (down.waiting || 0);
        if (n) arrow.push('↓' + n + ((down.failed || 0) ? '!' : ''));
      }
      if (arrow.length) main += ' · ' + arrow.join(' ');
    } catch (e) {
      main += ' · 未登录';
    }
    return main;
  }

  const INJECT = `(function(){
    if (window.__agentBridgeBadge) return 1;
    try {
      var st = document.createElement('style');
      st.textContent = '@keyframes __abPulse{0%,100%{opacity:1}50%{opacity:.35}}' +
        '.ab-log-row{padding:2px 0;border-bottom:1px solid rgba(255,255,255,.06);' +
        'white-space:pre-wrap;word-break:break-all;line-height:1.5}';
      document.head.appendChild(st);

      var panel = document.createElement('div');
      panel.id = 'agent-bridge-log-panel';
      panel.hidden = true;
      panel.style.cssText = 'position:fixed;left:10px;bottom:42px;z-index:2147483646;' +
        'width:360px;max-width:40vw;max-height:44vh;overflow-y:auto;' +
        'background:rgba(22,22,22,.93);border:1px solid rgba(255,255,255,.12);' +
        'border-radius:10px;padding:8px 10px;font:11px ui-monospace,Menlo,monospace;' +
        'color:rgba(255,255,255,.9);box-shadow:0 6px 24px rgba(0,0,0,.35)';
      var title = document.createElement('div');
      title.textContent = 'Agent Bridge 访问日志';
      title.style.cssText = 'font:600 11px -apple-system,"PingFang SC",sans-serif;' +
        'color:rgba(255,255,255,.75);margin-bottom:6px;position:sticky;top:0;' +
        'background:rgba(22,22,22,.93);padding:2px 0';
      var list = document.createElement('div');
      list.id = 'agent-bridge-log-list';
      panel.appendChild(title); panel.appendChild(list);
      document.body.appendChild(panel);

      var el = document.createElement('div');
      el.id = 'agent-bridge-badge';
      el.title = 'Agent Bridge MCP · http://127.0.0.1:PORT/mcp — 点击查看访问日志';
      el.style.cssText = 'position:fixed;left:10px;bottom:9px;z-index:2147483647;' +
        'display:flex;align-items:center;gap:6px;padding:3px 10px;border-radius:10px;' +
        'background:rgba(25,25,25,.55);font:11px -apple-system,"PingFang SC",sans-serif;' +
        'color:rgba(255,255,255,.94);cursor:pointer;user-select:none';
      var dot = document.createElement('span');
      dot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:#34c759;' +
        'box-shadow:0 0 5px #34c759;animation:__abPulse 2s ease-in-out infinite;flex:none';
      var label = document.createElement('span');
      label.id = 'agent-bridge-badge-label';
      label.textContent = 'Agent Bridge';
      el.appendChild(dot); el.appendChild(label);
      el.addEventListener('click', function(){
        var p = document.getElementById('agent-bridge-log-panel');
        if (p) { p.hidden = !p.hidden; }
      });
      document.body.appendChild(el);

      window.__abLastSeq = 0;
      window.__abLog = function(entries){
        var l = document.getElementById('agent-bridge-log-list');
        if (!l) return;
        var last = window.__abLastSeq || 0;
        for (var i = 0; i < entries.length; i++) {
          var e = entries[i];
          if (e.seq <= last) continue;
          var row = document.createElement('div');
          row.className = 'ab-log-row';
          row.textContent = e.ts + '  ' + e.msg;
          l.insertBefore(row, l.firstChild);
          window.__abLastSeq = e.seq;
        }
        while (l.children.length > 200) l.removeChild(l.lastChild);
      };
      window.__agentBridgeBadge = true;
      return 1;
    } catch (e) { return 0; }
  })()`.replace('PORT/mcp', PORT + '/mcp');

  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      let text = null;
      let snapshot = null;
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          if (win.isDestroyed()) continue;
          const wc = win.webContents;
          if (!wc || wc.isDestroyed()) continue;
          if ((win.getSize()[0] || 0) < 800) continue;
          const url = wc.getURL() || '';
          if (url.startsWith('devtools')) continue;
          const done = await wc.executeJavaScript('window.__agentBridgeBadge ? 1 : 0')
            .catch(() => 0);
          if (!done) {
            const ok = await wc.executeJavaScript(INJECT).catch(() => 0);
            if (ok) log('status badge injected into main window');
  // one-shot DOM outline dump (finds sidebar icons & layout for the badge UI)
  const INSPECT = "(function(){try{var out={href:location.href,html:'',frames:[],sidebar:[],bodyChildren:[]};" +
    "out.html=document.documentElement.outerHTML.slice(0,1500);" +
    "var fr=document.querySelectorAll('iframe,webview');" +
    "for(var k=0;k<fr.length;k++){out.frames.push({tag:fr[k].tagName.toLowerCase(),src:fr[k].getAttribute('src')||fr[k].src||'',id:fr[k].id||'',cls:(typeof fr[k].className==='string')?fr[k].className.slice(0,80):''});}" +
    "out.bodyChildren=[];var b=document.body?document.body.children:[];" +
    "for(var j=0;j<b.length&&j<30;j++){out.bodyChildren.push({tag:b[j].tagName.toLowerCase(),id:b[j].id||'',cls:(typeof b[j].className==='string')?b[j].className.slice(0,80):''});}" +
    "return JSON.stringify(out);}catch(e){return JSON.stringify({error:String(e)});}})()";

          if (!setupStatusBar.domDumped) {
            setupStatusBar.domDumped = true;
            const dump = await wc.executeJavaScript(INSPECT).catch(() => null);
            if (dump) {
              try {
                fs.writeFileSync(
                  path.join(app.getPath('userData'), 'agent-bridge-dom.json'), dump);
                log('DOM outline dumped to agent-bridge-dom.json');
              } catch (e2) { /* non-fatal */ }
            }
          }

          }
          if (text === null) text = await badgeText();
          if (snapshot === null) snapshot = statusLog.slice(-80);
          await wc.executeJavaScript(
            '(function(){var l=document.getElementById("agent-bridge-badge-label");' +
            'if(l){l.textContent=' + JSON.stringify(text) + ';}})()'
          ).catch(() => {});
          await wc.executeJavaScript(
            'window.__abLog && window.__abLog(' + JSON.stringify(snapshot) + ')'
          ).catch(() => {});
        } catch (e) { /* window mid-navigation; retried next tick */ }
      }
    } finally { busy = false; }
  }, 5000);
}

async function start() {
  try {
    await app.whenReady();
    const token = loadOrCreateToken();
    const server = createMcpServer(token);
    server.on('error', (e) => {
      log(`HTTP server error (service disabled): ${e.message}`);
    });
    server.listen(PORT, BIND_HOST, () => {
      log(`MCP service listening on http://${BIND_HOST}:${PORT}/mcp (v${SERVER_VERSION})`);
      setupStatusBar();
      log(`connect: claude mcp add --transport http baidupan http://${BIND_HOST}:${PORT}/mcp ` +
          `--header "Authorization: Bearer $(cat '${tokenPath()}')"`);
    });
    // Pre-warm the engine so the first upload does not pay the koffi load
    // cost; failures here are non-fatal (retried lazily per call).
    setTimeout(() => { try { getEngine(); } catch (e) { /* logged */ } }, 5000);
  } catch (e) {
    log(`startup failed: ${e && e.message}`);
  }
}

start();
