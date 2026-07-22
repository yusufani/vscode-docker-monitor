import { GpuData, GpuInfo, GpuProcess, ContainerFullInfo } from "../../types";
import { fmtMem, fmtUptime, fmtStartDate } from "../../utils/format";
// package.json is outside rootDir (src), so it can't be imported; load via require.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require("../../../package.json");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function bar(used: number, total: number, id?: string): string {
  const pct = total > 0 ? (used / total) * 100 : 0;
  const cls = pct > 90 ? "red" : pct > 70 ? "yellow" : "green";
  const idAttr = id ? ` data-bar="${id}"` : "";
  return `<div class="bar"${idAttr}><div class="bar-fill ${cls}" style="width:${pct}%"></div></div>`;
}

function memClass(mib: number): string {
  return mib > 40000 ? "red" : mib > 10000 ? "yellow" : "";
}

function vendorEmoji(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("nvidia")) return "\uD83D\uDFE2";
  if (lower.includes("amd") || lower.includes("radeon")) return "\uD83D\uDD34";
  if (lower.includes("apple")) return "\uD83C\uDF4E";
  return "\uD83C\uDFAE";
}

function renderGpuCards(gpus: GpuInfo[]): string {
  let html = "";
  for (const gpu of gpus) {
    const pct = gpu.memTotal > 0 ? Math.round((gpu.memUsed / gpu.memTotal) * 100) : 0;
    html += `<div class="gpu-card" data-gpu="${gpu.index}">
      <div class="gpu-header">${vendorEmoji(gpu.name)} GPU ${gpu.index}: ${esc(gpu.name)}</div>
      <div class="gpu-stats">
        <div class="gpu-stat"><span class="label">VRAM</span>${bar(gpu.memUsed, gpu.memTotal, `vram-${gpu.index}`)}<span class="value" data-val="vram-${gpu.index}">${fmtMem(gpu.memUsed)} / ${fmtMem(gpu.memTotal)} (${pct}%)</span></div>
        <div class="gpu-stat"><span class="label">Util</span>${bar(gpu.util, 100, `util-${gpu.index}`)}<span class="value ${gpu.util > 80 ? "red" : gpu.util > 50 ? "yellow" : "green"}" data-val="util-${gpu.index}">${gpu.util}%</span></div>
        <div class="gpu-inline">
          <span>Temp: <b class="${gpu.temp > 80 ? "red" : gpu.temp > 65 ? "yellow" : ""}" data-val="temp-${gpu.index}">${gpu.temp}\u00B0C</b></span>
          <span>Power: <b data-val="power-${gpu.index}">${gpu.power.toFixed(0)}W</b></span>
          <span>Free: <b data-val="free-${gpu.index}">${fmtMem(gpu.memFree)}</b></span>
        </div>
      </div>
    </div>`;
  }
  return html;
}

