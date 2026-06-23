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
  zoom: 10,
  rotationY: -0.42,
  rotationX: -0.08,
  dragging: false,
  pointer: new THREE.Vector2(),
  raycaster: new THREE.Raycaster(),
  lastPointer: { x: 0, y: 0 }
};

const COLORS = {
  rack: 0x24384a,
  rail: 0x8ca0b3,
  idle: 0x8ca0b3,
  busy: 0x0b6f7a,
  gpu: 0x4b62b5,
  warn: 0xe5a423,
  down: 0xc93f38,
  face: 0xf8fafc,
  accent: 0xd95f43
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
  parent.add(mesh);
  return mesh;
}

function initScene() {
  state.stage = document.querySelector("#hardwareStage");
  if (!state.stage || state.renderer) return;

  state.scene = new THREE.Scene();
  state.scene.background = new THREE.Color(0xeef2f6);

  state.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  state.camera.position.set(0, 1.2, state.zoom);
  state.camera.lookAt(0, 0, 0);

  state.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  state.renderer.shadowMap.enabled = true;
  state.stage.appendChild(state.renderer.domElement);

  const ambient = new THREE.HemisphereLight(0xffffff, 0x9aa8b5, 1.65);
  state.scene.add(ambient);

  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(4, 7, 6);
  key.castShadow = true;
  state.scene.add(key);

  const fill = new THREE.DirectionalLight(0x5aa7b0, 1.2);
  fill.position.set(-6, 3, 4);
  state.scene.add(fill);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(12, 9),
    new THREE.MeshStandardMaterial({ color: 0xdfe7ef, roughness: 0.8, metalness: 0.05 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -3.05;
  floor.receiveShadow = true;
  state.scene.add(floor);

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
  const rackMat = createMaterial(COLORS.rack, 0.38, 0.36);
  const railMat = createMaterial(COLORS.rail, 0.45, 0.22);
  const depth = 1.5;
  const height = 5.7;
  const width = 2.6;

  addBox(state.rackGroup, [0.12, height, 0.12], [-width / 2, 0, -depth / 2], railMat);
  addBox(state.rackGroup, [0.12, height, 0.12], [width / 2, 0, -depth / 2], railMat);
  addBox(state.rackGroup, [0.12, height, 0.12], [-width / 2, 0, depth / 2], railMat);
  addBox(state.rackGroup, [0.12, height, 0.12], [width / 2, 0, depth / 2], railMat);
  addBox(state.rackGroup, [width + 0.22, 0.12, depth + 0.18], [0, height / 2, 0], rackMat);
  addBox(state.rackGroup, [width + 0.22, 0.12, depth + 0.18], [0, -height / 2, 0], rackMat);

  const slots = Math.max(nodes.length, 1);
  const unit = Math.min(0.28, (height - 0.5) / Math.max(slots, 18));
  const startY = -height / 2 + 0.35;

  nodes.forEach((node, index) => {
    const type = nodeType(node);
    const group = new THREE.Group();
    const y = startY + index * unit;
    const isGpu = Number(node.gpu_total || 0) > 0;
    const serverHeight = isGpu ? unit * 1.55 : unit * 0.82;
    const mat = createMaterial(COLORS[type] || COLORS.idle, 0.48, 0.2);
    const faceMat = createMaterial(COLORS.face, 0.65, 0.04);
    const body = addBox(group, [2.25, Math.max(serverHeight, 0.11), 1.18], [0, y, 0], mat, node.name || `node-${index + 1}`);
    body.castShadow = true;
    body.userData.node = node;
    body.userData.type = type;
    const face = addBox(group, [2.05, Math.max(serverHeight * 0.72, 0.07), 0.04], [0, y, 0.62], faceMat);
    face.userData.node = node;
    face.userData.type = type;
    addBox(group, [0.18, 0.04, 0.06], [-0.92, y, 0.66], createMaterial(COLORS[type] || COLORS.idle), "status");
    addBox(group, [0.42, 0.04, 0.06], [0.82, y, 0.66], createMaterial(isGpu ? COLORS.gpu : COLORS.rail), "io");
    state.rackGroup.add(group);
    state.devices.push(body);
    state.devices.push(face);
  });
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
