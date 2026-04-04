import React, { useState, useEffect, useCallback } from 'react';
import Gallery from './pages/Gallery';
import ModelDetail from './pages/ModelDetail';
import PrintQueue from './pages/PrintQueue';
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
  const [filters, setFilters] = useState({ search: '', creator: '', status: '', tags: '', franchise: '', collection: '', has_thumbnail: false, recently_added: false })
  const [tags, setTags] = useState([]);
  const [showScan, setShowScan] = useState(false);
  const [showOrganize, setShowOrganize] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showHidden, setShowHidden] = useState(false);
  const [appVersion, setAppVersion] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [queueCount, setQueueCount] = useState(0);
  const [collections, setCollections] = useState([]);

  const fetchQueueCount = useCallback(() => {
    fetch('/api/queue').then(r => r.json()).then(q => setQueueCount(q.length)).catch(() => {});
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
  }, []);

  useEffect(() => { fetchStats(); fetchQueueCount(); fetchCollections(); }, [fetchStats, fetchQueueCount, fetchCollections]);

  // Auto-open scan modal if a scan is already in progress on page load
  useEffect(() => {
    fetch(`${API}/api/scan/status`)
      .then(r => r.json())
      .then(s => { if (s.inProgress) setShowScan(true); })
      .catch(() => {});
  }, []);

  const openModel = (model) => { setSelectedModel(model); setView('detail'); };
  const closeModel = () => { setSelectedModel(null); setView('gallery'); };
  const openQueue = () => { setSelectedModel(null); setView('queue'); };

  return (
    <div className={`app ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}>
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
        onCollectionClick={(id) => { setFilters(f => ({ ...f, collection: id })); setView('gallery'); }}
        onCollectionsChange={fetchCollections}
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
    </div>
  );
}
