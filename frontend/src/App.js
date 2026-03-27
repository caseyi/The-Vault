import React, { useState, useEffect, useCallback } from 'react';
import Gallery from './pages/Gallery';
import ModelDetail from './pages/ModelDetail';
import Sidebar from './components/Sidebar';
import ScanModal from './components/ScanModal';
import './App.css';

const API = '';

export default function App() {
  const [view, setView] = useState('gallery');
  const [selectedModel, setSelectedModel] = useState(null);
  const [stats, setStats] = useState(null);
  const [creators, setCreators] = useState([]);
  const [filters, setFilters] = useState({ search: '', creator: '', status: '', tags: '' });
  const [showScan, setShowScan] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showHidden, setShowHidden] = useState(false);
  const [appVersion, setAppVersion] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    fetch(`${API}/api/health`).then(r => r.json())
      .then(d => setAppVersion(d.version ? `${d.version}.${d.build}` : null))
      .catch(() => {});
  }, []);

  const fetchStats = useCallback(() => {
    fetch(`${API}/api/stats`).then(r => r.json()).then(setStats).catch(() => {});
    fetch(`${API}/api/creators`).then(r => r.json()).then(setCreators).catch(() => {});
  }, []);

  useEffect(() => { fetchStats(); }, [fetchStats]);

  // Auto-open scan modal if a scan is already in progress on page load
  useEffect(() => {
    fetch(`${API}/api/scan/status`)
      .then(r => r.json())
      .then(s => { if (s.inProgress) setShowScan(true); })
      .catch(() => {});
  }, []);

  const openModel = (model) => { setSelectedModel(model); setView('detail'); };
  const closeModel = () => { setSelectedModel(null); setView('gallery'); };

  return (
    <div className={`app ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}>
      <Sidebar
        open={sidebarOpen}
        onToggle={() => setSidebarOpen(o => !o)}
        stats={stats}
        creators={creators}
        filters={filters}
        onFilterChange={setFilters}
        onScanClick={() => setShowScan(true)}
        onHomeClick={closeModel}
        showHidden={showHidden}
        onToggleHidden={() => setShowHidden(h => !h)}
        appVersion={appVersion}
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
          />
        )}
        {view === 'detail' && selectedModel && (
          <ModelDetail
            modelId={selectedModel.id}
            onBack={closeModel}
            onSaved={fetchStats}
          />
        )}
      </main>
      {showScan && (
        <ScanModal
          onClose={() => { setShowScan(false); fetchStats(); setRefreshKey(k => k + 1); }}
          onScanComplete={() => { fetchStats(); setRefreshKey(k => k + 1); }}
        />
      )}
    </div>
  );
}
