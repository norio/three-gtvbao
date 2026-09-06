import * as THREE from "three/webgpu";

export function createSculpture(clay: THREE.Material, stone: THREE.Material) {
  const group = new THREE.Group();
  group.name = "Kinetic ceramic study";

  // A circular footprint accommodates every orientation of the rotating form.
  const profile = [
    [0, 0], [1.30, 0], [1.35, 0.015], [1.38, 0.04],
    [1.38, 0.10], [1.35, 0.135], [1.30, 0.15], [0, 0.15],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const pedestal = new THREE.Mesh(new THREE.LatheGeometry(profile, 96), stone);

  // A single closed trefoil has openings and overlapping surfaces from every
  // direction. Give it depth and tilt its plane so a turn never collapses into
  // the edge-on silhouette of a flat ring.
  const geometry = new THREE.TorusKnotGeometry(0.68, 0.17, 256, 40, 2, 3);
  geometry.scale(1, 1.12, 1.4);
  geometry.rotateX(Math.PI / 5);
  geometry.computeBoundingBox();
  geometry.translate(0, -geometry.boundingBox!.min.y, 0);
  const ceramic = new THREE.Mesh(geometry, clay);
  ceramic.name = "Rotating ceramic";
  ceramic.position.y = 0.15;

  for (const mesh of [pedestal, ceramic]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // Rotate the ceramic only; the base and camera remain stationary. A whole
  // turn wraps to the same pose, keeping the loop continuous indefinitely.
  const turn = Math.PI * 2;
  const update = (deltaSeconds: number) => {
    ceramic.rotation.y = (ceramic.rotation.y + deltaSeconds * turn / 24) % turn;
  };
  return { group, pedestal, update };
}
