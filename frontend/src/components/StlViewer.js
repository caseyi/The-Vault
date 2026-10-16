import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// Three.js STL preview. Bundled from npm (no CDN), so it works on an offline
// NAS; ModelDetail lazy-loads this module so three.js stays out of the main
// bundle. Everything created in the effect is disposed on unmount.

const COLOR_PRESETS = [
  { name: 'Grey',    hex: 0xc8c8d4, css: '#c8c8d4' },
  { name: 'Resin',   hex: 0xe8e0c8, css: '#e8e0c8' },
  { name: 'Orange',  hex: 0xe07820, css: '#e07820' },
  { name: 'Black',   hex: 0x282828, css: '#282828' },
  { name: 'White',   hex: 0xf0f0f0, css: '#f0f0f0' },
  { name: 'Green',   hex: 0x3aaf6a, css: '#3aaf6a' },
];

function cssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch { return fallback; }
}

function themeColors() {
  const light = document.documentElement.classList.contains('theme-light');
  return {
    background: cssVar('--bg3', light ? '#eef0f3' : '#1c1c21'),
    grid: light ? 0xc3c7ce : 0x2e2e36,
  };
}

function describeError(err) {
  const status = err && err.target && err.target.status;
  if (status === 404) return 'The STL file could not be found on the server (it may have been moved or deleted).';
  if (status && status >= 400) return `The server could not send this STL file (HTTP ${status}).`;
  if (err && /webgl/i.test(String(err.message || err))) return 'Your browser could not start 3D rendering (WebGL is unavailable or disabled).';
  return 'This STL file could not be loaded or is not a valid STL.';
}