function renderGpuHistoryCharts(history: Array<{ timestamp: number; gpus: Array<{ index: number; memUsed: number; memTotal: number; util: number; temp: number }> }>): string {
  if (history.length < 2) return "";

  const gpuIndices = new Set<number>();
  for (const h of history) for (const g of h.gpus) gpuIndices.add(g.index);

  let html = `<div class="section-title">\uD83D\uDCC8 GPU History (last ${history.length} samples)<button class="btn export-btn" onclick="vscode.postMessage({command:'exportHistory'})" title="Export CSV">\uD83D\uDCBE Export CSV</button></div>`;

  for (const idx of [...gpuIndices].sort()) {
    const points = history.map((h) => {
      const g = h.gpus.find((g) => g.index === idx);
      return g ? { vramPct: g.memTotal > 0 ? (g.memUsed / g.memTotal) * 100 : 0, util: g.util, temp: g.temp } : null;
    }).filter(Boolean) as Array<{ vramPct: number; util: number; temp: number }>;

    if (points.length < 2) continue;

    const w = 300, h2 = 60;
    const stepX = w / (points.length - 1);

    const vramPath = points.map((p, i) => `${i === 0 ? "M" : "L"}${(i * stepX).toFixed(1)},${(h2 - (p.vramPct / 100) * h2).toFixed(1)}`).join(" ");
    const utilPath = points.map((p, i) => `${i === 0 ? "M" : "L"}${(i * stepX).toFixed(1)},${(h2 - (p.util / 100) * h2).toFixed(1)}`).join(" ");
    const tempPath = points.map((p, i) => `${i === 0 ? "M" : "L"}${(i * stepX).toFixed(1)},${(h2 - Math.min(p.temp, 100) / 100 * h2).toFixed(1)}`).join(" ");

    html += `<div class="chart-card" data-chart-gpu="${idx}">
      <div class="chart-label">GPU ${idx}</div>
      <svg width="${w}" height="${h2}" class="chart-svg">
        <line x1="0" y1="${h2 * 0.1}" x2="${w}" y2="${h2 * 0.1}" stroke="#333" stroke-dasharray="2"/>
        <line x1="0" y1="${h2 * 0.5}" x2="${w}" y2="${h2 * 0.5}" stroke="#333" stroke-dasharray="2"/>
        <line x1="0" y1="${h2 * 0.9}" x2="${w}" y2="${h2 * 0.9}" stroke="#333" stroke-dasharray="2"/>
        <path d="${vramPath}" fill="none" stroke="#4ec9b0" stroke-width="2" class="chart-path" data-chart-path="vram-${idx}"/>
        <path d="${utilPath}" fill="none" stroke="#dcdcaa" stroke-width="1.5" stroke-dasharray="4" class="chart-path" data-chart-path="util-${idx}"/>
        <path d="${tempPath}" fill="none" stroke="#f44747" stroke-width="1" stroke-dasharray="2" class="chart-path" data-chart-path="temp-${idx}"/>
      </svg>
      <div class="chart-legend"><span class="green">\u2500 VRAM%</span><span class="yellow">--- Util%</span><span class="red">\u00B7\u00B7 Temp</span></div>
    </div>`;
  }

  return html;
}

function renderMultiGpuSummary(gpus: GpuInfo[]): string {
  if (gpus.length <= 1) return "";
  const totalUsed = gpus.reduce((s, g) => s + g.memUsed, 0);
  const totalMem = gpus.reduce((s, g) => s + g.memTotal, 0);
  const totalPct = totalMem > 0 ? Math.round((totalUsed / totalMem) * 100) : 0;
  const avgUtil = Math.round(gpus.reduce((s, g) => s + g.util, 0) / gpus.length);
  const maxTemp = Math.max(...gpus.map((g) => g.temp));

  return `<div class="summary-bar" id="summaryBar">
    <span>Total VRAM: <b class="${totalPct > 90 ? "red" : totalPct > 70 ? "yellow" : "green"}" data-val="total-vram">${fmtMem(totalUsed)}/${fmtMem(totalMem)} (${totalPct}%)</b></span>
    <span>Avg Util: <b data-val="avg-util">${avgUtil}%</b></span>
    <span>Max Temp: <b class="${maxTemp > 80 ? "red" : maxTemp > 65 ? "yellow" : ""}" data-val="max-temp">${maxTemp}\u00B0C</b></span>
    <span>${gpus.length} GPUs</span>
  </div>`;
}

