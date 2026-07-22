import * as vscode from "vscode";
import { SystemInfo, GpuInfo, GpuProcess, ContainerStats, ContainerFullInfo, HostProcessInfo, DiskInfo, DirUsage } from "../types";
import { fmtMem, fmtUptime, fmtStartDate } from "../utils/format";

function fmtGib(gib: number): string {
  if (gib >= 1024) return `${(gib / 1024).toFixed(1)}T`;
  return `${gib.toFixed(gib >= 10 ? 0 : 1)}G`;
}

// ── User Color Palette ───────────────────────────────────────────

// Theme color IDs for tree item icons
const USER_THEME_COLORS = [
  "terminal.ansiCyan",
  "terminal.ansiMagenta",
  "terminal.ansiYellow",
  "terminal.ansiBlue",
  "terminal.ansiGreen",
  "terminal.ansiRed",
  "terminal.ansiWhite",
  "terminal.ansiBrightCyan",
  "terminal.ansiBrightMagenta",
  "terminal.ansiBrightYellow",
];

// Hex colors for HTML tooltips (matching the theme colors above)
const USER_HEX_COLORS = [
  "#00CCCC", // cyan
  "#CC00CC", // magenta
  "#CCCC00", // yellow
  "#5555FF", // blue
  "#00CC00", // green
  "#FF4444", // red
  "#CCCCCC", // white
  "#55FFFF", // bright cyan
  "#FF55FF", // bright magenta
  "#FFFF55", // bright yellow
];

const userColorIndex = new Map<string, number>();

function getUserIndex(username: string): number {
  if (!userColorIndex.has(username)) {
    userColorIndex.set(username, userColorIndex.size % USER_THEME_COLORS.length);
  }
  return userColorIndex.get(username)!;
}

export function getUserColor(username: string): string {
  return USER_THEME_COLORS[getUserIndex(username)];
}

export function getUserHexColor(username: string): string {
  return USER_HEX_COLORS[getUserIndex(username)];
}

export function tempColor(temp: number): string {
  if (temp > 85) return "errorForeground";
  if (temp > 75) return "editorWarning.foreground";
  if (temp > 60) return "terminal.ansiYellow";
  return "testing.iconPassed";
}

export function vramColor(pct: number): string {
  if (pct > 90) return "errorForeground";
  if (pct > 70) return "editorWarning.foreground";
  if (pct > 50) return "terminal.ansiYellow";
  return "testing.iconPassed";
}

// ── GPU Monitor Tree Items ────────────────────────────────────────

export type SidebarItem =
  | SystemItem
  | GpuItem
  | GpuDetailItem
  | VramMapItem
  | SectionItem
  | ContainerItem
  | ContainerInfoItem
  | ProcessItem
  | ProcessDetailItem
  | UserItem
  | GpuUserItem
  | RamManagerItem
  | RamMapItem
  | RamUserItem
  | RamContainerItem
  | RamProcessItem
  | CpuManagerItem
  | CpuMapItem
  | CpuUserItem
  | CpuContainerItem
  | CpuProcessItem
  | DiskManagerItem
  | DiskMountItem
  | DiskUserItem
  | PodManagerItem
  | PodNamespaceItem
  | PodItem
  | PodPortItem
  | InfoItem
  | OpenMonitorItem
  | ErrorItem;

export class SystemItem extends vscode.TreeItem {
  constructor(public readonly info: SystemInfo) {
    super("System", vscode.TreeItemCollapsibleState.None);
    const cpuBar = "\u2588".repeat(Math.round(info.cpuPercent / 10)) + "\u2591".repeat(10 - Math.round(info.cpuPercent / 10));
    const memPct = info.memTotalMib > 0 ? Math.round((info.memUsedMib / info.memTotalMib) * 100) : 0;
    const memBar = "\u2588".repeat(Math.round(memPct / 10)) + "\u2591".repeat(10 - Math.round(memPct / 10));
    this.description = `CPU ${cpuBar} ${info.cpuPercent}% · RAM ${memBar} ${memPct}%`;
    this.tooltip = `CPU: ${info.cpuPercent}%\nRAM: ${fmtMem(info.memUsedMib)} / ${fmtMem(info.memTotalMib)} (${memPct}%)`;
    const cpuColor =
      info.cpuPercent > 80
        ? "errorForeground"
        : info.cpuPercent > 50
          ? "editorWarning.foreground"
          : "testing.iconPassed";
    this.iconPath = new vscode.ThemeIcon("dashboard", new vscode.ThemeColor(cpuColor));
  }
}

