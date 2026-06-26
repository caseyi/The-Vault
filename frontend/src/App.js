import React, { useState, useEffect, useCallback, useRef } from 'react';
import Gallery from './pages/Gallery';
import ModelDetail from './pages/ModelDetail';
import PrintQueue from './pages/PrintQueue';
import Wishlist from './pages/Wishlist';
import Sidebar from './components/Sidebar';
import ScanModal from './components/ScanModal';
import OrganizeModal from './components/OrganizeModal';
import './App.css';

const API = '';

export default function App() {
  const [view, setView] = useState('gallery');
  const [selectedModel, setSelectedModel] = useState(null);
  const [stats, setStats] = useState(null);
  const [creators, setCreators] = useState([]);
  const [filters, setFilters] = useState({ search: '', creator: '', status: '', tags: '', franchise: '', collection: '', folder: '', has_thumbnail: false, recently_added: false, favorite: false })
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
  const [showHidden, setShowHidden] = useState(false);
  const [appVersion, setAppVersion] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [queueCount, setQueueCount] = useState(0);
  const [wishlistCount, setWishlistCount] = useState(0);
  const [collections, setCollections] = useState([]);
  const [recentlyViewed, setRecentlyViewed] = useState(() => {
    try { return JSON.parse(localStorage.getItem('vault_recently_viewed') || '[]'); } catch { return []; }
  });
  const [scanStatus, setScanStatus] = useState({ inProgress: false, count: 0, last: '' });
  const [scanToast, setScanToast] = useState(null);
  const scanWasRunning = useRef(false);

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
      .then(d => setAppVersion(d.version ? `${d.version}.${d.build}` : null))
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
            setScanToast(s.summary.success
              ? `✓ Scan complete — ${s.summary.modelsAdded ?? 0} added, ${s.summary.modelsFound ?? 0} found`
              : `✗ Scan failed: ${s.summary.error || 'unknown error'}`);
            setTimeout(() => setScanToast(null), 7000);
          }
        }
        scanWasRunning.current = s.inProgress;
      } catch {}
    };
    poll();
    const id = setInterval(poll, 3500);
    return () => { active = false; clearInterval(id); };
  }, [fetchStats]);

  // Auto-open scan modal if a scan is already in progress on page load
  useEffect(() => {
    fetch(`${API}/api/scan/status`)
      .then(r => r.json())
      .then(s => { if (s.inProgress) setShowScan(true); })
      .catch(() => {});
  }, []);

  const openModel = (model) => {
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
  const openQueue = () => { setSelectedModel(null); setView('queue'); };
  const openWishlist = () => { setSelectedModel(null); setView('wishlist'); };

  return (
    <div className={`app ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'} density-${density}`}>
      <Sidebar
        open={sidebarOpen}
        onToggle={() => setSidebarOpen(o => !o)}
        stats={stats}
        creators={creators}
        tags={tags}
        filters={filters}
        onFilterChange={setFilters}
        onScanClick={() => setShowScan(true)}
        onOrganizeClick={() => setShowOrganize(true)}
        onHomeClick={closeModel}
        showHidden={showHidden}
        onToggleHidden={() => setShowHidden(h => !h)}
        appVersion={appVersion}
        onRescanCreator={() => setShowScan(true)}
        franchises={stats?.franchises || []}
        collections={collections}
        queueCount={queueCount}
        onQueueClick={openQueue}
        onWishlistClick={openWishlist}
        wishlistCount={wishlistCount}
        onCollectionClick={(id) => { setFilters(f => ({ ...f, collection: id })); setView('gallery'); }}
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
      <main className="main-content">
        {view === 'gallery' && (
          <Gallery
            filters={filters}
            onFilterChange={setFilters}
            onModelClick={openModel}
            showHidden={showHidden}
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
        />
      )}

      {/* Background-scan toast (completion) */}
      {scanToast && (
        <div
          onClick={() => setScanToast(null)}
          style={{
            position: 'fixed', bottom: 20, right: 20, zIndex: 500,
            background: 'var(--bg2)', border: '1px solid var(--border-bright)',
            borderLeft: '3px solid var(--accent)', borderRadius: 8,
            padding: '12px 16px', maxWidth: 320, cursor: 'pointer',
            boxShadow: '0 8px 28px rgba(0,0,0,0.5)',
            fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font-body)',
          }}
          title="Dismiss"
        >
          {scanToast}
        </div>
      )}
    </div>
  );
}