function renderContainerSummary(data: GpuData, containers: ContainerFullInfo[]): string {
  const { processes, containerStats, gpus } = data;
  const containerGpu: Record<string, Record<number, number>> = {};
  const cnameToId: Record<string, string> = {};
  for (const p of processes) {
    const cn = p.containerName === "host" ? "(host)" : p.containerName;
    if (!containerGpu[cn]) containerGpu[cn] = {};
    containerGpu[cn][p.gpuIndex] = (containerGpu[cn][p.gpuIndex] || 0) + p.memMib;
    if (p.containerId) cnameToId[cn] = p.containerId;
  }

  // Add all containers (even those without GPU processes)
  for (const c of containers) {
    if (!cnameToId[c.name]) cnameToId[c.name] = c.id;
    if (!containerGpu[c.name]) containerGpu[c.name] = {};
  }

  const gpuIndices = gpus.map((g) => g.index).sort((a, b) => a - b);
  const sc = Object.entries(containerGpu).sort(
    (a, b) =>
      Object.values(b[1]).reduce((s, v) => s + v, 0) - Object.values(a[1]).reduce((s, v) => s + v, 0),
  );

  let headers = `<th>Container</th>`;
  for (const gi of gpuIndices) headers += `<th>G${gi}</th>`;
  headers += `<th>VRAM</th><th>CPU</th><th>RAM</th><th>Net I/O</th><th>Disk I/O</th><th></th>`;

  let rows = "";
  for (const [cn, gm] of sc) {
    const tv = Object.values(gm).reduce((s, v) => s + v, 0);
    const cs = cnameToId[cn] ? containerStats.get(cnameToId[cn]) : undefined;
    const cid = cnameToId[cn] || "";
    const lbl = podLabel(cn);
    const badge = lbl.kind === "k8s" ? "☸ " : lbl.kind === "docker" ? "🐳 " : "";
    const nameCell = lbl.kind === "k8s"
      ? `${badge}${esc(lbl.short)} <span class="ns-tag">${esc(lbl.ns)}</span>`
      : `${badge}${esc(lbl.short)}`;
    let cols = `<td class="name" title="${esc(cn)}">${nameCell}</td>`;
    for (const gi of gpuIndices) cols += `<td class="${memClass(gm[gi] || 0)}">${gm[gi] ? fmtMem(gm[gi]) : "\u2014"}</td>`;
    cols += `<td class="${memClass(tv)}"><b>${tv > 0 ? fmtMem(tv) : "\u2014"}</b></td>`;
    cols += `<td>${cs ? cs.cpuPercent.toFixed(1) + "%" : "\u2014"}</td>`;
    cols += `<td>${cs ? fmtMem(cs.memUsedMib) : "\u2014"}</td>`;
    cols += `<td>${cs?.netIO || "\u2014"}</td>`;
    cols += `<td>${cs?.blockIO || "\u2014"}</td>`;
    // Action buttons
    let actions = "";
    if (cn !== "(host)" && cid) {
      actions = `<button class="btn btn-sm" onclick="execContainer('${cid}','${esc(cn)}')" title="Exec">\u25B6</button>`;
      actions += `<button class="btn btn-sm" onclick="showLogs('${cid}','${esc(cn)}')" title="Logs">\u2261</button>`;
      actions += `<button class="btn btn-sm" onclick="attachContainer('${cid}','${esc(cn)}')" title="Attach">\u2192</button>`;
      actions += `<button class="btn btn-sm" onclick="restartContainer('${cid}','${esc(cn)}')" title="Restart">\u21BB</button>`;
      actions += `<button class="btn btn-sm btn-warn" onclick="stopContainer('${cid}','${esc(cn)}')" title="Stop">\u25A0</button>`;
      actions += `<button class="btn btn-sm btn-danger" onclick="killContainerAction('${cid}','${esc(cn)}')" title="Kill">\u00D7</button>`;
    }
    cols += `<td class="actions">${actions}</td>`;
    rows += `<tr>${cols}</tr>`;
  }

  return `<table><tr>${headers}</tr>${rows}</table>`;
}

/** Split a k8s "ns/pod" container name into a namespace tag + short pod label. */
function podLabel(containerName: string): { kind: "k8s" | "docker" | "host"; ns: string; short: string } {
  if (containerName === "host" || containerName === "(host)") return { kind: "host", ns: "", short: "(host)" };
  const slash = containerName.indexOf("/");
  if (slash > 0) return { kind: "k8s", ns: containerName.slice(0, slash), short: containerName.slice(slash + 1) };
  return { kind: "docker", ns: "", short: containerName };
}

