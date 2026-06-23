import * as THREE from "./vendor/three/three.module.min.js";

const state = {
  stage: null,
  renderer: null,
  scene: null,
  camera: null,
  rackGroup: null,
  devices: [],
  selected: null,
  raf: null,
  zoom: 10.2,
  rotationY: -0.5,
  rotationX: -0.05,
  dragging: false,
  pointer: new THREE.Vector2(),
  raycaster: new THREE.Raycaster(),
  lastPointer: { x: 0, y: 0 }
};

const COLORS = {
  rack: 0x111417,
  rackSide: 0x1d2227,
  rail: 0x2e3740,
  trim: 0x0a0d10,
  idle: 0x6f8495,
  busy: 0x0b6f7a,
  gpu: 0x4b62b5,
  warn: 0xe5a423,
  down: 0xc93f38,
  face: 0x9eb0bd,
  vent: 0x27323a,
  accent: 0x32a9c7,
  wheel: 0x080a0c
};

function nodeType(node) {
  const stateText = String(node?.state || "").toLowerCase();
  if (stateText.includes("down")) return "down";
  if (stateText.includes("drain") || stateText.includes("fail")) return "warn";
  if (Number(node?.gpu_total || 0) > 0) return "gpu";
  if (stateText.includes("alloc") || stateText.includes("mix") || stateText.includes("completing")) return "busy";
  return "idle";
}

function fallbackNode(system = {}) {
  const host = system || {};
  return {
    name: host.hostname || "localhost",
    state: "local",
    partitions: "standalone",
    cpu_alloc: 0,
    cpu_total: host.cpu?.logical_count || 1,
    gpu_alloc: 0,
    gpu_total: 0,
    gres: "",
    reason: ""
  };
}

function createMaterial(color, roughness = 0.55, metalness = 0.18) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function addBox(parent, size, position, material, name = "") {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(...position);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function addCylinder(parent, radius, depth, position, material, rotation = [0, 0, 0], name = "") {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, depth, 24), material);
  mesh.position.set(...position);
  mesh.rotation.set(...rotation);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function initScene() {
  state.stage = document.querySelector("#hardwareStage");
  if (!state.stage || state.renderer) return;

  state.scene = new THREE.Scene();
  state.scene.background = new THREE.Color(0xeef2f6);

  state.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  state.camera.position.set(0.2, 1.15, state.zoom);
  state.camera.lookAt(0, 0, 0);

  state.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  state.renderer.shadowMap.enabled = true;
  state.stage.appendChild(state.renderer.domElement);

  const ambient = new THREE.HemisphereLight(0xffffff, 0x9aa8b5, 1.35);
  state.scene.add(ambient);

  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(4, 7, 7);
  key.castShadow = true;
  state.scene.add(key);

  const fill = new THREE.DirectionalLight(0x5aa7b0, 1.2);
  fill.position.set(-6, 3, 4);
  state.scene.add(fill);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(14, 11),
    new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.82, metalness: 0.02 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -3.05;
  floor.receiveShadow = true;
  state.scene.add(floor);

  const grid = new THREE.GridHelper(14, 28, 0x8c98a3, 0xcfd6dd);
  grid.position.y = -3.045;
  state.scene.add(grid);

  state.rackGroup = new THREE.Group();
  state.scene.add(state.rackGroup);

  bindControls();
  resize();
  animate();
}

function bindControls() {
  const canvas = state.renderer.domElement;
  canvas.addEventListener("pointerdown", (event) => {
    state.dragging = true;
    state.lastPointer = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!state.dragging) return;
    const dx = event.clientX - state.lastPointer.x;
    const dy = event.clientY - state.lastPointer.y;
    state.rotationY += dx * 0.007;
    state.rotationX = Math.max(-0.55, Math.min(0.28, state.rotationX + dy * 0.004));
    state.lastPointer = { x: event.clientX, y: event.clientY };
  });
  canvas.addEventListener("pointerup", (event) => {
    state.dragging = false;
    canvas.releasePointerCapture(event.pointerId);
    pick(event);
  });
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    state.zoom = Math.max(6, Math.min(16, state.zoom + event.deltaY * 0.005));
    state.camera.position.z = state.zoom;
  }, { passive: false });
  window.addEventListener("resize", resize);
}

function resize() {
  if (!state.stage || !state.renderer) return;
  const rect = state.stage.getBoundingClientRect();
  const width = Math.max(Math.round(rect.width), 1);
  const height = Math.max(Math.round(rect.height), 1);
  state.camera.aspect = width / height;
  state.camera.updateProjectionMatrix();
  state.renderer.setSize(width, height, false);
}

function clearRack() {
  while (state.rackGroup.children.length) {
    const child = state.rackGroup.children.pop();
    child.traverse?.((object) => {
      object.geometry?.dispose?.();
      object.material?.dispose?.();
    });
  }
  state.devices = [];
}

