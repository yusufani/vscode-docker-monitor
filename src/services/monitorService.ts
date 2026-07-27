import * as vscode from "vscode";
import * as os from "os";
import { SystemInfo, GpuData, ContainerFullInfo, ContainerInspect, MonitorData, DirUsage, K8sStatus } from "../types";
import { ISystemCollector, IGpuCollector, IContainerCollector } from "../collectors/interfaces";
import { computeDiskUsers } from "../collectors/diskUsage";
import { fmtMem } from "../utils/format";
import { log, logDebug } from "../utils/logger";

const DISK_USERS_TTL = 600_000; // 10 min — du is expensive, refresh slowly

export class MonitorService implements vscode.Disposable {
  private _onDataUpdated = new vscode.EventEmitter<MonitorData>();
  readonly onDataUpdated = this._onDataUpdated.event;

  private system: SystemInfo = { cpuPercent: 0, memUsedMib: 0, memTotalMib: 0, disks: [], hostProcesses: [], diskUsers: [] };
  private gpuData: GpuData = { gpus: [], processes: [], containerStats: new Map(), timestamp: 0, error: "" };
  private containers: ContainerFullInfo[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshing = false;
  private gpuEnabled: boolean;
  private wantRam = false; // set true while the RAM Manager section is expanded
  private wantCpu = false; // set true while the CPU Manager section is expanded
  private wantDisk = false; // set true while the Disk Manager section is expanded
  private diskUsers: DirUsage[] = [];
  private diskUsersTime = 0;
  private diskUsersComputing = false;
  private diskUsersCts?: vscode.CancellationTokenSource;
  private alertFired = new Set<number>(); // GPU indices that already fired alert
  private idleAlertFired = new Set<number>(); // GPU indices that fired idle alert
  private prevContainerIds = new Set<string>(); // for death detection
  private prevContainerNames = new Map<string, string>(); // id → name
  private prevContainerOwners = new Map<string, string>(); // id → ownerName
  private leakAlertFired = new Set<number>(); // GPU indices that fired leak alert
  private gpuHistory: Array<{ timestamp: number; gpus: Array<{ index: number; memUsed: number; memTotal: number; util: number; temp: number }> }> = [];

  constructor(
    private systemCollector: ISystemCollector,
    private gpuCollector: IGpuCollector,
    private dockerCollector: IContainerCollector,
    /** Optional — supplies the Kubernetes health shown in the sidebar. */
    private k8sCollector?: { getStatus(): K8sStatus },
  ) {
    this.gpuEnabled = vscode.workspace.getConfiguration("dockerMonitor").get<boolean>("gpuMonitoring", true);
  }

  getLatestData(): MonitorData {
    return {
      system: this.system,
      gpuData: this.gpuData,
      containers: this.containers,
      k8s: this.k8sCollector?.getStatus(),
    };
  }

  /** Kubernetes health (undefined when no Kubernetes collector was wired in). */
  getK8sStatus(): K8sStatus | undefined {
    return this.k8sCollector?.getStatus();
  }

  getSystem(): SystemInfo {
    return this.system;
  }

  getGpuData(): GpuData {
    return this.gpuData;
  }

  getContainers(): ContainerFullInfo[] {
    return this.containers;
  }

  async refresh(): Promise<void> {
    if (this.refreshing) {
      logDebug("Skipping refresh — previous cycle still running");
      return;
    }
    this.refreshing = true;
    try {
      try {
        // Container list first so we can attribute host processes to containers
        const containers = await this.dockerCollector.getAllRunningContainers();
        this.containers = containers;
        // getContainerNames returns cached data from getAllRunningContainers above — no extra docker ps call
        const containerNameMap = await this.dockerCollector.getContainerNames();
        // Pod index (k8s) — remaps container ids to their parent pod for attribution
        const podIndex = this.dockerCollector.getPodIndex ? await this.dockerCollector.getPodIndex() : undefined;
        // System info — RAM/disk breakdowns only collected while their sections are expanded
        this.system = await this.systemCollector.collect(containerNameMap, {
          ram: this.wantRam,
          cpu: this.wantCpu,
          disk: this.wantDisk,
        }, podIndex);
        // Attach the cached disk-user breakdown; (re)compute it in the background if needed
        this.system.diskUsers = this.diskUsers;
        this.maybeComputeDiskUsers();

        // GPU data — optional, graceful if missing
        if (this.gpuEnabled) {
          try {
            const [gpus, processes, containerStats] = await Promise.all([
              this.gpuCollector.collectGpus(),
              this.gpuCollector.collectProcesses(containerNameMap, podIndex),
              this.dockerCollector.getContainerStats(),
            ]);

            if (gpus.length > 0) {
              this.gpuData = {
                gpus,
                processes,
                containerStats,
                timestamp: Date.now(),
                error: "",
              };
            } else {
              this.gpuData = {
                gpus: [],
                processes: [],
                containerStats,
                timestamp: Date.now(),
                error: "",
              };
            }
          } catch (e) {
            log(`GPU collection failed: ${e}`);
            const containerStats = await this.dockerCollector.getContainerStats();
            this.gpuData = {
              gpus: [],
              processes: [],
              containerStats,
              timestamp: Date.now(),
              error: e instanceof Error ? e.message : String(e),
            };
          }
        } else {
          const containerStats = await this.dockerCollector.getContainerStats();
          this.gpuData = { gpus: [], processes: [], containerStats, timestamp: Date.now(), error: "" };
        }
      } catch (e) {
        log(`Monitor refresh error: ${e}`);
      }

      // Record GPU history for charts (keep last 60 data points)
      if (this.gpuData.gpus.length > 0) {
        this.gpuHistory.push({
          timestamp: Date.now(),
          gpus: this.gpuData.gpus.map((g) => ({ index: g.index, memUsed: g.memUsed, memTotal: g.memTotal, util: g.util, temp: g.temp })),
        });
        if (this.gpuHistory.length > 60) this.gpuHistory.shift();
      }

      // Alerts (pure logic on existing data — no extra commands)
      const notificationsEnabled = vscode.workspace.getConfiguration("dockerMonitor").get<boolean>("enableNotifications", false);
      if (notificationsEnabled) {
        this.checkVramAlerts();
        this.checkContainerDeaths();
        const idleEnabled = vscode.workspace.getConfiguration("dockerMonitor").get<boolean>("idleGpuDetection", true);
        const leakEnabled = vscode.workspace.getConfiguration("dockerMonitor").get<boolean>("leakDetection", true);
        if (idleEnabled) this.checkIdleGpus();
        if (leakEnabled) this.checkVramLeaks();
      } else {
        // Still track container state so notifications work immediately when enabled
        const currentIds = new Set(this.containers.map((c) => c.id));
        const currentNames = new Map<string, string>();
        const currentOwners = new Map<string, string>();
        for (const c of this.containers) {
          currentNames.set(c.id, c.name);
          currentOwners.set(c.id, c.ownerName);
        }
        this.prevContainerIds = currentIds;
        this.prevContainerNames = currentNames;
        this.prevContainerOwners = currentOwners;
      }

      this._onDataUpdated.fire(this.getLatestData());
    } finally {
      this.refreshing = false;
    }
  }

  startAutoRefresh(): void {
    const intervalSec = vscode.workspace.getConfiguration("dockerMonitor").get<number>("refreshInterval", 30);
    this.stopAutoRefresh();
    const loop = () => {
      this.refresh().finally(() => {
        if (this.refreshTimer !== undefined) {
          this.refreshTimer = setTimeout(loop, intervalSec * 1000);
        }
      });
    };
    this.refreshTimer = setTimeout(loop, 0); // start immediately
    log(`Auto-refresh started (${intervalSec}s interval)`);
  }

  stopAutoRefresh(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  async stopContainer(containerId: string): Promise<void> {
    await this.dockerCollector.stopContainer(containerId);
  }

  async killContainer(containerId: string): Promise<void> {
    await this.dockerCollector.killContainer(containerId);
  }

  async restartContainer(containerId: string): Promise<void> {
    await this.dockerCollector.restartContainer(containerId);
  }

  async killProcess(pid: number): Promise<void> {
    const { execCommand } = await import("../utils/exec");
    await execCommand(`kill -9 ${pid}`, { timeout: 5000 });
  }

  getGpuHistory(): typeof this.gpuHistory {
    return this.gpuHistory;
  }

  /** Toggle on-demand RAM collection (called when the RAM Manager section expands/collapses). */
  setRamWanted(wanted: boolean): void {
    if (wanted && !this.wantRam) {
      this.wantRam = true;
      this.refresh(); // fetch immediately so data appears on expand
    } else {
      this.wantRam = wanted;
    }
  }

  /** Toggle on-demand CPU collection (called when the CPU Manager section expands/collapses). */
  setCpuWanted(wanted: boolean): void {
    if (wanted && !this.wantCpu) {
      this.wantCpu = true;
      this.refresh();
    } else {
      this.wantCpu = wanted;
    }
  }

  /** Toggle on-demand disk-user collection (called when the Disk Manager section expands/collapses). */
  setDiskWanted(wanted: boolean): void {
    this.wantDisk = wanted;
    if (!wanted) {
      // Collapsing stops any in-flight du immediately
      this.diskUsersCts?.cancel();
      return;
    }
    // (Re)expanding recomputes if we have no fresh data yet
    if (this.diskUsers.length === 0 || Date.now() - this.diskUsersTime >= DISK_USERS_TTL) {
      this.diskUsersTime = 0; // force recompute on this expand
    }
    this.refresh();
  }

  /** True while a du pass is running (used by the sidebar to show "Calculating…"). */
  isDiskComputing(): boolean {
    return this.diskUsersComputing;
  }

  /** Kick off a cancellable, progress-reporting du pass when the Disk Manager is open and data is stale. */
  private maybeComputeDiskUsers(): void {
    if (!this.wantDisk || this.diskUsersComputing) return;
    if (Date.now() - this.diskUsersTime < DISK_USERS_TTL) return;
    const paths = vscode.workspace.getConfiguration("dockerMonitor").get<string[]>("diskUsagePaths", ["/home"]);
    if (paths.length === 0) return;

    this.diskUsersComputing = true;
    this.diskUsersTime = Date.now(); // start the TTL clock at launch so a cancel doesn't loop
    const cts = new vscode.CancellationTokenSource();
    this.diskUsersCts = cts;
    const mounts = this.system.disks;

    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        cancellable: true,
        title: "DevPulse: Calculating disk usage (du)…",
      },
      async (progress, token) => {
        const linked = token.onCancellationRequested(() => cts.cancel());
        try {
          const users = await computeDiskUsers(paths, mounts, cts.token, (msg) => progress.report({ message: msg }));
          if (!cts.token.isCancellationRequested) {
            this.diskUsers = users;
            this.diskUsersTime = Date.now();
            this.system.diskUsers = users;
            this._onDataUpdated.fire(this.getLatestData());
          }
        } catch (e) {
          log(`Disk usage computation failed: ${e}`);
        } finally {
          linked.dispose();
          this.diskUsersComputing = false;
          if (this.diskUsersCts === cts) this.diskUsersCts = undefined;
          // Refresh the tree so the "Calculating…" placeholder is replaced/cleared
          this._onDataUpdated.fire(this.getLatestData());
        }
      },
    );
  }

