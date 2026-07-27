export interface DiskInfo {
  mount: string;
  device: string;
  totalGib: number;
  usedGib: number;
  freeGib: number;
  usedPercent: number;
}

/** A host process with its RAM (RSS) usage, optionally attributed to a container. */
export interface HostProcessInfo {
  pid: number;
  uid: number;
  username: string;
  /** Resident set size in MiB */
  rssMib: number;
  /** CPU usage % (ps %cpu — average over the process lifetime; can exceed 100 on multi-core) */
  cpuPercent: number;
  /** Process command name (comm) */
  comm: string;
  /** Container short id ("" if running on the host) */
  containerId: string;
  /** Container name ("" if running on the host) */
  containerName: string;
}

/** Disk usage of a single directory (e.g. a user's home folder). */
export interface DirUsage {
  /** Full path, e.g. /home/yani */
  path: string;
  /** Last path component, e.g. yani */
  name: string;
  sizeGib: number;
  /** The df mount this directory lives on */
  mount: string;
}

export interface SystemInfo {
  cpuPercent: number;
  memUsedMib: number;
  memTotalMib: number;
  disks: DiskInfo[];
  /** Per-process RAM usage (sorted by RSS desc). Empty if unavailable. */
  hostProcesses: HostProcessInfo[];
  /** Per-directory disk usage (e.g. home folders). Empty until first du completes. */
  diskUsers: DirUsage[];
}

export interface GpuInfo {
  index: number;
  name: string;
  vendor: "nvidia" | "amd" | "apple" | "unknown";
  memUsed: number;
  memTotal: number;
  memFree: number;
  util: number;
  temp: number;
  power: number;
}

export interface GpuProcess {
  pid: number;
  gpuIndex: number;
  memMib: number;
  processName: string;
  containerId: string;
  containerName: string;
  cmdline: string;
  cwd: string;
  cpuPercent: number;
  /** Per-process GPU SM utilization % from nvidia-smi pmon (0 = idle/unknown) */
  gpuUtil: number;
  ramMib: number;
  uid: number;
  username: string;
  /** Process start time as epoch milliseconds (0 = unknown) */
  startTime: number;
}

export interface ContainerStats {
  cpuPercent: number;
  memUsedMib: number;
  memLimitMib: number;
  memPercent: number;
  netIO: string;
  blockIO: string;
}

export interface ContainerInspect {
  env: string[];
  mounts: Array<{ source: string; destination: string; mode: string }>;
}

export interface ContainerFullInfo {
  id: string;
  name: string;
  mainPid: number;
  ownerUid: number;
  ownerName: string;
  health: "healthy" | "unhealthy" | "starting" | "none";
  composeProject: string;
  uptime: string;
  image: string;
  ports: string;
  /** Which runtime this row comes from. Defaults to "docker" for backward compatibility. */
  source?: "docker" | "k8s";
  // ── Kubernetes-only fields (undefined for docker rows) ──
  /** Pod namespace */
  namespace?: string;
  /** Node the pod is scheduled on (spec.nodeName) */
  node?: string;
  /** Owning controller kind: Deployment | DaemonSet | StatefulSet | ReplicaSet | Job | "" (bare pod) */
  controllerKind?: string;
  /** Owning controller name (used for `kubectl rollout restart` / `scale`) */
  controllerName?: string;
  /** Pod phase: Running | Pending | Succeeded | Failed | Unknown */
  podPhase?: string;
}

export interface GpuData {
  gpus: GpuInfo[];
  processes: GpuProcess[];
  containerStats: Map<string, ContainerStats>;
  timestamp: number;
  error: string;
}

/** Signals that this machine is set up to talk to a Kubernetes cluster. */
export interface K8sFootprint {
  /** Absolute path to kubectl, or null when it is not on the extension host's PATH. */
  kubectlPath: string | null;
  /** First readable kubeconfig ($KUBECONFIG entry or ~/.kube/config), or null. */
  kubeconfig: string | null;
  /** True when a ServiceAccount token is mounted (extension host runs in a pod). */
  inCluster: boolean;
  /** True when any of the above is present — gates every Kubernetes warning in the UI. */
  any: boolean;
}

export type K8sState =
  | "ok" // pods are being listed
  | "disabled" // turned off via settings
  | "no-kubectl" // binary not found
  | "unreachable" // kubectl found but `cluster-info` failed
  | "list-failed" // cluster reachable but `get pods -A` failed (RBAC?)
  | "node-scope-empty" // cluster returned pods, 'node' scope filtered them all out
  | "no-pods"; // cluster reachable and genuinely empty

/** Why Kubernetes pods are (or are not) showing up — surfaced in the sidebar. */
export interface K8sStatus {
  state: K8sState;
  /** Raw stderr/message from the last failing command, for the diagnostics report. */
  detail?: string;
  /** Effective scope setting at the time of the probe. */
  scope: "node" | "cluster";
  /** Effective namespace allow-list at the time of the probe. */
  namespaces: string[];
  footprint: K8sFootprint;
}

export interface MonitorData {
  system: SystemInfo;
  gpuData: GpuData;
  containers: ContainerFullInfo[];
  /** Kubernetes health, undefined until the first probe completes. */
  k8s?: K8sStatus;
}

