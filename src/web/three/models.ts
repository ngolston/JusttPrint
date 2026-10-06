/** three.js meshes from the parse worker's plain arrays (src/web/thumbnails/loader.ts). */
import { THREE } from './setup';

export interface GeometryData {
  position?: Float32Array;
  normal?: Float32Array;
  uv?: Float32Array;
  index?: Uint32Array | Uint16Array;
  color?: number[];
  matrix?: number[];
}

declare global {
  interface Window {
    /** stl-sanity.js */
    normalsAreMissing?: (normals: Float32Array) => boolean;
    repairZeroFaceNormals?: (positions: Float32Array, normals: Float32Array) => number;
  }
}

/** The thumbnail model color setting (Settings → Theme). */
export function modelColor(): THREE.Color {
  const setting = window.currentRenderColor || '#cccccc';
  if (setting === 'rainbow') return new THREE.Color().setHSL(Math.random(), 1.0, 0.5);
  if (setting === 'pastel-rainbow') return new THREE.Color().setHSL(Math.random(), 1.0, 0.8);
  return new THREE.Color(setting);
}

/** One mesh per parsed geometry, Z-up turned Y-up. Throws when nothing is drawable. */
export function groupFromGeometryData(geometries: GeometryData[]): THREE.Group {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: modelColor(), metalness: 0.3, roughness: 0.4 });
  for (const data of geometries) {
    if (!data.position || data.position.length < 9) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
    if (!data.index && data.normal) window.repairZeroFaceNormals?.(data.position, data.normal);
    const normalsMissing = !data.normal || data.normal.length < data.position.length || !!window.normalsAreMissing?.(data.normal);
    if (!normalsMissing) geometry.setAttribute('normal', new THREE.BufferAttribute(data.normal!, 3));
    else geometry.computeVertexNormals();
    if (data.uv && data.uv.length >= (data.position.length / 3) * 2) geometry.setAttribute('uv', new THREE.BufferAttribute(data.uv, 2));
    if (data.index) geometry.setIndex(new THREE.BufferAttribute(data.index, 1));
    const meshMaterial = data.color && data.color.length >= 3
      ? new THREE.MeshStandardMaterial({ color: new THREE.Color(data.color[0], data.color[1], data.color[2]), metalness: 0.3, roughness: 0.4 })
      : material;
    const mesh = new THREE.Mesh(geometry, meshMaterial);
    if (data.matrix) mesh.applyMatrix4(new THREE.Matrix4().fromArray(data.matrix));
    group.add(mesh);
  }
  if (!group.children.length) throw new Error('Model contains no drawable mesh geometry');
  group.rotation.x = -Math.PI / 2;
  return group;
}

export function disposeObject3D(object: THREE.Object3D | null) {
  object?.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    if (mesh.material) (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((mat) => mat?.dispose());
  });
}
