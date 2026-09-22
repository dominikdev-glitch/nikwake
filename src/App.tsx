import { useCallback, useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { createUserWithEmailAndPassword, onAuthStateChanged, signInWithEmailAndPassword, signInWithPopup, signOut, updateProfile } from 'firebase/auth'
import type { User } from 'firebase/auth'
import { auth, firebaseConfigured, googleProvider } from './firebase'
import './App.css'
import './auth.css'

type SiteStatus = 'Online' | 'Paused' | 'Degraded'
type Site = { id: string; url: string; label: string; cadence: string; status: SiteStatus; lastWake: string; response: string; initials: string; tone?: string; retries?: number; expectedStatus?: string; failureCount?: number; lastStatusCode?: number }
type Activity = { id: string; site: string; action: string; detail: string; time: string; kind: 'success' | 'info' | 'error' }
type Page = 'overview' | 'sites' | 'activity' | 'settings' | 'docs'

function pageFromHash(): Page {
  const hash = window.location.hash.replace('#', '')
  return ['overview', 'sites', 'activity', 'settings', 'docs'].includes(hash) ? hash as Page : 'overview'
}

function App() {
  const [authUser, setAuthUser] = useState<User | null>(null)
  const [authReady, setAuthReady] = useState(!firebaseConfigured)
  const [page, setPage] = useState<Page>(() => pageFromHash())
  const [sites, setSites] = useState<Site[]>([])
  const [activity, setActivity] = useState<Activity[]>([])
  const [url, setUrl] = useState('')
  const [cadence, setCadence] = useState('Every 10 minutes')
  const [retries, setRetries] = useState('2')
  const [expectedStatus, setExpectedStatus] = useState('200-399')
  const [notice, setNotice] = useState('')
  const [wakesThisWeek, setWakesThisWeek] = useState(0)
  const [failuresThisWeek, setFailuresThisWeek] = useState(0)
  const onlineCount = sites.filter((site) => site.status === 'Online').length

  useEffect(() => {
    if (!auth || !firebaseConfigured) return
    return onAuthStateChanged(auth, (user) => { setAuthUser(user); setAuthReady(true) })
  }, [])

  useEffect(() => {
    const onHashChange = () => setPage(pageFromHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const apiFetch = useCallback(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    if (authUser) headers.set('authorization', `Bearer ${await authUser.getIdToken()}`)
    return fetch(input, { ...init, headers })
  }, [authUser])

  const refresh = useCallback(async () => {
    const response = await apiFetch('/api/dashboard')
    if (!response.ok) throw new Error('NikWake bot is offline')
    const data = await response.json() as { sites: Site[]; activity: Activity[]; wakesThisWeek: number; failuresThisWeek: number }
    setSites(data.sites)
    setActivity(data.activity)
    setWakesThisWeek(data.wakesThisWeek)
    setFailuresThisWeek(data.failuresThisWeek)
  }, [apiFetch])

  useEffect(() => {
    if (!authReady || !authUser) return
    refresh().catch((error: Error) => setNotice(error.message))
    const timer = window.setInterval(() => refresh().catch(() => undefined), 30_000)
    return () => window.clearInterval(timer)
  }, [authReady, authUser, refresh])

  async function addSite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!url.trim()) return
    const response = await apiFetch('/api/sites', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, cadence, retries: Number(retries), expectedStatus }) })
    const data = await response.json() as { error?: string; site?: Site }
    if (!response.ok) { setNotice(data.error || 'Could not add website'); return }
    setUrl(''); setNotice(`${data.site?.label || 'Website'} is now being watched`); await refresh()
  }
  async function wakeSite(site: Site) {
    const response = await apiFetch(`/api/sites/${site.id}/wake`, { method: 'POST' })
    const data = await response.json() as { error?: string; responseMs?: number }
    setNotice(response.ok ? `${site.label} woke up in ${data.responseMs} ms` : `${site.label}: ${data.error || 'wake failed'}`); await refresh()
  }
  async function toggleSite(site: Site) {
    const paused = site.status !== 'Paused'
    await apiFetch(`/api/sites/${site.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paused }) })
    await refresh()
  }
  async function updateSite(site: Site, changes: { cadence: string; retries: number; expectedStatus: string }) {
    const response = await apiFetch(`/api/sites/${site.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(changes) })
    const data = await response.json() as { error?: string }
    setNotice(response.ok ? `${site.label} settings updated` : data.error || 'Could not update monitor')
    await refresh()
  }
  async function removeSite(site: Site) { await apiFetch(`/api/sites/${site.id}`, { method: 'DELETE' }); setNotice(`${site.label} was removed`); await refresh() }

  if (!authReady) return <div className="auth-loading"><span className="brand-mark">NW</span><span>Loading NikWake</span></div>
  if (!firebaseConfigured) return <SetupScreen />
  if (!authUser) return <AuthScreen />

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">NW</span><span>NikWake</span></div>
      <div className="workspace-switcher"><span className="workspace-dot" /><span><strong>{authUser.displayName || authUser.email?.split('@')[0] || 'My workspace'}</strong><small>Personal workspace</small></span><span className="chevron">⌄</span></div>
      <nav><p className="nav-label">Workspace</p><a className={`nav-item ${page === 'overview' ? 'active' : ''}`} href="#overview"><span className="nav-icon">▦</span>Overview</a><a className={`nav-item ${page === 'sites' ? 'active' : ''}`} href="#sites"><span className="nav-icon">◉</span>All websites <span className="nav-count">{sites.length}</span></a><a className={`nav-item ${page === 'activity' ? 'active' : ''}`} href="#activity"><span className="nav-icon">↯</span>Activity</a><p className="nav-label nav-label-spaced">Manage</p><a className={`nav-item ${page === 'settings' ? 'active' : ''}`} href="#settings"><span className="nav-icon">⚙</span>Settings</a><a className={`nav-item ${page === 'docs' ? 'active' : ''}`} href="#docs"><span className="nav-icon">?</span>Documentation <span className="external">↗</span></a></nav>
      <div className="sidebar-bottom"><div className="mini-status"><span className="pulse-dot" /><span><strong>All systems operational</strong><small>Scheduler connected</small></span></div><div className="user-row"><span className="avatar">{(authUser.displayName || authUser.email || 'NW').slice(0, 2).toUpperCase()}</span><span><strong>{authUser.displayName || 'Account owner'}</strong><small>{authUser.email}</small></span><button className="signout-button" onClick={() => auth && signOut(auth)} aria-label="Sign out">↪</button></div></div>
    </aside>
    <main className="main-content" id="overview">
      <header className="topbar"><div className="breadcrumbs"><span>Workspace</span><span>/</span><strong>{pageLabel(page)}</strong></div><div className="top-actions"><button className="icon-button" aria-label="Notifications">♧<span className="notification-dot" /></button><button className="help-button">Need help? <span>↗</span></button></div></header>
      <div className="content-wrap">
        {page === 'overview' && <OverviewPage authUser={authUser} sites={sites} activity={activity} onlineCount={onlineCount} wakesThisWeek={wakesThisWeek} failuresThisWeek={failuresThisWeek} url={url} setUrl={setUrl} cadence={cadence} setCadence={setCadence} retries={retries} setRetries={setRetries} expectedStatus={expectedStatus} setExpectedStatus={setExpectedStatus} addSite={addSite} notice={notice} setNotice={setNotice} wakeSite={wakeSite} toggleSite={toggleSite} removeSite={removeSite} />}
        {page === 'sites' && <SitesPage sites={sites} onWake={wakeSite} onToggle={toggleSite} onRemove={removeSite} onUpdate={updateSite} />}
        {page === 'activity' && <ActivityPage activity={activity} />}
        {page === 'settings' && <SettingsPage authUser={authUser} />}
        {page === 'docs' && <DocsPage />}
      </div>
    </main>
  </div>
}

