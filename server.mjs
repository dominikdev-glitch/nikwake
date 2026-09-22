import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { URL } from 'node:url'
import { extname } from 'node:path'
import dns from 'node:dns/promises'
import { cert, getApps, initializeApp } from 'firebase-admin/app'
import { getAuth as getAdminAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'

const PORT = Number(process.env.PORT || 8787)
const DATA_FILE = new URL('./server/data.json', import.meta.url)
const DIST_DIR = new URL('./dist/', import.meta.url)
const cronSecret = process.env.CRON_SECRET || ''
const requireAuth = process.env.NIKWAKE_REQUIRE_AUTH === 'true'
let serviceAccount = null
try { serviceAccount = process.env.FIREBASE_ADMIN_JSON ? JSON.parse(process.env.FIREBASE_ADMIN_JSON) : null } catch { throw new Error('FIREBASE_ADMIN_JSON must contain valid Firebase service-account JSON') }
const adminCredentials = serviceAccount || (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY ? { projectId: process.env.FIREBASE_PROJECT_ID, clientEmail: process.env.FIREBASE_CLIENT_EMAIL, privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') } : null)
const adminApp = adminCredentials ? (getApps()[0] || initializeApp({ credential: cert(adminCredentials) })) : null
const adminAuth = adminApp ? getAdminAuth(adminApp) : null
const firestore = adminApp && process.env.NIKWAKE_STORAGE === 'firestore' ? getFirestore(adminApp) : null
const firestoreState = firestore?.collection('nikwake').doc('state')
let firestoreAvailable = Boolean(firestoreState)
const allowedCadences = new Map([
  ['Every 1 minute', 60_000],
  ['Every 5 minutes', 300_000],
  ['Every 10 minutes', 600_000],
  ['Every 15 minutes', 900_000],
  ['Every 30 minutes', 1_800_000],
  ['Every hour', 3_600_000],
])
let store = await loadStore()
let saving = Promise.resolve()

async function loadStore() {
  if (firestoreState) {
    try {
      const snapshot = await firestoreState.get()
      const data = snapshot.exists ? snapshot.data() : {}
      return { sites: data.sites || [], activity: data.activity || [] }
    } catch (error) {
      firestoreAvailable = false
      console.error('Firestore is unavailable. Create the Firestore database for this Firebase project, then redeploy. Falling back to server/data.json.', error instanceof Error ? error.message : error)
    }
  }
  try {
    const loaded = JSON.parse(await readFile(DATA_FILE, 'utf8'))
    loaded.sites = (loaded.sites || []).map((site) => ({ ...site, running: false }))
    loaded.activity = loaded.activity || []
    return loaded
  } catch { return { sites: [], activity: [] } }
}
function saveStore() {
  saving = saving.then(() => firestoreAvailable && firestoreState ? firestoreState.set(store) : writeFile(DATA_FILE, JSON.stringify(store, null, 2)))
  return saving
}
function send(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
  response.end(JSON.stringify(payload))
}
function cronAuthorized(request, url) {
  if (!cronSecret) return true
  const headerSecret = request.headers['x-cron-secret'] || (request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '')
  return headerSecret === cronSecret || url.searchParams.get('key') === cronSecret
}
async function serveFrontend(request, response, pathname) {
  const requestedPath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '')
  const assetUrl = new URL(requestedPath, DIST_DIR)
  if (!assetUrl.href.startsWith(DIST_DIR.href)) return send(response, 400, { error: 'Invalid path' })
  try {
    const content = await readFile(assetUrl)
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }
    response.writeHead(200, { 'content-type': types[extname(requestedPath)] || 'application/octet-stream', 'cache-control': requestedPath === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable' })
    return response.end(content)
  } catch {
    if (!extname(requestedPath)) return serveFrontend(request, response, '/index.html')
    return send(response, 404, { error: 'Not found' })
  }
}
async function body(request) {
  let raw = ''
  for await (const chunk of request) raw += chunk
  return raw ? JSON.parse(raw) : {}
}
function labelFor(url) { return new URL(url).hostname.replace(/^www\./, '').split('.')[0].replace(/[-_]/g, ' ').replace(/^./, (letter) => letter.toUpperCase()) }
function initialsFor(label) { return label.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase() }
function activity(site, action, detail, kind = 'info') { return { id: crypto.randomUUID(), ownerId: site.ownerId || 'local', site: site.label, action, detail, time: new Date().toISOString(), kind } }
function serializeSite(site) {
  return { ...site, retries: site.retries ?? 2, expectedStatus: site.expectedStatus ?? '200-399', status: site.paused ? 'Paused' : site.lastError ? 'Degraded' : 'Online', lastWake: site.lastWake ? relativeTime(site.lastWake) : 'Never', response: site.lastResponse ? `${site.lastResponse} ms` : '—' }
}
function relativeTime(value) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000))
  if (seconds < 10) return 'Just now'
  if (seconds < 60) return `${seconds} sec ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`
  return `${Math.floor(seconds / 86400)} days ago`
}
function serializeActivity(item) { return { ...item, time: relativeTime(item.time) } }
async function validateTarget(target) {
  const parsed = new URL(target)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported')
  if (parsed.username || parsed.password) throw new Error('URLs cannot contain credentials')
  const addresses = await dns.lookup(parsed.hostname, { all: true })
  if (addresses.some(({ address }) => /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(address) || address === '::1' || address.startsWith('fc') || address.startsWith('fd'))) throw new Error('Private network targets are not allowed')
  return parsed.toString()
}
async function wake(site) {
  const attempts = Math.max(1, Math.min(5, Number(site.retries ?? 2) + 1))
  const expected = String(site.expectedStatus ?? '200-399').match(/^(\d{3})-(\d{3})$/)
  const started = Date.now()
  let lastError = 'Request failed'
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const attemptStarted = Date.now()
    try {
      const response = await fetch(site.url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'NikWake/1.0' } })
      const responseMs = Date.now() - attemptStarted
      const accepted = expected ? response.status >= Number(expected[1]) && response.status <= Number(expected[2]) : response.status === Number(site.expectedStatus)
      if (!accepted) { lastError = `Unexpected HTTP ${response.status}`; continue }
      site.lastWake = new Date().toISOString(); site.lastResponse = responseMs; site.lastStatusCode = response.status; site.lastError = ''; site.failureCount = 0
      store.activity.unshift(activity(site, 'Wake request sent', `${responseMs} ms · HTTP ${response.status}${attempt > 1 ? ` · attempt ${attempt}` : ''}`, 'success'))
      store.activity = store.activity.slice(0, 50); await saveStore()
      return { ok: true, statusCode: response.status, responseMs, attempt }
    } catch (error) { lastError = error instanceof Error ? error.message : 'Request failed' }
  }
  site.lastWake = new Date().toISOString(); site.lastResponse = Date.now() - started; site.lastError = lastError; site.failureCount = (site.failureCount ?? 0) + 1; store.activity.unshift(activity(site, 'Wake request failed', `${lastError} · ${attempts} attempts`, 'error')); store.activity = store.activity.slice(0, 50); await saveStore()
  return { ok: false, error: lastError, responseMs: site.lastResponse, attempts }
}
async function tick() {
  const now = Date.now()
  for (const site of store.sites) {
    if (site.paused || site.running) continue
    const interval = allowedCadences.get(site.cadence) || allowedCadences.get('Every 10 minutes')
    if (!site.lastWake || now - new Date(site.lastWake).getTime() >= interval) {
      site.running = true
      try { await wake(site) } finally { site.running = false }
    }
  }
}
setInterval(() => tick().catch((error) => console.error('Scheduler error:', error)), 30_000)

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'OPTIONS') { response.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type' }); return response.end() }
    const url = new URL(request.url || '/', `http://${request.headers.host}`)
    if (request.method === 'GET' && url.pathname === '/health') return send(response, 200, { ok: true, service: 'nikwake' })
    if (request.method === 'GET' && url.pathname === '/api/cron/keep-alive') {
      if (!cronAuthorized(request, url)) return send(response, 401, { ok: false, error: 'Invalid cron secret' })
      void tick().catch((error) => console.error('Cron scheduler error:', error))
      return send(response, 200, { ok: true, service: 'nikwake', message: 'NikWake is awake', timestamp: new Date().toISOString() })
    }
    if (!url.pathname.startsWith('/api/')) return serveFrontend(request, response, url.pathname)
    const token = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : ''
    request.userId = 'local'
    if (token) {
      if (!adminAuth) { if (requireAuth) return send(response, 503, { error: 'Server Firebase credentials are not configured' }) }
      else { try { request.userId = (await adminAuth.verifyIdToken(token)).uid } catch { return send(response, 401, { error: 'Invalid Firebase session' }) } }
    } else if (requireAuth) return send(response, 401, { error: 'Sign in required' })
    if (request.method === 'GET' && url.pathname === '/api/dashboard') {
      const sites = store.sites.filter((site) => (site.ownerId || 'local') === request.userId)
      const activityItems = store.activity.filter((item) => (item.ownerId || 'local') === request.userId)
      return send(response, 200, { sites: sites.map(serializeSite), activity: activityItems.slice(0, 8).map(serializeActivity), wakesThisWeek: activityItems.filter((item) => item.kind === 'success' && Date.now() - new Date(item.time).getTime() < 604_800_000).length, failuresThisWeek: activityItems.filter((item) => item.kind === 'error' && Date.now() - new Date(item.time).getTime() < 604_800_000).length })
    }
    const match = url.pathname.match(/^\/api\/sites\/([^/]+)(?:\/(wake))?$/)
    if (request.method === 'POST' && url.pathname === '/api/sites') {
      const input = await body(request)
      const target = await validateTarget(String(input.url || '').trim())
      const cadence = String(input.cadence || 'Every 10 minutes')
      if (!allowedCadences.has(cadence)) return send(response, 400, { error: 'Unsupported cadence' })
      const retries = Math.max(0, Math.min(5, Number(input.retries ?? 2)))
      const expectedStatus = String(input.expectedStatus || '200-399')
      if (!/^\d{3}(?:-\d{3})?$/.test(expectedStatus)) return send(response, 400, { error: 'Expected status must be a code like 200 or a range like 200-399' })
      const site = { id: crypto.randomUUID(), ownerId: request.userId, url: target, label: labelFor(target), initials: initialsFor(labelFor(target)), cadence, retries, expectedStatus, paused: false, lastWake: null, lastResponse: null, lastError: '', failureCount: 0, createdAt: new Date().toISOString() }
      store.sites.unshift(site)
      store.activity.unshift(activity(site, 'Monitor created', cadence))
      await saveStore()
      return send(response, 201, { site: serializeSite(site) })
    }
    if (!match) return send(response, 404, { error: 'Not found' })
    const site = store.sites.find((item) => item.id === match[1] && (item.ownerId || 'local') === request.userId)
    if (!site) return send(response, 404, { error: 'Website not found' })
    if (request.method === 'POST' && match[2] === 'wake') { const result = await wake(site); return send(response, result.ok ? 200 : 502, { site: serializeSite(site), ...result }) }
    if (request.method === 'PATCH') { const input = await body(request); site.paused = input.paused === undefined ? site.paused : Boolean(input.paused); if (input.cadence && allowedCadences.has(String(input.cadence))) site.cadence = String(input.cadence); if (input.retries !== undefined) site.retries = Math.max(0, Math.min(5, Number(input.retries))); if (input.expectedStatus) site.expectedStatus = String(input.expectedStatus); store.activity.unshift(activity(site, site.paused ? 'Schedule paused' : 'Monitor settings updated', site.paused ? 'By you' : `${site.cadence} · ${site.retries} retries`)); await saveStore(); return send(response, 200, { site: serializeSite(site) }) }
    if (request.method === 'DELETE') { store.sites = store.sites.filter((item) => item.id !== site.id); store.activity.unshift(activity(site, 'Monitor removed', 'By you')); await saveStore(); return send(response, 200, { ok: true }) }
    return send(response, 405, { error: 'Method not allowed' })
  } catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : 'Request failed' }) }
})
server.listen(PORT, () => console.log(`NikWake bot listening at http://localhost:${PORT}`))
