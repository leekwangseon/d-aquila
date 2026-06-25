const API_BASE = location.protocol.startsWith("http") ? location.origin : "http://127.0.0.1:8000";

let racks = [];
let jobs = [];
let latestNodes = [];
let latestTargets = [];
let latestSummary = null;
let latestSystem = null;
let latestDiscovery = null;
let latestLogs = null;
let latestIpmi = null;
let latestAudit = null;
let latestJobError = "";
let latestJobPolicy = null;
let latestPrometheusConfig = null;
let latestAccessModel = null;
let latestTemplates = [];
let latestApprovals = [];
let latestFacilityLayout = null;
let latestAlertChannels = null;
let loadHistory = [];
let powerHistory = [];
let graphHistory = [];
let refreshTimer = null;

const loginScreen = document.querySelector("#loginScreen");
const appShell = document.querySelector("#appShell");
const loginForm = document.querySelector("#loginForm");
const loginMessage = document.querySelector("#loginMessage");
const rackMap = document.querySelector("#rackMap");
const jobTable = document.querySelector("#jobTable");
const alertList = document.querySelector("#alerts");
const submitDialog = document.querySelector("#submitDialog");
const jobForm = document.querySelector("#jobForm");
const searchInput = document.querySelector("#searchInput");
const apiState = document.querySelector("#apiState");
const viewTitle = document.querySelector("#viewTitle");
const filesystemList = document.querySelector("#filesystemList");

const viewTitles = {
  overview: "운영 개요",
  resources: "리소스 사용량",
  graphs: "그래프 보드",
  hardware: "하드웨어 랙",
  jobs: "작업 모니터링",
  nodes: "클러스터 노드",
  power: "전력/온도",
  logs: "로그 관제",
  settings: "설정 / 연결 진단"
};

function showLogin(message = "") {
  loginScreen?.classList.remove("hidden");
  appShell?.classList.add("locked");
  if (loginMessage && message) loginMessage.textContent = message;
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

function showApp(username = "") {
  loginScreen?.classList.add("hidden");
  appShell?.classList.remove("locked");
  if (username) setApiState(`Live API · ${username}`, true);
}

function setApiState(text, ok = true) {
  apiState.textContent = text;
  apiState.classList.toggle("offline", !ok);
}

async function apiGet(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${API_BASE}${path}`, { cache: "no-store", credentials: "same-origin", signal: controller.signal });
    if (response.status === 401) {
      showLogin("세션이 만료되었습니다. 다시 로그인하세요.");
      throw new Error("Login required");
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.detail || `${path} returned ${response.status}`);
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function apiPost(path, payload) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) showLogin("로그인이 필요합니다.");
  if (!response.ok) throw new Error(data.detail || `${path} returned ${response.status}`);
  return data;
}

async function checkAuth() {
  try {
    const auth = await apiGet("/api/auth/me");
    if (auth.authenticated) {
      showApp(auth.username);
      await refreshData();
      refreshTimer = setInterval(refreshData, 15000);
    } else {
      showLogin(auth.auth_mode === "pam" ? "운영 노드 OS 계정으로 로그인하세요." : "로그인이 필요합니다.");
    }
  } catch (error) {
    showLogin("인증 상태를 확인할 수 없습니다.");
  }
}

async function loadOptional(path, fallback) {
  try {
    return await apiGet(path);
  } catch (error) {
    return { ...fallback, unavailable: true, error: error.message };
  }
}

function groupNodes(nodes) {
  const buckets = new Map();

  nodes.forEach((node) => {
    const gpuType = (node.gres.match(/gpu:([^:,\s]+)/) || [])[1];
    const firstPartition = String(node.partitions || "").split(",").filter(Boolean)[0];
    const type = node.gpu_total > 0 || node.gres.includes("gpu") ? "gpu" : "cpu";
    const name = gpuType ? `GPU ${gpuType.toUpperCase()}` : firstPartition || (type === "gpu" ? "GPU nodes" : "CPU nodes");
    const key = `${type}:${name}`;
    if (!buckets.has(key)) {
      buckets.set(key, { name, type, members: [] });
    }
    buckets.get(key).members.push(node);
  });

  return Array.from(buckets.values())
    .map((group) => {
      const members = group.members;
      const busy = members.filter((node) => ["allocated", "mixed", "completing"].includes(node.state.toLowerCase())).length;
      const down = members.filter((node) => node.state.toLowerCase().includes("down")).length;
      const warn = members.filter((node) => node.state.toLowerCase().includes("drain") || node.state.toLowerCase().includes("fail")).length;
      return {
        ...group,
        nodes: members.length,
        busy,
        warn,
        down,
        power: group.type === "gpu" ? "DCGM" : "node-exporter"
      };
    })
    .sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`));
}

function renderRacks(filter = "all") {
  rackMap.innerHTML = "";
  const visible = racks.filter((rack) => filter === "all" || rack.type === filter || (filter === "warn" && rack.warn + rack.down > 0));

  if (!visible.length) {
    rackMap.innerHTML = `
      <div class="empty-state">
        <strong>노드 데이터 없음</strong>
        <span>Slurm client, slurm.conf, Munge socket이 감지되면 실제 노드가 표시됩니다.</span>
      </div>
    `;
    return;
  }

  visible.forEach((rack) => {
    const card = document.createElement("article");
    card.className = "rack";
    card.innerHTML = `
      <div class="rack-title">
        <span>${rack.name}</span>
        <span>${rack.type.toUpperCase()} / ${rack.power}</span>
      </div>
      <div class="node-grid"></div>
    `;

    const grid = card.querySelector(".node-grid");
    const members = rack.members || [];
    for (let i = 0; i < rack.nodes; i += 1) {
      const nodeData = members[i];
      const node = document.createElement("button");
      const cpuPct = nodeData ? Math.round((nodeData.cpu_alloc / Math.max(nodeData.cpu_total, 1)) * 100) : 0;
      let state = i < rack.busy ? "busy" : "idle";
      if (nodeData?.state?.toLowerCase().includes("drain") || nodeData?.state?.toLowerCase().includes("fail")) state = "warn";
      if (nodeData?.state?.toLowerCase().includes("down")) state = "down";
      node.className = `node ${rack.type} ${state}`;
      node.type = "button";
      node.dataset.load = state === "idle" ? "" : `${cpuPct || ""}%`;
      node.title = nodeData
        ? `${nodeData.name} / ${nodeData.state} / CPU ${nodeData.cpu_alloc}/${nodeData.cpu_total} / GPU ${nodeData.gpu_alloc}/${nodeData.gpu_total}`
        : `${rack.name}-${i + 1}`;
      grid.appendChild(node);
    }

    rackMap.appendChild(card);
  });
}

function nodeHealthType(node) {
  const state = String(node.state || "").toLowerCase();
  if (state.includes("down")) return "down";
  if (state.includes("drain") || state.includes("fail")) return "warn";
  if (state.includes("alloc") || state.includes("mix") || state.includes("completing")) return "busy";
  return "idle";
}