export default function StlViewer({ fileId, filename }) {
  const mountRef = useRef(null);
  const controlsRef = useRef(null);
  const cameraRef = useRef(null);
  const sceneRef = useRef(null);
  const gridRef = useRef(null);
  const defaultCamPos = useRef(null);
  const meshRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [wireframe, setWireframe] = useState(false);
  const [colorIdx, setColorIdx] = useState(0);
  const [stats, setStats] = useState(null); // { vertices, triangles }

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return undefined;
    let disposed = false;
    let animFrameId = 0;
    let renderer = null;
    let controls = null;
    let resizeObserver = null;
    const disposables = [];
    setLoading(true);
    setError(null);
    setStats(null);

    const w = el.clientWidth || 400;
    const h = el.clientHeight || 300;
    const colors = themeColors();

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(colors.background);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 10000);
    camera.position.set(0, 0, 200);
    cameraRef.current = camera;

    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch (e) {
      setError('Your browser could not start 3D rendering (WebGL is unavailable or disabled).');
      setLoading(false);
      return undefined;
    }
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    el.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xd0d8e8, 0x303040, 1.6));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(2, 3, 4);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0x8090c0, 0.8);
    fillLight.position.set(-3, 1, -2);
    scene.add(fillLight);

    const grid = new THREE.GridHelper(400, 20, colors.grid, colors.grid);
    scene.add(grid);
    gridRef.current = grid;
    disposables.push(grid.geometry, grid.material);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 10;
    controls.maxDistance = 2000;
    controlsRef.current = controls;

    const loader = new STLLoader();
    loader.load(
      `/api/files/${fileId}/stl`,
      (geometry) => {
        if (disposed) { geometry.dispose(); return; }
        geometry.computeBoundingBox();
        geometry.computeVertexNormals();
        const bbox = geometry.boundingBox;
        const center = new THREE.Vector3();
        bbox.getCenter(center);
        const size = new THREE.Vector3();
        bbox.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const scale = 100 / maxDim;
        geometry.translate(-center.x, -center.y, -center.z);

        const material = new THREE.MeshPhongMaterial({ color: COLOR_PRESETS[0].hex, specular: 0x333344, shininess: 40 });
        disposables.push(geometry, material);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.scale.setScalar(scale);
        mesh.rotation.x = -Math.PI / 2;
        meshRef.current = mesh;
        scene.add(mesh);

        const scaledH = size.z * scale;
        grid.position.y = -scaledH / 2;
        const fitY = scaledH * 0.8;
        const fitZ = maxDim * scale * 1.5;
        camera.position.set(0, fitY, fitZ);
        controls.target.set(0, 0, 0);
        controls.update();
        defaultCamPos.current = { x: 0, y: fitY, z: fitZ };

        const vCount = geometry.attributes.position ? geometry.attributes.position.count : 0;
        setStats({ vertices: vCount, triangles: Math.round(vCount / 3) });
        setLoading(false);
      },
      undefined,
      (err) => {
        if (disposed) return;
        setError(describeError(err));
        setLoading(false);
      }
    );

    const animate = () => {
      animFrameId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
      const w2 = el.clientWidth;
      const h2 = el.clientHeight;
      if (!w2 || !h2) return;
      camera.aspect = w2 / h2;
      camera.updateProjectionMatrix();
      renderer.setSize(w2, h2);
    };
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(handleResize);
      resizeObserver.observe(el);
    } else {
      window.addEventListener('resize', handleResize);
    }

    // Follow light/dark theme changes (App toggles .theme-light on <html>)
    const themeObserver = new MutationObserver(() => {
      const c = themeColors();
      scene.background = new THREE.Color(c.background);
      grid.material.color && grid.material.color.setHex(c.grid);
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    return () => {
      disposed = true;
      cancelAnimationFrame(animFrameId);
      themeObserver.disconnect();
      if (resizeObserver) resizeObserver.disconnect();
      else window.removeEventListener('resize', handleResize);
      if (controls) controls.dispose();
      for (const d of disposables) { try { d.dispose(); } catch { /* ignore */ } }
      if (meshRef.current) scene.remove(meshRef.current);
      meshRef.current = null;
      if (renderer) {
        renderer.dispose();
        try { renderer.forceContextLoss(); } catch { /* ignore */ }
        if (renderer.domElement.parentNode === el) el.removeChild(renderer.domElement);
      }
      controlsRef.current = null;
      cameraRef.current = null;
      sceneRef.current = null;
    };
  }, [fileId]);

  useEffect(() => {
    if (meshRef.current) meshRef.current.material.wireframe = wireframe;
  }, [wireframe, stats]);

  useEffect(() => {
    if (meshRef.current) meshRef.current.material.color.setHex(COLOR_PRESETS[colorIdx].hex);
  }, [colorIdx, stats]);

  const resetView = useCallback(() => {
    if (cameraRef.current && controlsRef.current && defaultCamPos.current) {
      const { x, y, z } = defaultCamPos.current;
      cameraRef.current.position.set(x, y, z);
      controlsRef.current.target.set(0, 0, 0);
      controlsRef.current.update();
    }
  }, []);

  return (
    <div className="stl-viewer">
      <div ref={mountRef} className="stl-viewer-mount" aria-label={`3D preview of ${filename}`} role="img" />

      {loading && !error && (
        <div className="stl-viewer-overlay">
          <div className="spinner" style={{ width: 24, height: 24 }} />
          Loading {filename}...
        </div>
      )}

      {error && (
        <div className="stl-viewer-overlay stl-viewer-error" role="alert">
          <div>✗ Could not show the 3D preview</div>
          <div className="stl-viewer-error-detail">{error}</div>
        </div>
      )}

      {!loading && !error && (
        <>
          {stats && (
            <div className="stl-viewer-stats">
              <div>{stats.triangles.toLocaleString()} △</div>
              <div>{stats.vertices.toLocaleString()} vert</div>
            </div>
          )}
          <div className="stl-viewer-hint">Drag · Scroll · Right-drag pan</div>
          <div className="stl-viewer-controls">
            <div style={{ display: 'flex', gap: 4 }}>
              {COLOR_PRESETS.map((c, i) => (
                <button key={c.name} onClick={() => setColorIdx(i)} title={c.name} aria-label={`Model color: ${c.name}`}
                  aria-pressed={i === colorIdx}
                  className={`stl-swatch ${i === colorIdx ? 'active' : ''}`} style={{ background: c.css }} />
              ))}
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <button onClick={resetView} className="stl-btn" title="Reset camera" aria-label="Reset camera">⌖</button>
              <button onClick={() => setWireframe(w => !w)} className={`stl-btn ${wireframe ? 'active' : ''}`}
                aria-pressed={wireframe}>WIRE</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
