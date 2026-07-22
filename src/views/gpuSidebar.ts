import * as vscode from "vscode";
import * as os from "os";
import { MonitorService } from "../services/monitorService";
import { GpuInfo, GpuProcess, ContainerStats, ContainerFullInfo, SystemInfo } from "../types";
import { fmtMem, fmtUptime, fmtStartDate } from "../utils/format";
import {
  SidebarItem,
  SystemItem,
  GpuItem,
  GpuDetailItem,
  VramMapItem,
  VramSegment,
  ContainerItem,
  ContainerInfoItem,
  ProcessItem,
  ProcessDetailItem,
  GpuUserItem,
  RamManagerItem,
  RamMapItem,
  RamUserItem,
  RamContainerItem,
  RamProcessItem,
  CpuManagerItem,
  CpuMapItem,
  CpuUserItem,
  CpuContainerItem,
  CpuProcessItem,
  UsageSegment,
  DiskManagerItem,
  DiskMountItem,
  DiskUserItem,
  PodManagerItem,
  PodNamespaceItem,
  PodItem,
  PodPortItem,
  InfoItem,
  OpenMonitorItem,
  ErrorItem,
  tempColor,
  vramColor,
} from "./treeItems";

export class GpuSidebarProvider implements vscode.TreeDataProvider<SidebarItem>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<SidebarItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private system: SystemInfo = { cpuPercent: 0, memUsedMib: 0, memTotalMib: 0, disks: [], hostProcesses: [], diskUsers: [] };
  private gpus: GpuInfo[] = [];
  private gpuProcesses: GpuProcess[] = [];
  private containers: ContainerFullInfo[] = [];
  private containerStats = new Map<string, ContainerStats>();
  private hasGpu = false;
  private gpuError = "";
  private gpuHistory: Array<{ timestamp: number; gpus: Array<{ index: number; memUsed: number; memTotal: number; util: number; temp: number }> }> = [];
  private subscription: vscode.Disposable;

  constructor(private monitor: MonitorService) {
    this.subscription = monitor.onDataUpdated((data) => {
      this.system = data.system;
      this.containers = data.containers;
      this.gpus = data.gpuData.gpus;
      this.gpuProcesses = data.gpuData.processes;
      this.containerStats = data.gpuData.containerStats;
      this.hasGpu = data.gpuData.gpus.length > 0;
      this.gpuError = data.gpuData.error || "";
      this.gpuHistory = monitor.getGpuHistory();
      this._onDidChangeTreeData.fire(undefined);
    });
  }

  getTreeItem(el: SidebarItem): vscode.TreeItem {
    return el;
  }

  getChildren(element?: SidebarItem): SidebarItem[] {
    if (!element) return this.getRootItems();
    if (element instanceof GpuItem) return this.getGpuChildren(element.gpu);
    if (element instanceof GpuUserItem) return this.getGpuUserChildren(element);
    if (element instanceof ContainerItem) return this.getContainerChildren(element);
    if (element instanceof ProcessItem) return this.getProcessChildren(element);
    if (element instanceof RamManagerItem) return this.getRamChildren();
    if (element instanceof RamUserItem) return this.getRamUserChildren(element);
    if (element instanceof RamContainerItem) return this.getRamContainerChildren(element);
    if (element instanceof CpuManagerItem) return this.getCpuChildren();
    if (element instanceof CpuUserItem) return this.getCpuUserChildren(element);
    if (element instanceof CpuContainerItem) return this.getCpuContainerChildren(element);
    if (element instanceof DiskManagerItem) return this.getDiskChildren();
    if (element instanceof DiskMountItem) return this.getDiskMountChildren(element);
    if (element instanceof PodManagerItem) return this.getPodManagerChildren();
    if (element instanceof PodNamespaceItem) return this.getPodNamespaceChildren(element);
    if (element instanceof PodItem) return this.getPodChildren(element);
    return [];
  }

  // ── Pod Manager (Kubernetes) ──────────────────────────────────

  /** Aggregate GPU usage per pod id, from the GPU processes attributed to pods. */
  private podGpuUsage(): Map<string, { vram: number; count: number; gpus: number[] }> {
    const byPod = new Map<string, { vram: number; count: number; gpus: number[] }>();
    for (const p of this.gpuProcesses) {
      if (!p.containerId.startsWith("k8s:")) continue;
      let e = byPod.get(p.containerId);
      if (!e) {
        e = { vram: 0, count: 0, gpus: [] };
        byPod.set(p.containerId, e);
      }
      e.vram += p.memMib;
      e.count++;
      if (p.gpuIndex >= 0 && !e.gpus.includes(p.gpuIndex)) e.gpus.push(p.gpuIndex);
    }
    for (const e of byPod.values()) e.gpus.sort((a, b) => a - b);
    return byPod;
  }

  private getPodManagerChildren(): SidebarItem[] {
    const pods = this.containers.filter((c) => c.source === "k8s");
    const gpuByPod = this.podGpuUsage();
    const byNs = new Map<string, { count: number; gpuPods: number; vram: number }>();
    for (const p of pods) {
      const ns = p.namespace || "default";
      let e = byNs.get(ns);
      if (!e) {
        e = { count: 0, gpuPods: 0, vram: 0 };
        byNs.set(ns, e);
      }
      e.count++;
      const g = gpuByPod.get(p.id);
      if (g) {
        e.gpuPods++;
        e.vram += g.vram;
      }
    }
    // GPU-bearing namespaces float to the top, then alphabetical.
    return [...byNs.entries()]
      .sort((a, b) => (b[1].vram - a[1].vram) || a[0].localeCompare(b[0]))
      .map(([ns, e]) => new PodNamespaceItem(ns, e.count, e.gpuPods, e.vram));
  }

  private getPodNamespaceChildren(el: PodNamespaceItem): SidebarItem[] {
    const gpuByPod = this.podGpuUsage();
    return this.containers
      .filter((c) => c.source === "k8s" && (c.namespace || "default") === el.namespace)
      // GPU pods first (heaviest VRAM on top), then the rest alphabetically.
      .sort((a, b) => {
        const av = gpuByPod.get(a.id)?.vram || 0;
        const bv = gpuByPod.get(b.id)?.vram || 0;
        return (bv - av) || a.name.localeCompare(b.name);
      })
      .map((c) => {
        const g = gpuByPod.get(c.id);
        return new PodItem(c, this.containerStats.get(c.id), g?.vram || 0, g?.count || 0, g?.gpus || []);
      });
  }

  private getPodChildren(el: PodItem): SidebarItem[] {
    const ports = el.container.ports ? el.container.ports.split(",").map((s) => s.trim()).filter(Boolean) : [];
    return ports.map((p) => new PodPortItem(el.container.id, el.container.name, el.container.namespace || "default", parseInt(p)));
  }

  private getRootItems(): SidebarItem[] {
    const items: SidebarItem[] = [];
    items.push(new SystemItem(this.system));

    const cfg = vscode.workspace.getConfiguration("dockerMonitor");
    if (cfg.get<boolean>("cpuManager", true)) {
      const userCount = new Set(this.system.hostProcesses.map((p) => p.username)).size;
      items.push(new CpuManagerItem(this.system.cpuPercent, userCount));
    }
    if (cfg.get<boolean>("ramManager", true)) {
      const userCount = new Set(this.system.hostProcesses.map((p) => p.username)).size;
      items.push(new RamManagerItem(this.system.memUsedMib, this.system.memTotalMib, userCount));
    }
    if (cfg.get<boolean>("diskManager", true) && this.system.disks.length > 0) {
      items.push(new DiskManagerItem(this.system.disks.length));
    }
    if (cfg.get<boolean>("podManager", true)) {
      const pods = this.containers.filter((c) => c.source === "k8s");
      if (pods.length > 0) {
        const nsCount = new Set(pods.map((p) => p.namespace || "default")).size;
        items.push(new PodManagerItem(pods.length, nsCount));
      }
    }

    if (this.gpuError && this.gpus.length === 0) {
      items.push(new ErrorItem("\u26A0 GPU error: " + this.gpuError));
    }
    // Multi-GPU summary line
    if (this.gpus.length > 1) {
      const totalUsed = this.gpus.reduce((s, g) => s + g.memUsed, 0);
      const totalMem = this.gpus.reduce((s, g) => s + g.memTotal, 0);
      const totalPct = totalMem > 0 ? Math.round((totalUsed / totalMem) * 100) : 0;
      items.push(new GpuDetailItem(
        `Total VRAM: ${fmtMem(totalUsed)}/${fmtMem(totalMem)} (${totalPct}%) · ${this.gpus.length} GPUs`,
        "server",
        vramColor(totalPct),
      ));
    }
    for (const gpu of this.gpus) items.push(new GpuItem(gpu, this.gpuHistory));
    if (this.hasGpu) items.push(new OpenMonitorItem());

    // Version footer — confirms which build is loaded
    const version = vscode.extensions.getExtension("ANISOFT.devpulse-monitor")?.packageJSON.version ?? "?";
    const versionItem = new InfoItem(`DevPulse v${version}`, "verified");
    versionItem.description = "";
    versionItem.tooltip = `DevPulse Monitor v${version}`;
    items.push(versionItem);
    return items;
  }

  private getGpuChildren(g: GpuInfo): SidebarItem[] {
    const items: SidebarItem[] = [];

    // Group processes on this GPU by user, sorted by total VRAM descending
    const procsOnGpu = this.gpuProcesses.filter((p) => p.gpuIndex === g.index);
    const byUser = new Map<string, { vram: number; count: number }>();
    for (const p of procsOnGpu) {
      let user = p.username || "unknown";
      if (p.containerId) {
        const c = this.containers.find((c) => c.id === p.containerId);
        if (c?.ownerName) user = c.ownerName;
      }
      if (!byUser.has(user)) byUser.set(user, { vram: 0, count: 0 });
      const entry = byUser.get(user)!;
      entry.vram += p.memMib;
      entry.count++;
    }
    const sortedUsers = [...byUser.entries()].sort((a, b) => b[1].vram - a[1].vram);

    // VRAM map bar (compact, hover for colored rectangle)
    const segments: VramSegment[] = sortedUsers.map(([user, info]) => ({ username: user, vram: info.vram }));
    items.push(new VramMapItem(segments, g.memTotal, g.memFree));

    // Compact info line: temp + power + util
    items.push(new GpuDetailItem(
      `${g.temp}\u00B0C · ${g.power.toFixed(0)}W · ${g.util}% util`,
      "flame",
      tempColor(g.temp),
    ));

    // User items (expandable with their containers/processes)
    for (const [user, info] of sortedUsers) {
      items.push(new GpuUserItem(user, g.index, info.count, info.vram));
    }

    return items;
  }

  private getGpuUserChildren(el: GpuUserItem): SidebarItem[] {
    const procsOnGpu = this.gpuProcesses.filter((p) => p.gpuIndex === el.gpuIndex);
    const items: SidebarItem[] = [];
    const seen = new Set<number>();

    // Container processes: group by container
    const containerVram = new Map<string, number>();
    for (const p of procsOnGpu) {
      if (!p.containerId) continue;
      const c = this.containers.find((c) => c.id === p.containerId);
      const owner = c?.ownerName || p.username || "unknown";
      if (owner !== el.username) continue;
      containerVram.set(p.containerId, (containerVram.get(p.containerId) || 0) + p.memMib);
    }
    // Sort containers by VRAM descending
    const sortedContainers = [...containerVram.entries()].sort((a, b) => b[1] - a[1]);
    for (const [cid] of sortedContainers) {
      const c = this.containers.find((c) => c.id === cid);
      if (!c) continue;
      const cProcs = procsOnGpu.filter((p) => p.containerId === cid);
      const vram = cProcs.reduce((s, p) => s + p.memMib, 0);
      const stats = this.containerStats.get(cid);
      items.push(new ContainerItem(c, vram, [el.gpuIndex], cProcs.length, stats));
      for (const p of cProcs) seen.add(p.pid);
    }

    // Host processes (non-container) for this user on this GPU
    const hostProcs = procsOnGpu.filter(
      (p) => !p.containerId && (p.username || "unknown") === el.username,
    );
    for (const p of hostProcs) {
      if (seen.has(p.pid)) continue;
      seen.add(p.pid);
      items.push(new ProcessItem(p));
    }

    return items;
  }

  private getContainerChildren(el: ContainerItem): SidebarItem[] {
    const items: SidebarItem[] = [];
    if (el.container.image) {
      items.push(new ContainerInfoItem(`Image: ${el.container.image}`, "symbol-package"));
    }
    items.push(new ContainerInfoItem(`Owner: ${el.container.ownerName}`, "person"));
    if (el.gpuIndices.length > 0) {
      items.push(new ContainerInfoItem(`GPU: ${el.gpuIndices.join(", ")}`, "pulse"));
    }
    const stats = this.containerStats.get(el.container.id);
    if (stats) {
      const ramWarn = stats.memLimitMib > 0 && (stats.memUsedMib / stats.memLimitMib) * 100 > 85 ? " \u26A0" : "";
      items.push(
        new ContainerInfoItem(
          `CPU: ${stats.cpuPercent.toFixed(1)}% · RAM: ${fmtMem(stats.memUsedMib)}/${fmtMem(stats.memLimitMib)}${ramWarn}`,
          "dashboard",
        ),
      );
      if (stats.netIO) items.push(new ContainerInfoItem(`Net: ${stats.netIO}`, "cloud"));
      if (stats.blockIO) items.push(new ContainerInfoItem(`Disk: ${stats.blockIO}`, "database"));
    }
    if (el.container.ports) {
      items.push(new ContainerInfoItem(`Ports: ${el.container.ports}`, "plug"));
    }
    const procs = this.gpuProcesses.filter((p) => p.containerId === el.container.id);
    const seen = new Set<number>();
    for (const p of procs) {
      if (seen.has(p.pid)) continue;
      seen.add(p.pid);
      items.push(new ProcessItem(p));
    }
    return items;
  }

  private getProcessChildren(el: ProcessItem): SidebarItem[] {
    const p = el.proc;
    const items: SidebarItem[] = [];
    if (p.cmdline && p.cmdline !== p.processName) {
      items.push(new ProcessDetailItem(p.cmdline, "terminal"));
    }
    if (p.cwd && p.cwd !== "?") {
      items.push(new ProcessDetailItem(p.cwd, "folder"));
    }
    const startDate = fmtStartDate(p.startTime);
    const uptime = fmtUptime(p.startTime);
    if (startDate) {
      const timeLabel = uptime ? `${startDate} (${uptime})` : startDate;
      items.push(new ProcessDetailItem(timeLabel, "clock"));
    }
    return items;
  }

  // ── RAM Manager ──────────────────────────────────────────────────

  private getRamChildren(): SidebarItem[] {
    const items: SidebarItem[] = [];
    const byUser = new Map<string, { rss: number; count: number }>();
    for (const p of this.system.hostProcesses) {
      const u = p.username || "unknown";
      const e = byUser.get(u) || { rss: 0, count: 0 };
      e.rss += p.rssMib;
      e.count++;
      byUser.set(u, e);
    }
    const sorted = [...byUser.entries()].sort((a, b) => b[1].rss - a[1].rss);

    if (sorted.length === 0) {
      items.push(new InfoItem("Loading…", "loading~spin"));
      return items;
    }

    const segments: UsageSegment[] = sorted.slice(0, 10).map(([label, info]) => ({ label, value: info.rss }));
    items.push(new RamMapItem(segments, this.system.memTotalMib));

    for (const [user, info] of sorted.slice(0, 20)) {
      items.push(new RamUserItem(user, info.count, info.rss));
    }
    return items;
  }

  private getRamUserChildren(el: RamUserItem): SidebarItem[] {
    const items: SidebarItem[] = [];
    const procs = this.system.hostProcesses.filter((p) => (p.username || "unknown") === el.username);

    // Container groups first, sorted by total RSS
    const byContainer = new Map<string, typeof procs>();
    for (const p of procs) {
      if (!p.containerId) continue;
      const arr = byContainer.get(p.containerId) || [];
      arr.push(p);
      byContainer.set(p.containerId, arr);
    }
    const sortedContainers = [...byContainer.entries()].sort(
      (a, b) => b[1].reduce((s, p) => s + p.rssMib, 0) - a[1].reduce((s, p) => s + p.rssMib, 0),
    );
    for (const [cid, cprocs] of sortedContainers) {
      items.push(new RamContainerItem(cid, cprocs[0].containerName || cid, cprocs));
    }

    // Host (non-container) processes, top 15 by RSS
    const hostProcs = procs.filter((p) => !p.containerId).sort((a, b) => b.rssMib - a.rssMib);
    for (const p of hostProcs.slice(0, 15)) {
      items.push(new RamProcessItem(p));
    }
    return items;
  }

  private getRamContainerChildren(el: RamContainerItem): SidebarItem[] {
    return el.procs
      .slice()
      .sort((a, b) => b.rssMib - a.rssMib)
      .slice(0, 15)
      .map((p) => new RamProcessItem(p));
  }

  // ── CPU Manager ──────────────────────────────────────────────────

  private getCpuChildren(): SidebarItem[] {
    const items: SidebarItem[] = [];
    const byUser = new Map<string, { cpu: number; count: number }>();
    for (const p of this.system.hostProcesses) {
      const u = p.username || "unknown";
      const e = byUser.get(u) || { cpu: 0, count: 0 };
      e.cpu += p.cpuPercent;
      e.count++;
      byUser.set(u, e);
    }
    // Only users with meaningful CPU, sorted desc
    const sorted = [...byUser.entries()].filter(([, i]) => i.cpu >= 0.1).sort((a, b) => b[1].cpu - a[1].cpu);

    if (this.system.hostProcesses.length === 0) {
      items.push(new InfoItem("Loading…", "loading~spin"));
      return items;
    }
    if (sorted.length === 0) {
      items.push(new InfoItem("No significant CPU usage", "check"));
      return items;
    }

    const capacity = os.cpus().length * 100;
    const segments: UsageSegment[] = sorted.slice(0, 10).map(([label, info]) => ({ label, value: info.cpu }));
    items.push(new CpuMapItem(segments, capacity));

    for (const [user, info] of sorted.slice(0, 20)) {
      items.push(new CpuUserItem(user, info.count, info.cpu));
    }
    return items;
  }

  private getCpuUserChildren(el: CpuUserItem): SidebarItem[] {
    const items: SidebarItem[] = [];
    const procs = this.system.hostProcesses.filter((p) => (p.username || "unknown") === el.username);

    const byContainer = new Map<string, typeof procs>();
    for (const p of procs) {
      if (!p.containerId) continue;
      const arr = byContainer.get(p.containerId) || [];
      arr.push(p);
      byContainer.set(p.containerId, arr);
    }
    const sortedContainers = [...byContainer.entries()].sort(
      (a, b) => b[1].reduce((s, p) => s + p.cpuPercent, 0) - a[1].reduce((s, p) => s + p.cpuPercent, 0),
    );
    for (const [cid, cprocs] of sortedContainers) {
      items.push(new CpuContainerItem(cid, cprocs[0].containerName || cid, cprocs));
    }

    const hostProcs = procs.filter((p) => !p.containerId).sort((a, b) => b.cpuPercent - a.cpuPercent);
    for (const p of hostProcs.slice(0, 15)) {
      items.push(new CpuProcessItem(p));
    }
    return items;
  }

  private getCpuContainerChildren(el: CpuContainerItem): SidebarItem[] {
    return el.procs
      .slice()
      .sort((a, b) => b.cpuPercent - a.cpuPercent)
      .slice(0, 15)
      .map((p) => new CpuProcessItem(p));
  }

  // ── Disk Manager ─────────────────────────────────────────────────

  private getDiskChildren(): SidebarItem[] {
    const items: SidebarItem[] = [];
    if (this.system.diskUsers.length === 0) {
      if (this.monitor.isDiskComputing()) {
        items.push(new InfoItem("Calculating disk usage… (cancel from the notification)", "loading~spin"));
      } else {
        items.push(new InfoItem("No per-user data — collapse & re-expand to recalculate", "info"));
      }
    }
    for (const d of this.system.disks) {
      const users = this.system.diskUsers
        .filter((u) => u.mount === d.mount)
        .sort((a, b) => b.sizeGib - a.sizeGib);
      items.push(new DiskMountItem(d, users));
    }
    return items;
  }

  private getDiskMountChildren(el: DiskMountItem): SidebarItem[] {
    return el.users.map((u) => new DiskUserItem(u, el.disk.usedGib));
  }

  dispose(): void {
    this.subscription.dispose();
    this._onDidChangeTreeData.dispose();
  }
}