  private checkVramAlerts(): void {
    const threshold = vscode.workspace.getConfiguration("dockerMonitor").get<number>("vramAlertThreshold", 90);
    for (const gpu of this.gpuData.gpus) {
      const pct = gpu.memTotal > 0 ? Math.round((gpu.memUsed / gpu.memTotal) * 100) : 0;
      if (pct > threshold && !this.alertFired.has(gpu.index)) {
        this.alertFired.add(gpu.index);
        vscode.window.showWarningMessage(
          `GPU ${gpu.index} VRAM ${pct}% (${fmtMem(gpu.memUsed)}/${fmtMem(gpu.memTotal)})`,
          "Open Monitor",
        ).then((action) => {
          if (action === "Open Monitor") {
            vscode.commands.executeCommand("gpuMonitor.show");
          }
        });
      } else if (pct <= threshold - 10) {
        // Reset alert when usage drops significantly below threshold
        this.alertFired.delete(gpu.index);
      }
    }
  }

  /** Detect containers that disappeared since last refresh */
  private checkContainerDeaths(): void {
    const currentIds = new Set(this.containers.map((c) => c.id));
    // Build current name/owner maps
    const currentNames = new Map<string, string>();
    const currentOwners = new Map<string, string>();
    for (const c of this.containers) {
      currentNames.set(c.id, c.name);
      currentOwners.set(c.id, c.ownerName);
    }

    const onlyMine = vscode.workspace.getConfiguration("dockerMonitor").get<boolean>("notifyOnlyMyContainers", true);
    const currentUser = os.userInfo().username;

    if (this.prevContainerIds.size > 0) {
      const stoppedNames: string[] = [];
      for (const prevId of this.prevContainerIds) {
        if (!currentIds.has(prevId)) {
          if (onlyMine) {
            const owner = this.prevContainerOwners.get(prevId) || "?";
            if (owner !== currentUser && owner !== "?" && owner !== "root") continue;
          }
          stoppedNames.push(this.prevContainerNames.get(prevId) || prevId);
        }
      }
      if (stoppedNames.length === 1) {
        vscode.window.showWarningMessage(
          `Container stopped: ${stoppedNames[0]}`,
          "Open Monitor",
        ).then((action) => {
          if (action === "Open Monitor") vscode.commands.executeCommand("gpuMonitor.show");
        });
      } else if (stoppedNames.length > 1) {
        vscode.window.showWarningMessage(
          `${stoppedNames.length} containers stopped: ${stoppedNames.join(", ")}`,
          "Open Monitor",
        ).then((action) => {
          if (action === "Open Monitor") vscode.commands.executeCommand("gpuMonitor.show");
        });
      }
    }
    this.prevContainerIds = currentIds;
    this.prevContainerNames = currentNames;
    this.prevContainerOwners = currentOwners;
  }