function renderProcessGroups(data: GpuData): string {
  const { processes, containerStats } = data;
  const cnameToId: Record<string, string> = {};
  const groups: Record<string, GpuProcess[]> = {};
  for (const p of processes) {
    const cn = p.containerName === "host" ? "(host)" : p.containerName;
    if (!groups[cn]) groups[cn] = [];
    groups[cn].push(p);
    if (p.containerId) cnameToId[cn] = p.containerId;
  }

  // Sort groups by total VRAM (heaviest first).
  const sortedGroups = Object.entries(groups).sort(
    (a, b) => b[1].reduce((s, p) => s + p.memMib, 0) - a[1].reduce((s, p) => s + p.memMib, 0),
  );

  let html = "";
  for (const [cn, procs] of sortedGroups) {
    procs.sort((a, b) => b.memMib - a.memMib); // heaviest process first within the group
    const tv = procs.reduce((s, p) => s + p.memMib, 0);
    const tr = procs.reduce((s, p) => s + p.ramMib, 0);
    const gu = [...new Set(procs.map((p) => p.gpuIndex))].sort().join(",");
    const guSum = procs.reduce((s, p) => s + (p.gpuUtil || 0), 0);
    const guStr = guSum > 0 ? ` · SM ${guSum}%` : "";
    const cid = cnameToId[cn] || "";
    const cs = cid ? containerStats.get(cid) : undefined;
    const cpuStr = cs ? ` \u00B7 CPU ${cs.cpuPercent.toFixed(1)}%` : "";
    const lbl = podLabel(cn);
    const badge = lbl.kind === "k8s" ? "\u2638 " : lbl.kind === "docker" ? "\uD83D\uDC33 " : "";
    const nsTag = lbl.kind === "k8s" ? `<span class="ns-tag" title="Kubernetes namespace">${esc(lbl.ns)}</span>` : "";
    let act = "";
    if (cn !== "(host)" && cid) {
      act = `<button class="btn btn-warn" onclick="restartContainer('${cid}','${esc(cn)}')">Restart</button>`;
      act += `<button class="btn btn-warn" onclick="stopContainer('${cid}','${esc(cn)}')">Stop</button>`;
      act += `<button class="btn btn-danger" onclick="killContainerAction('${cid}','${esc(cn)}')">Kill</button>`;
    }
    const groupText = `${cn} | ${procs.length} procs | VRAM ${fmtMem(tv)} | RAM ${fmtMem(tr)} | GPU ${gu}${guSum > 0 ? ` | SM ${guSum}%` : ""}${cs ? ` | CPU ${cs.cpuPercent.toFixed(1)}%` : ""}`;
    html += `<div class="group-header"><span class="group-name" title="${esc(cn)}">${badge}${esc(lbl.short)}</span>${nsTag}<span class="group-meta">${procs.length} procs \u00B7 VRAM ${fmtMem(tv)} \u00B7 RAM ${fmtMem(tr)} \u00B7 GPU ${gu}${guStr}${cpuStr}</span><button class="btn-copy" data-copy="${esc(groupText)}" title="Copy">copy</button>${act}</div>`;
    for (let i = 0; i < procs.length; i++) {
      const p = procs[i];
      const last = i === procs.length - 1;
      const br = last ? "\u2514\u2500" : "\u251C\u2500";
      const co = last ? "  " : "\u2502 ";
      const cmd = p.cmdline;
      const cw = p.cwd;
      const cwdShort = cw && cw !== "?" ? cw.split("/").filter(Boolean).pop() || cw : "";
      const cwdTag = cwdShort ? `<span class="cwd-tag" title="${esc(cw)}">${esc(cwdShort)}</span>` : "";
      const upStr = fmtUptime(p.startTime);
      const startStr = fmtStartDate(p.startTime);
      const timeInfo = upStr ? `<span class="uptime" title="Started: ${startStr}">\u23F1 ${upStr}</span>` : "";
      const smCls = p.gpuUtil > 50 ? "red" : p.gpuUtil > 20 ? "yellow" : "dim";
      const where = lbl.kind === "host" ? "host" : (lbl.kind === "k8s" ? `pod ${cn}` : `container ${cn}`);
      // Only pod-backed processes carry a marker, so they stand out in a mixed list.
      const procMark = lbl.kind === "k8s"
        ? `<span class="pod-mark" title="Kubernetes pod process">☸</span>`
        : "";
      const pnameTitle = `${p.processName}\n${where}\nPID ${p.pid} \u00B7 ${p.username}${startStr ? ` \u00B7 started ${startStr}` : ""}`;
      const rowText = `${where} | PID ${p.pid} | VRAM ${fmtMem(p.memMib)} | RAM ${fmtMem(p.ramMib)} | G${p.gpuIndex} | SM ${p.gpuUtil}% | ${p.processName} | ${p.username}${cwdShort ? ` | ${cw}` : ""}${upStr ? ` | uptime: ${upStr}` : ""}${cmd ? ` | CMD: ${cmd}` : ""}`;
      const detailText = `${cw}$ ${cmd}`;
      html += `<div class="proc-row" data-name="${esc(p.processName)}" data-user="${esc(p.username)}" data-container="${esc(cn)}"><span class="tree">${br}</span><span class="pid">${p.pid}</span><span class="mem ${memClass(p.memMib)}">${fmtMem(p.memMib)}</span><span class="ram">${fmtMem(p.ramMib)}</span><span class="gpu-idx">G${p.gpuIndex}</span><span class="gpu-util ${smCls}" title="Per-process GPU SM utilization (nvidia-smi pmon)">${p.gpuUtil}%</span>${procMark}<span class="pname" title="${esc(pnameTitle)}">${esc(p.processName)}</span>${cwdTag}${timeInfo}<span class="user-tag">${esc(p.username)}</span><button class="btn-copy" data-copy="${esc(rowText)}" title="Copy">copy</button><button class="btn-kill" onclick="killProc(${p.pid},'${esc(p.processName)}',${p.memMib})">\u00D7</button></div>`;
      html += `<div class="proc-detail" data-name="${esc(p.processName)}" data-user="${esc(p.username)}" data-container="${esc(cn)}"><span class="tree dim">${co}</span><span class="dim">\u2514 ${esc(cw)}$ ${esc(cmd)}</span><button class="btn-copy" data-copy="${esc(detailText)}" title="Copy">copy</button></div>`;
    }
  }
  return html;
}