function nodeNumber(node) {
  const match = String(node.name || "").match(/(\d+)$/);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function nodeFarmType(node) {
  const name = String(node.name || "").toLowerCase();
  const num = nodeNumber(node);
  if (name.startsWith("login")) return "login";
  if (num >= 21 || Number(node.gpu_total || 0) > 0 || String(node.gres || "").includes("gpu")) return "gpu";
  if (num >= 1 && num <= 20) return "cpu";
  return "other";
}

function nodeGroupMeta(type) {
  return {
    login: { title: "Login / Management", subtitle: "login node, controller, service host", className: "login" },
    cpu: { title: "CPU Farm", subtitle: "node01 - node20", className: "cpu" },
    gpu: { title: "GPU Farm", subtitle: "node21 - node28", className: "gpu" },
    other: { title: "Other Nodes", subtitle: "unclassified Slurm nodes", className: "other" }
  }[type] || { title: "Other Nodes", subtitle: "unclassified Slurm nodes", className: "other" };
}

function nodeUsagePercent(alloc, total) {
  const value = Number(total) ? (Number(alloc || 0) / Number(total)) * 100 : 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function renderNodeInsights() {
  const nodes = latestNodes;
  const total = nodes.length;
  const busy = nodes.filter((node) => nodeHealthType(node) === "busy").length;
  const warn = nodes.filter((node) => nodeHealthType(node) === "warn").length;
  const down = nodes.filter((node) => nodeHealthType(node) === "down").length;
  const idle = Math.max(total - busy - warn - down, 0);
  const active = total - warn - down;
  const cpuAlloc = nodes.reduce((sum, node) => sum + Number(node.cpu_alloc || 0), 0);
  const cpuTotal = nodes.reduce((sum, node) => sum + Number(node.cpu_total || 0), 0);
  const gpuAlloc = nodes.reduce((sum, node) => sum + Number(node.gpu_alloc || 0), 0);
  const gpuTotal = nodes.reduce((sum, node) => sum + Number(node.gpu_total || 0), 0);
  const cpuPct = cpuTotal ? (cpuAlloc / cpuTotal) * 100 : Number.NaN;
  const gpuPct = gpuTotal ? (gpuAlloc / gpuTotal) * 100 : Number.NaN;

  setText("#nodeTotalMetric", String(total));
  setText("#nodeActiveMetric", String(active));
  setText("#nodeWarnMetric", String(warn + down));
  setText("#nodeCpuMetric", Number.isFinite(cpuPct) ? `${Math.round(cpuPct)}%` : "N/A");
  setText("#nodeCpuDetail", cpuTotal ? `${cpuAlloc} / ${cpuTotal} cores` : "allocated / total");
  setText("#nodeGpuMetric", Number.isFinite(gpuPct) ? `${Math.round(gpuPct)}%` : "N/A");
  setText("#nodeGpuDetail", gpuTotal ? `${gpuAlloc} / ${gpuTotal} GPUs` : "allocated / total");

  const stateBars = document.querySelector("#nodeStateBars");
  if (stateBars) {
    const states = [
      ["idle", "IDLE", idle],
      ["busy", "ALLOC / MIX", busy],
      ["warn", "DRAIN / FAIL", warn],
      ["down", "DOWN", down]
    ].filter(([, , value]) => value > 0);
    if (!states.length) {
      renderEmptyInline("#nodeStateBars", "노드 데이터 없음", "Slurm 노드가 연결되면 상태 분포가 표시됩니다.");
    } else {
      stateBars.innerHTML = states.map(([type, label, value]) => {
        const pct = total ? Math.round((value / total) * 100) : 0;
        return `
          <div class="node-state-row ${type}">
            <span>${label}</span>
            <div class="bar"><i style="width: ${pct}%"></i></div>
            <strong>${value}</strong>
          </div>
        `;
      }).join("");
    }
  }

  const gpuPool = document.querySelector("#gpuPool");
  if (gpuPool) {
    const gpuNodes = nodes.filter((node) => Number(node.gpu_total || 0) > 0);
    if (!gpuNodes.length) {
      renderEmptyInline("#gpuPool", "GPU 노드 없음", "GPU GRES가 감지되면 할당량이 표시됩니다.");
    } else {
      const free = Math.max(gpuTotal - gpuAlloc, 0);
      gpuPool.innerHTML = `
        <div class="gpu-ring" style="--gpu-pct: ${Math.max(0, Math.min(100, gpuPct || 0))}">
          <strong>${Math.round(gpuPct || 0)}%</strong>
          <span>allocated</span>
        </div>
        <div class="gpu-pool-meta">
          <div><span>GPU Nodes</span><strong>${gpuNodes.length}</strong></div>
          <div><span>Allocated</span><strong>${gpuAlloc}</strong></div>
          <div><span>Free</span><strong>${free}</strong></div>
          <div><span>Total</span><strong>${gpuTotal}</strong></div>
        </div>
      `;
    }
  }

  const nodeCardList = document.querySelector("#nodeCardList");
  if (nodeCardList) {
    if (!nodes.length) {
      renderEmptyInline("#nodeCardList", "노드 상세 없음", "Slurm scontrol show node가 연결되면 노드 카드가 표시됩니다.");
    } else {
      nodeCardList.innerHTML = nodes.slice(0, 24).map((node) => {
        const type = nodeHealthType(node);
        const nodeCpuPct = Number(node.cpu_total) ? Math.round((Number(node.cpu_alloc || 0) / Number(node.cpu_total)) * 100) : 0;
        const nodeGpuPct = Number(node.gpu_total) ? Math.round((Number(node.gpu_alloc || 0) / Number(node.gpu_total)) * 100) : 0;
        return `
          <article class="node-card ${type}">
            <div>
              <strong>${escapeHtml(node.name || "-")}</strong>
              <span>${escapeHtml(node.partitions || "-")}</span>
            </div>
            <b>${escapeHtml(node.state || "unknown")}</b>
            <div class="node-card-bars">
              <span>CPU <em>${node.cpu_alloc || 0}/${node.cpu_total || 0}</em></span>
              <div class="mini-bar"><i style="width: ${nodeCpuPct}%"></i></div>
              <span>GPU <em>${node.gpu_alloc || 0}/${node.gpu_total || 0}</em></span>
              <div class="mini-bar gpu-mini"><i style="width: ${nodeGpuPct}%"></i></div>
            </div>
          </article>
        `;
      }).join("");
    }
  }
}

function renderNodeCardsGrouped() {
  const nodeCardList = document.querySelector("#nodeCardList");
  const nodes = latestNodes || [];
  if (!nodeCardList) return;
  if (!nodes.length) {
    renderEmptyInline("#nodeCardList", "노드 상세 없음", "Slurm scontrol show node가 연결되면 노드 카드가 표시됩니다.");
    return;
  }

  const grouped = nodes
    .slice()
    .sort((a, b) => nodeNumber(a) - nodeNumber(b) || String(a.name || "").localeCompare(String(b.name || "")))
    .reduce((acc, node) => {
      const type = nodeFarmType(node);
      if (!acc[type]) acc[type] = [];
      acc[type].push(node);
      return acc;
    }, {});

  nodeCardList.innerHTML = ["login", "cpu", "gpu", "other"]
    .filter((type) => grouped[type]?.length)
    .map((type) => {
      const group = grouped[type];
      const meta = nodeGroupMeta(type);
      const groupCpuAlloc = group.reduce((sum, node) => sum + Number(node.cpu_alloc || 0), 0);
      const groupCpuTotal = group.reduce((sum, node) => sum + Number(node.cpu_total || 0), 0);
      const groupGpuAlloc = group.reduce((sum, node) => sum + Number(node.gpu_alloc || 0), 0);
      const groupGpuTotal = group.reduce((sum, node) => sum + Number(node.gpu_total || 0), 0);
      const groupAttention = group.filter((node) => ["warn", "down"].includes(nodeHealthType(node))).length;

      return `
        <section class="node-farm ${meta.className}">
          <div class="node-farm-header">
            <div>
              <strong>${meta.title}</strong>
              <span>${meta.subtitle}</span>
            </div>
            <div class="node-farm-stats">
              <b>${group.length} nodes</b>
              <b>CPU ${groupCpuAlloc}/${groupCpuTotal}</b>
              ${groupGpuTotal ? `<b>GPU ${groupGpuAlloc}/${groupGpuTotal}</b>` : ""}
              ${groupAttention ? `<b class="warn">${groupAttention} attention</b>` : ""}
            </div>
          </div>
          <div class="node-farm-grid">
            ${group.map((node) => {
              const health = nodeHealthType(node);
              const farm = nodeFarmType(node);
              const nodeCpuPct = nodeUsagePercent(node.cpu_alloc, node.cpu_total);
              const nodeGpuPct = nodeUsagePercent(node.gpu_alloc, node.gpu_total);
              const partitionList = String(node.partitions || "").split(",").filter(Boolean);
              const partitions = partitionList.slice(0, 3);
              const extraPartitions = Math.max(0, partitionList.length - partitions.length);
              const gres = node.gres && node.gres !== "(null)" ? node.gres : "-";

              return `
                <article class="node-card ${health} ${farm}">
                  <div class="node-card-head">
                    <strong title="${escapeHtml(node.name || "-")}">${escapeHtml(node.name || "-")}</strong>
                    <b>${escapeHtml(node.state || "unknown")}</b>
                  </div>
                  <div class="node-type-line">
                    <span>${farm === "gpu" ? "GPU node" : farm === "cpu" ? "CPU node" : "Service node"}</span>
                    <em>${escapeHtml(gres)}</em>
                  </div>
                  <div class="node-card-bars">
                    <span>CPU <em>${node.cpu_alloc || 0}/${node.cpu_total || 0} · ${nodeCpuPct}%</em></span>
                    <div class="mini-bar"><i style="width: ${nodeCpuPct}%"></i></div>
                    <span>GPU <em>${node.gpu_alloc || 0}/${node.gpu_total || 0}${Number(node.gpu_total || 0) ? ` · ${nodeGpuPct}%` : ""}</em></span>
                    <div class="mini-bar gpu-mini"><i style="width: ${nodeGpuPct}%"></i></div>
                  </div>
                  <div class="node-partitions">
                    ${partitions.map((partition) => `<span>${escapeHtml(partition)}</span>`).join("")}
                    ${extraPartitions ? `<span>+${extraPartitions}</span>` : ""}
                  </div>
                </article>
              `;
            }).join("")}
          </div>
        </section>
      `;
    }).join("");
}

function renderNodeCardsGrouped() {
  const nodeCardList = document.querySelector("#nodeCardList");
  const nodes = latestNodes || [];
  if (!nodeCardList) return;
  if (!nodes.length) {
    renderEmptyInline("#nodeCardList", "노드 상세 없음", "Slurm scontrol show node가 연결되면 노드 카드가 표시됩니다.");
    return;
  }
  const grouped = nodes
    .slice()
    .sort((a, b) => nodeNumber(a) - nodeNumber(b) || String(a.name || "").localeCompare(String(b.name || "")))
    .reduce((acc, node) => {
      const type = nodeFarmType(node);
      if (!acc[type]) acc[type] = [];
      acc[type].push(node);
      return acc;
    }, {});
  nodeCardList.innerHTML = ["login", "cpu", "gpu", "other"]
    .filter((type) => grouped[type]?.length)
    .map((type) => {
      const group = grouped[type];
      const meta = nodeGroupMeta(type);
      const groupCpuAlloc = group.reduce((sum, node) => sum + Number(node.cpu_alloc || 0), 0);
      const groupCpuTotal = group.reduce((sum, node) => sum + Number(node.cpu_total || 0), 0);
      const groupGpuAlloc = group.reduce((sum, node) => sum + Number(node.gpu_alloc || 0), 0);
      const groupGpuTotal = group.reduce((sum, node) => sum + Number(node.gpu_total || 0), 0);
      const groupAttention = group.filter((node) => ["warn", "down"].includes(nodeHealthType(node))).length;
      return `
        <section class="node-farm ${meta.className}">
          <div class="node-farm-header">
            <div><strong>${meta.title}</strong><span>${meta.subtitle}</span></div>
            <div class="node-farm-stats">
              <b>${group.length} nodes</b>
              <b>CPU ${groupCpuAlloc}/${groupCpuTotal}</b>
              ${groupGpuTotal ? `<b>GPU ${groupGpuAlloc}/${groupGpuTotal}</b>` : ""}
              ${groupAttention ? `<b class="warn">${groupAttention} attention</b>` : ""}
            </div>
          </div>
          <div class="node-farm-grid">
            ${group.map((node) => {
              const farm = nodeFarmType(node);
              const health = nodeHealthType(node);
              const nodeCpuPct = Number.isFinite(Number(node.cpu_usage_percent)) ? Math.round(Number(node.cpu_usage_percent)) : nodeUsagePercent(node.cpu_alloc, node.cpu_total);
              const nodeMemPct = Number.isFinite(Number(node.memory_usage_percent)) ? Math.round(Number(node.memory_usage_percent)) : null;
              const nodeGpuPct = nodeUsagePercent(node.gpu_alloc, node.gpu_total);
              const partitionList = String(node.partitions || "").split(",").filter(Boolean);
              const partitions = partitionList.slice(0, 3);
              const extraPartitions = Math.max(0, partitionList.length - partitions.length);
              const gres = node.gres && node.gres !== "(null)" ? node.gres : "-";
              const cpuLabel = farm === "login" && Number.isFinite(Number(node.cpu_usage_percent))
                ? `avg ${nodeCpuPct}%`
                : `${node.cpu_alloc || 0}/${node.cpu_total || 0} · ${nodeCpuPct}%`;
              return `
                <article class="node-card ${health} ${farm}">
                  <div class="node-card-head"><strong title="${escapeHtml(node.name || "-")}">${escapeHtml(node.name || "-")}</strong><b>${escapeHtml(node.state || "unknown")}</b></div>
                  <div class="node-type-line"><span>${farm === "gpu" ? "GPU node" : farm === "cpu" ? "CPU node" : "Login node"}</span><em>${escapeHtml(gres)}</em></div>
                  <div class="node-card-bars">
                    <span>CPU <em>${cpuLabel}</em></span>
                    <div class="mini-bar"><i style="width: ${nodeCpuPct}%"></i></div>
                    ${nodeMemPct !== null ? `<span>Memory <em>avg ${nodeMemPct}%</em></span><div class="mini-bar memory-mini"><i style="width: ${nodeMemPct}%"></i></div>` : ""}
                    <span>GPU <em>${node.gpu_alloc || 0}/${node.gpu_total || 0}${Number(node.gpu_total || 0) ? ` · ${nodeGpuPct}%` : ""}</em></span>
                    <div class="mini-bar gpu-mini"><i style="width: ${nodeGpuPct}%"></i></div>
                  </div>
                  <div class="node-partitions">
                    ${partitions.map((partition) => `<span>${escapeHtml(partition)}</span>`).join("")}
                    ${extraPartitions ? `<span>+${extraPartitions}</span>` : ""}
                  </div>
                </article>`;
            }).join("")}
          </div>
        </section>`;
    }).join("");
}

function statusLabel(status) {
  const normalized = String(status || "").toLowerCase();
  const cls = normalized.includes("run") || normalized === "r" ? "running" : normalized.includes("pend") || normalized === "pd" ? "pending" : normalized.includes("fail") ? "failed" : "completed";
  return `<span class="status-pill ${cls}">${String(status || "UNKNOWN").toUpperCase()}</span>`;
}

function jobStatusType(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized.includes("run") || normalized === "r") return "running";
  if (normalized.includes("pend") || normalized === "pd") return "pending";
  if (normalized.includes("fail") || normalized === "f" || normalized.includes("cancel")) return "failed";
  if (normalized.includes("complet") || normalized === "cd") return "completed";
  return "other";
}

function extractCpu(job) {
  const direct = Number(job.min_cpus);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const values = [job.resource, job.tres].map((value) => String(value || ""));
  for (const value of values) {
    const match = value.match(/cpu=(\d+)/i) || value.match(/(\d+)\s*CPU/i);
    if (match) return Number(match[1]);
  }
  return 0;
}

function extractGpu(job) {
  const values = [job.tres, job.resource].map((value) => String(value || ""));
  for (const value of values) {
    const match = value.match(/(?:gres\/gpu=|gpu[:=]?|GPU\s*\/\s*)(\d+)/i) || value.match(/(\d+)\s*GPU/i);
    if (match) return Number(match[1]);
  }
  return 0;
}

function countBy(items, keyFn) {
  return items.reduce((map, item) => {
    const key = keyFn(item) || "-";
    map.set(key, (map.get(key) || 0) + 1);
    return map;
  }, new Map());
}

function renderEmptyInline(selector, title, detail) {
  const element = document.querySelector(selector);
  if (!element) return;
  element.innerHTML = `
    <div class="empty-inline">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(detail)}</span>
    </div>
  `;
}

function renderJobInsights() {
  const total = jobs.length;
  const running = jobs.filter((job) => jobStatusType(job.status) === "running").length;
  const pending = jobs.filter((job) => jobStatusType(job.status) === "pending").length;
  const failed = jobs.filter((job) => jobStatusType(job.status) === "failed").length;
  const completed = jobs.filter((job) => jobStatusType(job.status) === "completed").length;
  const cpuTotal = jobs.reduce((sum, job) => sum + extractCpu(job), 0);
  const gpuTotal = jobs.reduce((sum, job) => sum + extractGpu(job), 0);

  setText("#jobTotalMetric", String(total));
  setText("#jobRunningMetric", String(running));
  setText("#jobPendingMetric", String(pending));
  setText("#jobCpuMetric", cpuTotal ? String(cpuTotal) : "-");
  setText("#jobGpuMetric", gpuTotal ? String(gpuTotal) : "-");

  const stateBars = document.querySelector("#jobStateBars");
  if (stateBars) {
    const stateItems = [
      ["running", "RUNNING", running],
      ["pending", "PENDING", pending],
      ["failed", "FAILED", failed],
      ["completed", "COMPLETED", completed]
    ].filter(([, , value]) => value > 0);
    if (!stateItems.length) {
      renderEmptyInline("#jobStateBars", "작업 데이터 없음", "Slurm squeue가 연결되면 큐 분포가 표시됩니다.");
    } else {
      stateBars.innerHTML = stateItems.map(([type, label, value]) => {
        const pct = total ? Math.round((value / total) * 100) : 0;
        return `
          <div class="queue-row ${type}">
            <span>${label}</span>
            <div class="bar"><i style="width: ${pct}%"></i></div>
            <strong>${value}</strong>
          </div>
        `;
      }).join("");
    }
  }

  const userCounts = Array.from(countBy(jobs, (job) => job.user).entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const userList = document.querySelector("#jobUserList");
  if (userList) {
    if (!userCounts.length) {
      renderEmptyInline("#jobUserList", "사용자 데이터 없음", "작업이 감지되면 사용자별 점유가 표시됩니다.");
    } else {
      const max = Math.max(...userCounts.map(([, count]) => count), 1);
      userList.innerHTML = userCounts.map(([user, count]) => `
        <div class="rank-row">
          <div><strong>${escapeHtml(user)}</strong><span>${count} jobs</span></div>
          <div class="mini-bar"><i style="width: ${Math.round((count / max) * 100)}%"></i></div>
        </div>
      `).join("");
    }
  }

  const partitionCounts = Array.from(countBy(jobs, (job) => job.partition).entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const partitionList = document.querySelector("#jobPartitionList");
  if (partitionList) {
    if (!partitionCounts.length) {
      renderEmptyInline("#jobPartitionList", "파티션 데이터 없음", "작업이 감지되면 파티션별 큐가 표시됩니다.");
    } else {
      partitionList.innerHTML = partitionCounts.map(([partition, count]) => {
        const partJobs = jobs.filter((job) => job.partition === partition);
        const partRunning = partJobs.filter((job) => jobStatusType(job.status) === "running").length;
        const partPending = partJobs.filter((job) => jobStatusType(job.status) === "pending").length;
        return `
          <div class="partition-row">
            <strong>${escapeHtml(partition)}</strong>
            <span>${count} jobs</span>
            <small>${partRunning} running · ${partPending} pending</small>
          </div>
        `;
      }).join("");
    }
  }
}

function renderJobs(query = "") {
  const normalized = query.trim().toLowerCase();
  const filtered = jobs.filter((job) => JSON.stringify(job).toLowerCase().includes(normalized)).slice(0, 80);
  jobTable.innerHTML = "";
  renderJobInsights();

  if (!filtered.length) {
    jobTable.innerHTML = `
      <tr>
        <td class="table-empty" colspan="6">작업 데이터 없음. Slurm squeue가 연결되면 실제 작업이 표시됩니다.</td>
      </tr>
    `;
    return;
  }

  filtered.forEach((job) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${job.id}</td>
      <td>${job.user}</td>
      <td>${job.partition}</td>
      <td>${statusLabel(job.status)}</td>
      <td>${job.resource || job.tres || "-"}</td>
      <td>${job.time || job.time_left || "-"}</td>
    `;
    row.title = `${job.name || ""} ${job.reason || ""}`.trim();
    jobTable.appendChild(row);
  });
}

function renderJobFilters() {
  const userFilter = document.querySelector("#jobUserFilter");
  const stateFilter = document.querySelector("#jobStateFilter");
  if (userFilter) {
    const current = userFilter.value || "all";
    const users = Array.from(new Set(jobs.map((job) => job.user).filter(Boolean))).sort();
    userFilter.innerHTML = `<option value="all">모든 사용자</option>${users.map((user) => `<option value="${escapeHtml(user)}">${escapeHtml(user)}</option>`).join("")}`;
    userFilter.value = users.includes(current) ? current : "all";
  }
  if (stateFilter && !stateFilter.value) stateFilter.value = "all";
}

function renderJobs(query = "") {
  const normalized = query.trim().toLowerCase();
  renderJobFilters();
  const userFilter = document.querySelector("#jobUserFilter")?.value || "all";
  const stateFilter = document.querySelector("#jobStateFilter")?.value || "all";
  const filtered = jobs.filter((job) => {
    const queryOk = !normalized || JSON.stringify(job).toLowerCase().includes(normalized);
    const userOk = userFilter === "all" || job.user === userFilter;
    const stateOk = stateFilter === "all" || jobStatusType(job.status) === stateFilter;
    return queryOk && userOk && stateOk;
  }).slice(0, 80);
  jobTable.innerHTML = "";
  renderJobInsights();

  if (!filtered.length) {
    jobTable.innerHTML = `
      <tr>
        <td class="table-empty" colspan="7">작업 데이터 없음. Slurm squeue가 연결되면 실제 작업이 표시됩니다.</td>
      </tr>
    `;
    return;
  }

  filtered.forEach((job) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${escapeHtml(job.id)}</td>
      <td>${escapeHtml(job.user)}</td>
      <td>${escapeHtml(job.partition)}</td>
      <td>${statusLabel(job.status)}</td>
      <td>${escapeHtml(job.resource || job.tres || "-")}</td>
      <td>${escapeHtml(job.time || job.time_left || "-")}</td>
      <td><button class="danger-action job-cancel" type="button" data-job-id="${escapeHtml(job.id)}">취소</button></td>
    `;
    row.title = `${job.name || ""} ${job.reason || ""}`.trim();
    jobTable.appendChild(row);
  });
}

function renderJobs(query = "") {
  const normalized = query.trim().toLowerCase();
  renderJobFilters();
  const userFilter = document.querySelector("#jobUserFilter")?.value || "all";
  const stateFilter = document.querySelector("#jobStateFilter")?.value || "all";
  const filtered = jobs.filter((job) => {
    const queryOk = !normalized || JSON.stringify(job).toLowerCase().includes(normalized);
    const userOk = userFilter === "all" || job.user === userFilter;
    const stateOk = stateFilter === "all" || jobStatusType(job.status) === stateFilter;
    return queryOk && userOk && stateOk;
  }).slice(0, 80);

  jobTable.innerHTML = "";
  renderJobInsights();

  if (!filtered.length) {
    const emptyTitle = latestJobError ? "Slurm squeue 확인 필요" : "작업 데이터 없음";
    const emptyDetail = latestJobError
      ? `squeue 실행 오류: ${escapeHtml(latestJobError)}`
      : "현재 표시할 작업이 없습니다. 실행/대기 작업이 생기면 여기에 표시됩니다.";
    jobTable.innerHTML = `
      <tr>
        <td class="table-empty" colspan="7"><strong>${emptyTitle}</strong><br>${emptyDetail}</td>
      </tr>
    `;
    return;
  }

  filtered.forEach((job) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${escapeHtml(job.id)}</td>
      <td>${escapeHtml(job.user)}</td>
      <td>${escapeHtml(job.partition)}</td>
      <td>${statusLabel(job.status)}</td>
      <td>${escapeHtml(job.resource || job.tres || "-")}</td>
      <td>${escapeHtml(job.time || job.time_left || "-")}</td>
      <td><button class="danger-action job-cancel" type="button" data-job-id="${escapeHtml(job.id)}">취소</button></td>
    `;
    row.title = `${job.name || ""} ${job.reason || ""}`.trim();
    jobTable.appendChild(row);
  });
}

function renderAlerts() {
  const downTargets = latestTargets.filter((target) => target.health !== "up");
  const downNodes = latestNodes.filter((node) => node.state.toLowerCase().includes("down"));
  const alerts = [
    ...downNodes.slice(0, 4).map((node) => ({ level: "bad", title: `${node.name} ${node.state}`, detail: node.reason || "Slurm node state" })),
    ...downTargets.slice(0, 4).map((target) => {
      const instance = target.instance || target.scrapeUrl || "unknown target";
      const shortError = String(target.lastError || "scrape failed")
        .replace(/^.*dial tcp /, "dial tcp ")
        .replace(/^.*lookup /, "lookup ");
      return {
        level: "warn",
        title: `${target.job || "prometheus"} target down`,
        detail: `${instance} - ${shortError}`,
        raw: `${target.instance || ""} ${target.lastError || ""}`.trim()
      };
    })
  ];

  if (!alerts.length) {
    alerts.push({ level: "info", title: "주요 알림 없음", detail: "연결된 데이터 소스에서 경고가 감지되지 않았습니다." });
  }

  alertList.innerHTML = alerts
    .map(
      (alert) => `
        <div class="alert ${alert.level}">
          <span class="alert-dot"></span>
          <div title="${escapeHtml(alert.raw || alert.detail)}">
            <strong>${escapeHtml(alert.title)}</strong>
            <small>${escapeHtml(alert.detail)}</small>
          </div>
        </div>
      `
    )
    .join("");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setWidth(selector, value) {
  const element = document.querySelector(selector);
  if (!element) return;
  const percent = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  element.style.width = `${percent}%`;
}

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}

function prepareCanvas(canvas) {
  const ratio = Math.max(window.devicePixelRatio || 1, 1);
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(Math.round(rect.width || canvas.clientWidth || canvas.width), 1);
  const height = Math.max(Math.round(rect.height || canvas.clientHeight || canvas.height), 1);
  const targetWidth = Math.round(width * ratio);
  const targetHeight = Math.round(height * ratio);
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width, height };
}

function drawSparkline(canvas, values, color) {
  const { ctx, width, height } = prepareCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  ctx.lineWidth = 3;
  ctx.strokeStyle = color;
  ctx.beginPath();
  values.forEach((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = height - (value / 100) * (height - 6) - 3;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function drawLineChart(canvas, values = [], color, label, maxValue = 100) {
  if (!canvas) return;
  const { ctx, width, height } = prepareCanvas(canvas);
  const series = values.length ? values : [0];
  const scaleMax = Math.max(maxValue, ...series, 1);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#d7dde6";
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i += 1) {
    const y = (height / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.beginPath();
  series.forEach((value, index) => {
    const x = 16 + (index / Math.max(series.length - 1, 1)) * (width - 32);
    const y = height - 18 - (value / scaleMax) * (height - 36);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.stroke();
}

function drawThermalChart(values = []) {
  const canvas = document.querySelector("#thermalChart");
  drawLineChart(canvas, values, "#d95f43", "max temperature °C", 100);
}

function drawPowerChart(values = []) {
  const canvas = document.querySelector("#powerChart");
  const maxValue = Math.max(500, ...values, 0);
  drawLineChart(canvas, values, "#6957c8", "GPU power W", maxValue);
}

function drawMultiLineChart(canvas, seriesMap) {
  if (!canvas) return;
  const { ctx, width, height } = prepareCanvas(canvas);
  const padding = { top: 16, right: 18, bottom: 22, left: 26 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const keys = Object.keys(seriesMap);
  const maxLength = Math.max(...keys.map((key) => seriesMap[key].values.length), 1);

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#d7dde6";
  ctx.lineWidth = 1;

  for (let i = 0; i <= 4; i += 1) {
    const y = padding.top + (plotHeight / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
  }

  keys.forEach((key) => {
    const item = seriesMap[key];
    const values = item.values.length ? item.values : [0];
    ctx.beginPath();
    values.forEach((value, index) => {
      const x = padding.left + (index / Math.max(maxLength - 1, 1)) * plotWidth;
      const y = padding.top + plotHeight - (Math.max(0, Math.min(100, value)) / 100) * plotHeight;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = item.color;
    ctx.lineWidth = 3;
    ctx.stroke();
  });
}

function drawLoadChart(system) {
  const canvas = document.querySelector("#loadChart");
  if (!canvas) return;
  const { ctx, width, height } = prepareCanvas(canvas);
  const cores = Math.max(Number(system?.cpu?.logical_count || 1), 1);
  const load1 = Number(system?.cpu?.load1 || 0);
  const pressure = Math.min((load1 / cores) * 100, 100);
  if (Number.isFinite(load1)) {
    loadHistory.push({ load: load1, ratio: pressure });
    loadHistory = loadHistory.slice(-30);
  }
  const series = loadHistory.length ? loadHistory : [{ load: 0, ratio: 0 }];

  setText("#loadChartCurrent", Number.isFinite(load1) ? load1.toFixed(2) : "-");
  setText("#loadChartCores", String(cores));
  setText("#loadChartPressure", Number.isFinite(pressure) ? `${Math.round(pressure)}%` : "-");

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#d7dde6";
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i += 1) {
    const y = (height / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  ctx.beginPath();
  series.forEach((point, index) => {
    const x = 16 + (index / Math.max(series.length - 1, 1)) * (width - 32);
    const y = height - 18 - (point.ratio / 100) * (height - 42);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "#0b6f7a";
  ctx.lineWidth = 3;
  ctx.stroke();

  const latest = series[series.length - 1];
  const dotX = series.length === 1 ? 16 : width - 16;
  const dotY = height - 18 - (latest.ratio / 100) * (height - 42);
  ctx.fillStyle = "#0b6f7a";
  ctx.beginPath();
  ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
  ctx.fill();
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${Math.round(value)}%` : "N/A";
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled >= 10 ? Math.round(scaled) : scaled.toFixed(1)} ${units[unit]}`;
}

function formatRate(bytesPerSecond) {
  return `${formatBytes(bytesPerSecond)}/s`;
}

function formatClock(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

function formatDateShort(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatOs(osInfo) {
  if (!osInfo) return "-";
  const distro = osInfo.pretty_name || [osInfo.name, osInfo.version_id || osInfo.version].filter(Boolean).join(" ");
  const codename = osInfo.version_codename ? ` (${osInfo.version_codename})` : "";
  const kernel = osInfo.kernel_release ? `kernel ${osInfo.kernel_release}` : "";
  if (distro && kernel) return `${distro}${codename} · ${kernel}`;
  return distro || [osInfo.system, osInfo.kernel_release].filter(Boolean).join(" ") || "-";
}

function renderFilesystems(filesystems = []) {
  if (!filesystemList) return;
  if (!filesystems.length) {
    filesystemList.innerHTML = `
      <div class="empty-inline">
        <strong>파일 시스템 데이터 없음</strong>
        <span>서버에서 마운트 정보를 읽을 수 있으면 여기에 표시됩니다.</span>
      </div>
    `;
    return;
  }
  filesystemList.innerHTML = filesystems
    .map((fs) => {
      const percent = Number(fs.usage_percent || 0);
      return `
        <div class="fs-row" title="${escapeHtml(`${fs.device} ${fs.fstype}`)}">
          <div class="fs-meta">
            <strong>${escapeHtml(fs.label ? `${fs.label} (${fs.mountpoint || "-"})` : (fs.mountpoint || "-"))}</strong>
            <span>${formatBytes(fs.used_bytes)} / ${formatBytes(fs.total_bytes)}</span>
          </div>
          <div class="mini-bar"><i style="width: ${Math.max(0, Math.min(100, percent))}%"></i></div>
          <b>${Math.round(percent)}%</b>
        </div>
      `;
    })
    .join("");
}

function usageLevel(value) {
  if (!Number.isFinite(value)) return { label: "데이터 없음", className: "unknown" };
  if (value >= 90) return { label: "위험", className: "bad" };
  if (value >= 75) return { label: "주의", className: "warn" };
  if (value >= 55) return { label: "보통", className: "busy" };
  return { label: "여유", className: "ok" };
}

function renderOverviewInsights(summary, system) {
  const cpu = Number(summary?.cluster_cpu_usage_percent ?? summary?.cpu_usage_percent ?? system?.cpu?.usage_percent);
  const memory = Number(system?.memory?.usage_percent);
  const disk = Number(system?.disk?.usage_percent);
  const gpu = Number(summary?.gpu_usage_percent);
  const pending = Number(summary?.jobs_pending ?? 0);
  const downTargets = latestTargets.filter((target) => target.health !== "up").length;
  const downNodes = latestNodes.filter((node) => node.state.toLowerCase().includes("down")).length;
  const slurmTargetCount = Number(latestDiscovery?.prometheus?.targets_by_job?.["slurm-exporter"] || 0);
  const slurmMetrics = ["cpu_total", "cpu_alloc", "jobs_running", "jobs_pending", "nodes_down"]
    .some((key) => Number(summary?.[key] || 0) > 0);
  const slurmCommands = latestDiscovery?.commands || {};
  const slurmClientDetected = ["sinfo", "squeue", "scontrol"].some((name) => !!slurmCommands[name]);
  const slurmConfigDetected = (latestDiscovery?.slurm_config_paths || []).length > 0;
  const slurmConnected = latestNodes.length > 0 || jobs.length > 0 || slurmTargetCount > 0 || slurmMetrics || (slurmClientDetected && slurmConfigDetected);
  const prometheusConnected = latestTargets.length > 0 || !!summary;
  const connected = !!system || !!summary;
  const risks = downTargets + downNodes + (disk >= 90 ? 1 : 0) + (memory >= 90 ? 1 : 0);
  const health = risks > 0 ? "warn" : connected ? "ok" : "unknown";
  const healthText = health === "ok" ? "정상" : health === "warn" ? "주의" : "확인 중";

  const healthBadge = document.querySelector("#healthBadge");
  if (healthBadge) {
    healthBadge.textContent = healthText;
    healthBadge.className = `health-badge ${health}`;
  }
  setText("#healthTitle", health === "ok" ? "운영 상태가 안정적입니다" : health === "warn" ? "확인할 신호가 있습니다" : "데이터를 기다리는 중입니다");
  setText(
    "#healthDetail",
    health === "warn"
      ? `장애 노드 ${downNodes}개, target down ${downTargets}개를 확인했습니다.`
      : connected
        ? "API가 응답하고 핵심 지표가 갱신되고 있습니다."
        : "백엔드 API 또는 데이터 소스 연결을 확인해야 합니다."
  );
  setText("#apiSignal", connected ? "연결" : "대기");
  setText("#slurmSignal", slurmConnected ? "연결" : "미연결");
  setText("#promSignal", prometheusConnected ? "연결" : "미연결");

  const candidates = [
    { name: "CPU", value: cpu },
    { name: "Memory", value: memory },
    { name: "Disk", value: disk },
    { name: "GPU", value: gpu > 0 ? gpu : Number.NaN }
  ].filter((item) => Number.isFinite(item.value));
  const hottest = candidates.sort((a, b) => b.value - a.value)[0];
  const pressure = usageLevel(hottest?.value);
  const pressureFill = document.querySelector("#pressureFill");
  if (pressureFill) {
    pressureFill.style.width = `${Math.max(0, Math.min(100, hottest?.value || 0))}%`;
    pressureFill.className = `pressure-fill ${pressure.className}`;
  }
  setText("#pressureValue", hottest ? `${Math.round(hottest.value)}%` : "N/A");
  setText("#pressureLabel", hottest ? `${hottest.name} 기준 ${pressure.label}` : "표시할 사용률 없음");
  setText("#pressureSource", candidates.length ? candidates.map((item) => `${item.name} ${Math.round(item.value)}%`).join(" · ") : "CPU / Memory / Disk / GPU");

  const clusterMode = slurmConnected ? "클러스터 모드" : "단독 서버 모드";
  setText("#modePill", clusterMode);
  setText("#profileHost", system?.hostname || "-");
  setText("#profileIp", system?.ip_address || "-");
  setText("#profileOs", formatOs(system?.os));
  setText("#profileGpu", Number(summary?.gpu_total || 0) > 0 ? `${Math.round(summary.gpu_total)} detected` : "감지 안 됨");

  const events = [];
  if (!slurmConnected) events.push({ level: "info", title: "Slurm 미연결", detail: "단독 서버 모드로 시스템 자원을 표시합니다." });
  if (!prometheusConnected) events.push({ level: "info", title: "Prometheus target 없음", detail: "시스템 API 중심으로 개요를 구성합니다." });
  if (downTargets) events.push({ level: "warn", title: "Prometheus target down", detail: `${downTargets}개 target 확인 필요` });
  if (downNodes) events.push({ level: "bad", title: "Slurm down node", detail: `${downNodes}개 노드 확인 필요` });
  if (pending > 0) events.push({ level: "busy", title: "대기 작업 존재", detail: `${Math.round(pending)}개 작업이 대기 중입니다.` });
  if (disk >= 75) events.push({ level: disk >= 90 ? "bad" : "warn", title: "디스크 사용률 상승", detail: `${Math.round(disk)}% 사용 중` });
  if (memory >= 75) events.push({ level: memory >= 90 ? "bad" : "warn", title: "메모리 사용률 상승", detail: `${Math.round(memory)}% 사용 중` });
  if (!events.length) events.push({ level: "ok", title: "주요 이벤트 없음", detail: "현재 개요 지표가 안정적입니다." });

  const eventList = document.querySelector("#eventList");
  if (eventList) {
    eventList.innerHTML = events.slice(0, 5).map((event) => `
      <div class="event ${event.level}">
        <span></span>
        <div>
          <strong>${escapeHtml(event.title)}</strong>
          <small>${escapeHtml(event.detail)}</small>
        </div>
      </div>
    `).join("");
  }
}

function targetStats(jobName) {
  const matches = latestTargets.filter((target) => String(target.job || "").toLowerCase().includes(jobName));
  const up = matches.filter((target) => target.health === "up").length;
  return { total: matches.length, up, down: Math.max(matches.length - up, 0) };
}

function thermalLevel(value) {
  if (!Number.isFinite(value) || value <= 0) return { label: "N/A", className: "unknown", detail: "온도 센서 없음" };
  if (value >= 85) return { label: "위험", className: "bad", detail: "즉시 확인 필요" };
  if (value >= 75) return { label: "주의", className: "warn", detail: "냉각 상태 확인 권장" };
  return { label: "정상", className: "ok", detail: "온도 범위 안정" };
}

function renderPowerInsights(summary, system) {
  const gpuTemp = Number(summary?.max_gpu_temp_celsius || 0);
  const gpuPower = Number(summary?.gpu_power_watts || 0);
  const gpuUtil = Number(summary?.gpu_usage_percent || 0);
  const serverTemp = Number(system?.temperature?.max_celsius || 0);
  const maxTemp = Math.max(gpuTemp, serverTemp);
  const thermal = thermalLevel(maxTemp);
  const dcgm = targetStats("dcgm");
  const ipmi = targetStats("ipmi");
  const sensorCount = system?.temperature?.readings?.length || 0;
  const headroom = maxTemp > 0 ? Math.max(0, 85 - maxTemp) : Number.NaN;
  const telemetrySignals = [dcgm.total > 0, ipmi.total > 0, sensorCount > 0];
  const confidence = Math.round((telemetrySignals.filter(Boolean).length / telemetrySignals.length) * 100);
  const powerPerUtil = gpuPower > 0 && gpuUtil > 0 ? gpuPower / gpuUtil : Number.NaN;
  const efficiencySignal = !Number.isFinite(powerPerUtil)
    ? "데이터 없음"
    : powerPerUtil > 50
      ? "비효율 의심"
      : powerPerUtil > 25
        ? "관찰 필요"
        : "양호";

  powerHistory.push({ temp: maxTemp || 0, power: gpuPower || 0 });
  powerHistory = powerHistory.slice(-40);

  setText("#thermalStatusMetric", thermal.label);
  setText("#thermalStatusDetail", thermal.detail);
  setText("#powerGpuTempMetric", gpuTemp > 0 ? `${Math.round(gpuTemp)}°C` : "N/A");
  setText("#powerGpuWattMetric", gpuPower > 0 ? `${Math.round(gpuPower)} W` : "N/A");
  setText("#powerServerTempMetric", serverTemp > 0 ? `${Math.round(serverTemp)}°C` : "N/A");
  setText("#thermalHeadroomMetric", Number.isFinite(headroom) ? `${Math.round(headroom)}°C` : "N/A");
  setText("#telemetryConfidenceMetric", `${confidence}%`);
  setText("#telemetryConfidenceDetail", `${telemetrySignals.filter(Boolean).length}/3 sources`);
  setText("#ipmiMetric", ipmi.total ? `${ipmi.up}/${ipmi.total}` : "N/A");
  setText("#ipmiDetail", ipmi.total ? `${ipmi.down} down` : "target 없음");
  setText("#dcgmTargets", dcgm.total ? `${dcgm.up}/${dcgm.total}` : "N/A");
  setText("#dcgmSignal", dcgm.total ? `${dcgm.up}/${dcgm.total} up` : "미감지");
  setText("#ipmiSignal", ipmi.total ? `${ipmi.up}/${ipmi.total} up` : "미감지");
  setText("#sensorSignal", sensorCount ? `${sensorCount} sensors` : "미감지");
  setText("#gpuEfficiencyUtil", gpuUtil > 0 ? `${Math.round(gpuUtil)}%` : "N/A");
  setText("#gpuPowerPerUtil", Number.isFinite(powerPerUtil) ? `${powerPerUtil.toFixed(1)} W/%` : "N/A");
  setText("#gpuEfficiencySignal", efficiencySignal);
  setText("#powerCurrentStrip", gpuPower > 0 ? `${Math.round(gpuPower)} W` : "N/A");
  setText("#powerPeakStrip", Math.max(...powerHistory.map((sample) => sample.power)) > 0 ? `${Math.round(Math.max(...powerHistory.map((sample) => sample.power)))} W` : "N/A");
  setText("#powerSamplesStrip", String(powerHistory.length));

  const badge = document.querySelector("#thermalBadge");
  if (badge) {
    badge.textContent = thermal.label;
    badge.className = `health-badge ${thermal.className}`;
  }
  const gauge = document.querySelector("#thermalGauge");
  if (gauge) {
    gauge.style.setProperty("--thermal-pct", String(Math.max(0, Math.min(100, maxTemp || 0))));
    gauge.className = `thermal-gauge ${thermal.className}`;
  }
  setText("#thermalGaugeValue", maxTemp > 0 ? `${Math.round(maxTemp)}°C` : "N/A");

  const sensorList = document.querySelector("#sensorList");
  if (sensorList) {
    const readings = system?.temperature?.readings || [];
    if (!readings.length) {
      renderEmptyInline("#sensorList", "센서 데이터 없음", "OS 또는 컨테이너가 온도 센서를 노출하면 표시됩니다.");
    } else {
      sensorList.innerHTML = readings.slice(0, 8).map((sensor) => `
        <div class="sensor-row">
          <div>
            <strong>${escapeHtml(sensor.label || sensor.chip || "-")}</strong>
            <span>${escapeHtml(sensor.chip || "-")}</span>
          </div>
          <b>${Math.round(sensor.current_celsius)}°C</b>
        </div>
      `).join("");
    }
  }

  const events = [];
  if (!dcgm.total) events.push({ level: "info", title: "DCGM target 없음", detail: "GPU 온도/전력은 DCGM exporter 연결 후 표시됩니다." });
  if (dcgm.down) events.push({ level: "warn", title: "DCGM target down", detail: `${dcgm.down}개 target 확인 필요` });
  if (!ipmi.total) events.push({ level: "info", title: "IPMI target 없음", detail: "서버 전력/흡기 온도 계측은 IPMI exporter가 필요합니다." });
  if (ipmi.down) events.push({ level: "warn", title: "IPMI target down", detail: `${ipmi.down}개 target 확인 필요` });
  if (!sensorCount) events.push({ level: "info", title: "로컬 온도 센서 없음", detail: "컨테이너 권한 또는 하드웨어 센서 노출을 확인하세요." });
  if (thermal.className === "warn" || thermal.className === "bad") events.push({ level: thermal.className, title: `열 상태 ${thermal.label}`, detail: `${Math.round(maxTemp)}°C 감지` });
  if (Number.isFinite(headroom) && headroom <= 10) events.push({ level: "warn", title: "냉각 여유 부족", detail: `위험 기준까지 ${Math.round(headroom)}°C 남았습니다.` });
  if (confidence < 67) events.push({ level: "warn", title: "계측 신뢰도 낮음", detail: `사용 가능한 데이터 소스 ${telemetrySignals.filter(Boolean).length}/3` });
  if (efficiencySignal === "비효율 의심") events.push({ level: "warn", title: "전력 효율 확인", detail: `${powerPerUtil.toFixed(1)} W/% 수준입니다.` });
  if (!events.length) events.push({ level: "ok", title: "전력/온도 이벤트 없음", detail: "수집된 전력/온도 신호가 안정적입니다." });

  const eventList = document.querySelector("#powerEventList");
  if (eventList) {
    eventList.innerHTML = events.slice(0, 5).map((event) => `
      <div class="event ${event.level}">
        <span></span>
        <div>
          <strong>${escapeHtml(event.title)}</strong>
          <small>${escapeHtml(event.detail)}</small>
        </div>
      </div>
    `).join("");
  }

  drawThermalChart(powerHistory.map((sample) => sample.temp));
  drawPowerChart(powerHistory.map((sample) => sample.power));
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function renderGraphRadials(values) {
  const container = document.querySelector("#graphRadials");
  if (!container) return;
  const items = [
    ["CPU", values.cpu, "cpu"],
    ["Memory", values.memory, "memory"],
    ["Disk", values.disk, "disk"],
    ["GPU", values.gpu, "gpu"]
  ];
  container.innerHTML = items.map(([label, value, type]) => {
    const pct = clampPercent(value);
    const display = pct > 0 || type !== "gpu" ? `${Math.round(pct)}%` : "N/A";
    return `
      <div class="graph-ring ${type}" style="--ring-pct: ${pct}">
        <strong>${display}</strong>
        <span>${label}</span>
      </div>
    `;
  }).join("");
}

function renderNodeDotMatrix() {
  const container = document.querySelector("#nodeDotMatrix");
  if (!container) return;
  if (!latestNodes.length) {
    renderEmptyInline("#nodeDotMatrix", "노드 데이터 없음", "Slurm 노드가 연결되면 도트 그래프가 표시됩니다.");
    return;
  }
  container.innerHTML = latestNodes.slice(0, 120).map((node) => {
    const type = nodeHealthType(node);
    const cpuPct = Number(node.cpu_total) ? Math.round((Number(node.cpu_alloc || 0) / Number(node.cpu_total)) * 100) : 0;
    return `<span class="dot ${type}" title="${escapeHtml(node.name || "-")} · ${escapeHtml(node.state || "-")} · CPU ${cpuPct}%"></span>`;
  }).join("");
}

function renderNodeDotMatrix() {
  const container = document.querySelector("#nodeDotMatrix");
  if (!container) return;
  if (!latestNodes.length) {
    renderEmptyInline("#nodeDotMatrix", "노드 데이터 없음", "Slurm 노드가 연결되면 상태 도트가 표시됩니다.");
    return;
  }
  const groups = ["login", "cpu", "gpu", "other"]
    .map((type) => ({ type, meta: nodeGroupMeta(type), nodes: latestNodes.filter((node) => nodeFarmType(node) === type) }))
    .filter((group) => group.nodes.length);
  container.innerHTML = `
    <div class="dot-explainer">
      <strong>노드 1개 = 점 1개</strong>
      <span>색상은 상태, 숫자는 CPU 사용률입니다. GPU 노드는 GPU 사용률도 함께 확인합니다.</span>
    </div>
    ${groups.map((group) => `
      <div class="dot-group ${group.type}">
        <div class="dot-group-title">
          <strong>${group.meta.title}</strong>
          <span>${group.nodes.length} nodes</span>
        </div>
        <div class="dot-grid">
          ${group.nodes
            .slice()
            .sort((a, b) => nodeNumber(a) - nodeNumber(b) || String(a.name || "").localeCompare(String(b.name || "")))
            .map((node) => {
              const type = nodeHealthType(node);
              const cpuPct = Number.isFinite(Number(node.cpu_usage_percent))
                ? Math.round(Number(node.cpu_usage_percent))
                : nodeUsagePercent(node.cpu_alloc, node.cpu_total);
              const gpuPct = nodeUsagePercent(node.gpu_alloc, node.gpu_total);
              const label = String(node.name || "-").replace(/^node/, "n").replace(/^login/, "L");
              return `<span class="node-dot ${type}" style="--load:${Math.max(18, Math.min(100, cpuPct))}%" title="${escapeHtml(node.name || "-")} · ${escapeHtml(node.state || "-")} · CPU ${cpuPct}%${Number(node.gpu_total || 0) ? ` · GPU ${gpuPct}%` : ""}">${escapeHtml(label)}</span>`;
            }).join("")}
        </div>
      </div>
    `).join("")}
  `;
}

function renderResourceHeatmap(values) {
  const container = document.querySelector("#resourceHeatmap");
  if (!container) return;
  const rows = [
    ["CPU", values.cpu, "cpu"],
    ["Memory", values.memory, "memory"],
    ["Disk", values.disk, "disk"],
    ["GPU", values.gpu, "gpu"]
  ];
  container.innerHTML = rows.map(([label, value, type]) => {
    const pct = clampPercent(value);
    const filled = Math.round(pct / 5);
    const cells = Array.from({ length: 20 }, (_, index) => `<span class="${index < filled ? "on" : ""}"></span>`).join("");
    const display = pct > 0 || type !== "gpu" ? `${Math.round(pct)}%` : "N/A";
    return `
      <div class="heat-row ${type}">
        <strong>${label}</strong>
        <div>${cells}</div>
        <b>${display}</b>
      </div>
    `;
  }).join("");
}

function renderJobDistributionGraph() {
  const container = document.querySelector("#jobDistributionGraph");
  if (!container) return;
  const total = Math.max(jobs.length, 1);
  const items = [
    ["실행", jobs.filter((job) => jobStatusType(job.status) === "running").length, "running"],
    ["대기", jobs.filter((job) => jobStatusType(job.status) === "pending").length, "pending"],
    ["실패", jobs.filter((job) => jobStatusType(job.status) === "failed").length, "failed"],
    ["완료", jobs.filter((job) => jobStatusType(job.status) === "completed").length, "completed"]
  ];
  if (!jobs.length) {
    renderEmptyInline("#jobDistributionGraph", "작업 데이터 없음", "Slurm squeue가 연결되면 작업 큐 분포가 표시됩니다.");
    return;
  }
  container.innerHTML = items.map(([label, value, type]) => {
    const pct = Math.round((value / total) * 100);
    return `
      <div class="dist-row ${type}">
        <span>${label}</span>
        <div><i style="width: ${pct}%"></i></div>
        <strong>${value}</strong>
      </div>
    `;
  }).join("");
}

function renderPowerPulseGraph(summary, system) {
  const container = document.querySelector("#powerPulseGraph");
  if (!container) return;
  const gpuTemp = Number(summary?.max_gpu_temp_celsius || 0);
  const gpuPower = Number(summary?.gpu_power_watts || 0);
  const serverTemp = Number(system?.temperature?.max_celsius || 0);
  const maxTemp = Math.max(gpuTemp, serverTemp);
  const items = [
    ["GPU Temp", gpuTemp > 0 ? `${Math.round(gpuTemp)}°C` : "N/A", clampPercent(gpuTemp), "temp"],
    ["Server Temp", serverTemp > 0 ? `${Math.round(serverTemp)}°C` : "N/A", clampPercent(serverTemp), "server"],
    ["GPU Power", gpuPower > 0 ? `${Math.round(gpuPower)} W` : "N/A", clampPercent((gpuPower / 500) * 100), "power"],
    ["Thermal Headroom", maxTemp > 0 ? `${Math.max(0, 85 - Math.round(maxTemp))}°C` : "N/A", clampPercent(maxTemp ? 100 - ((maxTemp / 85) * 100) : 0), "headroom"]
  ];
  container.innerHTML = items.map(([label, value, pct, type]) => `
    <div class="pulse-card ${type}">
      <span>${label}</span>
      <strong>${value}</strong>
      <div class="pulse-meter"><i style="width: ${pct}%"></i></div>
    </div>
  `).join("");
}

function renderGraphBoard(summary, system) {
  const cpu = Number(summary?.cluster_cpu_usage_percent ?? summary?.cpu_usage_percent ?? system?.cpu?.usage_percent);
  const memory = Number(system?.memory?.usage_percent);
  const disk = Number(system?.disk?.usage_percent);
  const gpu = Number(summary?.gpu_usage_percent || 0);
  const netRate = Number(system?.network?.rx_bytes_per_sec ?? 0) + Number(system?.network?.tx_bytes_per_sec ?? 0);
  const netPct = clampPercent((netRate / (125 * 1024 * 1024)) * 100);

  graphHistory.push({
    cpu: clampPercent(cpu),
    memory: clampPercent(memory),
    disk: clampPercent(disk),
    network: netPct
  });
  graphHistory = graphHistory.slice(-36);

  drawMultiLineChart(document.querySelector("#resourceFlowChart"), {
    cpu: { color: "#0b6f7a", values: graphHistory.map((sample) => sample.cpu) },
    memory: { color: "#1f9d68", values: graphHistory.map((sample) => sample.memory) },
    disk: { color: "#e5a423", values: graphHistory.map((sample) => sample.disk) },
    network: { color: "#2478c8", values: graphHistory.map((sample) => sample.network) }
  });
  renderGraphRadials({ cpu, memory, disk, gpu });
  renderNodeDotMatrix();
  renderResourceHeatmap({ cpu, memory, disk, gpu });
  renderJobDistributionGraph();
  renderPowerPulseGraph(summary, system);
}

function renderHardwareView() {
  const gpuNodes = latestNodes.filter((node) => Number(node.gpu_total || 0) > 0).length;
  const warnNodes = latestNodes.filter((node) => ["warn", "down"].includes(nodeHealthType(node))).length;
  const deviceCount = latestNodes.length || 1;
  setText("#hardwareDeviceCount", String(deviceCount));
  setText("#hardwareGpuCount", String(gpuNodes));
  setText("#hardwareWarnCount", String(warnNodes));
  setText("#hardwareRackSummary", latestNodes.length ? `${latestNodes.length} nodes mapped into virtual rack` : "단독 서버 1대 기준 가상 랙");
  if (window.DAquilaHardware3D?.update) {
    window.DAquilaHardware3D.update({
      nodes: latestNodes,
      system: latestSystem,
      summary: latestSummary
    });
  }
}

function estimateHardwareRackCount(nodes) {
  if (!nodes.length) return 1;
  let racks = 1;
  let used = 0;
  nodes.forEach((node) => {
    const units = Number(node.gpu_total || 0) > 0 ? 4 : 2;
    if (used + units > 42) {
      racks += 1;
      used = 0;
    }
    used += units;
  });
  return racks;
}

function renderHardwareView() {
  const gpuNodes = latestNodes.filter((node) => Number(node.gpu_total || 0) > 0).length;
  const warnNodes = latestNodes.filter((node) => ["warn", "down"].includes(nodeHealthType(node))).length;
  const deviceCount = latestNodes.length || 1;
  const rackEstimate = estimateHardwareRackCount(latestNodes);
  setText("#hardwareDeviceCount", String(deviceCount));
  setText("#hardwareGpuCount", String(gpuNodes));
  setText("#hardwareWarnCount", String(warnNodes));
  setText("#hardwareRackSummary", latestNodes.length ? `${latestNodes.length} nodes mapped across ${rackEstimate} rack${rackEstimate > 1 ? "s" : ""}` : "단독 서버 1대 기준 가상 랙");
  if (window.DAquilaHardware3D?.update) {
    window.DAquilaHardware3D.update({
      nodes: latestNodes,
      system: latestSystem,
      summary: latestSummary
    });
  }
}

function logLevelLabel(level) {
  if (level === "error") return "오류";
  if (level === "warn") return "경고";
  return "정보";
}

function logCategoryLabel(category) {
  const labels = {
    system: "시스템",
    security: "보안",
    hardware: "하드웨어",
    service: "서비스"
  };
  return labels[category] || category || "기타";
}

function formatLogTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function renderLogItem(log, compact = false) {
  const level = log.level || "info";
  const category = log.category || "system";
  const source = [log.source, log.unit].filter(Boolean).join(" / ") || "-";
  return `
    <div class="log-item ${level} ${category}">
      <span class="log-dot"></span>
      <div class="log-body">
        <div class="log-meta">
          <strong>${escapeHtml(logCategoryLabel(category))}</strong>
          <span>${escapeHtml(logLevelLabel(level))}</span>
          <time>${escapeHtml(formatLogTime(log.time))}</time>
        </div>
        <p>${escapeHtml(log.message || "-")}</p>
        ${compact ? "" : `<small>${escapeHtml(source)}</small>`}
      </div>
    </div>
  `;
}

function renderLogFocus(selector, logs, emptyText) {
  const target = document.querySelector(selector);
  if (!target) return;
  const visible = logs.slice(0, 5);
  target.innerHTML = visible.length
    ? visible.map((log) => renderLogItem(log, true)).join("")
    : `<div class="empty-inline"><strong>표시할 로그 없음</strong><span>${escapeHtml(emptyText)}</span></div>`;
}

function renderLogSources(sources = []) {
  const target = document.querySelector("#logSourceList");
  if (!target) return;
  target.innerHTML = sources.length
    ? sources.map((source) => `
        <div class="log-source ${source.status}">
          <span></span>
          <div>
            <strong>${escapeHtml(source.name || "-")}</strong>
            <small>${escapeHtml(source.type || "-")} · ${escapeHtml(source.detail || source.status || "-")}</small>
          </div>
        </div>
      `).join("")
    : `<div class="empty-inline"><strong>로그 소스 없음</strong><span>journalctl 또는 /var/log 접근 권한을 확인하세요.</span></div>`;
}

function renderLogs() {
  const data = latestLogs || {};
  const summary = data.summary || {};
  const logs = data.logs || [];
  const categoryFilter = document.querySelector("#logCategoryFilter")?.value || "all";
  const levelFilter = document.querySelector("#logLevelFilter")?.value || "all";
  const visible = logs.filter((log) => {
    const categoryOk = categoryFilter === "all" || log.category === categoryFilter;
    const levelOk = levelFilter === "all" || log.level === levelFilter;
    return categoryOk && levelOk;
  });

  setText("#logTotalMetric", String(summary.total ?? logs.length ?? 0));
  setText("#logErrorMetric", String(summary.error ?? 0));
  setText("#logWarnMetric", String(summary.warn ?? 0));
  setText("#logSecurityMetric", String(summary.security ?? logs.filter((log) => log.category === "security").length));
  setText("#logHardwareMetric", String(summary.hardware ?? logs.filter((log) => log.category === "hardware").length));
  setText("#logSourceMetric", `${summary.sources_ok ?? 0}/${(summary.sources_ok ?? 0) + (summary.sources_limited ?? 0)}`);
  setText("#logSourceDetail", `${summary.sources_limited ?? 0} limited · ${formatDateShort(data.generated_at)}`);
  setText("#logHostMetric", data.host || "master server");

  const timeline = document.querySelector("#logTimeline");
  if (timeline) {
    timeline.innerHTML = visible.length
      ? visible.slice(0, 160).map((log) => renderLogItem(log)).join("")
      : `<div class="empty-state"><strong>조건에 맞는 로그 없음</strong><span>필터를 바꾸거나 새로고침을 눌러 다시 확인하세요.</span></div>`;
  }

  renderLogFocus("#securityLogList", logs.filter((log) => log.category === "security"), "SSH, sudo, PAM 이벤트가 감지되면 표시됩니다.");
  renderLogFocus("#hardwareLogList", logs.filter((log) => log.category === "hardware"), "커널, 디스크, GPU, 센서 이벤트가 감지되면 표시됩니다.");
  renderLogSources(data.sources || []);
}

function okText(ok) {
  return ok ? "OK" : "확인 필요";
}

function checkRow(level, title, detail) {
  return `
    <div class="check-row ${level}">
      <span></span>
      <div>
        <strong>${escapeHtml(title)}</strong>
        <small>${escapeHtml(detail)}</small>
      </div>
    </div>
  `;
}

function renderSettings(discovery) {
  const commands = discovery?.commands || {};
  const commandValues = Object.values(commands);
  const slurmClientOk = ["sinfo", "squeue", "scontrol"].every((name) => !!commands[name]);
  const slurmConfigOk = (discovery?.slurm_config_paths || []).length > 0;
  const mungeOk = (discovery?.munge_sockets || []).length > 0;
  const promReady = !!discovery?.prometheus?.ready;
  const auth = discovery?.auth || {};
  const pamOk = auth.mode !== "pam" || !!auth.pam_available || !!auth.shadow_fallback_available;
  const submitEnabled = !!discovery?.submit_enabled;
  const targetCounts = discovery?.prometheus?.targets_by_job || {};

  setText("#settingsSlurmMetric", slurmClientOk && slurmConfigOk ? "OK" : "주의");
  setText("#settingsSlurmDetail", `${commandValues.filter(Boolean).length}/5 commands · ${(discovery?.slurm_config_paths || []).length} config`);
  setText("#settingsMungeMetric", okText(mungeOk));
  setText("#settingsMungeDetail", mungeOk ? `${discovery.munge_sockets.length} socket` : "socket 없음");
  setText("#settingsPromMetric", promReady ? "OK" : "미연결");
  setText("#settingsPromDetail", discovery?.prometheus?.url || "Prometheus URL 없음");
  setText("#settingsAuthMetric", auth.mode === "disabled" ? "Disabled" : okText(pamOk));
  setText("#settingsAuthDetail", `${auth.mode || "-"} · shadow ${auth.shadow_fallback_available ? "ready" : "off"} · ${auth.session_seconds || "-"}s`);
  setText("#settingsSubmitMetric", submitEnabled ? "Enabled" : "Disabled");

  const checks = [
    [slurmClientOk ? "ok" : "warn", "Slurm client", slurmClientOk ? "sinfo, squeue, scontrol 명령을 사용할 수 있습니다." : "필수 Slurm 명령 일부가 감지되지 않았습니다."],
    [slurmConfigOk ? "ok" : "warn", "Slurm config", slurmConfigOk ? discovery.slurm_config_paths.join(", ") : "/etc/slurm 또는 /etc/slurm-llnl 마운트를 확인하세요."],
    [mungeOk ? "ok" : "warn", "Munge socket", mungeOk ? discovery.munge_sockets.join(", ") : "/run/munge 또는 /var/run/munge 마운트를 확인하세요."],
    [promReady ? "ok" : "warn", "Prometheus", promReady ? `${discovery.prometheus.url} 응답 확인` : `${discovery?.prometheus?.url || "Prometheus"} 연결 실패`],
    [pamOk ? "ok" : "warn", "OS account login", auth.mode === "disabled" ? "개발 모드: 인증이 비활성화되어 있습니다." : auth.pam_available ? "PAM 인증 모듈을 사용할 수 있습니다." : auth.shadow_fallback_available ? "PAM 실패 시 로컬 shadow 계정 검증을 사용할 수 있습니다." : "pamela/PAM 런타임 또는 호스트 계정 마운트를 확인하세요."],
    [submitEnabled ? "warn" : "ok", "Job submission", submitEnabled ? "작업 제출이 켜져 있습니다. 정책 제한을 확인하세요." : "작업 제출은 비활성화되어 있습니다."]
  ];
  const checkList = document.querySelector("#connectionChecks");
  if (checkList) checkList.innerHTML = checks.map(([level, title, detail]) => checkRow(level, title, detail)).join("");

  const commandList = document.querySelector("#settingsCommands");
  if (commandList) {
    commandList.innerHTML = Object.entries(commands).map(([name, path]) => `
      <div class="config-row">
        <span>${escapeHtml(name)}</span>
        <strong>${escapeHtml(path || "missing")}</strong>
      </div>
    `).join("");
  }

  const targetList = document.querySelector("#settingsTargets");
  if (targetList) {
    const entries = Object.entries(targetCounts).sort((a, b) => b[1] - a[1]);
    targetList.innerHTML = entries.length
      ? entries.map(([job, count]) => `
          <div class="target-row">
            <strong>${escapeHtml(job)}</strong>
            <span>${count} targets</span>
          </div>
        `).join("")
      : `<div class="empty-inline"><strong>Target 없음</strong><span>Prometheus target이 감지되면 여기에 표시됩니다.</span></div>`;
  }

  const runtime = document.querySelector("#settingsRuntime");
  if (runtime) {
    const rows = [
      ["Auth mode", auth.mode || "-"],
      ["PAM available", String(!!auth.pam_available)],
      ["Session", auth.session_seconds ? `${auth.session_seconds}s` : "-"],
      ["Disk path", discovery?.runtime?.disk_path || "-"],
      ["Command timeout", discovery?.runtime?.command_timeout ? `${discovery.runtime.command_timeout}s` : "-"],
      ["Prometheus URL", discovery?.prometheus?.url || "-"]
    ];
    runtime.innerHTML = rows.map(([key, value]) => `
      <div class="config-row">
        <span>${escapeHtml(key)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
    `).join("");
  }

  const actions = [];
  if (!slurmClientOk) actions.push({ level: "warn", title: "Slurm client 확인", detail: "컨테이너에 slurm-client가 설치됐는지, 명령 PATH가 맞는지 확인하세요." });
  if (!slurmConfigOk) actions.push({ level: "warn", title: "Slurm 설정 마운트", detail: "/etc/slurm 또는 /etc/slurm-llnl을 읽기 전용으로 마운트하세요." });
  if (!mungeOk) actions.push({ level: "warn", title: "Munge socket 마운트", detail: "Slurm 명령 인증을 위해 /run/munge/munge.socket.2가 필요할 수 있습니다." });
  if (!promReady) actions.push({ level: "warn", title: "Prometheus URL 확인", detail: "D_AQUILA_PROMETHEUS_URL 또는 localhost:9090 접근성을 확인하세요." });
  if (!pamOk) actions.push({ level: "warn", title: "PAM 인증 확인", detail: "pamela 패키지, PAM 모듈, /etc/shadow 마운트 정책을 점검하세요." });
  if (submitEnabled) actions.push({ level: "busy", title: "작업 제출 정책 확인", detail: "허용 파티션, 최대 CPU/GPU/메모리/시간 제한을 정하세요." });
  if (!actions.length) actions.push({ level: "ok", title: "주요 조치 없음", detail: "핵심 연결 진단이 안정적으로 보입니다." });
  const actionList = document.querySelector("#settingsActions");
  if (actionList) {
    actionList.innerHTML = actions.map((event) => `
      <div class="event ${event.level}">
        <span></span>
        <div>
          <strong>${escapeHtml(event.title)}</strong>
          <small>${escapeHtml(event.detail)}</small>
        </div>
      </div>
    `).join("");
  }
}

function renderJobPolicy(policy = {}) {
  latestJobPolicy = policy;
  const enabled = !!policy.enabled;
  const allowed = Array.isArray(policy.allowed_partitions) ? policy.allowed_partitions : [];
  const setValue = (selector, value) => {
    const element = document.querySelector(selector);
    if (element) element.value = value ?? "";
  };
  const setChecked = (selector, value) => {
    const element = document.querySelector(selector);
    if (element) element.checked = !!value;
  };
  setChecked("#policyEnabled", enabled);
  setValue("#policyPartitions", allowed.join(","));
  setValue("#policyMaxCpu", policy.max_cpu ?? 64);
  setValue("#policyMaxGpu", policy.max_gpu ?? 8);
  setValue("#policyMaxMemory", policy.max_memory_gb ?? 256);
  setValue("#policyMaxTime", policy.max_time_hours ?? 24);
  setChecked("#policyCustomScript", policy.allow_custom_script !== false);
  setText("#policyStatusBadge", enabled ? "제출 허용" : "제출 차단");
}

function renderPrometheusWizard(config = {}) {
  latestPrometheusConfig = config;
  const setValue = (selector, value) => {
    const element = document.querySelector(selector);
    if (element && document.activeElement !== element) element.value = value ?? "";
  };
  setValue("#prometheusUrlInput", config.url || latestDiscovery?.prometheus?.url || "http://localhost:9090");
  setValue("#prometheusNodeTargets", (config.node_targets || []).join("\n"));
  setValue("#prometheusDcgmTargets", (config.dcgm_targets || []).join("\n"));
  setValue("#prometheusIpmiTargets", (config.ipmi_targets || []).join("\n"));
  setText("#promWizardStatus", latestDiscovery?.prometheus?.ready ? "연결됨" : "확인 필요");
}

function sensorRow(item, unit = "") {
  const value = Number(item?.value);
  const display = Number.isFinite(value) ? `${Math.round(value * 10) / 10}${unit}` : "N/A";
  return `
    <div class="sensor-row">
      <div>
        <strong>${escapeHtml(item?.name || "-")}</strong>
        <span>${escapeHtml(item?.instance || item?.type || "-")}</span>
      </div>
      <b>${escapeHtml(display)}</b>
    </div>
  `;
}

function renderIpmiDetails(data = {}) {
  const summary = data.summary || {};
  setText("#ipmiDetailBadge", summary.targets ? `${summary.up || 0}/${summary.targets} up` : "IPMI 없음");
  const summaryTarget = document.querySelector("#ipmiSummary");
  if (summaryTarget) {
    summaryTarget.innerHTML = `
      <div><span>Targets</span><strong>${summary.targets ?? 0}</strong></div>
      <div><span>흡기 최고</span><strong>${summary.inlet_max == null ? "N/A" : `${Math.round(summary.inlet_max)}°C`}</strong></div>
      <div><span>전력 합계</span><strong>${summary.power_sum ? `${Math.round(summary.power_sum)} W` : "N/A"}</strong></div>
    `;
  }
  const inlet = data.inlet_temperatures || [];
  const power = data.power_readings || [];
  const inletTarget = document.querySelector("#ipmiInletList");
  const powerTarget = document.querySelector("#ipmiPowerList");
  if (inletTarget) {
    inletTarget.innerHTML = inlet.length
      ? inlet.slice(0, 12).map((item) => sensorRow(item, "°C")).join("")
      : `<div class="empty-inline"><strong>흡기 온도 없음</strong><span>IPMI exporter의 inlet/intake/ambient 센서가 감지되면 표시됩니다.</span></div>`;
  }
  if (powerTarget) {
    powerTarget.innerHTML = power.length
      ? power.slice(0, 12).map((item) => sensorRow(item, " W")).join("")
      : `<div class="empty-inline"><strong>전력 센서 없음</strong><span>IPMI power/watt 센서가 감지되면 표시됩니다.</span></div>`;
  }
}

function renderAuditLogs(data = {}) {
  const target = document.querySelector("#auditLogList");
  if (!target) return;
  const rows = data.audit || [];
  target.innerHTML = rows.length
    ? rows.slice(0, 12).map((item) => `
        <div class="audit-row ${item.status === "ok" ? "ok" : "warn"}">
          <span></span>
          <div>
            <strong>${escapeHtml(item.action || "-")}</strong>
            <small>${escapeHtml(item.user || "system")} · ${escapeHtml(formatDateShort(item.time))}</small>
          </div>
        </div>
      `).join("")
    : `<div class="empty-inline"><strong>감사 로그 없음</strong><span>로그인, 제출, 취소, 정책 변경 시 기록됩니다.</span></div>`;
}

function csvValue(selector) {
  return String(document.querySelector(selector)?.value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function setCsv(selector, items = []) {
  const element = document.querySelector(selector);
  if (element && document.activeElement !== element) element.value = (items || []).join(",");
}

function renderAccessModel(data = {}) {
  const model = data.access_model || {};
  latestAccessModel = model;
  setText("#currentRoleBadge", data.current_role ? `현재 ${data.current_role}` : "Role");
  setCsv("#accessAdminUsers", model.admin_users);
  setCsv("#accessOperatorUsers", model.operator_users);
  setCsv("#accessViewerUsers", model.viewer_users);
  setCsv("#accessAdminGroups", model.admin_groups);
  setCsv("#accessOperatorGroups", model.operator_groups);
  setCsv("#accessViewerGroups", model.viewer_groups);
}

function renderTemplates(data = {}) {
  latestTemplates = data.templates || [];
  const target = document.querySelector("#templateList");
  if (!target) return;
  target.innerHTML = latestTemplates.length
    ? latestTemplates.map((item) => `
        <div class="ops-row">
          <div>
            <strong>${escapeHtml(item.name)}</strong>
            <small>${escapeHtml(item.partition)} · CPU ${escapeHtml(item.cpu)} · GPU ${escapeHtml(item.gpu)} · ${escapeHtml(item.time)}</small>
          </div>
          <button class="ghost-action request-template" type="button" data-template-id="${escapeHtml(item.id)}">승인 요청</button>
        </div>
      `).join("")
    : `<div class="empty-inline"><strong>템플릿 없음</strong><span>반복 작업 템플릿을 저장하면 표시됩니다.</span></div>`;
}

function renderApprovals(data = {}) {
  latestApprovals = data.approvals || [];
  const target = document.querySelector("#approvalList");
  if (!target) return;
  const pending = latestApprovals.slice(0, 10);
  target.innerHTML = pending.length
    ? pending.map((item) => `
        <div class="ops-row ${item.status}">
          <div>
            <strong>${escapeHtml(item.template_name || item.template_id)}</strong>
            <small>${escapeHtml(item.requester || "-")} · ${escapeHtml(item.status)} · ${escapeHtml(formatDateShort(item.created_at))}</small>
          </div>
          ${item.status === "pending" ? `
            <button class="ghost-action approval-decision" type="button" data-approval-id="${escapeHtml(item.id)}" data-action="reject">반려</button>
            <button class="primary-action approval-decision" type="button" data-approval-id="${escapeHtml(item.id)}" data-action="approve">승인</button>
          ` : ""}
        </div>
      `).join("")
    : `<div class="empty-inline"><strong>승인 요청 없음</strong><span>템플릿 승인 요청이 들어오면 표시됩니다.</span></div>`;
}

function renderFacilityLayout(data = {}) {
  const layout = data.facility_layout || {};
  latestFacilityLayout = layout;
  const roomsInput = document.querySelector("#facilityRooms");
  const racksInput = document.querySelector("#facilityRacks");
  if (roomsInput && document.activeElement !== roomsInput) roomsInput.value = JSON.stringify(layout.rooms || [], null, 2);
  if (racksInput && document.activeElement !== racksInput) racksInput.value = JSON.stringify(layout.racks || [], null, 2);
  const target = document.querySelector("#facilitySummary");
  if (target) {
    target.innerHTML = `
      <div class="ops-row">
        <div><strong>${(layout.rooms || []).length} rooms</strong><small>${(layout.racks || []).length} racks configured</small></div>
      </div>
    `;
  }
}

function renderAlertChannels(data = {}) {
  const channels = data.alert_channels || {};
  latestAlertChannels = channels;
  const webhook = document.querySelector("#alertWebhookUrl");
  if (webhook && document.activeElement !== webhook) webhook.value = channels.webhook_url || "";
  setCsv("#alertEmails", channels.email_recipients || []);
  setCsv("#alertEvents", channels.enabled_events || []);
}

function ensureLocationMetric(system) {
  const grid = document.querySelector('.status-grid[aria-label="Operations summary"]');
  if (!grid) return;
  if (!document.querySelector("#locationMetric")) {
    const card = document.createElement("article");
    card.className = "metric location-metric";
    card.innerHTML = `
      <span class="metric-label">현재 위치</span>
      <strong id="locationMetric">-</strong>
      <small id="locationDetailMetric">master node</small>
    `;
    grid.appendChild(card);
  }
  setText("#locationMetric", system?.hostname || "-");
  setText("#locationDetailMetric", [system?.ip_address, "D-aquila API"].filter(Boolean).join(" · ") || "master node");
}

function updateMetrics(summary, system) {
  const systemCpu = Number(system?.cpu?.usage_percent);
  const clusterCpu = Number(summary?.cluster_cpu_usage_percent ?? summary?.cpu_usage_percent);
  const cpu = Number.isFinite(clusterCpu) ? clusterCpu : systemCpu;
  const gpu = Number(summary?.gpu_usage_percent ?? 0);
  const temp = Number(summary?.max_gpu_temp_celsius ?? 0);
  const power = Number(summary?.gpu_power_watts ?? 0);
  const pending = Number(summary?.jobs_pending ?? 0);
  const serverTemp = Number(system?.temperature?.max_celsius ?? 0);
  const netRate = Number(system?.network?.rx_bytes_per_sec ?? 0) + Number(system?.network?.tx_bytes_per_sec ?? 0);
  const logicalCores = Number(system?.cpu?.logical_count || 0);
  const physicalCores = Number(system?.cpu?.physical_count || 0);
  const clusterCores = Number(summary?.cluster_core_total || summary?.cpu_total || 0);
  const clusterGpus = Number(summary?.gpu_total || 0);
  const load1 = Number(system?.cpu?.load1 || 0);
  const load5 = Number(system?.cpu?.load5 || 0);
  const load15 = Number(system?.cpu?.load15 || 0);
  const loadPressure = logicalCores ? (load1 / logicalCores) * 100 : Number.NaN;

  setText("#cpuMetric", formatPercent(cpu));
  setText("#gpuMetric", gpu > 0 ? formatPercent(gpu) : "N/A");
  setText("#queueMetric", String(Math.round(pending)));
  setText("#tempMetric", temp > 0 ? `${Math.round(temp)}°C` : "N/A");
  setText("#powerMetric", power > 0 ? `${Math.round(power)} W` : "N/A");
  setText("#thermalTemp", temp > 0 ? `${Math.round(temp)}°C` : "N/A");
  setText("#thermalPower", power > 0 ? `${Math.round(power)} W` : "N/A");
  setText("#memMetric", Number.isFinite(system?.memory?.usage_percent) ? `${Math.round(system.memory.usage_percent)}%` : "N/A");
  setText("#memDetail", system?.memory ? `${formatBytes(system.memory.used_bytes)} / ${formatBytes(system.memory.total_bytes)}` : "local server");
  setText("#diskMetric", Number.isFinite(system?.disk?.usage_percent) ? `${Math.round(system.disk.usage_percent)}%` : "N/A");
  setText("#diskDetail", system?.disk ? `${formatBytes(system.disk.used_bytes)} / ${formatBytes(system.disk.total_bytes)}` : "local server");
  setText("#netMetric", netRate > 0 ? formatRate(netRate) : "0 B/s");
  setText("#serverTempMetric", serverTemp > 0 ? `${Math.round(serverTemp)}°C` : "N/A");
  setText("#timeMetric", formatClock(system?.time));
  setText("#hostMetric", system?.hostname || "local server");
  setText("#uptimeMetric", system?.uptime_human || "-");
  setText("#bootShortMetric", system?.boot_time ? `boot ${formatDateShort(system.boot_time)}` : "boot time");
  ensureLocationMetric(system);
  setText("#coresMetric", clusterCores ? `${Math.round(clusterCores)}` : "-");
  setText("#coresDetailMetric", clusterGpus ? `${Math.round(clusterGpus)} GPUs · cluster total` : "cluster CPU cores");
  setText("#cpuMetricDetail", formatPercent(cpu));
  setText("#cpuDetail", system?.cpu ? `${system.cpu.logical_count} logical / ${system.cpu.physical_count || "-"} physical` : "logical cores");
  setText("#memMetricDetail", Number.isFinite(system?.memory?.usage_percent) ? `${Math.round(system.memory.usage_percent)}%` : "N/A");
  setText("#memDetailDetail", system?.memory ? `${formatBytes(system.memory.available_bytes)} available` : "local server");
  setText("#diskMetricDetail", Number.isFinite(system?.disk?.usage_percent) ? `${Math.round(system.disk.usage_percent)}%` : "N/A");
  setText("#diskDetailDetail", system?.disk ? `${system.disk.path} / ${formatBytes(system.disk.free_bytes)} free` : "local server");
  setText("#thermalServerTemp", serverTemp > 0 ? `${Math.round(serverTemp)}°C` : "N/A");
  setText("#loadDetail", system?.cpu ? `${system.cpu.load1} / ${system.cpu.load5} / ${system.cpu.load15}` : "-");
  setText("#rxDetail", system?.network ? formatRate(system.network.rx_bytes_per_sec) : "-");
  setText("#txDetail", system?.network ? formatRate(system.network.tx_bytes_per_sec) : "-");
  setText("#bootDetail", system?.boot_time ? new Date(system.boot_time).toLocaleString("ko-KR") : "-");
  setText("#diskReadRate", system?.disk_io ? formatRate(system.disk_io.read_bytes_per_sec) : "-");
  setText("#diskWriteRate", system?.disk_io ? formatRate(system.disk_io.write_bytes_per_sec) : "-");
  setText("#diskReadTotal", system?.disk_io ? `${formatBytes(system.disk_io.read_bytes)} total` : "total");
  setText("#diskWriteTotal", system?.disk_io ? `${formatBytes(system.disk_io.write_bytes)} total` : "total");
  setText("#diskReadOps", system?.disk_io ? Number(system.disk_io.read_count || 0).toLocaleString("ko-KR") : "-");
  setText("#diskWriteOps", system?.disk_io ? Number(system.disk_io.write_count || 0).toLocaleString("ko-KR") : "-");
  setText("#loadPressureMetric", Number.isFinite(loadPressure) ? `${Math.round(loadPressure)}%` : "-");
  setText("#loadTrendMetric", system?.cpu ? `${load1.toFixed(2)} / ${load5.toFixed(2)} / ${load15.toFixed(2)}` : "-");
  setText("#cpuBusyMetric", formatPercent(cpu));
  setText("#memAvailableMetric", system?.memory ? formatBytes(system.memory.available_bytes) : "-");
  setText("#memUsedMetric", system?.memory ? formatBytes(system.memory.used_bytes) : "-");
  setText("#memTotalMetric", system?.memory ? formatBytes(system.memory.total_bytes) : "-");
  setText("#rxTotalMetric", system?.network ? formatBytes(system.network.bytes_recv) : "-");
  setText("#txTotalMetric", system?.network ? formatBytes(system.network.bytes_sent) : "-");
  setText("#netNowMetric", netRate > 0 ? formatRate(netRate) : "0 B/s");
  setText("#cpuBarText", formatPercent(cpu));
  setText("#memBarText", Number.isFinite(system?.memory?.usage_percent) ? `${Math.round(system.memory.usage_percent)}%` : "N/A");
  setText("#diskBarText", Number.isFinite(system?.disk?.usage_percent) ? `${Math.round(system.disk.usage_percent)}%` : "N/A");
  setText("#gpuBarText", gpu > 0 ? formatPercent(gpu) : "N/A");
  setWidth("#cpuBar", cpu);
  setWidth("#memBar", system?.memory?.usage_percent);
  setWidth("#diskBar", system?.disk?.usage_percent);
  setWidth("#gpuBar", gpu);
  if (document.querySelector("#cpuSpark")) drawSparkline(document.querySelector("#cpuSpark"), [0, 0, 0, cpu, cpu, cpu, cpu], "#0b6f7a");
  if (document.querySelector("#gpuSpark")) drawSparkline(document.querySelector("#gpuSpark"), [0, 0, 0, gpu, gpu, gpu, gpu], "#4b62b5");
  drawLoadChart(system);
  renderFilesystems(system?.filesystems || []);
  renderOverviewInsights(summary, system);
  renderPowerInsights(summary, system);
  renderGraphBoard(summary, system);
  renderHardwareView();
}

function updateScriptFromForm() {
  const data = new FormData(jobForm);
  const gpu = Number(data.get("gpu"));
  const gpuLine = gpu > 0 ? `#SBATCH --gres=gpu:${gpu}\n` : "";
  const body = gpu > 0 ? "nvidia-smi\nhostname\ndate" : "hostname\ndate";
  jobForm.elements.script.value = `#!/bin/bash
#SBATCH --job-name=${data.get("name")}
#SBATCH --partition=${data.get("partition")}
${gpuLine}#SBATCH --cpus-per-task=${data.get("cpu")}
#SBATCH --mem=${data.get("memory")}
#SBATCH --time=${data.get("time")}

${body}`;
}

async function refreshData() {
  const [summary, system, nodeData, jobData, targetData, discoveryData, logData, ipmiData, auditData, policyData, promConfigData, accessData, templateData, approvalData, facilityData, alertData] = await Promise.all([
    loadOptional("/api/summary", {}),
    loadOptional("/api/system", {}),
    loadOptional("/api/nodes", { nodes: [] }),
    loadOptional("/api/jobs", { jobs: [] }),
    loadOptional("/api/targets", { targets: [] }),
    loadOptional("/api/discovery", {}),
    loadOptional("/api/logs?limit=220", { logs: [], summary: {}, sources: [] }),
    loadOptional("/api/ipmi", { targets: [], sensors: [], inlet_temperatures: [], power_readings: [], summary: {} }),
    loadOptional("/api/audit?limit=120", { audit: [], summary: {} }),
    loadOptional("/api/job-policy", { policy: {} }),
    loadOptional("/api/prometheus/config", { prometheus: {} }),
    loadOptional("/api/access-model", { access_model: {}, current_role: "" }),
    loadOptional("/api/job-templates", { templates: [] }),
    loadOptional("/api/approvals", { approvals: [] }),
    loadOptional("/api/facility-layout", { facility_layout: {} }),
    loadOptional("/api/alert-channels", { alert_channels: {} })
  ]);

  latestSummary = summary.unavailable ? null : summary;
  latestSystem = system.unavailable ? null : system;
  latestDiscovery = discoveryData.unavailable ? null : discoveryData;
  latestLogs = logData.unavailable ? { logs: [], summary: {}, sources: [], error: logData.error } : logData;
  latestIpmi = ipmiData.unavailable ? { targets: [], sensors: [], inlet_temperatures: [], power_readings: [], summary: {} } : ipmiData;
  latestAudit = auditData.unavailable ? { audit: [], summary: {} } : auditData;
  latestNodes = nodeData.nodes || [];
  latestTargets = targetData.targets || [];
  latestJobError = jobData.unavailable ? (jobData.error || "Slurm squeue request failed") : "";
  jobs = jobData.jobs || [];
  racks = groupNodes(latestNodes);

  updateMetrics(latestSummary, latestSystem);
  renderRacks(document.querySelector(".segmented button.active")?.dataset.filter || "all");
  renderNodeInsights();
  renderNodeCardsGrouped();
  renderJobs(searchInput.value);
  renderAlerts();
  renderSettings(latestDiscovery);
  renderLogs();
  renderIpmiDetails(latestIpmi);
  renderAuditLogs(latestAudit);
  renderJobPolicy(policyData.policy || latestDiscovery?.job_policy || {});
  renderPrometheusWizard(promConfigData.prometheus || latestDiscovery?.prometheus || {});
  renderAccessModel(accessData);
  renderTemplates(templateData);
  renderApprovals(approvalData);
  renderFacilityLayout(facilityData);
  renderAlertChannels(alertData);

  const connected = !summary.unavailable || !system.unavailable || !nodeData.unavailable || !jobData.unavailable || !targetData.unavailable || !discoveryData.unavailable || !logData.unavailable || !ipmiData.unavailable;
  setApiState(connected ? "Live API" : "No API", connected);
}

function switchView(view) {
  document.querySelectorAll(".view").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.viewPanel === view);
  });
  viewTitle.textContent = viewTitles[view] || "D-aquila";
  document.querySelector(".main").scrollTop = 0;
  if (view === "hardware") {
    requestAnimationFrame(renderHardwareView);
  }
}