function pageLabel(page: Page) { return page === 'sites' ? 'All websites' : page.charAt(0).toUpperCase() + page.slice(1) }

type DashboardProps = { authUser: User; sites: Site[]; activity: Activity[]; onlineCount: number; wakesThisWeek: number; failuresThisWeek: number; url: string; setUrl: (value: string) => void; cadence: string; setCadence: (value: string) => void; retries: string; setRetries: (value: string) => void; expectedStatus: string; setExpectedStatus: (value: string) => void; addSite: (event: FormEvent<HTMLFormElement>) => void; notice: string; setNotice: (value: string) => void; wakeSite: (site: Site) => void; toggleSite: (site: Site) => void; removeSite: (site: Site) => void }

function PageIntro({ eyebrow, title, copy, action }: { eyebrow: string; title: string; copy: string; action?: ReactNode }) {
  return <section className="page-intro"><div><div className="eyebrow"><span className="spark">✦</span>{eyebrow}</div><h1>{title}</h1><p>{copy}</p></div>{action}</section>
}

function OverviewPage(props: DashboardProps) {
  const { authUser, sites, activity, onlineCount, wakesThisWeek, failuresThisWeek, url, setUrl, cadence, setCadence, retries, setRetries, expectedStatus, setExpectedStatus, addSite, notice, setNotice, wakeSite, toggleSite, removeSite } = props
  return <><section className="intro"><div><div className="eyebrow"><span className="spark">✦</span> NIKWAKE CONTROL CENTER</div><h1>Welcome back, {authUser.displayName?.split(' ')[0] || authUser.email?.split('@')[0] || 'there'}.</h1><p>Keep your websites awake and ready for visitors.</p></div><div className="live-pill"><span className="pulse-dot" />Monitoring live</div></section><section className="stat-grid" aria-label="Workspace summary"><div className="stat-card"><div className="stat-top"><span>Websites watched</span><span className="stat-icon peach-icon">◉</span></div><strong>{sites.length}</strong><span className="stat-foot"><b className="up">{sites.filter((site) => site.failureCount).length ? 'Needs attention' : 'Healthy'}</b> monitor fleet</span></div><div className="stat-card"><div className="stat-top"><span>Currently online</span><span className="stat-icon mint-icon">✓</span></div><strong>{onlineCount}<small>/{sites.length}</small></strong><span className="stat-foot"><span className="green-line" />{failuresThisWeek ? `${failuresThisWeek} failed wakes` : 'All looking good'}</span></div><div className="stat-card"><div className="stat-top"><span>Wakes this week</span><span className="stat-icon blue-icon">↯</span></div><strong>{wakesThisWeek}</strong><span className="stat-foot"><b className="up">Live</b> from scheduler</span></div></section><AddMonitor {...{ url, setUrl, cadence, setCadence, retries, setRetries, expectedStatus, setExpectedStatus, addSite }} />{notice && <div className="notice" role="status"><span>✓</span>{notice}<button onClick={() => setNotice('')} aria-label="Dismiss notification">×</button></div>}<section className="dashboard-split"><div><div className="section-heading"><div><h2>Websites needing attention</h2><p>Prioritize degraded monitors first.</p></div><a className="text-button" href="#sites">View all →</a></div><SiteTable sites={sites.filter((site) => site.status !== 'Online')} onWake={wakeSite} onToggle={toggleSite} onRemove={removeSite} empty="Everything is healthy right now." /></div><div className="activity-panel compact-panel"><div className="panel-heading"><div><h2>Recent activity</h2><p>Latest scheduler events.</p></div><a className="text-button" href="#activity">View all →</a></div><ActivityList activity={activity.slice(0, 4)} /></div></section></>
}

