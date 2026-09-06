import * as THREE from "three/webgpu";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { createSculpture } from "./sculpture.js";
import { mergeStaticMeshes } from "./mergeStaticMeshes.js";

// A small architectural study: broad recesses, delicate gaps and grounded
// objects let ambient occlusion describe the forms without texture noise.
export function createScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe8e5df);
  scene.fog = new THREE.Fog(0xe8e5df, 26, 65);

  const palette = {
    plaster: 0xe8dfcf,
    chalk: 0xf2ece0,
    stone: 0xcfc4b2,
    clay: 0xb96c51,
    floor: 0xd9d5cc,
  };
  const materials = new Map<number, THREE.MeshStandardNodeMaterial>();
  const staticMeshes: THREE.Mesh[] = [];
  const material = (color: number) => {
    if (!materials.has(color)) {
      materials.set(
        color,
        new THREE.MeshStandardNodeMaterial({ color, roughness: 0.9, metalness: 0 }),
      );
    }
    return materials.get(color)!;
  };
  const add = (
    geometry: THREE.BufferGeometry,
    color: number,
    position: [number, number, number],
    parent: THREE.Object3D = scene,
  ) => {
    const mesh = new THREE.Mesh(geometry, material(color));
    mesh.position.set(...position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    staticMeshes.push(mesh);
    return mesh;
  };
  const box = (
    width: number,
    height: number,
    depth: number,
    position: [number, number, number],
    color = palette.plaster,
    radius = 0.035,
  ) => add(new RoundedBoxGeometry(width, height, depth, 3, radius), color, position);

  const floor = add(new THREE.PlaneGeometry(120, 120), palette.floor, [0, -0.03, 0]);
  floor.rotation.x = -Math.PI / 2;
  floor.castShadow = false;

  // The low monolithic plinth unifies the objects and provides a clean contact
  // edge against the seamless studio floor. All studies rest on its top.
  const base = 0.3;
  box(11.2, base, 7.8, [0, base / 2, 0], palette.chalk, 0.09);
  box(10.75, 0.08, 7.35, [0, 0.06, 0], palette.stone, 0.035);

  // Three open archways. The underside is an actual concave semicircle, not a
  // dark painted surface, so both the AO-only and unoccluded views stay honest.
  const arcadeX = -2.15;
  const arcadeZ = -2.65;
  const opening = 1.25;
  const pierWidth = 0.4;
  const pitch = opening + pierWidth;
  const springHeight = 1.82;
  const arcadeHeight = 3.18;
  const arcadeDepth = 0.72;
  const radius = opening / 2;
  const halfWidth = (pitch * 3 + pierWidth) / 2;
  // One continuous boundary, including all three open-bottom cutouts. A single
  // extrusion avoids seams between individual piers and arch spandrels.
  const arcade = new THREE.Shape();
  arcade.moveTo(-halfWidth, 0);
  arcade.lineTo(-halfWidth, arcadeHeight);
  arcade.lineTo(halfWidth, arcadeHeight);
  arcade.lineTo(halfWidth, 0);
  for (let i = 1; i >= -1; i -= 1) {
    const center = i * pitch;
    arcade.lineTo(center + radius, 0);
    arcade.lineTo(center + radius, springHeight);
    arcade.absarc(center, springHeight, radius, 0, Math.PI, false);
    arcade.lineTo(center - radius, 0);
  }
  arcade.closePath();
  const arcadeGeometry = new THREE.ExtrudeGeometry(arcade, {
    depth: arcadeDepth - 0.04,
    bevelEnabled: true,
    bevelThickness: 0.02,
    bevelSize: 0.02,
    bevelSegments: 3,
    curveSegments: 40,
    steps: 1,
  });
  // ExtrudeGeometry supplies flat side normals. Weld the untextured surface
  // before recomputing them so the curved soffits and bevels remain smooth.
  arcadeGeometry.deleteAttribute("normal");
  arcadeGeometry.deleteAttribute("uv");
  const smoothArcade = mergeVertices(arcadeGeometry);
  smoothArcade.computeVertexNormals();
  arcadeGeometry.dispose();
  add(smoothArcade, palette.plaster, [arcadeX, base, arcadeZ - arcadeDepth / 2 + 0.02]);
  // The shallow cornice sits above the facade without covering its faces.
  box(5.55, 0.12, 0.91, [arcadeX, base + arcadeHeight + 0.06, arcadeZ], palette.chalk);

  // A staircase and its retaining wall produce a sequence of deeper corners.
  // The blocks extend to the plinth so there are no unsupported floating treads.
  const stairX = 3.1;
  const stairFrontZ = -0.2;
  for (let i = 0; i < 7; i += 1) {
    const height = (i + 1) * 0.34;
    box(2.15, height, 0.48, [stairX, base + height / 2, stairFrontZ - i * 0.46], palette.chalk, 0.025);
  }
  box(0.22, 2.68, 3.46, [stairX + 1.18, base + 1.34, stairFrontZ - 1.38], palette.plaster, 0.035);
  box(2.15, 0.12, 0.48, [stairX, base + 2.44, stairFrontZ - 2.76], palette.stone, 0.025);

  // Close-spaced rounded fins make the small-scale occlusion easy to read.
  // Align their center with the stairs, with a clear aisle between the studies.
  const finsZ = 2.05;
  box(3.08, 0.16, 1.66, [stairX, base + 0.08, finsZ], palette.stone, 0.045);
  for (let i = 0; i < 9; i += 1) {
    const height = 0.98 + 0.36 * Math.sin((i / 8) * Math.PI);
    box(0.14, height, 1.4, [stairX + (i - 4) * 0.315, base + 0.16 + height / 2, finsZ], palette.chalk, 0.045);
  }

  // A single sculpted ceramic volume anchors the architectural studies.
  const sculpture = createSculpture(material(palette.clay), material(palette.stone));
  sculpture.group.position.set(-3.05, base, 1.5);
  scene.add(sculpture.group);
  staticMeshes.push(sculpture.pedestal);

  // Fluted columns bridge the two foreground studies. Stagger them toward the
  // back as they rise, giving each silhouette room beside the staircase.
  // Each shaft is assembled from overlapping cylinders, keeping the silhouette
  // and the recesses geometric at every viewing angle.
  for (let column = 0; column < 3; column += 1) {
    const x = -0.72 + column * 0.78;
    const z = 1.55 - column * 0.46;
    const height = 1.12 + column * 0.42;
    add(new THREE.CylinderGeometry(0.3, 0.32, 0.14, 48), palette.stone, [x, base + 0.07, z]);
    add(new THREE.CylinderGeometry(0.2, 0.2, height, 48), palette.plaster, [x, base + 0.14 + height / 2, z]);
    for (let flute = 0; flute < 12; flute += 1) {
      const angle = (flute / 12) * Math.PI * 2;
      add(
        new THREE.CylinderGeometry(0.052, 0.052, height, 12),
        palette.plaster,
        [x + Math.cos(angle) * 0.2, base + 0.14 + height / 2, z + Math.sin(angle) * 0.2],
      );
    }
    add(new THREE.CylinderGeometry(0.28, 0.28, 0.1, 48), palette.chalk, [x, base + height + 0.19, z]);
  }

  // Keep the non-casting floor and animated ceramic separate from the batches.
  mergeStaticMeshes(scene, staticMeshes.filter(mesh => mesh.castShadow));

  // Indirect light carries most of the illumination: AO can shape the recesses
  // while a restrained warm key light supplies a readable, soft silhouette.
  scene.add(new THREE.HemisphereLight(0xf7f3eb, 0xb4aa98, 3.1));
  const sun = new THREE.DirectionalLight(0xfff2de, 1.65);
  sun.position.set(-3, 10, 7);
  sun.target.position.set(0, 0.8, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -9;
  sun.shadow.camera.right = 9;
  sun.shadow.camera.top = 9;
  sun.shadow.camera.bottom = -9;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 28;
  sun.shadow.bias = 0.0005;
  sun.shadow.normalBias = 0;
  sun.shadow.radius = 5;
  sun.shadow.blurSamples = 16;
  scene.add(sun, sun.target);

  const sunOrbitRadius = Math.hypot(sun.position.x, sun.position.z);
  let sunAngle = Math.atan2(sun.position.z, sun.position.x);
  const update = (deltaSeconds: number, autoLighting: boolean) => {
    sculpture.update(deltaSeconds);
    if (!autoLighting) return;
    // One orbit in 30 seconds; pausing preserves the current light direction.
    sunAngle = (sunAngle + deltaSeconds * Math.PI * 2 / 30) % (Math.PI * 2);
    sun.position.x = Math.cos(sunAngle) * sunOrbitRadius;
    sun.position.z = Math.sin(sunAngle) * sunOrbitRadius;
  };

  return { scene, sun, update };
}