window.addEventListener("d-aquila-hardware-ready", renderHardwareView);

document.querySelector("#openSubmit").addEventListener("click", () => submitDialog.showModal());
document.querySelector("#closeSubmit").addEventListener("click", () => submitDialog.close());
document.querySelector("#previewScript").addEventListener("click", updateScriptFromForm);

jobForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(jobForm);
  const payload = {
    name: data.get("name"),
    partition: data.get("partition"),
    cpu: Number(data.get("cpu")),
    gpu: Number(data.get("gpu")),
    memory: data.get("memory"),
    time: data.get("time"),
    script: data.get("script")
  };

  try {
    await apiPost("/api/jobs/submit", payload);
    await refreshData();
    submitDialog.close();
  } catch (error) {
    alert(`작업 제출 실패: ${error.message}`);
  }
});

document.querySelector("#refreshJobs").addEventListener("click", async () => {
  await refreshData();
});

document.querySelector("#jobUserFilter")?.addEventListener("change", () => renderJobs(searchInput.value));
document.querySelector("#jobStateFilter")?.addEventListener("change", () => renderJobs(searchInput.value));

jobTable?.addEventListener("click", async (event) => {
  const button = event.target.closest(".job-cancel");
  if (!button) return;
  const jobId = button.dataset.jobId;
  if (!jobId) return;
  const ok = confirm(`Slurm 작업 ${jobId}을 scancel로 취소할까요?`);
  if (!ok) return;
  try {
    button.disabled = true;
    await apiPost(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { reason: "cancelled from D-aquila" });
    await refreshData();
  } catch (error) {
    alert(`작업 취소 실패: ${error.message}`);
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#policyForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    enabled: !!document.querySelector("#policyEnabled")?.checked,
    allowed_partitions: String(document.querySelector("#policyPartitions")?.value || "").split(",").map((item) => item.trim()).filter(Boolean),
    max_cpu: Number(document.querySelector("#policyMaxCpu")?.value || 64),
    max_gpu: Number(document.querySelector("#policyMaxGpu")?.value || 8),
    max_memory_gb: Number(document.querySelector("#policyMaxMemory")?.value || 256),
    max_time_hours: Number(document.querySelector("#policyMaxTime")?.value || 24),
    allow_custom_script: !!document.querySelector("#policyCustomScript")?.checked
  };
  try {
    const data = await apiPost("/api/job-policy", payload);
    renderJobPolicy(data.policy || payload);
    await refreshData();
  } catch (error) {
    alert(`정책 저장 실패: ${error.message}`);
  }
});