  /** On-demand inspect — only called when user explicitly requests */
  async inspectContainer(containerId: string): Promise<ContainerInspect> {
    return this.dockerCollector.inspectContainer(containerId);
  }

  /** Detect GPUs with VRAM allocated but 0% utilization */
  private checkIdleGpus(): void {
    for (const gpu of this.gpuData.gpus) {
      const pct = gpu.memTotal > 0 ? (gpu.memUsed / gpu.memTotal) * 100 : 0;
      const hasVram = pct > 10; // at least 10% VRAM used
      const isIdle = gpu.util <= 2; // ~0% utilization

      if (hasVram && isIdle && !this.idleAlertFired.has(gpu.index)) {
        // Confirm idle by checking last 3 history points
        const recentHistory = this.gpuHistory.slice(-3);
        const consistentlyIdle = recentHistory.length >= 3 && recentHistory.every((h) => {
          const g = h.gpus.find((g) => g.index === gpu.index);
          return g ? g.util <= 2 : false;
        });
        if (consistentlyIdle) {
          this.idleAlertFired.add(gpu.index);
          // Find which containers are using this GPU
          const users = this.gpuData.processes
            .filter((p) => p.gpuIndex === gpu.index && p.containerName)
            .map((p) => p.containerName);
          const uniqueUsers = [...new Set(users)].slice(0, 3).join(", ");
          vscode.window.showInformationMessage(
            `GPU ${gpu.index} idle (${fmtMem(gpu.memUsed)} VRAM allocated, 0% util)${uniqueUsers ? ` — ${uniqueUsers}` : ""}`,
          );
        }
      } else if (!isIdle || !hasVram) {
        this.idleAlertFired.delete(gpu.index);
      }
    }
  }

