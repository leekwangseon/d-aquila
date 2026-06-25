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
  logoCanvas: null,
  contextGroups: {},
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

function addRotatedBar(parent, size, position, material, rotationZ, name = "") {
  const mesh = addBox(parent, size, position, material, name);
  mesh.rotation.z = rotationZ;
  return mesh;
}

function initScene() {
  state.stage = document.querySelector("#hardwareStage");
  if (!state.stage || state.renderer) return;

  state.scene = new THREE.Scene();
  state.scene.background = new THREE.Color(0xeef2f6);

  state.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  state.camera.position.set(0.2, 1.15, state.zoom);
  updateCameraPosition();
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
    new THREE.PlaneGeometry(34, 26),
    new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.82, metalness: 0.02 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -3.05;
  floor.receiveShadow = true;
  state.scene.add(floor);

  const grid = new THREE.GridHelper(34, 48, 0x8c98a3, 0xcfd6dd);
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
    state.logoCanvas = crop;
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
    state.zoom = Math.max(5.6, Math.min(62, state.zoom + event.deltaY * 0.018));
    updateCameraPosition();
    updateContextVisibility();
  }, { passive: false });
  window.addEventListener("resize", resize);
}

function updateCameraPosition() {
  if (!state.camera) return;
  const farRatio = Math.max(0, Math.min(1, (state.zoom - 10.5) / 48));
  state.camera.position.set(0.2 + farRatio * 2.2, 1.15 + farRatio * 8.8, state.zoom);
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
    const current = state.selected.userData.layout || {};
    layout[name] = { units, startU, rackIndex: current.rackIndex || 0 };
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
  layout[name] = { units, startU, rackIndex: current.rackIndex || 0 };
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
  state.contextGroups = {};
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

  addCampusContext(state.rackGroup, nodes, { width, depth, height });
  const activeRackGroup = new THREE.Group();
  activeRackGroup.name = "active-rack-detail";
  state.rackGroup.add(activeRackGroup);
  state.contextGroups.activeRackGroup = activeRackGroup;

  const placements = computePlacements(nodes);
  const rackCount = Math.max(1, placements.reduce((max, item) => Math.max(max, item.rackIndex + 1), 0));
  const rackGap = 0.72;
  const rackSpacing = width + rackGap;
  const rackGroups = Array.from({ length: rackCount }, (_, rackIndex) => {
    const rack = new THREE.Group();
    rack.name = `rack-${rackIndex + 1}`;
    rack.position.x = (rackIndex - (rackCount - 1) / 2) * rackSpacing;
    activeRackGroup.add(rack);
    buildRackFrame(rack, {
      width,
      depth,
      height,
      frontZ,
      unitHeight,
      bottomY,
      rackMat,
      sideMat,
      trimMat,
      railMat,
      label: `RACK ${String(rackIndex + 1).padStart(2, "0")}`
    });
    return rack;
  });

  placements.forEach(({ node, units, startU, rackIndex }) => {
    const type = nodeType(node);
    const group = new THREE.Group();
    const y = bottomY + ((startU - 1) + units / 2) * unitHeight;
    const serverHeight = Math.max(unitHeight * units * 0.9, unitHeight * 0.72);
    const isGpu = Number(node.gpu_total || 0) > 0;
    createServer(group, node, type, y, serverHeight, width, frontZ, isGpu, { units, startU, rackIndex });
    rackGroups[Math.min(rackGroups.length - 1, Math.max(0, rackIndex || 0))]?.add(group);
  });
  updateContextVisibility();
}

