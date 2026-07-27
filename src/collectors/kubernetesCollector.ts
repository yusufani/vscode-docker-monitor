import { readdirSync } from "fs";
import * as os from "os";
import { IContainerCollector, PodIndex } from "./interfaces";
import { ContainerStats, ContainerFullInfo, ContainerInspect, K8sFootprint, K8sState, K8sStatus } from "../types";
import { probeFootprint } from "./kubernetesDiagnostics";
import { clearBinaryCache, execCommand } from "../utils/exec";
import { fmtUptime } from "../utils/format";
import { log, logDebug } from "../utils/logger";

const POD_LIST_CACHE_TTL = 8_000; // pod list 8s cache (matches docker list TTL)
const STATS_CACHE_TTL = 25_000; // kubectl top 25s cache
const AVAIL_CACHE_TTL = 60_000; // cluster reachability probe cached 60s

const KUBEPODS_CGROUP = "/sys/fs/cgroup/kubepods.slice";

export interface KubernetesOptions {
  /** Master switch (dockerMonitor.kubernetes.enabled). When false the collector reports "disabled". */
  enabled: boolean;
  /** "node" (default) shows only pods with a container on this host; "cluster" shows all pods. */
  scope: "node" | "cluster";
  /** Namespace allow-list. Empty = all namespaces. */
  namespaces: string[];
  /** Custom kubectl binary path (empty = auto-detect). */
  kubectlBinary: string;
}

/** Parse a Kubernetes CPU quantity (e.g. "250m", "1", "500000000n") to fractional cores. */
function parseCpuToCores(s: string): number {
  s = s.trim();
  if (!s) return 0;
  if (s.endsWith("m")) return (parseFloat(s) || 0) / 1000;
  if (s.endsWith("u")) return (parseFloat(s) || 0) / 1e6;
  if (s.endsWith("n")) return (parseFloat(s) || 0) / 1e9;
  return parseFloat(s) || 0;
}

/** Parse a Kubernetes memory quantity (e.g. "512Mi", "1Gi", "134217728") to MiB. */
function parseMemToMib(s: string): number {
  s = s.trim();
  if (!s) return 0;
  if (s.endsWith("Ki")) return (parseFloat(s) || 0) / 1024;
  if (s.endsWith("Mi")) return parseFloat(s) || 0;
  if (s.endsWith("Gi")) return (parseFloat(s) || 0) * 1024;
  if (s.endsWith("Ti")) return (parseFloat(s) || 0) * 1024 * 1024;
  // decimal SI suffixes (limits sometimes use these) or plain bytes
  if (s.endsWith("M")) return (parseFloat(s) || 0) * 1000 * 1000 / (1024 * 1024);
  if (s.endsWith("G")) return (parseFloat(s) || 0) * 1000 * 1000 * 1000 / (1024 * 1024);
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n / (1024 * 1024);
}

/** Best-effort one-line error text (exec errors carry stderr worth showing in diagnostics). */
function errText(e: unknown): string {
  const err = e as { stderr?: string; message?: string };
  const s = (err?.stderr || err?.message || String(e)).trim();
  return s.length > 800 ? s.slice(0, 800) + "…" : s;
}

/** Strip the trailing ReplicaSet hash to get the owning Deployment name (foo-5595474b89 -> foo). */
function deploymentNameFromReplicaSet(rsName: string): string {
  return rsName.replace(/-[a-z0-9]{6,10}$/i, "");
}

interface K8sPodSpec {
  metadata: { namespace: string; name: string; ownerReferences?: Array<{ kind: string; name: string; controller?: boolean }> };
  spec: {
    nodeName?: string;
    containers: Array<{
      image?: string;
      resources?: { limits?: { memory?: string } };
      ports?: Array<{ containerPort: number; protocol?: string; name?: string }>;
    }>;
  };
  status: {
    phase?: string;
    startTime?: string;
    conditions?: Array<{ type: string; status: string }>;
    containerStatuses?: Array<{ containerID?: string }>;
  };
}

export class KubernetesCollector implements IContainerCollector {
  private kubectlPath: string | null = null;
  private available: boolean | null = null;
  private lastAvailTime = 0;