function AddMonitor({ url, setUrl, cadence, setCadence, retries, setRetries, expectedStatus, setExpectedStatus, addSite }: Pick<DashboardProps, 'url' | 'setUrl' | 'cadence' | 'setCadence' | 'retries' | 'setRetries' | 'expectedStatus' | 'setExpectedStatus' | 'addSite'>) {
  return <section className="add-panel"><div className="add-copy"><div className="add-icon">+</div><div><h2>Add a website</h2><p>Paste a URL and tune its wake policy.</p></div></div><form className="add-form" onSubmit={addSite}><input aria-label="Website URL" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://your-website.com" type="text" /><select aria-label="Wake frequency" value={cadence} onChange={(event) => setCadence(event.target.value)}><option>Every 1 minute</option><option>Every 5 minutes</option><option>Every 10 minutes</option><option>Every 15 minutes</option><option>Every 30 minutes</option><option>Every hour</option></select><select aria-label="Retries" value={retries} onChange={(event) => setRetries(event.target.value)}><option value="0">No retries</option><option value="1">1 retry</option><option value="2">2 retries</option><option value="3">3 retries</option><option value="5">5 retries</option></select><select aria-label="Expected status" value={expectedStatus} onChange={(event) => setExpectedStatus(event.target.value)}><option>200-399</option><option>200</option><option>201</option><option>204</option></select><button className="primary-button" type="submit">Start watching <span>→</span></button></form></section>
}