function prometheusWizardPayload() {
  return {
    url: document.querySelector("#prometheusUrlInput")?.value || "http://localhost:9090",
    node_targets: String(document.querySelector("#prometheusNodeTargets")?.value || "").split(/\n|,/).map((item) => item.trim()).filter(Boolean),
    dcgm_targets: String(document.querySelector("#prometheusDcgmTargets")?.value || "").split(/\n|,/).map((item) => item.trim()).filter(Boolean),
    ipmi_targets: String(document.querySelector("#prometheusIpmiTargets")?.value || "").split(/\n|,/).map((item) => item.trim()).filter(Boolean)
  };
}

function showPrometheusWizardResult(result) {
  const target = document.querySelector("#prometheusWizardResult");
  if (!target) return;
  const ok = !!result?.test?.ok;
  target.innerHTML = `
    <div class="check-row ${ok ? "ok" : "warn"}">
      <span></span>
      <div>
        <strong>${ok ? "Prometheus 연결 성공" : "Prometheus 연결 확인 필요"}</strong>
        <small>${escapeHtml(result?.test?.detail || "-")}</small>
      </div>
    </div>
  `;
}

document.querySelector("#testPrometheusWizard")?.addEventListener("click", async () => {
  try {
    const result = await apiPost("/api/prometheus/test", prometheusWizardPayload());
    showPrometheusWizardResult(result);
  } catch (error) {
    alert(`Prometheus 테스트 실패: ${error.message}`);
  }
});