export interface GpuHistoryPoint {
  timestamp: number;
  gpus: Array<{ index: number; memUsed: number; memTotal: number; util: number; temp: number }>;
}

/** Build JSON-serializable data for incremental updates */
export function buildGpuMonitorData(data: GpuData, refreshIntervalSec = 5, history: GpuHistoryPoint[] = [], containers: ContainerFullInfo[] = []): Record<string, unknown> {
  const { gpus, processes, containerStats, error } = data;

  // Serialize containerStats map (include netIO and blockIO)
  const statsObj: Record<string, { cpuPercent: number; memUsedMib: number; memLimitMib: number; memPercent: number; netIO: string; blockIO: string }> = {};
  containerStats.forEach((v, k) => { statsObj[k] = v; });

  return {
    gpus,
    processes,
    containerStats: statsObj,
    containers: containers.map(c => ({ id: c.id, name: c.name })),
    error,
    refreshIntervalSec,
    history,
    timestamp: new Date().toLocaleTimeString(),
    processGroupsHtml: processes.length > 0 ? renderProcessGroups(data) : "",
    containerSummaryHtml: renderContainerSummary(data, containers),
  };
}

export function getGpuMonitorHtml(data: GpuData, refreshIntervalSec = 5, history: GpuHistoryPoint[] = [], containers: ContainerFullInfo[] = []): string {
  const { gpus, processes, error } = data;
  const gpuRows = renderGpuCards(gpus);
  const multiGpuSummary = renderMultiGpuSummary(gpus);
  const historyCharts = renderGpuHistoryCharts(history);
  const hasContainers = containers.length > 0 || processes.length > 0;

  let processHtml = "";
  if (hasContainers) {
    processHtml = `<div class="section-title">\uD83D\uDC33 Container Summary</div><div id="containerSummary">${renderContainerSummary(data, containers)}</div>`;
    if (processes.length > 0) {
      processHtml += `<div class="section-title">\u2699\uFE0F GPU Processes <input type="text" id="procFilter" class="filter-input" placeholder="Filter by name, user, container..." oninput="filterProcs()"></div><div id="processGroups">${renderProcessGroups(data)}</div>`;
    }
  } else if (!error) {
    processHtml = `<div class="no-data">No containers or GPU processes.</div>`;
  }

  // Build initial JSON data for incremental updates
  const initialData = JSON.stringify(buildGpuMonitorData(data, refreshIntervalSec, history, containers));

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
:root{--bg:var(--vscode-editor-background);--fg:var(--vscode-editor-foreground);--border:var(--vscode-panel-border,#333);--green:#4ec9b0;--yellow:#dcdcaa;--red:#f44747;--cyan:#9cdcfe;--dim:var(--vscode-disabledForeground,#666);--card-bg:var(--vscode-sideBar-background,#1e1e1e)}
body{font-family:var(--vscode-editor-font-family,monospace);font-size:13px;color:var(--fg);background:var(--bg);padding:12px;margin:0}
.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.header h2{margin:0;color:var(--cyan);font-size:15px}.version{font-size:11px;color:var(--dim);font-weight:normal}
.header .meta{color:var(--dim);font-size:12px}
.refresh-btn{background:none;border:1px solid var(--border);color:var(--fg);padding:4px 12px;cursor:pointer;border-radius:3px;font-size:12px}
.refresh-btn:hover{background:var(--border)}
.error{color:var(--red);padding:8px;border:1px solid var(--red);border-radius:4px;margin-bottom:12px}
.section-title{color:var(--cyan);font-weight:bold;margin:16px 0 6px 0;font-size:13px;border-bottom:1px solid var(--border);padding-bottom:4px;display:flex;align-items:center;gap:12px}
.summary-bar{background:var(--card-bg);border:1px solid var(--border);border-radius:6px;padding:8px 14px;margin-bottom:10px;display:flex;gap:24px;flex-wrap:wrap;font-size:13px}
.summary-bar span{color:var(--dim)}
.summary-bar b{color:var(--fg)}
.gpu-card{background:var(--card-bg);border:1px solid var(--border);border-radius:6px;padding:10px 14px;margin-bottom:10px}
.gpu-header{font-weight:bold;margin-bottom:8px}
.gpu-stats{display:flex;flex-direction:column;gap:4px}
.gpu-stat{display:flex;align-items:center;gap:8px}
.gpu-stat .label{width:40px;color:var(--dim)}
.gpu-stat .value{min-width:140px;transition:color .3s}
.gpu-inline{display:flex;gap:20px;margin-top:4px;color:var(--dim)}
.gpu-inline b{color:var(--fg);transition:color .3s}
.bar{width:160px;height:14px;background:#333;border-radius:3px;overflow:hidden;flex-shrink:0}
.bar-fill{height:100%;border-radius:3px;transition:width .5s ease,background-color .3s}
.bar-fill.green{background:var(--green)}.bar-fill.yellow{background:var(--yellow)}.bar-fill.red{background:var(--red)}
.chart-card{background:var(--card-bg);border:1px solid var(--border);border-radius:6px;padding:8px 14px;margin-bottom:8px;display:inline-block;margin-right:8px}
.chart-label{font-weight:bold;margin-bottom:4px;font-size:12px}
.chart-svg{display:block}
.chart-path{transition:d .5s ease}
.chart-legend{display:flex;gap:12px;margin-top:4px;font-size:11px}
.filter-input{background:var(--card-bg);border:1px solid var(--border);color:var(--fg);padding:3px 8px;border-radius:3px;font-size:12px;font-family:inherit;width:200px}
.filter-input:focus{outline:1px solid var(--cyan);border-color:var(--cyan)}
table{border-collapse:collapse;width:100%;margin-bottom:8px}
th,td{text-align:right;padding:3px 10px;border-bottom:1px solid var(--border);font-size:12px;transition:color .3s,background .3s}
th{color:var(--dim);font-weight:normal;text-transform:uppercase;font-size:11px}
td.name{text-align:left;font-weight:bold;color:var(--cyan)}
td.actions{text-align:right;white-space:nowrap}
.group-header{background:var(--card-bg);border:1px solid var(--border);border-radius:4px;padding:6px 10px;margin:8px 0 2px 0;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.group-name{color:var(--cyan);font-weight:bold}
.group-meta{color:var(--dim);font-size:12px}
.ns-tag{color:var(--yellow);font-size:11px;background:var(--card-bg);padding:1px 6px;border-radius:3px;border:1px solid var(--border);white-space:nowrap}
.pod-mark{color:#4a9eff;font-size:12px;flex-shrink:0;cursor:default}
.proc-row{display:flex;align-items:center;gap:8px;padding:2px 0 2px 16px;font-family:monospace}
.proc-detail{padding:0 0 4px 16px;font-family:monospace;font-size:11px;word-break:break-all;white-space:normal}
.tree{color:var(--dim);width:20px;flex-shrink:0}
.pid{color:var(--dim);width:70px;text-align:right}
.mem{width:70px;text-align:right;font-weight:bold}
.ram{width:60px;text-align:right;color:var(--dim)}
.gpu-idx{width:24px;color:var(--dim)}
.gpu-util{width:44px;text-align:right;font-size:11px;cursor:default}
.pname{color:var(--fg);flex:1}
.user-tag{color:var(--dim);font-size:11px;background:var(--card-bg);padding:1px 6px;border-radius:3px;border:1px solid var(--border)}
.uptime{color:var(--dim);font-size:11px;margin:0 4px;cursor:default}
.dim{color:var(--dim)}
.green{color:var(--green)}.yellow{color:var(--yellow)}.red{color:var(--red)}
.no-data{color:var(--dim);padding:12px}
.btn{border:1px solid var(--border);background:none;color:var(--fg);padding:2px 8px;border-radius:3px;cursor:pointer;font-size:11px}
.btn-sm{padding:1px 5px;font-size:12px}
.btn-warn{border-color:var(--yellow);color:var(--yellow)}.btn-warn:hover{background:var(--yellow);color:#000}
.btn-danger{border-color:var(--red);color:var(--red)}.btn-danger:hover{background:var(--red);color:#fff}
.btn-kill{background:none;border:none;color:var(--red);cursor:pointer;font-size:16px;padding:0 4px;opacity:.5}.btn-kill:hover{opacity:1}
.btn-copy{background:none;border:none;color:var(--dim);cursor:pointer;font-size:12px;padding:0 4px;opacity:.4;transition:opacity .2s}.btn-copy:hover{opacity:1}
.cwd-tag{color:var(--dim);font-size:11px;background:var(--card-bg);padding:1px 6px;border-radius:3px;border:1px solid var(--border);white-space:nowrap;cursor:default}
.hidden{display:none!important}
@keyframes valPulse{0%{text-shadow:0 0 4px var(--cyan)}100%{text-shadow:none}}
.val-changed{animation:valPulse .6s ease}
</style></head><body>
<div class="header">
  <h2>GPU / Docker VRAM Monitor <span class="version">v${pkg.version}</span></h2>
  <div>
    <span class="meta" id="metaInfo">${new Date().toLocaleTimeString()} \u00B7 ${processes.length} procs \u00B7 auto-refresh ${refreshIntervalSec}s</span>
    <button class="refresh-btn" onclick="vscode.postMessage({command:'refresh'})">\u21BB Refresh</button>
  </div>
</div>
${error ? `<div class="error" id="errorBox">${esc(error)}</div>` : `<div class="error hidden" id="errorBox"></div>`}
<div id="multiGpuSummary">${multiGpuSummary}</div>
<div class="section-title">\uD83C\uDFAE GPU Overview</div>
<div id="gpuCards">${gpuRows}</div>
<div id="historyCharts">${historyCharts}</div>
<div id="processSection">${processHtml}</div>
<script>
const vscode=acquireVsCodeApi();
function killProc(p,n,m){vscode.postMessage({command:'killProcess',pid:p,name:n,mem:m})}
function stopContainer(c,n){vscode.postMessage({command:'stopContainer',containerId:c,name:n})}
function killContainerAction(c,n){vscode.postMessage({command:'killContainer',containerId:c,name:n})}
function restartContainer(c,n){vscode.postMessage({command:'restartContainer',containerId:c,name:n})}
function execContainer(c,n){vscode.postMessage({command:'exec',containerId:c,name:n})}
function showLogs(c,n){vscode.postMessage({command:'logs',containerId:c,name:n})}
function attachContainer(c,n){vscode.postMessage({command:'attach',containerId:c,name:n})}
document.addEventListener('click',function(e){var btn=e.target.closest('.btn-copy');if(!btn)return;var text=btn.getAttribute('data-copy');if(!text)return;vscode.postMessage({command:'copyText',text:text});btn.textContent='\\u2713';setTimeout(function(){btn.textContent='copy'},1000)});
function filterProcs(){
  const q=(document.getElementById('procFilter')||{}).value||'';
  const ql=q.toLowerCase();
  document.querySelectorAll('.proc-row,.proc-detail').forEach(function(el){
    if(!ql){el.classList.remove('hidden');return}
    var n=el.getAttribute('data-name')||'';
    var u=el.getAttribute('data-user')||'';
    var c=el.getAttribute('data-container')||'';
    var match=(n+' '+u+' '+c).toLowerCase().indexOf(ql)>=0;
    el.classList.toggle('hidden',!match);
  });
}

// Incremental update: update bar fills and values in-place
function updateBarFill(barEl, pct, cls) {
  var fill = barEl.querySelector('.bar-fill');
  if (fill) {
    fill.style.width = pct + '%';
    fill.className = 'bar-fill ' + cls;
  }
}

function setValText(el, text) {
  if (el && el.textContent !== text) {
    el.textContent = text;
    el.classList.remove('val-changed');
    void el.offsetWidth; // force reflow
    el.classList.add('val-changed');
  }
}

// Listen for incremental data updates
window.addEventListener('message', function(event) {
  var msg = event.data;
  if (msg.type !== 'update') return;

  // For now, do a full re-render via innerHTML since the GPU monitor HTML is complex
  // But update bar fills in-place for smooth transitions where possible
  var gpus = msg.gpus || [];

  // Update bar fills for existing GPU cards
  for (var i = 0; i < gpus.length; i++) {
    var g = gpus[i];
    var vramPct = g.memTotal > 0 ? (g.memUsed / g.memTotal) * 100 : 0;
    var vramCls = vramPct > 90 ? 'red' : vramPct > 70 ? 'yellow' : 'green';
    var utilCls = g.util > 90 ? 'red' : g.util > 70 ? 'yellow' : 'green';

    var vramBar = document.querySelector('[data-bar="vram-' + g.index + '"]');
    var utilBar = document.querySelector('[data-bar="util-' + g.index + '"]');
    if (vramBar) updateBarFill(vramBar, vramPct, vramCls);
    if (utilBar) updateBarFill(utilBar, g.util, utilCls);

    // Update value text
    var fmtM = function(mib) { return mib >= 1024 ? (mib/1024).toFixed(1)+'G' : mib >= 10 ? mib.toFixed(1)+'M' : mib > 0 ? mib.toFixed(2)+'M' : '0M'; };
    var vramVal = document.querySelector('[data-val="vram-' + g.index + '"]');
    var utilVal = document.querySelector('[data-val="util-' + g.index + '"]');
    var tempVal = document.querySelector('[data-val="temp-' + g.index + '"]');
    var powerVal = document.querySelector('[data-val="power-' + g.index + '"]');
    var freeVal = document.querySelector('[data-val="free-' + g.index + '"]');

    setValText(vramVal, fmtM(g.memUsed) + ' / ' + fmtM(g.memTotal) + ' (' + Math.round(vramPct) + '%)');
    setValText(utilVal, g.util + '%');
    if (tempVal) setValText(tempVal, g.temp + '\\u00B0C');
    if (powerVal) setValText(powerVal, g.power.toFixed(0) + 'W');
    if (freeVal) setValText(freeVal, fmtM(g.memFree));
  }

  // Update meta info
  var meta = document.getElementById('metaInfo');
  if (meta) meta.textContent = msg.timestamp + ' \\u00B7 ' + (msg.processes||[]).length + ' procs \\u00B7 auto-refresh ' + msg.refreshIntervalSec + 's';

  // Update chart paths (smooth SVG transitions)
  var history = msg.history || [];
  if (history.length >= 2) {
    var gpuIndicesSet = {};
    for (var hi = 0; hi < history.length; hi++) {
      for (var gi = 0; gi < history[hi].gpus.length; gi++) {
        gpuIndicesSet[history[hi].gpus[gi].index] = true;
      }
    }
    for (var idx in gpuIndicesSet) {
      var points = [];
      for (var hi2 = 0; hi2 < history.length; hi2++) {
        var gp = null;
        for (var gi2 = 0; gi2 < history[hi2].gpus.length; gi2++) {
          if (history[hi2].gpus[gi2].index == idx) { gp = history[hi2].gpus[gi2]; break; }
        }
        if (gp) {
          points.push({
            vramPct: gp.memTotal > 0 ? (gp.memUsed / gp.memTotal) * 100 : 0,
            util: gp.util,
            temp: gp.temp
          });
        }
      }
      if (points.length < 2) continue;
      var w = 300, h2 = 60;
      var stepX = w / (points.length - 1);
      var makePath = function(getter) {
        return points.map(function(p, i) {
          return (i === 0 ? 'M' : 'L') + (i * stepX).toFixed(1) + ',' + (h2 - getter(p) / 100 * h2).toFixed(1);
        }).join(' ');
      };
      var vp = document.querySelector('[data-chart-path="vram-' + idx + '"]');
      var up = document.querySelector('[data-chart-path="util-' + idx + '"]');
      var tp = document.querySelector('[data-chart-path="temp-' + idx + '"]');
      if (vp) vp.setAttribute('d', makePath(function(p){return p.vramPct}));
      if (up) up.setAttribute('d', makePath(function(p){return p.util}));
      if (tp) tp.setAttribute('d', makePath(function(p){return Math.min(p.temp,100)}));
    }
  }

  // Update process groups and container summary HTML
  var pg = document.getElementById('processGroups');
  if (pg && msg.processGroupsHtml !== undefined) {
    pg.innerHTML = msg.processGroupsHtml;
    filterProcs();
  }
  var cs = document.getElementById('containerSummary');
  if (cs && msg.containerSummaryHtml !== undefined) cs.innerHTML = msg.containerSummaryHtml;
});

// Store initial data
var _lastData = ${initialData};
</script>
</body></html>`;
}