function SiteTable({ sites, onWake, onToggle, onRemove, onEdit, empty }: { sites: Site[]; onWake: (site: Site) => void; onToggle: (site: Site) => void; onRemove: (site: Site) => void; onEdit?: (site: Site) => void; empty: string }) {
  return <section className="sites-table" aria-label="Websites"><div className="table-head"><span>Website</span><span>Schedule</span><span>Last wake</span><span>Status</span><span /></div>{sites.map((site) => <SiteRow key={site.id} site={site} onWake={onWake} onToggle={onToggle} onRemove={onRemove} onEdit={onEdit} />)}{sites.length === 0 && <div className="empty-state"><span>✓</span><strong>{empty}</strong><p>No action is needed.</p></div>}</section>
}

function SiteRow({ site, onWake, onToggle, onRemove, onEdit }: { site: Site; onWake: (site: Site) => void; onToggle: (site: Site) => void; onRemove: (site: Site) => void; onEdit?: (site: Site) => void }) {
  return <div className="site-row"><div className="site-cell"><span className={`site-avatar ${site.tone || 'violet'}`}>{site.initials}</span><span><strong>{site.label}</strong><small>{site.url}</small></span></div><span className="schedule-cell"><span className="clock-icon">◷</span>{site.cadence}<small className="policy-line">{site.retries ?? 2} retries · expects {site.expectedStatus || '200-399'}</small></span><span className="last-cell"><strong>{site.lastWake}</strong><small>{site.response}{site.lastStatusCode ? ` · HTTP ${site.lastStatusCode}` : ''}</small></span><span className={`status-badge ${site.status.toLowerCase()}`}><span />{site.status}</span><div className="row-actions"><button onClick={() => onWake(site)} title="Wake website now" aria-label={`Wake ${site.label} now`}>↯</button>{onEdit && <button onClick={() => onEdit(site)} title="Edit monitor" aria-label={`Edit ${site.label}`}>⚙</button>}<button onClick={() => onToggle(site)} title={site.status === 'Paused' ? 'Resume schedule' : 'Pause schedule'} aria-label={site.status === 'Paused' ? `Resume ${site.label}` : `Pause ${site.label}`}>{site.status === 'Paused' ? '▶' : 'Ⅱ'}</button><button onClick={() => onRemove(site)} title="Remove website" aria-label={`Remove ${site.label}`}>×</button></div></div>
}