function buildRack(nodes) {
  clearRack();
  const rackMat = createMaterial(COLORS.rack, 0.32, 0.42);
  const sideMat = createMaterial(COLORS.rackSide, 0.48, 0.24);
  const trimMat = createMaterial(COLORS.trim, 0.28, 0.48);
  const railMat = createMaterial(COLORS.rail, 0.45, 0.28);
  const depth = 2.9;
  const height = 6.15;
  const width = 2.05;
  const frontZ = depth / 2;

  addBox(state.rackGroup, [width + 0.28, 0.18, depth + 0.22], [0, height / 2, 0], trimMat);
  addBox(state.rackGroup, [width + 0.28, 0.2, depth + 0.22], [0, -height / 2, 0], trimMat);
  addBox(state.rackGroup, [0.14, height, 0.14], [-width / 2, 0, frontZ], rackMat);
  addBox(state.rackGroup, [0.14, height, 0.14], [width / 2, 0, frontZ], rackMat);
  addBox(state.rackGroup, [0.18, height, depth], [-width / 2, 0, 0], sideMat);
  addBox(state.rackGroup, [0.18, height, depth], [width / 2, 0, 0], sideMat);
  addBox(state.rackGroup, [width, height, 0.16], [0, 0, -depth / 2], sideMat);
  addBox(state.rackGroup, [0.045, height - 0.46, 0.08], [-width / 2 + 0.18, 0, frontZ + 0.05], railMat);
  addBox(state.rackGroup, [0.045, height - 0.46, 0.08], [width / 2 - 0.18, 0, frontZ + 0.05], railMat);
  addSideVents(state.rackGroup, width, depth, height);
  addWheels(state.rackGroup, width, depth, height);

  const visibleNodes = nodes.slice(0, 14);
  const displayNodes = [...visibleNodes];
  while (displayNodes.length < 10) {
    displayNodes.push({
      name: `empty-slot-${displayNodes.length + 1}`,
      state: "empty",
      partitions: "blank",
      cpu_alloc: 0,
      cpu_total: 0,
      gpu_alloc: 0,
      gpu_total: 0,
      gres: "",
      reason: "",
      empty: true
    });
  }
  const slots = Math.max(displayNodes.length, 1);
  const unit = Math.min(0.44, (height - 0.82) / Math.max(slots, 10));
  const startY = -height / 2 + 0.55;

  displayNodes.forEach((node, index) => {
    const type = nodeType(node);
    const group = new THREE.Group();
    const y = startY + index * unit;
    const isGpu = Number(node.gpu_total || 0) > 0;
    const serverHeight = isGpu ? unit * 0.95 : unit * 0.82;
    createServer(group, node, type, y, serverHeight, width, frontZ, isGpu);
    state.rackGroup.add(group);
  });
}

function addSideVents(parent, width, depth, height) {
  const ventMat = createMaterial(0x0d1013, 0.65, 0.18);
  [-1, 1].forEach((side) => {
    for (let i = 0; i < 8; i += 1) {
      addBox(parent, [0.022, 0.42, 0.035], [side * (width / 2 + 0.094), 0.75 + i * 0.055, -0.2 + i * 0.055], ventMat, "side-vent");
      addBox(parent, [0.022, 0.42, 0.035], [side * (width / 2 + 0.094), -1.9 + i * 0.055, -0.25 + i * 0.055], ventMat, "side-vent");
    }
  });
}

function addWheels(parent, width, depth, height) {
  const wheelMat = createMaterial(COLORS.wheel, 0.38, 0.35);
  const y = -height / 2 - 0.19;
  const positions = [
    [-width / 2 + 0.18, y, depth / 2 - 0.24],
    [width / 2 - 0.18, y, depth / 2 - 0.24],
    [-width / 2 + 0.18, y, -depth / 2 + 0.24],
    [width / 2 - 0.18, y, -depth / 2 + 0.24]
  ];
  positions.forEach((position) => {
    addCylinder(parent, 0.11, 0.08, position, wheelMat, [Math.PI / 2, 0, 0], "caster");
  });
}

