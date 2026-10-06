/**
 * The dashboard hero's picture (docs/redesign-5.md, Phase 5): one model of the user's library
 * drawn in the accent cyan on a transparent background, three-quarter view, soft key and rim
 * light. Drawn with the thumbnail loader in this browser; the caller caches the PNG.
 */
import { LIGHT, THREE } from '../three/setup';
import { disposeObject3D, groupFromGeometryData } from '../three/models';
import { loadModelData } from '../thumbnails/loader';

const WIDTH = 720;
const HEIGHT = 420;

/** A PNG data URL of the model, or null when it has nothing to draw. */
export async function renderHero(filePath: string, timeoutMs = 45000): Promise<string | null> {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  let gl: THREE.WebGLRenderer | null = null;
  let model: THREE.Object3D | null = null;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Loading the model timed out')), timeoutMs);
    });
    const data = await Promise.race([loadModelData(filePath), timeout]).finally(() => clearTimeout(timer));
    if (!data) return null;

    gl = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    gl.debug.checkShaderErrors = false;
    gl.outputColorSpace = THREE.LinearSRGBColorSpace;
    gl.setSize(WIDTH, HEIGHT, false);
    gl.setClearColor(0x000000, 0);

    model = groupFromGeometryData(data.geometries);
    const material = new THREE.MeshStandardMaterial({ color: 0x0a7fcf, metalness: 0.25, roughness: 0.42 });
    model.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) mesh.material = material;
    });

    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0x9fdcff, 0x06121c, 0.55 * LIGHT));
    const key = new THREE.DirectionalLight(0xffffff, 1.1 * LIGHT);
    key.position.set(-4, 8, 6);
    const rim = new THREE.DirectionalLight(0x5fd4ff, 0.9 * LIGHT);
    rim.position.set(6, 3, -6);
    const fill = new THREE.DirectionalLight(0x3a8fd0, 0.35 * LIGHT);
    fill.position.set(2, -2, 8);
    scene.add(key, rim, fill, model);

    // Center the model and frame it from a three-quarter view with a little room around it.
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    model.position.sub(center);
    model.updateMatrixWorld(true);
    const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1e-3);
    const camera = new THREE.PerspectiveCamera(32, WIDTH / HEIGHT, 0.01, 100000);
    const distance = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 0.82;
    const direction = new THREE.Vector3(1, 0.62, 1.15).normalize();
    camera.position.copy(direction.multiplyScalar(distance));
    camera.near = Math.max(0.01, distance / 1000);
    camera.far = distance * 10;
    camera.updateProjectionMatrix();
    camera.lookAt(0, 0, 0);

    gl.render(scene, camera);
    material.dispose();
    return canvas.toDataURL('image/png');
  } finally {
    disposeObject3D(model);
    gl?.dispose();
    gl?.forceContextLoss();
  }
}