document.querySelector("#applyPrometheusWizard")?.addEventListener("click", async () => {
  try {
    const result = await apiPost("/api/prometheus/apply", {});
    showPrometheusWizardResult({ test: result.reload || {} });
    await refreshData();
  } catch (error) {
    alert(`Prometheus 반영 실패: ${error.message}`);
  }
});

document.querySelector("#prometheusWizardForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await apiPost("/api/prometheus/config", prometheusWizardPayload());
    showPrometheusWizardResult(result);
    await refreshData();
  } catch (error) {
    alert(`Prometheus 설정 저장 실패: ${error.message}`);
  }
});

document.querySelector("#accessModelForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    admin_users: csvValue("#accessAdminUsers"),
    operator_users: csvValue("#accessOperatorUsers"),
    viewer_users: csvValue("#accessViewerUsers"),
    admin_groups: csvValue("#accessAdminGroups"),
    operator_groups: csvValue("#accessOperatorGroups"),
    viewer_groups: csvValue("#accessViewerGroups")
  };
  try {
    const result = await apiPost("/api/access-model", payload);
    renderAccessModel(result);
  } catch (error) {
    alert(`권한 저장 실패: ${error.message}`);
  }
});

document.querySelector("#templateForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    name: document.querySelector("#templateName")?.value || "",
    partition: document.querySelector("#templatePartition")?.value || "",
    cpu: Number(document.querySelector("#templateCpu")?.value || 1),
    gpu: Number(document.querySelector("#templateGpu")?.value || 0),
    memory: document.querySelector("#templateMemory")?.value || "16G",
    time: document.querySelector("#templateTime")?.value || "01:00:00",
    script: document.querySelector("#templateScript")?.value || "#!/bin/bash\nhostname\n",
    requires_approval: !!document.querySelector("#templateRequiresApproval")?.checked
  };
  try {
    const result = await apiPost("/api/job-templates", payload);
    renderTemplates(result);
  } catch (error) {
    alert(`템플릿 저장 실패: ${error.message}`);
  }
});