export class GpuItem extends vscode.TreeItem {
  constructor(
    public readonly gpu: GpuInfo,
    history?: Array<{ timestamp: number; gpus: Array<{ index: number; memUsed: number; memTotal: number; util: number; temp: number }> }>,
  ) {
    const pct = gpu.memTotal > 0 ? Math.round((gpu.memUsed / gpu.memTotal) * 100) : 0;
    super(`GPU ${gpu.index}`, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${gpu.name} · ${gpu.util}% util · ${fmtMem(gpu.memUsed)}/${fmtMem(gpu.memTotal)} · ${gpu.temp}\u00B0C`;
    this.iconPath = new vscode.ThemeIcon("circuit-board", new vscode.ThemeColor(vramColor(pct)));

    const md = new vscode.MarkdownString("", true);
    md.supportHtml = true;
    md.isTrusted = true;

    // Build SVG sparklines from history data (no extra commands)
    let sparklineHtml = "";
    if (history && history.length >= 2) {
      const points = history.map((h) => h.gpus.find((g) => g.index === gpu.index)).filter(Boolean) as Array<{ memUsed: number; memTotal: number; util: number; temp: number }>;
      if (points.length >= 2) {
        const w = 200, h = 24;
        const stepX = w / (points.length - 1);
        const mkPath = (vals: number[], max: number, color: string) => {
          const d = vals.map((v, i) => `${i === 0 ? "M" : "L"}${(i * stepX).toFixed(1)},${(h - (Math.min(v, max) / max) * h).toFixed(1)}`).join(" ");
          return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5"/>`;
        };
        const vramPcts = points.map((p) => p.memTotal > 0 ? (p.memUsed / p.memTotal) * 100 : 0);
        const utils = points.map((p) => p.util);
        const temps = points.map((p) => p.temp);
        sparklineHtml = `<div style="margin:4px 0"><svg width="${w}" height="${h}" style="display:block">` +
          mkPath(vramPcts, 100, "#4ec9b0") +
          mkPath(utils, 100, "#dcdcaa") +
          mkPath(temps, 100, "#f44747") +
          `</svg><div style="font-size:10px;color:#888"><span style="color:#4ec9b0">\u2500 VRAM</span> <span style="color:#dcdcaa">\u2500 Util</span> <span style="color:#f44747">\u2500 Temp</span></div></div>`;
      }
    }

    md.value = `<div style="font-family:monospace"><strong>GPU ${gpu.index}: ${gpu.name}</strong><br>` +
      `VRAM: ${fmtMem(gpu.memUsed)} / ${fmtMem(gpu.memTotal)} (${pct}%)<br>` +
      `Temp: ${gpu.temp}\u00B0C · Power: ${gpu.power.toFixed(0)}W · Util: ${gpu.util}%` +
      sparklineHtml + `</div>`;
    this.tooltip = md;
  }
}

export class GpuDetailItem extends vscode.TreeItem {
  constructor(label: string, icon: string, color?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
  }
}

export interface VramSegment {
  username: string;
  vram: number;
}

export function buildVramTooltip(segments: VramSegment[], totalVram: number, freeMib: number): vscode.MarkdownString {
  const md = new vscode.MarkdownString("", true);
  md.supportHtml = true;
  md.isTrusted = true;

  const usedPct = totalVram > 0 ? Math.round(((totalVram - freeMib) / totalVram) * 100) : 0;
  const barPx = 260;
  let html = `<div style="font-family:monospace"><strong>VRAM ${fmtMem(totalVram - freeMib)} / ${fmtMem(totalVram)} (${usedPct}%)</strong>`;
  html += `<div style="display:flex;width:${barPx}px;height:16px;border:1px solid #666;border-radius:3px;overflow:hidden;margin:4px 0">`;
  for (const seg of segments) {
    const w = totalVram > 0 ? Math.max(2, Math.round((seg.vram / totalVram) * barPx)) : 0;
    html += `<div style="width:${w}px;height:100%;background:${getUserHexColor(seg.username)}"></div>`;
  }
  if (freeMib > 0) {
    html += `<div style="flex:1;height:100%;background:#333"></div>`;
  }
  html += `</div>`;
  for (const seg of segments) {
    const p = totalVram > 0 ? Math.round((seg.vram / totalVram) * 100) : 0;
    html += `<div><span style="color:${getUserHexColor(seg.username)}">\u25A0</span> ${seg.username} ${fmtMem(seg.vram)} (${p}%)</div>`;
  }
  if (freeMib > 0) {
    const p = totalVram > 0 ? Math.round((freeMib / totalVram) * 100) : 0;
    html += `<div><span style="color:#555">\u25A1</span> free ${fmtMem(freeMib)} (${p}%)</div>`;
  }
  html += `</div>`;
  md.value = html;
  return md;
}