  /** Detect monotonically increasing VRAM — possible memory leak */
  private checkVramLeaks(): void {
    if (this.gpuHistory.length < 10) return; // need enough samples
    const recent = this.gpuHistory.slice(-10);

    for (const gpu of this.gpuData.gpus) {
      if (this.leakAlertFired.has(gpu.index)) continue;
      const pct = gpu.memTotal > 0 ? (gpu.memUsed / gpu.memTotal) * 100 : 0;
      if (pct < 80) continue; // only care if already above 80%

      const vals = recent
        .map((h) => h.gpus.find((g) => g.index === gpu.index)?.memUsed)
        .filter((v): v is number => v !== undefined);
      if (vals.length < 10) continue;

      // Check monotonic increase: each sample >= previous
      let monotonic = true;
      for (let i = 1; i < vals.length; i++) {
        if (vals[i] < vals[i - 1]) { monotonic = false; break; }
      }
      // Must have meaningful growth (at least 5% increase over the window)
      const growth = vals[vals.length - 1] - vals[0];
      const growthPct = gpu.memTotal > 0 ? (growth / gpu.memTotal) * 100 : 0;

      if (monotonic && growthPct >= 10) {
        this.leakAlertFired.add(gpu.index);
        vscode.window.showWarningMessage(
          `GPU ${gpu.index}: VRAM growing steadily (+${fmtMem(growth)} in last ${recent.length} samples, now ${Math.round(pct)}%) — possible memory leak`,
          "Open Monitor",
        ).then((action) => {
          if (action === "Open Monitor") {
            vscode.commands.executeCommand("gpuMonitor.show");
          }
        });
      }
    }
  }

  dispose(): void {
    this.stopAutoRefresh();
    this._onDataUpdated.dispose();
  }
}