function SitesPage({ sites, onWake, onToggle, onRemove, onUpdate }: { sites: Site[]; onWake: (site: Site) => void; onToggle: (site: Site) => void; onRemove: (site: Site) => void; onUpdate: (site: Site, changes: { cadence: string; retries: number; expectedStatus: string }) => void }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'All' | SiteStatus>('All')
  const [editing, setEditing] = useState<Site | null>(null)
  const visibleSites = sites.filter((site) => (filter === 'All' || site.status === filter) && `${site.label} ${site.url}`.toLowerCase().includes(query.toLowerCase()))
  return <><PageIntro eyebrow="MONITOR FLEET" title="Your websites" copy="Manage schedules, policies, and wake actions from one place." action={<span className="live-pill"><span className="pulse-dot" />{sites.length} monitors</span>} /><div className="fleet-toolbar"><label className="search-field"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search websites" aria-label="Search websites" /></label><div className="filter-tabs">{(['All', 'Online', 'Degraded', 'Paused'] as const).map((option) => <button className={filter === option ? 'selected' : ''} key={option} onClick={() => setFilter(option)}>{option}<span>{option === 'All' ? sites.length : sites.filter((site) => site.status === option).length}</span></button>)}</div></div><SiteTable sites={visibleSites} onWake={onWake} onToggle={onToggle} onRemove={onRemove} onEdit={setEditing} empty={query || filter !== 'All' ? 'No monitors match this view.' : 'No websites watching yet.'} />{editing && <EditMonitor site={editing} onClose={() => setEditing(null)} onSave={(changes) => { onUpdate(editing, changes); setEditing(null) }} />}</>
}

function EditMonitor({ site, onClose, onSave }: { site: Site; onClose: () => void; onSave: (changes: { cadence: string; retries: number; expectedStatus: string }) => void }) {
  const [cadence, setCadence] = useState(site.cadence)
  const [retries, setRetries] = useState(String(site.retries ?? 2))
  const [expectedStatus, setExpectedStatus] = useState(site.expectedStatus || '200-399')
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}><section className="edit-modal" role="dialog" aria-modal="true" aria-labelledby="edit-monitor-title"><div className="modal-heading"><div><span className="eyebrow">MONITOR POLICY</span><h2 id="edit-monitor-title">{site.label}</h2></div><button onClick={onClose} aria-label="Close">×</button></div><p className="modal-url">{site.url}</p><label>Wake frequency<select value={cadence} onChange={(event) => setCadence(event.target.value)}><option>Every 1 minute</option><option>Every 5 minutes</option><option>Every 10 minutes</option><option>Every 15 minutes</option><option>Every 30 minutes</option><option>Every hour</option></select></label><label>Retries<select value={retries} onChange={(event) => setRetries(event.target.value)}><option value="0">No retries</option><option value="1">1 retry</option><option value="2">2 retries</option><option value="3">3 retries</option><option value="5">5 retries</option></select></label><label>Expected HTTP status<select value={expectedStatus} onChange={(event) => setExpectedStatus(event.target.value)}><option>200-399</option><option>200</option><option>201</option><option>204</option></select></label><div className="modal-actions"><button className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" onClick={() => onSave({ cadence, retries: Number(retries), expectedStatus })}>Save policy <span>→</span></button></div></section></div>
}
function ActivityList({ activity }: { activity: Activity[] }) { return <div className="activity-list">{activity.map((item) => <div className="activity-item" key={item.id}><span className={`activity-icon ${item.kind}`}>{item.kind === 'success' ? '✓' : item.kind === 'error' ? '!' : 'Ⅱ'}</span><span className="activity-copy"><strong>{item.action}</strong><small>{item.site} · {item.detail}</small></span><span className="activity-time">{item.time}</span></div>)}</div> }
function ActivityPage({ activity }: { activity: Activity[] }) { return <><PageIntro eyebrow="EVENT STREAM" title="Activity" copy="A complete timeline of requests, retries, failures, and monitor changes." /><div className="full-panel activity-page-panel"><ActivityList activity={activity} /></div></> }
function SettingsPage({ authUser }: { authUser: User }) { return <><PageIntro eyebrow="WORKSPACE SETTINGS" title="Settings" copy="Your account is securely connected to Firebase Authentication." /><div className="settings-grid"><div className="full-panel setting-card"><span className="setting-label">Signed-in account</span><strong>{authUser.displayName || 'Account owner'}</strong><p>{authUser.email}</p><span className="verified-pill">✓ Firebase verified</span></div><div className="full-panel setting-card"><span className="setting-label">Scheduler policy</span><strong>Real HTTP requests</strong><p>Requests use retries, timeouts, and expected-status validation.</p><span className="verified-pill">● Production ready</span></div></div></> }
function DocsPage() { return <><PageIntro eyebrow="NIKWAKE GUIDE" title="How NikWake works" copy="A quiet, reliable loop for keeping your sites ready." /><div className="docs-grid"><div className="full-panel doc-card"><span className="doc-number">01</span><h2>Watch</h2><p>Add a public HTTP or HTTPS URL. NikWake validates it before creating a monitor.</p></div><div className="full-panel doc-card"><span className="doc-number">02</span><h2>Wake</h2><p>The scheduler sends a real request on your chosen cadence with a 15-second timeout.</p></div><div className="full-panel doc-card"><span className="doc-number">03</span><h2>Report</h2><p>Every response records latency, HTTP status, retries, errors, and current health.</p></div></div></> }