export class VramMapItem extends vscode.TreeItem {
  constructor(segments: VramSegment[], totalVram: number, freeMib: number) {
    const barW = 15;
    const usedPct = totalVram > 0 ? Math.round(((totalVram - freeMib) / totalVram) * 100) : 0;
    const usedBlocks = Math.round((usedPct / 100) * barW);
    const bar = "\u2588".repeat(usedBlocks) + "\u2591".repeat(barW - usedBlocks);
    const legend = segments.map((s) => `${s.username}:${fmtMem(s.vram)}`).join(" ");
    super(`${bar}`, vscode.TreeItemCollapsibleState.None);
    this.description = `${usedPct}% ${legend}`;
    this.iconPath = new vscode.ThemeIcon("graph", new vscode.ThemeColor(vramColor(usedPct)));
    this.tooltip = buildVramTooltip(segments, totalVram, freeMib);
  }
}

export class SectionItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly sectionType: "containers" | "hostProcs",
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon(sectionType === "containers" ? "server-process" : "person");
  }
}

export class ContainerItem extends vscode.TreeItem {
  constructor(
    public readonly container: ContainerFullInfo,
    public readonly gpuVram: number,
    public readonly gpuIndices: number[],
    public readonly gpuProcCount: number,
    stats?: ContainerStats,
  ) {
    const isK8s = container.source === "k8s";
    // Health badge in label
    const healthBadge = container.health === "healthy" ? " \u2705"
      : container.health === "unhealthy" ? " \u274C"
      : container.health === "starting" ? " \u23F3"
      : "";
    // Kubernetes pods get a \u2638 prefix so they're distinguishable from docker containers
    const sourcePrefix = isK8s ? "\u2638 " : "";
    super(
      sourcePrefix + container.name + healthBadge,
      gpuProcCount > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    const parts: string[] = [];
    if (isK8s && container.namespace) parts.push(container.namespace);
    if (gpuVram > 0) parts.push(`VRAM ${fmtMem(gpuVram)}`);
    if (stats) {
      parts.push(`CPU ${stats.cpuPercent.toFixed(1)}%`);
      parts.push(`RAM ${fmtMem(stats.memUsedMib)}`);
    }
    if (gpuIndices.length > 0) parts.push(`GPU ${gpuIndices.join(",")}`);
    if (container.uptime) parts.push(container.uptime);
    this.description = parts.join(" · ") || "starting...";
    const hasGpu = gpuVram > 0;
    const iconColor = container.health === "unhealthy" ? "errorForeground"
      : hasGpu ? "terminal.ansiCyan"
      : isK8s ? "terminal.ansiBlue"
      : "terminal.ansiGreen";
    this.iconPath = new vscode.ThemeIcon("package", new vscode.ThemeColor(iconColor));
    this.contextValue = isK8s ? "k8sPod" : "gpuContainer";

    const tooltipParts = isK8s
      ? [`${container.namespace}/${container.name}`, `Namespace: ${container.ownerName}`]
      : [`${container.name}`, `Owner: ${container.ownerName}`];
    if (isK8s && container.node) tooltipParts.push(`Node: ${container.node}`);
    if (isK8s && container.podPhase) tooltipParts.push(`Phase: ${container.podPhase}`);
    if (isK8s && container.controllerKind) tooltipParts.push(`Controller: ${container.controllerKind}/${container.controllerName}`);
    if (container.composeProject) tooltipParts.push(`Compose: ${container.composeProject}`);
    if (container.health !== "none") tooltipParts.push(`Health: ${container.health}`);
    if (container.uptime) tooltipParts.push(`Uptime: ${container.uptime}`);
    tooltipParts.push(...parts.filter((p) => !p.includes(container.uptime)));
    this.tooltip = tooltipParts.join("\n");
  }
}

export class ContainerInfoItem extends vscode.TreeItem {
  constructor(label: string, icon: string = "info") {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

export class ProcessItem extends vscode.TreeItem {
  constructor(public readonly proc: GpuProcess) {
    super(proc.processName, vscode.TreeItemCollapsibleState.Collapsed);
    const parts = [`PID ${proc.pid}`, `VRAM ${fmtMem(proc.memMib)}`, `G${proc.gpuIndex}`];
    if (proc.gpuUtil > 0) parts.push(`SM ${proc.gpuUtil}%`);
    if (proc.ramMib > 0) parts.push(`RAM ${fmtMem(proc.ramMib)}`);
    const uptime = fmtUptime(proc.startTime);
    if (uptime) parts.push(uptime);
    const cwdFolder = proc.cwd && proc.cwd !== "?" ? proc.cwd.split("/").filter(Boolean).pop() : "";
    if (cwdFolder) parts.push(`📁 ${cwdFolder}`);
    // Show the owner inline so "who started it" is visible without hovering.
    const userTag = proc.username && proc.username !== "?" ? ` · 👤 ${proc.username}` : "";
    this.description = parts.join(" · ") + userTag;
    this.contextValue = "gpuProcess";
    // Where the process runs: a k8s pod ("ns/pod"), a docker container, or the host.
    const isK8s = proc.containerId.startsWith("k8s:");
    // Pod-backed processes get their own icon+color so they stand out from
    // plain docker/host processes at a glance (matches ContainerItem's k8s blue).
    this.iconPath = isK8s
      ? new vscode.ThemeIcon("server-process", new vscode.ThemeColor("terminal.ansiBlue"))
      : new vscode.ThemeIcon("symbol-method");
    const where = !proc.containerName || proc.containerName === "host"
      ? "host"
      : isK8s ? `Pod: ${proc.containerName}` : `Container: ${proc.containerName}`;
    const tooltipLines = [proc.processName, where, ...parts, `User: ${proc.username}`];
    const startDate = fmtStartDate(proc.startTime);
    if (startDate) tooltipLines.push(`Started: ${startDate}`);
    if (proc.cwd && proc.cwd !== "?") tooltipLines.push(`CWD: ${proc.cwd}`);
    if (proc.cmdline && proc.cmdline !== proc.processName) tooltipLines.push(`CMD: ${proc.cmdline}`);
    this.tooltip = tooltipLines.join("\n");
  }
}

export class ProcessDetailItem extends vscode.TreeItem {
  constructor(label: string, icon: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = "gpuProcessDetail";
  }
}

export class UserItem extends vscode.TreeItem {
  constructor(
    public readonly username: string,
    procCount: number,
    totalVram: number,
  ) {
    super(username, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${procCount} proc · VRAM ${fmtMem(totalVram)}`;
    this.iconPath = new vscode.ThemeIcon("person");
  }
}

export class GpuUserItem extends vscode.TreeItem {
  constructor(
    public readonly username: string,
    public readonly gpuIndex: number,
    procCount: number,
    totalVram: number,
  ) {
    super(username, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${procCount} proc · VRAM ${fmtMem(totalVram)}`;
    const color = getUserColor(username);
    this.iconPath = new vscode.ThemeIcon("person", new vscode.ThemeColor(color));
  }
}

// ── RAM Manager Tree Items ────────────────────────────────────────

/** Root "RAM Manager" section — host RAM usage, expands to per-user breakdown. */
export class RamManagerItem extends vscode.TreeItem {
  constructor(usedMib: number, totalMib: number, userCount: number) {
    super("RAM Manager", vscode.TreeItemCollapsibleState.Collapsed);
    this.id = "ramManager"; // stable id so expand state persists across refreshes
    const pct = totalMib > 0 ? Math.round((usedMib / totalMib) * 100) : 0;
    const users = userCount > 0 ? ` · ${userCount} users` : "";
    this.description = `${fmtMem(usedMib)}/${fmtMem(totalMib)} (${pct}%)${users}`;
    this.iconPath = new vscode.ThemeIcon("server-environment", new vscode.ThemeColor(vramColor(pct)));
    this.tooltip = `Host RAM: ${fmtMem(usedMib)} / ${fmtMem(totalMib)} (${pct}%)\nExpand to load per-user / per-process breakdown`;
  }
}

export interface UsageSegment {
  label: string;
  value: number;
}

function buildUsageTooltip(
  title: string,
  segments: UsageSegment[],
  total: number,
  fmt: (n: number) => string,
): vscode.MarkdownString {
  const md = new vscode.MarkdownString("", true);
  md.supportHtml = true;
  md.isTrusted = true;
  const used = segments.reduce((s, x) => s + x.value, 0);
  const usedPct = total > 0 ? Math.round((used / total) * 100) : 0;
  const barPx = 260;
  let html = `<div style="font-family:monospace"><strong>${title} ${fmt(used)} / ${fmt(total)} (${usedPct}%)</strong>`;
  html += `<div style="display:flex;width:${barPx}px;height:16px;border:1px solid #666;border-radius:3px;overflow:hidden;margin:4px 0">`;
  for (const seg of segments) {
    const w = total > 0 ? Math.max(2, Math.round((seg.value / total) * barPx)) : 0;
    html += `<div style="width:${w}px;height:100%;background:${getUserHexColor(seg.label)}"></div>`;
  }
  const free = Math.max(0, total - used);
  if (free > 0) html += `<div style="flex:1;height:100%;background:#333"></div>`;
  html += `</div>`;
  for (const seg of segments) {
    const p = total > 0 ? Math.round((seg.value / total) * 100) : 0;
    html += `<div><span style="color:${getUserHexColor(seg.label)}">■</span> ${seg.label} ${fmt(seg.value)} (${p}%)</div>`;
  }
  if (free > 0) {
    const p = total > 0 ? Math.round((free / total) * 100) : 0;
    html += `<div><span style="color:#555">□</span> free/other ${fmt(free)} (${p}%)</div>`;
  }
  html += `</div>`;
  md.value = html;
  return md;
}

/** Compact bar showing per-user RAM share of total memory. */
export class RamMapItem extends vscode.TreeItem {
  constructor(segments: UsageSegment[], totalMib: number) {
    const barW = 15;
    const used = segments.reduce((s, x) => s + x.value, 0);
    const usedPct = totalMib > 0 ? Math.round((used / totalMib) * 100) : 0;
    const usedBlocks = Math.min(barW, Math.round((usedPct / 100) * barW));
    const bar = "█".repeat(usedBlocks) + "░".repeat(barW - usedBlocks);
    super(bar, vscode.TreeItemCollapsibleState.None);
    const legend = segments.slice(0, 4).map((s) => `${s.label}:${fmtMem(s.value)}`).join(" ");
    this.description = `${usedPct}% ${legend}`;
    this.iconPath = new vscode.ThemeIcon("graph", new vscode.ThemeColor(vramColor(usedPct)));
    this.tooltip = buildUsageTooltip("RAM", segments, totalMib, fmtMem);
  }
}

/** A user grouping under RAM Manager — expands to their containers + host processes. */
export class RamUserItem extends vscode.TreeItem {
  constructor(
    public readonly username: string,
    public readonly procCount: number,
    public readonly rssMib: number,
  ) {
    super(username, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${fmtMem(rssMib)} · ${procCount} proc`;
    this.iconPath = new vscode.ThemeIcon("person", new vscode.ThemeColor(getUserColor(username)));
    this.tooltip = `${username}\nRAM: ${fmtMem(rssMib)}\nProcesses: ${procCount}`;
  }
}

/** A container grouping under a RAM user — expands to its processes. */
export class RamContainerItem extends vscode.TreeItem {
  constructor(
    public readonly containerId: string,
    public readonly containerName: string,
    public readonly procs: HostProcessInfo[],
  ) {
    super(containerName, vscode.TreeItemCollapsibleState.Collapsed);
    const rss = procs.reduce((s, p) => s + p.rssMib, 0);
    this.description = `${fmtMem(rss)} · ${procs.length} proc`;
    this.iconPath = new vscode.ThemeIcon("package", new vscode.ThemeColor("terminal.ansiCyan"));
    this.contextValue = "ramContainer";
    this.tooltip = `${containerName}\nRAM: ${fmtMem(rss)}\nProcesses: ${procs.length}`;
  }
}

/** A single host process under RAM Manager. */
export class RamProcessItem extends vscode.TreeItem {
  constructor(public readonly proc: HostProcessInfo) {
    super(proc.comm || `PID ${proc.pid}`, vscode.TreeItemCollapsibleState.None);
    const parts = [`PID ${proc.pid}`, `RAM ${fmtMem(proc.rssMib)}`];
    if (proc.containerName) parts.push(`📦 ${proc.containerName}`);
    this.description = parts.join(" · ");
    this.iconPath = new vscode.ThemeIcon("symbol-method");
    this.contextValue = "ramProcess";
    const lines = [proc.comm || `PID ${proc.pid}`, `PID: ${proc.pid}`, `RAM: ${fmtMem(proc.rssMib)}`, `User: ${proc.username}`];
    if (proc.containerName) lines.push(`Container: ${proc.containerName}`);
    this.tooltip = lines.join("\n");
  }
}

// ── CPU Manager Tree Items ────────────────────────────────────────

function fmtCpu(pct: number): string {
  return `${pct.toFixed(pct >= 10 ? 0 : 1)}%`;
}

/** Root "CPU Manager" section — host CPU usage, expands to per-user breakdown. */
export class CpuManagerItem extends vscode.TreeItem {
  constructor(cpuPercent: number, userCount: number) {
    super("CPU Manager", vscode.TreeItemCollapsibleState.Collapsed);
    this.id = "cpuManager"; // stable id so expand state persists across refreshes
    const users = userCount > 0 ? ` · ${userCount} users` : "";
    this.description = `${cpuPercent}%${users}`;
    const color = cpuPercent > 80 ? "errorForeground" : cpuPercent > 50 ? "editorWarning.foreground" : "testing.iconPassed";
    this.iconPath = new vscode.ThemeIcon("pulse", new vscode.ThemeColor(color));
    this.tooltip = `Host CPU: ${cpuPercent}%\nExpand to load per-user / per-process breakdown`;
  }
}

/** Compact bar showing per-user CPU share (relative to total cores × 100%). */
export class CpuMapItem extends vscode.TreeItem {
  constructor(segments: UsageSegment[], totalCapacity: number) {
    const barW = 15;
    const used = segments.reduce((s, x) => s + x.value, 0);
    const usedPct = totalCapacity > 0 ? Math.round((used / totalCapacity) * 100) : 0;
    const usedBlocks = Math.min(barW, Math.round((usedPct / 100) * barW));
    const bar = "█".repeat(usedBlocks) + "░".repeat(barW - usedBlocks);
    super(bar, vscode.TreeItemCollapsibleState.None);
    const legend = segments.slice(0, 4).map((s) => `${s.label}:${fmtCpu(s.value)}`).join(" ");
    this.description = `${usedPct}% ${legend}`;
    this.iconPath = new vscode.ThemeIcon("graph", new vscode.ThemeColor(vramColor(usedPct)));
    this.tooltip = buildUsageTooltip("CPU", segments, totalCapacity, fmtCpu);
  }
}

/** A user grouping under CPU Manager — expands to their containers + host processes. */
export class CpuUserItem extends vscode.TreeItem {
  constructor(
    public readonly username: string,
    public readonly procCount: number,
    public readonly cpuPercent: number,
  ) {
    super(username, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${fmtCpu(cpuPercent)} · ${procCount} proc`;
    this.iconPath = new vscode.ThemeIcon("person", new vscode.ThemeColor(getUserColor(username)));
    this.tooltip = `${username}\nCPU: ${fmtCpu(cpuPercent)}\nProcesses: ${procCount}`;
  }
}

/** A container grouping under a CPU user — expands to its processes. */
export class CpuContainerItem extends vscode.TreeItem {
  constructor(
    public readonly containerId: string,
    public readonly containerName: string,
    public readonly procs: HostProcessInfo[],
  ) {
    super(containerName, vscode.TreeItemCollapsibleState.Collapsed);
    const cpu = procs.reduce((s, p) => s + p.cpuPercent, 0);
    this.description = `${fmtCpu(cpu)} · ${procs.length} proc`;
    this.iconPath = new vscode.ThemeIcon("package", new vscode.ThemeColor("terminal.ansiCyan"));
    this.contextValue = "cpuContainer";
    this.tooltip = `${containerName}\nCPU: ${fmtCpu(cpu)}\nProcesses: ${procs.length}`;
  }
}

/** A single host process under CPU Manager. */
export class CpuProcessItem extends vscode.TreeItem {
  constructor(public readonly proc: HostProcessInfo) {
    super(proc.comm || `PID ${proc.pid}`, vscode.TreeItemCollapsibleState.None);
    const parts = [`PID ${proc.pid}`, `CPU ${fmtCpu(proc.cpuPercent)}`, `RAM ${fmtMem(proc.rssMib)}`];
    if (proc.containerName) parts.push(`📦 ${proc.containerName}`);
    this.description = parts.join(" · ");
    this.iconPath = new vscode.ThemeIcon("symbol-method");
    this.contextValue = "cpuProcess";
    const lines = [proc.comm || `PID ${proc.pid}`, `PID: ${proc.pid}`, `CPU: ${fmtCpu(proc.cpuPercent)}`, `RAM: ${fmtMem(proc.rssMib)}`, `User: ${proc.username}`];
    if (proc.containerName) lines.push(`Container: ${proc.containerName}`);
    this.tooltip = lines.join("\n");
  }
}

// ── Disk Manager Tree Items ───────────────────────────────────────

/** Root "Disk Manager" section — expands to per-mount items. */
export class DiskManagerItem extends vscode.TreeItem {
  constructor(mountCount: number) {
    super("Disk Manager", vscode.TreeItemCollapsibleState.Collapsed);
    this.id = "diskManager"; // stable id so expand state persists across refreshes
    this.description = `${mountCount} mounts`;
    this.iconPath = new vscode.ThemeIcon("database");
    this.tooltip = "Disk usage per mount and per user home folder\nExpand to load per-user breakdown (du runs in the background)";
  }
}

/** A plain informational / loading placeholder row. */
export class InfoItem extends vscode.TreeItem {
  constructor(label: string, icon = "info") {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

/** A single df mount under Disk Manager — expands to the user dirs that live on it. */
export class DiskMountItem extends vscode.TreeItem {
  constructor(
    public readonly disk: DiskInfo,
    public readonly users: DirUsage[],
  ) {
    super(disk.mount, users.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    const barW = 10;
    const blocks = Math.min(barW, Math.round((disk.usedPercent / 100) * barW));
    const bar = "█".repeat(blocks) + "░".repeat(barW - blocks);
    const warn = disk.usedPercent >= 90 ? " ⚠" : "";
    this.description = `${bar} ${fmtGib(disk.usedGib)}/${fmtGib(disk.totalGib)} (${disk.usedPercent}%)${warn}`;
    this.iconPath = new vscode.ThemeIcon("disc", new vscode.ThemeColor(vramColor(disk.usedPercent)));
    this.tooltip = `${disk.mount} (${disk.device})\nUsed: ${fmtGib(disk.usedGib)} / ${fmtGib(disk.totalGib)} (${disk.usedPercent}%)\nFree: ${fmtGib(disk.freeGib)}`;
  }
}

/** A user's directory size under a disk mount. */
export class DiskUserItem extends vscode.TreeItem {
  constructor(usage: DirUsage, mountUsedGib: number) {
    super(usage.name, vscode.TreeItemCollapsibleState.None);
    const share = mountUsedGib > 0 ? Math.round((usage.sizeGib / mountUsedGib) * 100) : 0;
    this.description = `${fmtGib(usage.sizeGib)}${share > 0 ? ` · ${share}% of used` : ""}`;
    this.iconPath = new vscode.ThemeIcon("folder", new vscode.ThemeColor(getUserColor(usage.name)));
    this.tooltip = `${usage.path}\nSize: ${fmtGib(usage.sizeGib)}`;
  }
}

// ── Pod Manager Tree Items (Kubernetes) ───────────────────────────

/** Root "Pod Manager" section — Kubernetes pods grouped by namespace. */
export class PodManagerItem extends vscode.TreeItem {
  constructor(podCount: number, nsCount: number) {
    super("Pod Manager", vscode.TreeItemCollapsibleState.Collapsed);
    this.id = "podManager"; // stable id so expand state persists across refreshes
    this.description = `${podCount} pod${podCount !== 1 ? "s" : ""} · ${nsCount} ns`;
    this.iconPath = new vscode.ThemeIcon("symbol-namespace", new vscode.ThemeColor("terminal.ansiBlue"));
    this.tooltip = "Kubernetes pods on this node\nExpand to start port-forwards, restart, view logs/exec";
  }
}

/** A namespace grouping under Pod Manager — expands to its pods. */
export class PodNamespaceItem extends vscode.TreeItem {
  constructor(
    public readonly namespace: string,
    podCount: number,
    /** How many pods in this namespace run GPU processes. */
    gpuPodCount = 0,
    /** Total VRAM (MiB) used across this namespace's pods. */
    gpuVram = 0,
  ) {
    super(namespace, vscode.TreeItemCollapsibleState.Collapsed);
    // Pod rows carry the "chip" icon, so the namespace line just needs the counts.
    const gpuPart = gpuPodCount > 0 ? ` · ${gpuPodCount} GPU · VRAM ${fmtMem(gpuVram)}` : "";
    this.description = `${podCount} pod${podCount !== 1 ? "s" : ""}${gpuPart}`;
    this.iconPath = new vscode.ThemeIcon("folder", new vscode.ThemeColor(getUserColor(namespace)));
    this.contextValue = "podNamespace";
    const tip = [`Namespace: ${namespace}`, `Pods: ${podCount}`];
    if (gpuPodCount > 0) tip.push(`GPU pods: ${gpuPodCount} · VRAM ${fmtMem(gpuVram)}`);
    this.tooltip = tip.join("\n");
  }
}

/** A single pod under Pod Manager — expands to its exposed ports (port-forward). */
export class PodItem extends vscode.TreeItem {
  constructor(
    public readonly container: ContainerFullInfo,
    stats?: ContainerStats,
    /** Total VRAM (MiB) used by this pod's GPU processes — 0 when the pod uses no GPU. */
    gpuVram = 0,
    /** How many GPU processes this pod owns. */
    gpuProcCount = 0,
    /** GPU indices this pod has processes on. */
    gpuIndices: number[] = [],
  ) {
    const hasGpu = gpuVram > 0 || gpuProcCount > 0;
    const healthBadge = container.health === "unhealthy" ? " ❌"
      : container.health === "starting" ? " ⏳"
      : "";
    const portList = container.ports ? container.ports.split(",").map((s) => s.trim()).filter(Boolean) : [];
    super(
      container.name + healthBadge,
      portList.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    const parts: string[] = [];
    if (container.podPhase) parts.push(container.podPhase);
    if (hasGpu) parts.push(`VRAM ${fmtMem(gpuVram)}`);
    if (stats) {
      parts.push(`CPU ${stats.cpuPercent.toFixed(1)}%`);
      parts.push(`RAM ${fmtMem(stats.memUsedMib)}`);
    }
    if (hasGpu && gpuIndices.length > 0) parts.push(`GPU ${gpuIndices.join(",")}`);
    if (portList.length > 0) parts.push(`:${portList.join(",")}`);
    if (container.uptime) parts.push(container.uptime);
    this.description = parts.join(" · ");
    // GPU pods get the "chip" codicon; plain pods keep "package".
    // Health/phase colors still win over the GPU tint so problems stay visible.
    const phaseColor = container.health === "unhealthy" ? "errorForeground"
      : container.podPhase === "Pending" ? "editorWarning.foreground"
      : hasGpu ? "terminal.ansiCyan"
      : "terminal.ansiBlue";
    this.iconPath = new vscode.ThemeIcon(hasGpu ? "chip" : "package", new vscode.ThemeColor(phaseColor));
    this.contextValue = "k8sPod"; // reuse the pod inline/context menus (restart, stop, logs, exec, describe)
    const tip = [`${container.namespace}/${container.name}`];
    if (container.node) tip.push(`Node: ${container.node}`);
    if (container.controllerKind) tip.push(`Controller: ${container.controllerKind}/${container.controllerName}`);
    if (hasGpu) {
      tip.push(`GPU: ${gpuProcCount} process${gpuProcCount !== 1 ? "es" : ""} · VRAM ${fmtMem(gpuVram)}${gpuIndices.length > 0 ? ` · GPU ${gpuIndices.join(", ")}` : ""}`);
    }
    if (portList.length > 0) tip.push(`Ports: ${portList.join(", ")}`);
    this.tooltip = tip.join("\n");
  }
}

/** A single exposed pod port — click to start a kubectl port-forward and open it. */
export class PodPortItem extends vscode.TreeItem {
  constructor(podId: string, podName: string, namespace: string, port: number) {
    super(`Port ${port}`, vscode.TreeItemCollapsibleState.None);
    this.description = "port-forward → open in browser";
    this.iconPath = new vscode.ThemeIcon("plug", new vscode.ThemeColor("terminal.ansiGreen"));
    this.contextValue = "podPort";
    this.tooltip = `kubectl port-forward ${port} (${namespace}/${podName})`;
    this.command = {
      command: "gpuMonitor.podPortForward",
      title: "Port Forward",
      arguments: [podId, port, podName, namespace],
    };
  }
}

export class OpenMonitorItem extends vscode.TreeItem {
  constructor() {
    super("Open Full GPU Monitor", vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("window");
    this.command = { command: "gpuMonitor.show", title: "Open GPU Monitor" };
  }
}

export class ErrorItem extends vscode.TreeItem {
  constructor(msg: string) {
    super(msg, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("warning");
  }
}