function buildRackFrame(parent, parts) {
  const { width, depth, height, frontZ, unitHeight, bottomY, rackMat, sideMat, trimMat, railMat, label } = parts;
  addBox(parent, [width + 0.28, 0.18, depth + 0.22], [0, height / 2, 0], trimMat);
  addBox(parent, [width + 0.28, 0.2, depth + 0.22], [0, -height / 2, 0], trimMat);
  addBox(parent, [0.14, height, 0.14], [-width / 2, 0, frontZ], rackMat);
  addBox(parent, [0.14, height, 0.14], [width / 2, 0, frontZ], rackMat);
  addBox(parent, [0.18, height, depth], [-width / 2, 0, 0], sideMat);
  addBox(parent, [0.18, height, depth], [width / 2, 0, 0], sideMat);
  addBox(parent, [width, height, 0.16], [0, 0, -depth / 2], sideMat);
  addBox(parent, [0.045, height - 0.46, 0.08], [-width / 2 + 0.18, 0, frontZ + 0.05], railMat);
  addBox(parent, [0.045, height - 0.46, 0.08], [width / 2 - 0.18, 0, frontZ + 0.05], railMat);
  addRackUnitTicks(parent, width, height, frontZ, unitHeight, bottomY);
  addSideVents(parent, width, depth, height);
  addSideLogos(parent, width, height);
  addRearPdu(parent, width, depth, height);
  addWheels(parent, width, depth, height);
  addRackLabel(parent, label, [0, height / 2 - 0.34, frontZ + 0.16]);
}

function computePlacements(nodes) {
  const layout = readLayout();
  const sorted = nodes.slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true }));
  let nextU = 1;
  let rackIndex = 0;
  return sorted.map((node) => {
    const saved = layout[node.name] || {};
    const units = clampNumber(saved.units, 1, 8, Number(node.gpu_total || 0) > 0 ? 4 : 2);
    const maxStart = Math.max(1, RACK_UNITS - units + 1);
    if (!saved.startU && nextU + units - 1 > RACK_UNITS) {
      rackIndex += 1;
      nextU = 1;
    }
    const effectiveRackIndex = Number.isFinite(Number(saved.rackIndex)) ? clampNumber(saved.rackIndex, 0, 99, rackIndex) : rackIndex;
    const startU = saved.startU ? clampNumber(saved.startU, 1, maxStart, nextU) : clampNumber(nextU, 1, maxStart, 1);
    nextU = Math.min(RACK_UNITS, startU + units);
    return { node, units, startU, rackIndex: effectiveRackIndex };
  });
}

function addCampusContext(parent, nodes, rackSize) {
  const roomGroup = new THREE.Group();
  roomGroup.name = "room-context";
  const floorGroup = new THREE.Group();
  floorGroup.name = "floor-context";
  const buildingGroup = new THREE.Group();
  buildingGroup.name = "building-context";
  parent.add(roomGroup, floorGroup, buildingGroup);
  state.contextGroups = { roomGroup, floorGroup, buildingGroup };

  addRoomContext(roomGroup, nodes, rackSize);
  addFloorContext(floorGroup);
  addBuildingContext(buildingGroup);
}

function addRoomContext(parent, nodes, rackSize) {
  const floorMat = createMaterial(0xe7edf3, 0.76, 0.03);
  const lineMat = createMaterial(0x8ea0af, 0.62, 0.04);
  const glassMat = createMaterial(0x9cc8d8, 0.42, 0.02, { transparent: true, opacity: 0.32 });
  const labelMat = createMaterial(0x243443, 0.58, 0.05);
  const rooms = [
    { name: "GPU ROOM", x: -5.4, z: -3.8, color: 0x4b62b5 },
    { name: "CPU ROOM", x: 5.4, z: -3.8, color: 0x0b6f7a },
    { name: "STORAGE", x: -5.4, z: 4.2, color: 0xe5a423 },
    { name: "NETWORK", x: 5.4, z: 4.2, color: 0xd95f43 }
  ];

  rooms.forEach((room, roomIndex) => {
    addBox(parent, [5.2, 0.035, 4.2], [room.x, -3.025, room.z], floorMat, "room-floor");
    addBox(parent, [5.2, 0.05, 0.06], [room.x, -2.96, room.z - 2.08], lineMat, "room-wall");
    addBox(parent, [5.2, 0.05, 0.06], [room.x, -2.96, room.z + 2.08], lineMat, "room-wall");
    addBox(parent, [0.06, 0.05, 4.2], [room.x - 2.58, -2.96, room.z], lineMat, "room-wall");
    addBox(parent, [0.06, 0.05, 4.2], [room.x + 2.58, -2.96, room.z], lineMat, "room-wall");
    addBox(parent, [4.4, 1.15, 0.035], [room.x, -2.42, room.z - 2.1], glassMat, "room-glass");
    addRoomLabel(parent, room.name, [room.x, -2.86, room.z - 1.55], room.color);

    const rackCount = Math.max(2, Math.min(6, Math.ceil((nodes.length || 4) / 4)));
    for (let i = 0; i < rackCount; i += 1) {
      const column = i % 3;
      const row = Math.floor(i / 3);
      const x = room.x - 1.55 + column * 1.55;
      const z = room.z - 0.45 + row * 1.15;
      addMiniRack(parent, [x, -2.36, z], room.color, roomIndex === 0 && i === 0 ? 1.0 : 0.74);
    }
  });

  addBox(parent, [rackSize.width + 0.58, 0.028, rackSize.depth + 0.48], [0, -3.015, 0], createMaterial(0xd9eef0, 0.64, 0.02), "active-rack-pad");
  addMiniRack(parent, [0, -2.35, 0], 0xd95f43, 0.92);
}

