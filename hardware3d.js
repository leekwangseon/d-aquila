import * as THREE from "./vendor/three/three.module.min.js";

const RACK_UNITS = 42;
const LAYOUT_KEY = "d-aquila-rack-layout";
const PDU_KEY = "d-aquila-rack-pdu";

const state = {
  stage: null,
  renderer: null,
  scene: null,
  camera: null,
  rackGroup: null,
  devices: [],
  selected: null,
  currentNodes: [],
  currentSystem: {},
  rackMeta: null,
  logoTexture: null,
  raf: null,
  zoom: 10.2,
  rotationY: -0.5,
  rotationX: -0.05,
  dragging: false,
  pointer: new THREE.Vector2(),
  raycaster: new THREE.Raycaster(),
  lastPointer: { x: 0, y: 0 },
  panelBound: false
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
  wheel: 0x080a0c,
  pdu: 0xd95f43
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
    reason: "",
    local: true
  };
}

function createMaterial(color, roughness = 0.55, metalness = 0.18, options = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, ...options });
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

  loadLogoTexture();
  bindControls();
  bindPanelControls();
  resize();
  animate();
}

function loadLogoTexture() {
  const image = new Image();
  image.onload = () => {
    const crop = cropLogoImage(image);
    state.logoTexture = new THREE.CanvasTexture(crop);
    state.logoTexture.colorSpace = THREE.SRGBColorSpace;
    rebuildRack();
  };
  image.src = "./assets/dasan-logo.png";
}

function cropLogoImage(image) {
  const source = document.createElement("canvas");
  source.width = image.naturalWidth || image.width;
  source.height = image.naturalHeight || image.height;
  const ctx = source.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, source.width, source.height).data;
  let minX = source.width;
  let minY = source.height;
  let maxX = 0;
  let maxY = 0;

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const offset = (y * source.width + x) * 4;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      const a = data[offset + 3];
      if (a > 8 && (r > 38 || g > 38 || b > 38)) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (maxX <= minX || maxY <= minY) return source;
  const pad = 28;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(source.width - 1, maxX + pad);
  maxY = Math.min(source.height - 1, maxY + pad);

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const target = document.createElement("canvas");
  target.width = width;
  target.height = height;
  target.getContext("2d").drawImage(source, minX, minY, width, height, 0, 0, width, height);
  return target;
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

function bindPanelControls() {
  if (state.panelBound) return;
  state.panelBound = true;

  document.querySelector("#hardwareApplyLayout")?.addEventListener("click", () => {
    if (!state.selected?.userData?.node?.name) return;
    const name = state.selected.userData.node.name;
    const units = clampNumber(document.querySelector("#hardwareUnitInput")?.value, 1, 8, 2);
    const startU = clampNumber(document.querySelector("#hardwareStartUInput")?.value, 1, RACK_UNITS - units + 1, 1);
    const layout = readLayout();
    layout[name] = { units, startU };
    saveLayout(layout);
    rebuildRack(name);
  });

  document.querySelector("#hardwareMoveUp")?.addEventListener("click", () => moveSelected(1));
  document.querySelector("#hardwareMoveDown")?.addEventListener("click", () => moveSelected(-1));

  document.querySelector("#pduApply")?.addEventListener("click", () => {
    const capacityWatts = clampNumber(document.querySelector("#pduCapacityInput")?.value, 1, 100000, 6000);
    const allocatedWatts = clampNumber(document.querySelector("#pduAllocatedInput")?.value, 0, 100000, 0);
    savePdu({ capacityWatts, allocatedWatts });
    updatePduPanel();
    rebuildRack(state.selected?.userData?.node?.name);
  });
}

function moveSelected(delta) {
  if (!state.selected?.userData?.node?.name) return;
  const name = state.selected.userData.node.name;
  const layout = readLayout();
  const current = layout[name] || state.selected.userData.layout || { units: 2, startU: 1 };
  const units = clampNumber(current.units, 1, 8, 2);
  const startU = clampNumber(Number(current.startU || 1) + delta, 1, RACK_UNITS - units + 1, 1);
  layout[name] = { units, startU };
  saveLayout(layout);
  rebuildRack(name);
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
      if (Array.isArray(object.material)) {
        object.material.forEach((material) => material?.dispose?.());
      } else if (object.material?.map !== state.logoTexture) {
        object.material?.dispose?.();
      }
    });
  }
  state.devices = [];
}

