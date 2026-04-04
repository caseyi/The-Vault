import React, { useEffect, useRef, useState, useCallback } from 'react';

// Dynamically load Three.js from CDN
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

const COLOR_PRESETS = [
  { name: 'Grey',    hex: 0xc8c8d4, label: '⬤', css: '#c8c8d4' },
  { name: 'Resin',   hex: 0xe8e0c8, label: '⬤', css: '#e8e0c8' },
  { name: 'Orange',  hex: 0xe07820, label: '⬤', css: '#e07820' },
  { name: 'Black',   hex: 0x282828, label: '⬤', css: '#282828' },
  { name: 'White',   hex: 0xf0f0f0, label: '⬤', css: '#f0f0f0' },
  { name: 'Green',   hex: 0x3aaf6a, label: '⬤', css: '#3aaf6a' },
];

export default function StlViewer({ fileId, filename }) {
  const mountRef = useRef(null);
  const sceneRef = useRef(null);
  const controlsRef = useRef(null);
  const cameraRef = useRef(null);
  const defaultCamPos = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [wireframe, setWireframe] = useState(false);
  const [colorIdx, setColorIdx] = useState(0);
  const [stats, setStats] = useState(null); // { vertices, triangles }
  const meshRef = useRef(null);

  useEffect(() => {
    let animFrameId;
    let renderer;

    async function init() {
      try {
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js');
        // Load STLLoader as a module-like script
        await loadScript('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/STLLoader.js');
        await loadScript('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js');

        const THREE = window.THREE;
        const el = mountRef.current;
        if (!el) return;

        const w = el.clientWidth;
        const h = el.clientHeight;

        // Scene
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x1c1c21);
        sceneRef.current = scene;

        // Camera
        const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 10000);
        camera.position.set(0, 0, 200);

        // Renderer
        renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(w, h);
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.shadowMap.enabled = true;
        el.appendChild(renderer.domElement);

        // Lights — hemisphere (sky/ground) + two directionals for depth
        const hemi = new THREE.HemisphereLight(0xd0d8e8, 0x303040, 0.6);
        scene.add(hemi);
        const keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
        keyLight.position.set(2, 3, 4);
        scene.add(keyLight);
        const fillLight = new THREE.DirectionalLight(0x8090c0, 0.3);
        fillLight.position.set(-3, 1, -2);
        scene.add(fillLight);

        // Grid
        const grid = new THREE.GridHelper(400, 20, 0x2e2e36, 0x2e2e36);
        grid.position.y = 0;
        scene.add(grid);

        // Controls
        const controls = new THREE.OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.05;
        controls.minDistance = 10;
        controls.maxDistance = 2000;
        controlsRef.current = controls;

        // Load STL
        const loader = new THREE.STLLoader();
        const stlUrl = `/api/files/${fileId}/stl`;

        loader.load(
          stlUrl,
          (geometry) => {
            geometry.computeBoundingBox();
            geometry.computeVertexNormals();

            const bbox = geometry.boundingBox;
            const center = new THREE.Vector3();
            bbox.getCenter(center);
            const size = new THREE.Vector3();
            bbox.getSize(size);
            const maxDim = Math.max(size.x, size.y, size.z);
            const scale = 100 / maxDim;

            geometry.translate(-center.x, -center.y, -center.z);

            const material = new THREE.MeshPhongMaterial({
              color: COLOR_PRESETS[0].hex,
              specular: 0x333344,
              shininess: 40,
            });

            const mesh = new THREE.Mesh(geometry, material);
            mesh.scale.setScalar(scale);
            mesh.rotation.x = -Math.PI / 2;
            meshRef.current = mesh;
            scene.add(mesh);

            // Move grid below model
            const scaledH = size.z * scale;
            grid.position.y = -scaledH / 2;

            // Fit camera
            const fitY = scaledH * 0.8;
            const fitZ = maxDim * scale * 1.5;
            camera.position.set(0, fitY, fitZ);
            controls.target.set(0, 0, 0);
            controls.update();
            cameraRef.current = camera;
            defaultCamPos.current = { x: 0, y: fitY, z: fitZ };

            // Stats
            const vCount = geometry.attributes.position
              ? geometry.attributes.position.count
              : 0;
            setStats({ vertices: vCount, triangles: Math.round(vCount / 3) });

            setLoading(false);
          },
          undefined,
          (err) => {
            setError('Failed to load STL file.');
            setLoading(false);
          }
        );

        // Animate
        function animate() {
          animFrameId = requestAnimationFrame(animate);
          controls.update();
          renderer.render(scene, camera);
        }
        animate();

        // Resize handler
        const handleResize = () => {
          if (!el) return;
          const w2 = el.clientWidth;
          const h2 = el.clientHeight;
          camera.aspect = w2 / h2;
          camera.updateProjectionMatrix();
          renderer.setSize(w2, h2);
        };
        window.addEventListener('resize', handleResize);

        return () => {
          window.removeEventListener('resize', handleResize);
        };
      } catch (e) {
        setError(`Could not load 3D viewer: ${e.message}`);
        setLoading(false);
      }
    }

    init();

    return () => {
      if (animFrameId) cancelAnimationFrame(animFrameId);
      if (renderer) {
        renderer.dispose();
        if (mountRef.current && renderer.domElement.parentNode === mountRef.current) {
          mountRef.current.removeChild(renderer.domElement);
        }
      }
    };
  }, [fileId]);

  // Toggle wireframe
  useEffect(() => {
    if (meshRef.current) {
      meshRef.current.material.wireframe = wireframe;
    }
  }, [wireframe]);

  // Change color
  useEffect(() => {
    if (meshRef.current) {
      meshRef.current.material.color.setHex(COLOR_PRESETS[colorIdx].hex);
    }
  }, [colorIdx]);

  const resetView = useCallback(() => {
    if (cameraRef.current && controlsRef.current && defaultCamPos.current) {
      const { x, y, z } = defaultCamPos.current;
      cameraRef.current.position.set(x, y, z);
      controlsRef.current.target.set(0, 0, 0);
      controlsRef.current.update();
    }
  }, []);

  return (
    <div style={{ position: 'relative', width: '100%', aspectRatio: '4/3', background: '#1c1c21', borderRadius: 6, overflow: 'hidden' }}>
      <div ref={mountRef} style={{ width: '100%', height: '100%' }} />

      {loading && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, color: '#7a7a8c', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          <div style={{ width: 24, height: 24, border: '2px solid #2e2e36', borderTopColor: '#c17f3a', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          Loading {filename}...
        </div>
      )}

      {error && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#cf7272', fontFamily: 'var(--font-mono)', fontSize: 12, padding: 20, textAlign: 'center' }}>
          ✗ {error}
        </div>
      )}

      {!loading && !error && (
        <>
          {/* Top-left: stats */}
          {stats && (
            <div style={{ position: 'absolute', top: 8, left: 8, fontFamily: 'var(--font-mono)', fontSize: 9, color: '#4a4a5a', lineHeight: 1.6 }}>
              <div>{stats.triangles.toLocaleString()} △</div>
              <div>{stats.vertices.toLocaleString()} vert</div>
            </div>
          )}

          {/* Bottom-left: hint */}
          <div style={{ position: 'absolute', bottom: 8, left: 8, fontFamily: 'var(--font-mono)', fontSize: 9, color: '#4a4a5a' }}>
            Drag · Scroll · Right-drag pan
          </div>

          {/* Bottom-right: controls */}
          <div style={{ position: 'absolute', bottom: 8, right: 8, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
            {/* Color presets */}
            <div style={{ display: 'flex', gap: 4 }}>
              {COLOR_PRESETS.map((c, i) => (
                <button key={c.name} onClick={() => setColorIdx(i)} title={c.name}
                  style={{
                    width: 16, height: 16, borderRadius: '50%', border: `2px solid ${i === colorIdx ? '#c17f3a' : 'transparent'}`,
                    background: c.css, cursor: 'pointer', padding: 0,
                    boxShadow: i === colorIdx ? '0 0 0 1px rgba(193,127,58,0.5)' : 'none',
                  }} />
              ))}
            </div>
            {/* Wire + Reset */}
            <div style={{ display: 'flex', gap: 4 }}>
              <button onClick={resetView}
                style={{ background: 'rgba(13,13,15,0.75)', border: '1px solid #3f3f4d', borderRadius: 4, color: '#7a7a8c', padding: '3px 7px', cursor: 'pointer', fontSize: 10, fontFamily: 'var(--font-mono)' }}
                title="Reset camera">
                ⌖
              </button>
              <button onClick={() => setWireframe(w => !w)}
                style={{ background: wireframe ? 'rgba(193,127,58,0.3)' : 'rgba(13,13,15,0.75)', border: `1px solid ${wireframe ? '#c17f3a' : '#3f3f4d'}`, borderRadius: 4, color: wireframe ? '#c17f3a' : '#7a7a8c', padding: '3px 7px', cursor: 'pointer', fontSize: 10, fontFamily: 'var(--font-mono)' }}>
                WIRE
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