function addMiniRack(parent, position, color, scale = 0.72) {
  const group = new THREE.Group();
  group.position.set(...position);
  group.scale.set(scale, scale, scale);
  parent.add(group);
  const rackMat = createMaterial(0x151a1f, 0.4, 0.3);
  const faceMat = createMaterial(0x9fb0bc, 0.48, 0.14);
  const accentMat = createMaterial(color, 0.34, 0.08);
  addBox(group, [0.58, 1.25, 0.82], [0, 0, 0], rackMat, "mini-rack");
  for (let i = 0; i < 5; i += 1) {
    addBox(group, [0.46, 0.12, 0.035], [0, -0.42 + i * 0.2, 0.43], faceMat, "mini-server");
    addBox(group, [0.06, 0.1, 0.045], [-0.17, -0.42 + i * 0.2, 0.455], accentMat, "mini-server-led");
  }
}

function addRoomLabel(parent, text, position, color) {
  const texture = createTextTexture(text, { width: 512, height: 128, background: "rgba(255,255,255,0.92)", color: "#17202a", accent: color });
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.55, 0.38), material);
  mesh.position.set(...position);
  mesh.rotation.x = -Math.PI / 2;
  parent.add(mesh);
}

function addRackLabel(parent, text, position) {
  const texture = createTextTexture(text, {
    width: 640,
    height: 160,
    background: "rgba(5,8,11,0.9)",
    color: "#f4f7fb",
    accent: 0xd95f43,
    font: "900 58px Arial, sans-serif"
  });
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, toneMapped: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.08, 0.27), material);
  mesh.position.set(...position);
  parent.add(mesh);
}

function addHostnameLabel(parent, text, position, faceHeight) {
  const texture = createTextTexture(text, {
    width: 512,
    height: 128,
    background: "rgba(7,12,16,0.94)",
    color: "#ffffff",
    accent: 0x32a9c7,
    font: "900 58px Arial, sans-serif"
  });
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, toneMapped: false });
  const width = Math.min(0.9, Math.max(0.68, String(text).length * 0.082));
  const height = Math.min(0.22, Math.max(0.13, faceHeight * 0.34));
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
  mesh.position.set(...position);
  parent.add(mesh);
}

