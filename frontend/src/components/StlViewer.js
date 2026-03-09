import React, { useEffect, useRef, useState } from 'react';

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

export default function StlViewer({ fileId, filename }) {
  const mountRef = useRef(null);
  const sceneRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [wireframe, setWireframe] = useState(false);
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

        // Lights
        const ambient = new THREE.AmbientLight(0xffffff, 0.4);
        scene.add(ambient);
        const dir1 = new THREE.DirectionalLight(0xffffff, 0.8);
        dir1.position.set(1, 2, 3);
        scene.add(dir1);
        const dir2 = new THREE.DirectionalLight(0xc17f3a, 0.3);
        dir2.position.set(-2, -1, -1);
        scene.add(dir2);

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
              color: 0xc8c8d4,
              specular: 0x444444,
              shininess: 30,
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
            camera.position.set(0, scaledH * 0.8, maxDim * scale * 1.5);
            controls.target.set(0, 0, 0);
            controls.update();

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
        <div style={{ position: 'absolute', bottom: 10, right: 10, display: 'flex', gap: 6 }}>
          <button
            onClick={() => setWireframe(w => !w)}
            style={{ background: wireframe ? 'rgba(193,127,58,0.3)' : 'rgba(13,13,15,0.7)', border: `1px solid ${wireframe ? '#c17f3a' : '#3f3f4d'}`, borderRadius: 4, color: wireframe ? '#c17f3a' : '#7a7a8c', padding: '4px 8px', cursor: 'pointer', fontSize: 10, fontFamily: 'var(--font-mono)' }}>
            WIRE
          </button>
        </div>
      )}

      <div style={{ position: 'absolute', bottom: 10, left: 10, fontFamily: 'var(--font-mono)', fontSize: 9, color: '#4a4a5a' }}>
        Drag to rotate · Scroll to zoom · Right-drag to pan
      </div>
    </div>
  );
}