  // Pod list cache
  private lastPodList: ContainerFullInfo[] = [];
  private lastPodListTime = 0;
  // pod id -> full info (for action dispatch: controller kind/name/namespace)
  private podById = new Map<string, ContainerFullInfo>();
  // container short id -> pod ref (for GPU/host process attribution)
  private podIndex: PodIndex = new Map();
  // pod id -> memory limit in MiB (joined into stats)
  private podMemLimitMib = new Map<string, number>();

  // Stats cache
  private cachedStats = new Map<string, ContainerStats>();
  private lastStatsTime = 0;

  // Logged-once flag: node-scope requested but local cgroup is unreadable
  // (typical when the extension host itself runs inside a container).
  private warnedNodeScopeUnavailable = false;

  // Why pods are (or are not) visible — consumed by the sidebar warning row.
  private state: K8sState = "disabled";
  private detail = "";
  private footprint: K8sFootprint = { kubectlPath: null, kubeconfig: null, inCluster: false, any: false };

  constructor(private readonly opts: KubernetesOptions) {}

  private get kubectl(): string {
    return this.opts.kubectlBinary || this.kubectlPath || "kubectl";
  }

  /** Current health, safe to call on every refresh (served from the probe cache). */
  getStatus(): K8sStatus {
    return {
      state: this.state,
      detail: this.detail || undefined,
      scope: this.opts.scope,
      namespaces: this.opts.namespaces,
      podCount: this.lastPodList.length,
      footprint: this.footprint,
    };
  }

  /**
   * Re-probe from scratch and report the outcome. Backs the manual "Check Kubernetes"
   * command, where the user has usually just installed kubectl or fixed a kubeconfig and
   * expects an answer about *now* — so every cache, including the `which kubectl` lookup,
   * is dropped first.
   */
  async refreshStatus(): Promise<K8sStatus> {
    clearBinaryCache();
    this.available = null;
    this.lastAvailTime = 0;
    this.lastPodList = [];
    this.lastPodListTime = 0;
    if (await this.isAvailable()) await this.getAllRunningContainers();
    return this.getStatus();
  }

  async isAvailable(): Promise<boolean> {
    if (this.available !== null && Date.now() - this.lastAvailTime < AVAIL_CACHE_TTL) {
      return this.available;
    }
    // Refreshed alongside the reachability probe so the diagnostics report always
    // reflects the environment as the extension host actually sees it.
    this.footprint = await probeFootprint();

    if (!this.opts.enabled) {
      this.state = "disabled";
      this.detail = "";
      this.available = false;
      this.lastAvailTime = Date.now();
      return false;
    }

    this.kubectlPath = this.opts.kubectlBinary || this.footprint.kubectlPath;
    if (!this.kubectlPath) {
      this.state = "no-kubectl";
      this.detail = "";
      this.available = false;
      this.lastAvailTime = Date.now();
      return false;
    }
    // Probe cluster reachability cheaply; if the API server is unreachable we
    // disable the source rather than blocking every refresh on timeouts.
    try {
      await execCommand(`${this.kubectl} cluster-info --request-timeout=4s`, { timeout: 6000 });
      this.available = true;
      if (this.state === "no-kubectl" || this.state === "unreachable" || this.state === "disabled") {
        this.state = "ok"; // refined by getAllRunningContainers()
        this.detail = "";
      }
    } catch (e) {
      logDebug(`[k8s] cluster unreachable: ${e}`);
      this.state = "unreachable";
      this.detail = errText(e);
      this.available = false;
    }
    this.lastAvailTime = Date.now();
    return this.available;
  }