function addFloorContext(parent) {
  const slabMat = createMaterial(0xf5f7fa, 0.8, 0.02);
  const wallMat = createMaterial(0xcbd5df, 0.68, 0.04);
  const coreMat = createMaterial(0x213342, 0.5, 0.18);
  const levelNames = ["1F POWER", "2F DATA HALL", "3F GPU HALL", "4F NOC"];
  const zoneColors = [0xe5a423, 0x0b6f7a, 0x4b62b5, 0xd95f43];

  for (let level = 0; level < 4; level += 1) {
    const floor = new THREE.Group();
    floor.position.set(0, -3.08 + level * 0.42, -level * 0.42);
    floor.scale.set(1 - level * 0.045, 1, 1 - level * 0.045);
    parent.add(floor);
    addBox(floor, [17.5, 0.055, 11.4], [0, 0, 0], slabMat, "stacked-floor-plate");
    addBox(floor, [17.5, 0.08, 0.08], [0, 0.09, -5.7], wallMat, "stacked-floor-outline");
    addBox(floor, [17.5, 0.08, 0.08], [0, 0.09, 5.7], wallMat, "stacked-floor-outline");
    addBox(floor, [0.08, 0.08, 11.4], [-8.75, 0.09, 0], wallMat, "stacked-floor-outline");
    addBox(floor, [0.08, 0.08, 11.4], [8.75, 0.09, 0], wallMat, "stacked-floor-outline");
    addBox(floor, [2.0, 0.14, 4.8], [0, 0.17, 0], coreMat, "floor-core");
    addBox(floor, [0.08, 0.12, 10.2], [0, 0.2, 0], wallMat, "floor-corridor");
    addBox(floor, [16.2, 0.12, 0.08], [0, 0.2, 0], wallMat, "floor-corridor");
    addBox(floor, [3.7, 0.08, 2.4], [-5.4, 0.22, -3.1], createMaterial(zoneColors[level], 0.58, 0.04, { transparent: true, opacity: 0.42 }), "floor-zone");
    addBox(floor, [3.7, 0.08, 2.4], [5.4, 0.22, -3.1], createMaterial(0x74aabf, 0.58, 0.04, { transparent: true, opacity: 0.34 }), "floor-zone");
    addRoomLabel(floor, levelNames[level], [-5.4, 0.31, -3.1], zoneColors[level]);
    if (level === 2) {
      addMiniRack(floor, [-5.9, 0.9, -2.6], 0x4b62b5, 0.45);
      addMiniRack(floor, [-5.1, 0.9, -2.6], 0x4b62b5, 0.45);
    }
  }
}

function addBuildingContext(parent) {
  const baseMat = createMaterial(0x2a3642, 0.48, 0.22);
  const sideMat = createMaterial(0x1c2630, 0.55, 0.2);
  const glassMat = createMaterial(0x74aabf, 0.36, 0.06, { transparent: true, opacity: 0.72 });
  const signMat = createSignMaterial();
  const building = new THREE.Group();
  building.position.set(0, -0.2, 0);
  parent.add(building);

  addBox(building, [12.2, 8.2, 5.8], [0, 0.25, 0], baseMat, "cluster-center-building");
  addBox(building, [12.6, 0.42, 6.2], [0, 4.58, 0], sideMat, "building-roof");
  addBox(building, [12.9, 0.34, 6.5], [0, -4.05, 0], sideMat, "building-base");
  for (let floor = 0; floor < 4; floor += 1) {
    const y = -2.45 + floor * 1.55;
    for (let i = 0; i < 9; i += 1) {
      addBox(building, [0.72, 0.46, 0.055], [-4.4 + i * 1.1, y, 2.93], glassMat, "building-window");
    }
  }
  addBox(building, [1.6, 1.65, 0.08], [0, -3.3, 2.98], createMaterial(0x0b1117, 0.42, 0.2), "building-door");
  if (signMat) {
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(8.6, 1.05), signMat);
    sign.position.set(0, 3.05, 3.03);
    building.add(sign);
  }
}

function createTextTexture(text, options = {}) {
  const width = options.width || 1024;
  const height = options.height || 256;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = options.background || "rgba(255,255,255,0.94)";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = typeof options.accent === "number" ? `#${options.accent.toString(16).padStart(6, "0")}` : "#0b6f7a";
  ctx.fillRect(0, 0, 18, height);
  ctx.fillStyle = options.color || "#17202a";
  ctx.font = options.font || "700 58px Arial, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 48, height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createSignMaterial() {
  const canvas = document.createElement("canvas");
  canvas.width = 1400;
  canvas.height = 260;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#050607";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (state.logoCanvas) {
    ctx.drawImage(state.logoCanvas, 46, 58, 310, 118);
  }
  ctx.fillStyle = "#e7edf3";
  ctx.font = "700 64px Arial, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText("DASAN DATA", 385, 98);
  ctx.fillStyle = "#d95f43";
  ctx.font = "700 52px Arial, sans-serif";
  ctx.fillText("CLUSTER CENTER", 385, 166);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, toneMapped: false });
}

