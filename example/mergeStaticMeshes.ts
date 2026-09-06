import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// The untextured, static shadow casters in this demo own their geometries.
// Bake their transforms once and draw each material in a single batch.
export function mergeStaticMeshes(scene: THREE.Scene, meshes: THREE.Mesh[]) {
  scene.updateMatrixWorld(true);
  const batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    geometry.applyMatrix4(mesh.matrixWorld);
    // The arcade has no UVs; none of the demo's static materials use them.
    geometry.deleteAttribute("uv");
    // Rounded boxes are non-indexed, while cylinders and the arcade are indexed.
    if (geometry.index === null) {
      geometry.setIndex(Array.from({ length: geometry.getAttribute("position").count }, (_, i) => i));
    }
    const material = mesh.material as THREE.Material;
    let batch = batches.get(material);
    if (!batch) {
      batch = [];
      batches.set(material, batch);
    }
    batch.push(geometry);
    mesh.removeFromParent();
  }
  for (const [material, geometries] of batches) {
    // Keep the authored normals and triangle topology, without material groups.
    const geometry = mergeGeometries(geometries)!;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "Static architecture";
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    for (const source of geometries) source.dispose();
  }
}