function createServer(group, node, type, y, serverHeight, rackWidth, frontZ, isGpu) {
  const isEmpty = !!node.empty;
  const statusColor = COLORS[type] || COLORS.idle;
  const chassisMat = createMaterial(isEmpty ? 0x171c21 : 0x242b31, 0.5, 0.32);
  const faceMat = createMaterial(isEmpty ? 0x343d45 : COLORS.face, 0.56, 0.15);
  const darkMat = createMaterial(0x10151a, 0.58, 0.25);
  const ventMat = createMaterial(COLORS.vent, 0.66, 0.08);
  const ledMat = createMaterial(statusColor, 0.28, 0.1);
  const accentMat = createMaterial(isGpu ? COLORS.gpu : COLORS.accent, 0.36, 0.16);
  const body = addBox(group, [rackWidth - 0.38, serverHeight, 2.65], [0, y, -0.12], chassisMat, node.name || "server");
  body.userData.node = node;
  body.userData.type = type;

  const face = addBox(group, [rackWidth - 0.48, serverHeight * 0.86, 0.055], [0, y, frontZ + 0.09], faceMat, "front-panel");
  face.userData.node = node;
  face.userData.type = type;

  addBox(group, [0.09, serverHeight * 0.72, 0.075], [-(rackWidth / 2) + 0.28, y, frontZ + 0.13], accentMat, "accent-strip");
  addBox(group, [0.34, serverHeight * 0.55, 0.075], [-(rackWidth / 2) + 0.52, y, frontZ + 0.14], ventMat, "left-vent");
  addBox(group, [0.34, serverHeight * 0.55, 0.075], [(rackWidth / 2) - 0.5, y, frontZ + 0.14], ventMat, "right-vent");
  addBox(group, [0.24, serverHeight * 0.38, 0.08], [0, y, frontZ + 0.145], darkMat, "handle");
  addBox(group, [0.06, 0.06, 0.09], [0.24, y + serverHeight * 0.16, frontZ + 0.15], ledMat, "led");
  addBox(group, [0.06, 0.06, 0.09], [0.34, y + serverHeight * 0.16, frontZ + 0.15], createMaterial(0x34d399, 0.25, 0.05), "led-ok");

  for (let i = 0; i < 5; i += 1) {
    addBox(group, [0.014, serverHeight * 0.45, 0.082], [-(rackWidth / 2) + 0.42 + i * 0.052, y, frontZ + 0.17], darkMat, "vent-line");
    addBox(group, [0.014, serverHeight * 0.45, 0.082], [(rackWidth / 2) - 0.64 + i * 0.052, y, frontZ + 0.17], darkMat, "vent-line");
  }

  if (!isEmpty) {
    state.devices.push(body, face);
  }
}

function pick(event) {
  if (!state.devices.length) return;
  const rect = state.renderer.domElement.getBoundingClientRect();
  state.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  state.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  state.raycaster.setFromCamera(state.pointer, state.camera);
  const hit = state.raycaster.intersectObjects(state.devices, false)[0];
  if (hit?.object?.userData?.node) {
    selectDevice(hit.object);
  }
}

function selectDevice(mesh) {
  state.selected?.material?.emissive?.setHex?.(0x000000);
  state.selected = mesh;
  mesh.material.emissive = new THREE.Color(0x173d42);
  const node = mesh.userData.node;
  const type = mesh.userData.type;
  const cpuPct = Number(node.cpu_total) ? Math.round((Number(node.cpu_alloc || 0) / Number(node.cpu_total)) * 100) : 0;
  const gpuText = Number(node.gpu_total || 0) > 0 ? `${node.gpu_alloc || 0}/${node.gpu_total} GPU` : "No GPU";
  const target = document.querySelector("#hardwareSelected");
  if (target) {
    target.innerHTML = `
      <strong>${escapeHtml(node.name || "unknown")}</strong>
      <span>${escapeHtml(node.state || type)} · ${escapeHtml(node.partitions || "partition 없음")}</span>
      <dl>
        <dt>CPU</dt><dd>${node.cpu_alloc || 0}/${node.cpu_total || 0} cores · ${cpuPct}%</dd>
        <dt>GPU</dt><dd>${escapeHtml(gpuText)}</dd>
        <dt>GRES</dt><dd>${escapeHtml(node.gres || "-")}</dd>
        <dt>Reason</dt><dd>${escapeHtml(node.reason || "-")}</dd>
      </dl>
    `;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function animate() {
  state.raf = requestAnimationFrame(animate);
  if (!state.renderer) return;
  state.rackGroup.rotation.y += (state.rotationY - state.rackGroup.rotation.y) * 0.12;
  state.rackGroup.rotation.x += (state.rotationX - state.rackGroup.rotation.x) * 0.12;
  state.camera.lookAt(0, 0, 0);
  state.renderer.render(state.scene, state.camera);
}

function update(payload = {}) {
  initScene();
  const nodes = payload.nodes?.length ? payload.nodes : [fallbackNode(payload.system)];
  buildRack(nodes.slice(0, 42));
  const selectedStillExists = nodes.find((node) => node.name === state.selected?.userData?.node?.name);
  if (!selectedStillExists) {
    state.selected = null;
  }
  resize();
}

window.DAquilaHardware3D = { update, resize };
window.dispatchEvent(new CustomEvent("d-aquila-hardware-ready"));