function updateContextVisibility() {
  const { activeRackGroup, roomGroup, floorGroup, buildingGroup } = state.contextGroups || {};
  if (!roomGroup || !floorGroup || !buildingGroup) return;
  if (activeRackGroup) {
    const shrink = Math.max(0, Math.min(1, (state.zoom - 11) / 12));
    const scale = 1 - shrink * 0.72;
    activeRackGroup.visible = state.zoom < 25;
    activeRackGroup.scale.set(scale, scale, scale);
  }
  roomGroup.visible = state.zoom >= 12 && state.zoom < 27;
  floorGroup.visible = state.zoom >= 23 && state.zoom < 43;
  buildingGroup.visible = state.zoom >= 40;
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
  const chassisMat = createMaterial(0xcfd7dd, 0.38, 0.28);
  const faceMat = createMaterial(0xe8ecef, 0.34, 0.22);
  const darkMat = createMaterial(0x0b0f13, 0.62, 0.16);
  const bayMat = createMaterial(0x151b21, 0.7, 0.08);
  const grilleMat = createMaterial(0xf2f4f5, 0.28, 0.18);
  const ledMat = createMaterial(statusColor, 0.22, 0.06);
  const accentMat = createMaterial(isGpu ? COLORS.gpu : COLORS.accent, 0.32, 0.14);
  const body = addBox(group, [rackWidth - 0.34, serverHeight, 2.66], [0, y, -0.12], chassisMat, node.name || "server");
  body.userData = { node, type, layout };

  const faceHeight = Math.max(serverHeight * 0.9, 0.08);
  const face = addBox(group, [rackWidth - 0.36, faceHeight, 0.075], [0, y, frontZ + 0.105], faceMat, "front-panel");
  face.userData = { node, type, layout };

  addServerFaceDetails(group, {
    node,
    y,
    serverHeight,
    faceHeight,
    rackWidth,
    frontZ,
    isGpu,
    darkMat,
    bayMat,
    grilleMat,
    ledMat,
    accentMat
  });

  state.devices.push(body, face);
}

function addServerFaceDetails(group, parts) {
  const {
    node,
    y,
    serverHeight,
    faceHeight,
    rackWidth,
    frontZ,
    isGpu,
    darkMat,
    bayMat,
    grilleMat,
    ledMat,
    accentMat
  } = parts;
  const z = frontZ + 0.155;
  const safeHeight = Math.max(faceHeight, 0.08);
  const bayHeight = Math.max(safeHeight * 0.62, 0.055);
  const bayWidth = 0.16;
  const bayGap = 0.04;
  const bayCount = safeHeight > 0.42 ? 8 : 6;
  const bayStart = -((bayCount - 1) * (bayWidth + bayGap)) / 2;

  addBox(group, [0.16, safeHeight * 0.88, 0.09], [-(rackWidth / 2) + 0.2, y, z], createMaterial(0xd5dbdf, 0.36, 0.22), "left-ear");
  addBox(group, [0.16, safeHeight * 0.88, 0.09], [(rackWidth / 2) - 0.2, y, z], createMaterial(0xd5dbdf, 0.36, 0.22), "right-ear");
  addBox(group, [0.045, safeHeight * 0.68, 0.11], [-(rackWidth / 2) + 0.28, y, z + 0.018], accentMat, "status-strip");
  addBox(group, [0.045, safeHeight * 0.68, 0.11], [(rackWidth / 2) - 0.28, y, z + 0.018], createMaterial(0x90a4b5, 0.38, 0.12), "service-strip");

  for (let i = 0; i < bayCount; i += 1) {
    const x = bayStart + i * (bayWidth + bayGap);
    addBox(group, [bayWidth, bayHeight, 0.105], [x, y, z + 0.006], bayMat, "drive-bay");
    addDriveBayLines(group, x, y, z + 0.068, bayWidth, bayHeight, darkMat);
    addBox(group, [0.018, 0.018, 0.118], [x + bayWidth * 0.25, y + bayHeight * 0.32, z + 0.078], ledMat, "bay-led");
    addBox(group, [0.016, 0.016, 0.118], [x - bayWidth * 0.25, y + bayHeight * 0.32, z + 0.078], createMaterial(0x34d399, 0.22, 0.04), "bay-ok-led");
  }

  addHoneycombGuard(group, {
    centerY: y,
    height: safeHeight,
    width: rackWidth - 0.66,
    z: z + 0.12,
    material: grilleMat
  });

  const badgeMat = createMaterial(0xc7ccd1, 0.32, 0.24);
  addCylinder(group, Math.min(0.075, safeHeight * 0.2), 0.018, [0, y, z + 0.145], badgeMat, [Math.PI / 2, 0, 0], "server-badge");
  addBox(group, [0.11, Math.max(safeHeight * 0.09, 0.018), 0.018], [0, y, z + 0.157], createMaterial(0x7c8790, 0.35, 0.12), "server-badge-mark");

  if (isGpu) {
    addBox(group, [rackWidth - 0.7, Math.max(safeHeight * 0.06, 0.018), 0.12], [0, y - safeHeight * 0.37, z + 0.1], createMaterial(COLORS.gpu, 0.32, 0.1), "gpu-accent-line");
  }
  addHostnameLabel(group, node?.name || "server", [0, y + safeHeight * 0.32, z + 0.2], safeHeight);
}

