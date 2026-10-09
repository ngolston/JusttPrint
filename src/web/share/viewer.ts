/**
 * The 3D view on share pages (src/server/share-pages.js). Visitors are not logged in, so this is
 * its own small script (web-build/share-viewer.js, with the three.js chunk), not the app: a
 * "3D view" button opens a dialog that loads /s/<token>/mesh/<id> (an STL file, or a 3MF the
 * server parsed into three.js JSON) and lets the visitor turn and zoom it.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

const MATERIAL = () => new THREE.MeshStandardMaterial({ color: 0x4a9eff, metalness: 0.25, roughness: 0.6 });

interface Viewer {
  dialog: HTMLDialogElement;
  title: HTMLElement;
  stage: HTMLElement;
  status: HTMLElement;
}

let viewer: Viewer | null = null;
let stop: (() => void) | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function makeViewer(): Viewer {
  const dialog = el('dialog', 'viewer');
  dialog.setAttribute('aria-label', '3D view');
  const bar = el('div', 'viewer-bar');
  const title = el('strong');
  const close = el('button', 'btn btn-quiet', 'Close');
  close.type = 'button';
  close.addEventListener('click', () => dialog.close());
  bar.append(title, close);
  const stage = el('div', 'viewer-stage');
  const status = el('div', 'viewer-status');
  stage.append(status);
  dialog.append(bar, stage);
  dialog.addEventListener('close', () => {
    stop?.();
    stop = null;
  });
  document.body.append(dialog);
  return { dialog, title, stage, status };
}

/** The model as a three.js object, Y-up like the camera. */
async function loadMesh(url: string, kind: string): Promise<THREE.Object3D> {
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw new Error((await response.text().catch(() => '')) || `The server answered ${response.status}`);
  if (kind === 'stl') {
    const geometry = new STLLoader().parse(await response.arrayBuffer());
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, MATERIAL());
    mesh.rotation.x = -Math.PI / 2; // STL files are Z-up.
    return mesh;
  }
  const object = new THREE.ObjectLoader().parse(await response.json());
  object.rotation.x = -Math.PI / 2; // 3MF is Z-up.
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    // 3MF files have no normals; shared corners would round off every edge. Each face gets its
    // own corners, as in an STL, and normals of its own.
    if (mesh.geometry.index) mesh.geometry = mesh.geometry.toNonIndexed();
    mesh.geometry.computeVertexNormals();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    // Parts without colors of their own get the default color, lit like the rest.
    if (!materials.some((m) => (m as THREE.MeshStandardMaterial).vertexColors || (m as THREE.MeshStandardMaterial).map)) mesh.material = MATERIAL();
  });
  return object;
}

function dispose(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((m) => m.dispose());
  });
}

async function open(button: HTMLButtonElement) {
  viewer ??= makeViewer();
  const { dialog, title, stage, status } = viewer;
  stop?.();
  title.textContent = button.dataset.name || '3D view';
  status.textContent = 'Loading the model…';
  status.hidden = false;
  if (!dialog.open) dialog.showModal();

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x0e1821);
  stage.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(1, 2, 1.5);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  let object: THREE.Object3D | null = null;
  let frame = 0;
  let closed = false;
  const resize = () => {
    const { clientWidth: w, clientHeight: h } = stage;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
  };
  const loop = () => {
    frame = requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(stage);
  stop = () => {
    closed = true;
    cancelAnimationFrame(frame);
    observer.disconnect();
    controls.dispose();
    if (object) dispose(object);
    renderer.dispose();
    renderer.domElement.remove();
  };
  resize();
  loop();

  try {
    object = await loadMesh(button.dataset.mesh || '', button.dataset.kind || 'stl');
    if (closed) return dispose(object);
    // Centered on the floor, the camera far enough back to see all of it.
    const box = new THREE.Box3().setFromObject(object);
    const center = box.getCenter(new THREE.Vector3());
    object.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));
    scene.add(object);
    const height = box.max.y - box.min.y;
    const radius = box.getBoundingSphere(new THREE.Sphere()).radius || 1;
    // Far enough that the whole model fits, with some room around it.
    const fov = THREE.MathUtils.degToRad(camera.fov) / 2;
    const distance = (radius / Math.sin(Math.min(fov, Math.atan(Math.tan(fov) * camera.aspect)))) * 1.25;
    controls.target.set(0, height / 2, 0);
    camera.position.copy(new THREE.Vector3(1, 0.75, 1).normalize().multiplyScalar(distance)).add(controls.target);
    camera.near = distance / 1000;
    camera.far = distance * 100;
    camera.updateProjectionMatrix();
    const floor = new THREE.GridHelper(radius * 6, 24, 0x2f4351, 0x1a2833);
    scene.add(floor);
    status.hidden = true;
    dialog.dataset.ready = 'true';
  } catch (error) {
    status.textContent = `This model cannot be shown in 3D. ${error instanceof Error ? error.message : ''}`.trim();
  }
}

document.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button.view3d');
  if (button) void open(button);
});