function AuthScreen() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setBusy(true)
    try {
      if (!auth) throw new Error('Firebase is not available')
      if (mode === 'signup') { const credential = await createUserWithEmailAndPassword(auth, email, password); if (name.trim()) await updateProfile(credential.user, { displayName: name.trim() }) }
      else await signInWithEmailAndPassword(auth, email, password)
    } catch (caught) { setError(caught instanceof Error ? caught.message.replace('Firebase: ', '') : 'Authentication failed') } finally { setBusy(false) }
  }

  return <main className="auth-page"><div className="auth-decoration"><span className="auth-orbit orbit-one" /><span className="auth-orbit orbit-two" /><span className="auth-signal">↯</span></div><section className="auth-card"><div className="auth-brand"><span className="brand-mark">NW</span><strong>NikWake</strong></div><p className="auth-kicker">WEBSITE WAKE CONTROL</p><h1>{mode === 'signin' ? 'Welcome back.' : 'Start waking sites.'}</h1><p className="auth-copy">{mode === 'signin' ? 'Sign in to manage your monitors and keep every deployment ready.' : 'Create your private workspace and put your first monitor on a schedule.'}</p><button className="google-button" onClick={() => auth && signInWithPopup(auth, googleProvider)}><span className="google-mark">G</span> Continue with Google</button><div className="auth-divider"><span>or use email</span></div><form onSubmit={submit} className="auth-form">{mode === 'signup' && <label>Display name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" autoComplete="name" /></label>}<label>Email address<input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" type="email" autoComplete="email" required /></label><label>Password<input value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 6 characters" type="password" minLength={6} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} required /></label>{error && <p className="auth-error" role="alert">{error}</p>}<button className="primary-button auth-submit" disabled={busy} type="submit">{busy ? 'Connecting...' : mode === 'signin' ? 'Sign in' : 'Create account'} <span>→</span></button></form><p className="auth-switch">{mode === 'signin' ? 'New to NikWake?' : 'Already have an account?'} <button onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError('') }}>{mode === 'signin' ? 'Create an account' : 'Sign in'}</button></p></section><p className="auth-footer">Secure authentication powered by Firebase</p></main>
}

function SetupScreen() {
  return <main className="auth-page"><section className="auth-card setup-card"><div className="auth-brand"><span className="brand-mark">NW</span><strong>NikWake</strong></div><p className="auth-kicker">ONE LAST SETUP STEP</p><h1>Connect Firebase.</h1><p className="auth-copy">Add your Firebase web app values to a local `.env` file, then restart Vite. NikWake intentionally stops here instead of showing a fake workspace.</p><div className="setup-steps"><span>1</span><p>Copy `.env.example` to `.env`</p><span>2</span><p>Paste the Firebase web configuration</p><span>3</span><p>Enable Email/Password or Google in Firebase Authentication</p></div><code>npm run dev:all</code></section></main>
}

export default App