  /**
   * Read the set of container short ids that have a cgroup on THIS host (node scoping).
   * Returns `null` when the kubepods cgroup root is unreadable — this happens when the
   * extension host runs inside a container with its own (private) cgroup namespace, where
   * the host's pod cgroups are simply not visible. In that case node-scoping is impossible
   * and the caller must fall back to showing all pods instead of filtering everything out.
   * An empty (non-null) Set means the root was readable but no local pod containers exist.
   */
  private collectLocalContainerIds(): Set<string> | null {
    let rootEntries: string[];
    try {
      rootEntries = readdirSync(KUBEPODS_CGROUP);
    } catch {
      return null; // cgroup root not visible (in-container) — cannot node-scope
    }

    const ids = new Set<string>();
    const walk = (entries: string[], dir: string, depth: number) => {
      if (depth > 4) return;
      for (const name of entries) {
        // containerd, CRI-O and Docker each name the container scope differently.
        const m = name.match(/^(?:cri-containerd|crio|docker)-([0-9a-f]{64})\.scope$/);
        if (m) {
          ids.add(m[1].substring(0, 12));
          continue;
        }
        if (name.endsWith(".slice")) {
          const child = `${dir}/${name}`;
          try {
            walk(readdirSync(child), child, depth + 1);
          } catch {
            /* unreadable sub-slice — skip */
          }
        }
      }
    };
    walk(rootEntries, KUBEPODS_CGROUP, 0);
    return ids;
  }

  async getAllRunningContainers(): Promise<ContainerFullInfo[]> {
    if (this.opts.kubectlBinary) this.kubectlPath = this.opts.kubectlBinary;
    if (!(await this.isAvailable())) return [];

    if (this.lastPodList.length > 0 && Date.now() - this.lastPodListTime < POD_LIST_CACHE_TTL) {
      return this.lastPodList;
    }

    // Node-scope: enumerate container ids that live on this host. When the cgroup root
    // is unreadable (extension host inside a container), collectLocalContainerIds()
    // returns null — node-scoping is impossible, so we degrade to cluster scope (show
    // all pods) rather than filtering every pod out and showing nothing.
    let localIds: Set<string> | null = null;
    if (this.opts.scope === "node") {
      localIds = this.collectLocalContainerIds();
      if (localIds === null && !this.warnedNodeScopeUnavailable) {
        this.warnedNodeScopeUnavailable = true;
        log(
          "[k8s] node scope requested but local pod cgroups are not visible " +
            "(running inside a container?) — showing all cluster pods instead",
        );
      }
    }

    try {
      const { stdout } = await execCommand(`${this.kubectl} get pods -A -o json --request-timeout=8s`, {
        timeout: 12000,
      });
      const parsed: { items: K8sPodSpec[] } = JSON.parse(stdout);

      const results: ContainerFullInfo[] = [];
      const podById = new Map<string, ContainerFullInfo>();
      const podIndex: PodIndex = new Map();
      const podMemLimit = new Map<string, number>();
      const nsFilter = this.opts.namespaces;
      let matchedNamespaceFilter = 0; // pods left after the namespace filter, before node scoping

      for (const pod of parsed.items) {
        const ns = pod.metadata.namespace;
        const name = pod.metadata.name;
        if (nsFilter.length > 0 && !nsFilter.includes(ns)) continue;
        matchedNamespaceFilter++;

        // Container short ids for this pod (from running container statuses)
        const shortIds: string[] = [];
        for (const cs of pod.status.containerStatuses || []) {
          const cidRaw = cs.containerID || "";
          const m = cidRaw.match(/[0-9a-f]{64}/);
          if (m) shortIds.push(m[0].substring(0, 12));
        }

        // Node scoping: keep the pod only if one of its containers runs locally
        if (localIds && !shortIds.some((id) => localIds.has(id))) continue;

        const id = `k8s:${ns}/${name}`;

        // Controller (owner) — convert ReplicaSet to its Deployment for rollout/scale
        let controllerKind = "";
        let controllerName = "";
        const owner = (pod.metadata.ownerReferences || []).find((o) => o.controller) || pod.metadata.ownerReferences?.[0];
        if (owner) {
          if (owner.kind === "ReplicaSet") {
            controllerKind = "Deployment";
            controllerName = deploymentNameFromReplicaSet(owner.name);
          } else {
            controllerKind = owner.kind;
            controllerName = owner.name;
          }
        }

        // Health from pod phase + Ready condition (low-noise: ready running pods get no badge)
        const phase = pod.status.phase || "Unknown";
        const ready = (pod.status.conditions || []).find((c) => c.type === "Ready")?.status === "True";
        let health: ContainerFullInfo["health"] = "none";
        if (phase === "Pending") health = "starting";
        else if (phase === "Failed") health = "unhealthy";
        else if (phase === "Running" && !ready) health = "unhealthy";

        const image = pod.spec.containers[0]?.image || "";
        const moreImages = pod.spec.containers.length > 1 ? ` (+${pod.spec.containers.length - 1})` : "";

        // Sum memory limits across containers (joined into stats as memLimitMib)
        let limitMib = 0;
        const portSet = new Set<number>();
        for (const c of pod.spec.containers) {
          const lim = c.resources?.limits?.memory;
          if (lim) limitMib += parseMemToMib(lim);
          for (const p of c.ports || []) if (p.containerPort) portSet.add(p.containerPort);
        }
        if (limitMib > 0) podMemLimit.set(id, limitMib);
        const ports = [...portSet].sort((a, b) => a - b).join(", ");

        const info: ContainerFullInfo = {
          id,
          name,
          mainPid: 0,
          ownerUid: -1,
          ownerName: ns, // group-by-owner groups pods by namespace
          health,
          composeProject: "",
          uptime: pod.status.startTime ? fmtUptime(Date.parse(pod.status.startTime)) : "",
          image: image + moreImages,
          ports,
          source: "k8s",
          namespace: ns,
          node: pod.spec.nodeName,
          controllerKind,
          controllerName,
          podPhase: phase,
        };
        results.push(info);
        podById.set(id, info);
        for (const sid of shortIds) podIndex.set(sid, { id, name: `${ns}/${name}` });
      }

      this.lastPodList = results;
      this.lastPodListTime = Date.now();
      this.podById = podById;
      this.podIndex = podIndex;
      this.podMemLimitMib = podMemLimit;

      // Distinguish "nothing to show" from "everything got filtered out" — a silently
      // empty Pod Manager is exactly the symptom the diagnostics row exists to explain.
      if (results.length > 0) {
        this.state = "ok";
        this.detail = "";
      } else if (matchedNamespaceFilter > 0) {
        this.state = "node-scope-empty";
        this.detail = `${matchedNamespaceFilter} pod(s) returned by the API server, 0 matched a container cgroup on this machine.`;
      } else {
        this.state = "no-pods";
        this.detail = nsFilter.length > 0 ? `Namespace filter: ${nsFilter.join(", ")}` : "";
      }
      return results;
    } catch (e) {
      log(`[k8s] getAllRunningContainers failed: ${e}`);
      this.state = "list-failed";
      this.detail = errText(e);
      return this.lastPodList; // serve stale on transient errors
    }
  }