function rebuildRack(selectName = "") {
  if (!state.rackGroup) return;
  buildRack(state.currentNodes);
  if (selectName) {
    const mesh = state.devices.find((device) => device.userData?.node?.name === selectName);
    if (mesh) selectDevice(mesh);
  }
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
  const unitHeight = (height - 0.92) / RACK_UNITS;
  const bottomY = -height / 2 + 0.46;
  state.rackMeta = { width, depth, height, frontZ, unitHeight, bottomY };

  addBox(state.rackGroup, [width + 0.28, 0.18, depth + 0.22], [0, height / 2, 0], trimMat);
  addBox(state.rackGroup, [width + 0.28, 0.2, depth + 0.22], [0, -height / 2, 0], trimMat);
  addBox(state.rackGroup, [0.14, height, 0.14], [-width / 2, 0, frontZ], rackMat);
  addBox(state.rackGroup, [0.14, height, 0.14], [width / 2, 0, frontZ], rackMat);
  addBox(state.rackGroup, [0.18, height, depth], [-width / 2, 0, 0], sideMat);
  addBox(state.rackGroup, [0.18, height, depth], [width / 2, 0, 0], sideMat);
  addBox(state.rackGroup, [width, height, 0.16], [0, 0, -depth / 2], sideMat);
  addBox(state.rackGroup, [0.045, height - 0.46, 0.08], [-width / 2 + 0.18, 0, frontZ + 0.05], railMat);
  addBox(state.rackGroup, [0.045, height - 0.46, 0.08], [width / 2 - 0.18, 0, frontZ + 0.05], railMat);
  addRackUnitTicks(state.rackGroup, width, height, frontZ, unitHeight, bottomY);
  addSideVents(state.rackGroup, width, depth, height);
  addSideLogos(state.rackGroup, width, height);
  addRearPdu(state.rackGroup, width, depth, height);
  addWheels(state.rackGroup, width, depth, height);

  const actualNodes = nodes.slice(0, RACK_UNITS);
  const placements = computePlacements(actualNodes);
  placements.forEach(({ node, units, startU }) => {
    const type = nodeType(node);
    const group = new THREE.Group();
    const y = bottomY + ((startU - 1) + units / 2) * unitHeight;
    const serverHeight = Math.max(unitHeight * units * 0.9, unitHeight * 0.72);
    const isGpu = Number(node.gpu_total || 0) > 0;
    createServer(group, node, type, y, serverHeight, width, frontZ, isGpu, { units, startU });
    state.rackGroup.add(group);
  });
}

function computePlacements(nodes) {
  const layout = readLayout();
  let nextU = 1;
  return nodes.map((node) => {
    const saved = layout[node.name] || {};
    const units = clampNumber(saved.units, 1, 8, Number(node.gpu_total || 0) > 0 ? 4 : 2);
    const maxStart = Math.max(1, RACK_UNITS - units + 1);
    const startU = saved.startU ? clampNumber(saved.startU, 1, maxStart, nextU) : clampNumber(nextU, 1, maxStart, 1);
    nextU = Math.min(RACK_UNITS, startU + units);
    return { node, units, startU };
  });
}