document.querySelector("#templateList")?.addEventListener("click", async (event) => {
  const button = event.target.closest(".request-template");
  if (!button) return;
  try {
    await apiPost("/api/approvals", { template_id: button.dataset.templateId, parameters: {} });
    await refreshData();
  } catch (error) {
    alert(`승인 요청 실패: ${error.message}`);
  }
});

document.querySelector("#approvalList")?.addEventListener("click", async (event) => {
  const button = event.target.closest(".approval-decision");
  if (!button) return;
  try {
    await apiPost(`/api/approvals/${encodeURIComponent(button.dataset.approvalId)}/decision`, {
      action: button.dataset.action,
      comment: ""
    });
    await refreshData();
  } catch (error) {
    alert(`승인 처리 실패: ${error.message}`);
  }
});

document.querySelector("#facilityForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = {
      rooms: JSON.parse(document.querySelector("#facilityRooms")?.value || "[]"),
      racks: JSON.parse(document.querySelector("#facilityRacks")?.value || "[]")
    };
    const result = await apiPost("/api/facility-layout", payload);
    renderFacilityLayout(result);
  } catch (error) {
    alert(`배치 저장 실패: ${error.message}`);
  }
});

document.querySelector("#alertChannelForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    webhook_url: document.querySelector("#alertWebhookUrl")?.value || "",
    email_recipients: csvValue("#alertEmails"),
    enabled_events: csvValue("#alertEvents")
  };
  try {
    const result = await apiPost("/api/alert-channels", payload);
    renderAlertChannels(result);
  } catch (error) {
    alert(`알림 저장 실패: ${error.message}`);
  }
});

