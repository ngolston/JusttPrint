/**
 * three.js (0.181) set up to render like the r128 copy the page used before: colors are not
 * color-managed (hex values are used as they are), and LIGHT scales light intensities to the
 * old "legacy" units (r155 removed the division by π).
 */
import * as THREE from 'three';

THREE.ColorManagement.enabled = false;

export const LIGHT = Math.PI;
export { THREE };