function addRackUnitTicks(parent, width, height, frontZ, unitHeight, bottomY) {
  const tickMat = createMaterial(0x4d5965, 0.6, 0.12);
  for (let u = 0; u <= RACK_UNITS; u += 1) {
    const y = bottomY + u * unitHeight;
    const tickWidth = u % 5 === 0 ? 0.12 : 0.07;
    addBox(parent, [tickWidth, 0.008, 0.012], [-width / 2 + 0.18, y, frontZ + 0.11], tickMat, "rack-unit-tick");
    addBox(parent, [tickWidth, 0.008, 0.012], [width / 2 - 0.18, y, frontZ + 0.11], tickMat, "rack-unit-tick");
  }
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

function addSideLogos(parent, width, height) {
  if (!state.logoTexture) return;
  const logoMat = new THREE.MeshBasicMaterial({
    map: state.logoTexture,
    transparent: true,
    toneMapped: false,
    side: THREE.DoubleSide
  });
  [-1, 1].forEach((side) => {
    const logo = new THREE.Mesh(new THREE.PlaneGeometry(1.62, 0.5), logoMat);
    logo.position.set(side * (width / 2 + 0.106), height * 0.18, 0.22);
    logo.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
    parent.add(logo);
  });
}

function addRearPdu(parent, width, depth, height) {
  const pdu = readPdu();
  const capacity = Math.max(Number(pdu.capacityWatts || 0), 1);
  const allocated = Math.max(Number(pdu.allocatedWatts || 0), 0);
  const pct = Math.min(1, allocated / capacity);
  const railHeight = height - 0.9;
  const rearZ = -depth / 2 - 0.1;
  const pduMat = createMaterial(0x202832, 0.5, 0.25);
  const fillMat = createMaterial(COLORS.pdu, 0.34, 0.1);
  const capMat = createMaterial(0x0b1117, 0.45, 0.24);

  [-1, 1].forEach((side) => {
    const x = side * (width / 2 - 0.24);
    addBox(parent, [0.1, railHeight, 0.08], [x, 0, rearZ], pduMat, "rear-pdu");
    addBox(parent, [0.104, Math.max(0.04, railHeight * pct), 0.09], [x, -railHeight / 2 + (railHeight * pct) / 2, rearZ - 0.004], fillMat, "rear-pdu-load");
    for (let i = 0; i < 10; i += 1) {
      addBox(parent, [0.058, 0.05, 0.095], [x, -2.25 + i * 0.45, rearZ - 0.015], capMat, "pdu-outlet");
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

function createServer(group, node, type, y, serverHeight, rackWidth, frontZ, isGpu, layout) {
  const statusColor = COLORS[type] || COLORS.idle;
  const chassisMat = createMaterial(0x242b31, 0.5, 0.32);
  const faceMat = createMaterial(COLORS.face, 0.56, 0.15);
  const darkMat = createMaterial(0x10151a, 0.58, 0.25);
  const ventMat = createMaterial(COLORS.vent, 0.66, 0.08);
  const ledMat = createMaterial(statusColor, 0.28, 0.1);
  const accentMat = createMaterial(isGpu ? COLORS.gpu : COLORS.accent, 0.36, 0.16);
  const body = addBox(group, [rackWidth - 0.38, serverHeight, 2.65], [0, y, -0.12], chassisMat, node.name || "server");
  body.userData = { node, type, layout };

  const face = addBox(group, [rackWidth - 0.48, serverHeight * 0.86, 0.055], [0, y, frontZ + 0.09], faceMat, "front-panel");
  face.userData = { node, type, layout };

  addBox(group, [0.09, serverHeight * 0.72, 0.075], [-(rackWidth / 2) + 0.28, y, frontZ + 0.13], accentMat, "accent-strip");
  addBox(group, [0.34, serverHeight * 0.55, 0.075], [-(rackWidth / 2) + 0.52, y, frontZ + 0.14], ventMat, "left-vent");
  addBox(group, [0.34, serverHeight * 0.55, 0.075], [(rackWidth / 2) - 0.5, y, frontZ + 0.14], ventMat, "right-vent");
  addBox(group, [0.24, Math.min(serverHeight * 0.38, 0.18), 0.08], [0, y, frontZ + 0.145], darkMat, "handle");
  addBox(group, [0.06, 0.06, 0.09], [0.24, y + Math.min(serverHeight * 0.16, 0.12), frontZ + 0.15], ledMat, "led");
  addBox(group, [0.06, 0.06, 0.09], [0.34, y + Math.min(serverHeight * 0.16, 0.12), frontZ + 0.15], createMaterial(0x34d399, 0.25, 0.05), "led-ok");

  for (let i = 0; i < 5; i += 1) {
    addBox(group, [0.014, serverHeight * 0.45, 0.082], [-(rackWidth / 2) + 0.42 + i * 0.052, y, frontZ + 0.17], darkMat, "vent-line");
    addBox(group, [0.014, serverHeight * 0.45, 0.082], [(rackWidth / 2) - 0.64 + i * 0.052, y, frontZ + 0.17], darkMat, "vent-line");
  }

  state.devices.push(body, face);
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
  const layout = mesh.userData.layout || { units: 2, startU: 1 };
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
        <dt>Rack U</dt><dd>${layout.startU}U부터 ${layout.units}U 사용</dd>
        <dt>Reason</dt><dd>${escapeHtml(node.reason || "-")}</dd>
      </dl>
    `;
  }
  setLayoutControls(node.name, layout);
}

function setLayoutControls(name, layout) {
  const panel = document.querySelector("#rackPlacementPanel");
  const nameTarget = document.querySelector("#hardwareSelectedName");
  const unitInput = document.querySelector("#hardwareUnitInput");
  const startInput = document.querySelector("#hardwareStartUInput");
  if (panel) panel.classList.remove("disabled");
  if (nameTarget) nameTarget.textContent = name || "-";
  if (unitInput) unitInput.value = layout.units || 2;
  if (startInput) startInput.value = layout.startU || 1;
  setPlacementDisabled(false);
}

function resetLayoutControls() {
  document.querySelector("#rackPlacementPanel")?.classList.add("disabled");
  const nameTarget = document.querySelector("#hardwareSelectedName");
  if (nameTarget) nameTarget.textContent = "서버를 선택하세요";
  setPlacementDisabled(true);
}

function setPlacementDisabled(disabled) {
  [
    "#hardwareUnitInput",
    "#hardwareStartUInput",
    "#hardwareMoveDown",
    "#hardwareMoveUp",
    "#hardwareApplyLayout"
  ].forEach((selector) => {
    const element = document.querySelector(selector);
    if (element) element.disabled = disabled;
  });
}

function updatePduPanel() {
  const pdu = readPdu();
  const capacityInput = document.querySelector("#pduCapacityInput");
  const allocatedInput = document.querySelector("#pduAllocatedInput");
  const usageText = document.querySelector("#pduUsageText");
  const usageBar = document.querySelector("#pduUsageBar");
  if (capacityInput) capacityInput.value = pdu.capacityWatts;
  if (allocatedInput) allocatedInput.value = pdu.allocatedWatts;
  const pct = pdu.capacityWatts ? Math.round((pdu.allocatedWatts / pdu.capacityWatts) * 100) : 0;
  if (usageText) usageText.textContent = `${formatWatts(pdu.allocatedWatts)} / ${formatWatts(pdu.capacityWatts)} · ${pct}%`;
  if (usageBar) usageBar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
}

function readLayout() {
  try {
    return JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function saveLayout(layout) {
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
}

function readPdu() {
  try {
    return { capacityWatts: 6000, allocatedWatts: 0, ...(JSON.parse(localStorage.getItem(PDU_KEY) || "{}") || {}) };
  } catch {
    return { capacityWatts: 6000, allocatedWatts: 0 };
  }
}

function savePdu(pdu) {
  localStorage.setItem(PDU_KEY, JSON.stringify(pdu));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function formatWatts(value) {
  const watts = Number(value || 0);
  if (watts >= 1000) return `${(watts / 1000).toFixed(1)} kW`;
  return `${watts} W`;
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
  state.currentSystem = payload.system || {};
  state.currentNodes = payload.nodes?.length ? payload.nodes.slice(0, RACK_UNITS) : [fallbackNode(payload.system)];
  buildRack(state.currentNodes);
  updatePduPanel();
  const selectedStillExists = state.currentNodes.find((node) => node.name === state.selected?.userData?.node?.name);
  if (!selectedStillExists) {
    state.selected = null;
    resetLayoutControls();
  }
  resize();
}

window.DAquilaHardware3D = { update, resize };
window.dispatchEvent(new CustomEvent("d-aquila-hardware-ready"));