document.querySelector("#testAlertChannel")?.addEventListener("click", async () => {
  try {
    await apiPost("/api/alert-channels/test", {});
    const target = document.querySelector("#alertChannelResult");
    if (target) target.innerHTML = `<div class="check-row ok"><span></span><div><strong>테스트 전송 요청 완료</strong><small>Webhook URL과 이벤트 설정을 확인하세요.</small></div></div>`;
  } catch (error) {
    alert(`알림 테스트 실패: ${error.message}`);
  }
});

document.querySelector("#refreshSettings")?.addEventListener("click", async () => {
  await refreshData();
});

document.querySelector("#refreshLogs")?.addEventListener("click", async () => {
  await refreshData();
});

document.querySelector("#logCategoryFilter")?.addEventListener("change", renderLogs);
document.querySelector("#logLevelFilter")?.addEventListener("change", renderLogs);

document.querySelectorAll(".segmented button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".segmented button").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    renderRacks(button.dataset.filter);
  });
});

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    switchView(button.dataset.view);
  });
});

searchInput.addEventListener("input", (event) => renderJobs(event.target.value));

loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(loginForm);
  loginMessage.textContent = "로그인 확인 중입니다.";
  try {
    const auth = await apiPost("/api/auth/login", {
      username: data.get("username"),
      password: data.get("password")
    });
    loginForm.reset();
    showApp(auth.username);
    await refreshData();
    refreshTimer = setInterval(refreshData, 15000);
  } catch (error) {
    loginMessage.textContent = error.message.includes("PAM")
      ? "이 실행 환경에서는 OS 계정 인증을 사용할 수 없습니다. 로그인 노드에서 실행하세요."
      : "로그인 실패: OS 계정과 비밀번호를 확인하세요.";
  }
});

document.querySelector("#logoutButton")?.addEventListener("click", async () => {
  try {
    await apiPost("/api/auth/logout", {});
  } finally {
    showLogin("로그아웃되었습니다.");
  }
});

checkAuth();