  async getPodIndex(): Promise<PodIndex> {
    return new Map(this.podIndex);
  }

  async getContainerNames(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const [shortId, ref] of this.podIndex) map.set(shortId, ref.name);
    return map;
  }

  async getContainerStats(): Promise<Map<string, ContainerStats>> {
    if (!(await this.isAvailable())) return new Map();

    if (Date.now() - this.lastStatsTime < STATS_CACHE_TTL && this.cachedStats.size > 0) {
      return new Map(this.cachedStats);
    }

    const map = new Map<string, ContainerStats>();
    try {
      const { stdout } = await execCommand(
        `${this.kubectl} top pods -A --no-headers --request-timeout=8s`,
        { timeout: 12000 },
      );
      const numCores = os.cpus().length || 1;
      for (const line of stdout.trim().split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4) continue;
        const [ns, name, cpu, mem] = parts;
        const id = `k8s:${ns}/${name}`;
        const cores = parseCpuToCores(cpu);
        const memMib = parseMemToMib(mem);
        const limitMib = this.podMemLimitMib.get(id) || 0;
        map.set(id, {
          cpuPercent: (cores / numCores) * 100,
          memUsedMib: memMib,
          memLimitMib: limitMib,
          memPercent: limitMib > 0 ? (memMib / limitMib) * 100 : 0,
          netIO: "",
          blockIO: "",
        });
      }
    } catch (e) {
      // metrics-server may be absent — degrade gracefully like docker stats
      logDebug(`[k8s] top pods failed (metrics-server missing?): ${e}`);
    }

    this.cachedStats = map;
    this.lastStatsTime = Date.now();
    return new Map(map);
  }

  /** Split "k8s:<ns>/<name>" into its parts. */
  private splitId(podId: string): { ns: string; name: string } | null {
    if (!podId.startsWith("k8s:")) return null;
    const rest = podId.slice(4);
    const slash = rest.indexOf("/");
    if (slash < 0) return null;
    return { ns: rest.substring(0, slash), name: rest.substring(slash + 1) };
  }

  /** Restart a pod: rollout restart its controller, or delete a bare/unmanaged pod. */
  async restartContainer(podId: string): Promise<void> {
    const p = this.splitId(podId);
    if (!p) return;
    const info = this.podById.get(podId);
    const kind = info?.controllerKind || "";
    if (["Deployment", "StatefulSet", "DaemonSet"].includes(kind) && info?.controllerName) {
      await execCommand(
        `${this.kubectl} rollout restart ${kind.toLowerCase()}/${info.controllerName} -n ${p.ns} --request-timeout=15s`,
        { timeout: 20000 },
      );
    } else {
      await execCommand(`${this.kubectl} delete pod ${p.name} -n ${p.ns} --request-timeout=15s`, { timeout: 20000 });
    }
  }

  /** Stop a pod: scale its controller to 0 if scalable, else delete the pod. */
  async stopContainer(podId: string): Promise<void> {
    const p = this.splitId(podId);
    if (!p) return;
    const info = this.podById.get(podId);
    const kind = info?.controllerKind || "";
    if (["Deployment", "StatefulSet"].includes(kind) && info?.controllerName) {
      await execCommand(
        `${this.kubectl} scale ${kind.toLowerCase()}/${info.controllerName} --replicas=0 -n ${p.ns} --request-timeout=15s`,
        { timeout: 20000 },
      );
    } else {
      await execCommand(`${this.kubectl} delete pod ${p.name} -n ${p.ns} --request-timeout=15s`, { timeout: 20000 });
    }
  }

  /** Force-delete a pod. */
  async killContainer(podId: string): Promise<void> {
    const p = this.splitId(podId);
    if (!p) return;
    await execCommand(
      `${this.kubectl} delete pod ${p.name} -n ${p.ns} --grace-period=0 --force --request-timeout=15s`,
      { timeout: 20000 },
    );
  }

  /** Inspect a pod: env vars and volume mounts across its containers. */
  async inspectContainer(podId: string): Promise<ContainerInspect> {
    const p = this.splitId(podId);
    if (!p) return { env: [], mounts: [] };
    try {
      const { stdout } = await execCommand(
        `${this.kubectl} get pod ${p.name} -n ${p.ns} -o json --request-timeout=8s`,
        { timeout: 12000 },
      );
      const pod = JSON.parse(stdout);
      const env: string[] = [];
      const mounts: Array<{ source: string; destination: string; mode: string }> = [];
      for (const c of pod.spec?.containers || []) {
        for (const e of c.env || []) {
          if (e.value !== undefined) env.push(`${e.name}=${e.value}`);
          else if (e.valueFrom) {
            const ref = e.valueFrom.secretKeyRef
              ? `<secret:${e.valueFrom.secretKeyRef.name}>`
              : e.valueFrom.configMapKeyRef
                ? `<configMap:${e.valueFrom.configMapKeyRef.name}>`
                : e.valueFrom.fieldRef
                  ? `<field:${e.valueFrom.fieldRef.fieldPath}>`
                  : "<from>";
            env.push(`${e.name}=${ref}`);
          } else env.push(`${e.name}=`);
        }
        for (const vm of c.volumeMounts || []) {
          mounts.push({ source: vm.name, destination: vm.mountPath, mode: vm.readOnly ? "ro" : "rw" });
        }
      }
      return { env, mounts };
    } catch (e) {
      log(`[k8s] inspect failed: ${e}`);
      return { env: [], mounts: [] };
    }
  }
}
