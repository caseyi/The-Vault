import React, { useState, useEffect, useCallback, useRef } from 'react';
import Gallery from './pages/Gallery';
import ModelDetail from './pages/ModelDetail';
import PrintQueue from './pages/PrintQueue';
import Wishlist from './pages/Wishlist';
import Sidebar from './components/Sidebar';
import ScanModal from './components/ScanModal';
import OrganizeModal from './components/OrganizeModal';
import Modal, { useUniqueId } from './components/Modal';
import { NoticeProvider, useNotify } from './components/Notices';
import { EMPTY_FILTERS } from './filters';
import './App.css';

const API = '';
const MOBILE_QUERY = '(max-width: 768px)';

// Native desktop builds inject one of these; the Docker/browser build has neither.
export function isNativeApp() {
  return typeof window !== 'undefined' && !!(window.__TAURI__ || window.__VAULT_API__);
}

function useMediaQuery(query) {
  const get = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else if (mql.addListener) mql.addListener(onChange);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', onChange);
      else if (mql.removeListener) mql.removeListener(onChange);
    };
  }, [query]);
  return matches;
}

export default function App() {
  return (
    <NoticeProvider>
      <VaultApp />
    </NoticeProvider>
  );
}

function VaultApp() {
  const notify = useNotify();
  const onboardingTitleId = useUniqueId('onboarding-title');
  const [view, setView] = useState('gallery');
  const [selectedModel, setSelectedModel] = useState(null);
  const [stats, setStats] = useState(null);
  const [creators, setCreators] = useState([]);
  const [filters, setFilters] = useState(() => ({ ...EMPTY_FILTERS }));
  const [tags, setTags] = useState([]);
  const [folderTree, setFolderTree] = useState(null);
  const [density, setDensity] = useState(() => {
    try { return localStorage.getItem('vault_density') || 'comfortable'; } catch { return 'comfortable'; }
  });
  const toggleDensity = () => setDensity(d => {
    const n = d === 'compact' ? 'comfortable' : 'compact';
    try { localStorage.setItem('vault_density', n); } catch {}
    return n;
  });
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('vault_theme') || 'dark'; } catch { return 'dark'; }
  });
  const toggleTheme = () => setTheme(t => {
    const n = t === 'light' ? 'dark' : 'light';
    try { localStorage.setItem('vault_theme', n); } catch {}
    return n;
  });
  useEffect(() => {
    document.documentElement.classList.toggle('theme-light', theme === 'light');
  }, [theme]);
  const [showScan, setShowScan] = useState(false);
  const [showOrganize, setShowOrganize] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [appVersion, setAppVersion] = useState(null);
  const [health, setHealth] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [queueCount, setQueueCount] = useState(0);
  const [wishlistCount, setWishlistCount] = useState(0);
  const [collections, setCollections] = useState([]);
  const [recentlyViewed, setRecentlyViewed] = useState(() => {
    try { return JSON.parse(localStorage.getItem('vault_recently_viewed') || '[]'); } catch { return []; }
  });
  const [scanStatus, setScanStatus] = useState({ inProgress: false, count: 0, last: '' });
  const scanWasRunning = useRef(false);
  const [onboarded, setOnboarded] = useState(() => {
    try { return localStorage.getItem('vault_onboarded') === '1'; } catch { return true; }
  });
  const dismissOnboarding = () => {
    try { localStorage.setItem('vault_onboarded', '1'); } catch {}
    setOnboarded(true);
  };

  const fetchQueueCount = useCallback(() => {
    fetch('/api/queue').then(r => r.json()).then(q => setQueueCount(q.length)).catch(() => {});
  }, []);

  const fetchWishlistCount = useCallback(() => {
    fetch('/api/wishlist').then(r => r.json()).then(w => setWishlistCount(w.filter(i => i.status === 'want').length)).catch(() => {});
  }, []);

  const fetchCollections = useCallback(() => {
    fetch('/api/collections').then(r => r.json()).then(setCollections).catch(() => {});
  }, []);

  useEffect(() => {
    fetch(`${API}/api/health`).then(r => r.json())
      .then(d => {
        setHealth(d || null);
        setAppVersion(d && d.version ? `${d.version}${d.build != null && d.build !== '' ? `.${d.build}` : ''}` : null);
      })
      .catch(() => {});
  }, []);

  const fetchStats = useCallback(() => {
    fetch(`${API}/api/stats`).then(r => r.json()).then(setStats).catch(() => {});
    fetch(`${API}/api/creators`).then(r => r.json()).then(setCreators).catch(() => {});
    fetch(`${API}/api/tags`).then(r => r.json()).then(setTags).catch(() => {});
    fetch(`${API}/api/library/tree`).then(r => r.json()).then(setFolderTree).catch(() => {});
  }, []);

  useEffect(() => { fetchStats(); fetchQueueCount(); fetchCollections(); fetchWishlistCount(); }, [fetchStats, fetchQueueCount, fetchCollections, fetchWishlistCount]);

  // Poll background scan progress so a running scan is visible app-wide (even
  // with the Scan window closed), and auto-refresh the gallery when it finishes.
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const r = await fetch(`${API}/api/scan/progress`);
        const s = await r.json();
        if (!active) return;
        setScanStatus(s);
        if (scanWasRunning.current && !s.inProgress) {
          fetchStats();
          setRefreshKey(k => k + 1);
          if (s.summary) {
            if (s.summary.success) {
              notify(`✓ Scan complete — ${s.summary.modelsAdded ?? 0} added, ${s.summary.modelsFound ?? 0} found`, { type: 'success', duration: 7000 });
            } else {
              notify(`✗ Scan failed: ${s.summary.error || 'unknown error'}`, { type: 'error', duration: 10000 });
            }
          }
        }
        scanWasRunning.current = s.inProgress;
      } catch {}
    };
    poll();
    const id = setInterval(poll, 3500);
    return () => { active = false; clearInterval(id); };
  }, [fetchStats, notify]);

  // Auto-open scan modal if a scan is already in progress on page load
  useEffect(() => {
    fetch(`${API}/api/scan/status`)
      .then(r => r.json())
      .then(s => { if (s.inProgress) setShowScan(true); })
      .catch(() => {});
  }, []);

  const closeDrawer = () => setDrawerOpen(false);

  const openModel = (model) => {
    closeDrawer();
    setSelectedModel(model);
    setView('detail');
    // Track recently viewed (store minimal info for sidebar display)
    setRecentlyViewed(prev => {
      const entry = { id: model.id, name: model.name, thumbnail_path: model.thumbnail_path, creator_name: model.creator_name };
      const filtered = prev.filter(m => m.id !== model.id);
      const next = [entry, ...filtered].slice(0, 10);
      try { localStorage.setItem('vault_recently_viewed', JSON.stringify(next)); } catch {}
      return next;
    });
  };
  const closeModel = () => { setSelectedModel(null); setView('gallery'); };
  // Logo / "Gallery" click: back to the unfiltered gallery
  const goHome = () => { closeDrawer(); setFilters({ ...EMPTY_FILTERS }); setShowHidden(false); closeModel(); };
  const openQueue = () => { closeDrawer(); setSelectedModel(null); setView('queue'); };
  const openWishlist = () => { closeDrawer(); setSelectedModel(null); setView('wishlist'); };
  const openScan = () => { closeDrawer(); setShowScan(true); };
  const openOrganize = () => { closeDrawer(); setShowOrganize(true); };

  const sidebarExpanded = isMobile ? true : sidebarOpen;
  const appClass = [
    'app',
    sidebarExpanded ? 'sidebar-open' : 'sidebar-closed',
    `density-${density}`,
    isMobile ? 'is-mobile' : '',
    isMobile && drawerOpen ? 'drawer-open' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={appClass}>
      {isMobile && (
        <button className="mobile-menu-btn" onClick={() => setDrawerOpen(true)} aria-label="Open menu"
          aria-expanded={drawerOpen} aria-controls="app-sidebar">☰</button>
      )}
      {isMobile && drawerOpen && <div className="drawer-backdrop" onClick={closeDrawer} aria-hidden="true" />}
      <Sidebar
        open={sidebarExpanded}
        isMobile={isMobile}
        onToggle={() => (isMobile ? closeDrawer() : setSidebarOpen(o => !o))}
        stats={stats}
        creators={creators}
        tags={tags}
        filters={filters}
        onFilterChange={setFilters}
        onScanClick={openScan}
        onOrganizeClick={openOrganize}
        onHomeClick={goHome}
        showHidden={showHidden}
        onToggleHidden={() => setShowHidden(h => !h)}
        appVersion={appVersion}
        gitSha={health?.gitSha}
        onRescanCreator={openScan}
        franchises={stats?.franchises || []}
        collections={collections}
        queueCount={queueCount}
        onQueueClick={openQueue}
        onWishlistClick={openWishlist}
        wishlistCount={wishlistCount}
        onCollectionClick={(id) => { closeDrawer(); setFilters(f => ({ ...f, collection: id })); setView('gallery'); }}
        onCollectionsChange={fetchCollections}
        recentlyViewed={recentlyViewed}
        onRecentClick={openModel}
        folderTree={folderTree}
        onFolderSelect={(p) => { setFilters(f => ({ ...f, folder: p })); setView('gallery'); }}
        density={density}
        onToggleDensity={toggleDensity}
        theme={theme}
        onToggleTheme={toggleTheme}
        onTagsChange={() => { fetchStats(); setRefreshKey(k => k + 1); }}
        scanRunning={scanStatus.inProgress}
        scanCount={scanStatus.count}
        scanLast={scanStatus.last}
      />
      <main className="main-content" inert={isMobile && drawerOpen ? '' : undefined}>
        {view === 'gallery' && (
          <Gallery
            filters={filters}
            onFilterChange={setFilters}
            onModelClick={openModel}
            showHidden={showHidden}
            onToggleHidden={() => setShowHidden(h => !h)}
            onScanClick={openScan}
            onRefreshStats={fetchStats}
            refreshKey={refreshKey}
            collections={collections}
            onRefreshCollections={fetchCollections}
          />
        )}
        {view === 'detail' && selectedModel && (
          <ModelDetail
            modelId={selectedModel.id}
            onBack={closeModel}
            onSaved={() => { fetchStats(); fetchQueueCount(); fetchCollections(); }}
            onQueueChange={fetchQueueCount}
            collections={collections}
            onCollectionsChange={fetchCollections}
          />
        )}
        {view === 'queue' && (
          <PrintQueue
            onModelClick={openModel}
            onQueueChange={fetchQueueCount}
          />
        )}
        {view === 'wishlist' && (
          <Wishlist
            onBack={closeModel}
            onWishlistChange={fetchWishlistCount}
          />
        )}
      </main>
      {showScan && (
        <ScanModal
          onClose={() => { setShowScan(false); fetchStats(); setRefreshKey(k => k + 1); }}
          onScanComplete={() => { fetchStats(); setRefreshKey(k => k + 1); }}
        />
      )}
      {showOrganize && (
        <OrganizeModal
          onClose={() => { setShowOrganize(false); fetchStats(); }}
          libraryWritable={health ? health.libraryWritable : undefined}
          libraryPath={health?.libraryPath}
        />
      )}

      {/* First-run onboarding (shown once, when the library is empty) */}
      {!onboarded && stats && (stats.total || 0) === 0 && !scanStatus.inProgress && (
        <Modal onClose={dismissOnboarding} labelledBy={onboardingTitleId} className="modal onboarding-modal">
          <div style={{ fontSize: 40, marginBottom: 6 }} aria-hidden="true">🗃️</div>
          <div className="modal-title" id={onboardingTitleId} style={{ textAlign: 'center' }}>WELCOME TO THE VAULT</div>
          <div className="modal-subtitle" style={{ textAlign: 'center' }}>Your self-hosted 3D-print library. Three quick things:</div>
          <div className="onboarding-steps">
            {isNativeApp() ? (
              <div><b>1. Scan</b> &nbsp;Point it at your prints folder to index models and pull preview images.</div>
            ) : (
              <div><b>1. Scan</b> &nbsp;Your library folder (set in docker-compose / <code>.env</code>) is ready to scan — indexing pulls in models and preview images.</div>
            )}
            <div><b>2. Organize</b> &nbsp;Browse by folder, creator, tags, favorites ⭐, and collections.</div>
            <div><b>3. AI (optional)</b> &nbsp;Add a Claude API key for auto-tagging and finding thumbnails.</div>
          </div>
          <div className="modal-actions" style={{ justifyContent: 'center', marginTop: 8 }}>
            <button className="btn-cancel" onClick={dismissOnboarding}>Skip</button>
            <button className="btn-primary" onClick={() => { dismissOnboarding(); setShowScan(true); }}>⟳ Scan your library</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