function addDriveBayLines(group, x, y, z, bayWidth, bayHeight, material) {
  const lineCount = 4;
  for (let i = 0; i < lineCount; i += 1) {
    const offset = -bayWidth * 0.26 + i * bayWidth * 0.17;
    addBox(group, [0.012, bayHeight * 0.72, 0.018], [x + offset, y - bayHeight * 0.04, z], material, "drive-slot-line");
  }
}

function addHoneycombGuard(group, { centerY, height, width, z, material }) {
  const cells = 5;
  const cellWidth = width / cells;
  const cellHeight = Math.max(height * 0.76, 0.07);
  const barThickness = Math.max(Math.min(height * 0.055, 0.026), 0.012);
  const diagonalLength = Math.min(cellWidth * 0.54, cellHeight * 0.78);
  const verticalLength = Math.max(cellHeight * 0.48, 0.05);
  const startX = -width / 2 + cellWidth / 2;

  for (let i = 0; i < cells; i += 1) {
    const x = startX + i * cellWidth;
    const sideOffset = cellWidth * 0.26;
    const yOffset = cellHeight * 0.21;
    addBox(group, [barThickness, verticalLength, 0.035], [x - sideOffset, centerY, z], material, "hex-vertical");
    addBox(group, [barThickness, verticalLength, 0.035], [x + sideOffset, centerY, z], material, "hex-vertical");
    addRotatedBar(group, [diagonalLength, barThickness, 0.035], [x - sideOffset / 2, centerY + yOffset, z], material, -Math.PI / 5, "hex-diagonal");
    addRotatedBar(group, [diagonalLength, barThickness, 0.035], [x + sideOffset / 2, centerY + yOffset, z], material, Math.PI / 5, "hex-diagonal");
    addRotatedBar(group, [diagonalLength, barThickness, 0.035], [x - sideOffset / 2, centerY - yOffset, z], material, Math.PI / 5, "hex-diagonal");
    addRotatedBar(group, [diagonalLength, barThickness, 0.035], [x + sideOffset / 2, centerY - yOffset, z], material, -Math.PI / 5, "hex-diagonal");
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
        <dt>Rack U</dt><dd>Rack ${(layout.rackIndex || 0) + 1} · ${layout.startU}U부터 ${layout.units}U 사용</dd>
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
  state.currentNodes = payload.nodes?.length ? payload.nodes.slice() : [fallbackNode(payload.system)];
  buildRack(state.currentNodes);
  updatePduPanel();
  const selectedStillExists = state.currentNodes.find((node) => node.name === state.selected?.userData?.node?.name);
  if (!selectedStillExists) {
    state.selected = null;
    resetLayoutControls();
  }
  resize();
}

function setZoom(value) {
  state.zoom = Math.max(5.6, Math.min(62, Number(value) || state.zoom));
  updateCameraPosition();
  updateContextVisibility();
}

window.DAquilaHardware3D = { update, resize, setZoom };
window.dispatchEvent(new CustomEvent("d-aquila-hardware-ready"));
