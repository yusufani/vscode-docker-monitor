import { readFileSync } from "fs";
import { execSync } from "child_process";
import { IGpuCollector, PodIndex } from "./interfaces";
import { GpuInfo, GpuProcess } from "../types";
import { findBinary, execCommand } from "../utils/exec";
import { detectPlatform } from "../utils/platform";
import { log, logDebug } from "../utils/logger";
import { resolveContainerFromPid, extractContainerShortId } from "./containerResolver";
import { readHostProcViaDocker } from "../utils/hostProcHelper";
import { deriveProcessName, looksRenamed, isShimOrInit } from "../utils/procName";

function readProcFile(filePath: string): string {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

/** Returns true if host /proc is accessible (i.e. we're not in a PID-namespaced container) */
function canAccessHostProc(pid: number): boolean {
  return readProcFile(`/proc/${pid}/status`).length > 0;
}

// UID resolution cache
let _uidMap: Map<number, string> | null = null;

function resolveUidFromPasswd(uid: number): string {
  if (!_uidMap) {
    _uidMap = new Map();
    try {
      const passwd = readProcFile("/etc/passwd");
      for (const line of passwd.split("\n")) {
        const p = line.split(":");
        if (p.length >= 3) _uidMap.set(parseInt(p[2]), p[0]);
      }
    } catch {
      // no passwd file
    }
  }
  return _uidMap.get(uid) || `uid:${uid}`;
}

async function resolveUidAsync(uid: number): Promise<string> {
  const cached = resolveUidFromPasswd(uid);
  if (!cached.startsWith("uid:")) return cached;
  // macOS fallback: /etc/passwd may not contain all users
  try {
    const { stdout } = await execCommand(`id -un ${uid}`, { timeout: 3000 });
    const name = stdout.trim();
    if (name && _uidMap) {
      _uidMap.set(uid, name);
      return name;
    }
  } catch (e) {
    logDebug(`[nvidia] id -un ${uid} failed: ${e}`);
  }
  return cached;
}

// ── /proc-based resolution (works on host) ─────────────────────
// Container/pod attribution from /proc/<pid>/cgroup lives in containerResolver.ts
// (shared with the host-process path in linuxSystem.ts).

// Boot time cache — read once from /proc/stat
let _bootTimeMs: number | null = null;

function getBootTimeMs(): number {
  if (_bootTimeMs !== null) return _bootTimeMs;
  try {
    const stat = readProcFile("/proc/stat");
    const m = stat.match(/^btime\s+(\d+)/m);
    if (m) {
      _bootTimeMs = parseInt(m[1]) * 1000;
      return _bootTimeMs;
    }
  } catch { /* ignore */ }
  _bootTimeMs = 0;
  return 0;
}

// Clock ticks per second — read once
let _clkTck: number | null = null;

function getClkTck(): number {
  if (_clkTck !== null) return _clkTck;
  try {
    _clkTck = parseInt(execSync("getconf CLK_TCK", { encoding: "utf-8" }).trim()) || 100;
  } catch {
    _clkTck = 100; // Linux default
  }
  return _clkTck;
}

function getProcessDetailFromProc(
  pid: number,
): { cmdline: string; cwd: string; ramMib: number; uid: number; startTime: number } {
  let cmdline = "", cwd = "", ramMib = 0, uid = -1, startTime = 0;

  const raw = readProcFile(`/proc/${pid}/cmdline`);
  if (raw) cmdline = raw.replace(/\0/g, " ").trim();

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readlinkSync } = require("fs");
    cwd = readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    // no access
  }

  const status = readProcFile(`/proc/${pid}/status`);

  // If cmdline looks like a renamed process (e.g. "VLLM::EngineCore"), try parent process
  // Processes that use prctl(PR_SET_NAME) overwrite cmdline, losing the real command
  if (status) {
    const ppidMatch = status.match(/PPid:\s+(\d+)/);
    if (ppidMatch) {
      const ppid = parseInt(ppidMatch[1]);
      const cmdlineLooksRenamed = !cmdline || !cmdline.includes("/") && !cmdline.includes(" ");
      if (cmdlineLooksRenamed && ppid > 1) {
        const parentRaw = readProcFile(`/proc/${ppid}/cmdline`);
        if (parentRaw) {
          const parentCmdline = parentRaw.replace(/\0/g, " ").trim();
          if (parentCmdline && parentCmdline.includes("/")) {
            cmdline = `[parent] ${parentCmdline}`;
          }
        }
        if (!cwd) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { readlinkSync } = require("fs");
            cwd = readlinkSync(`/proc/${ppid}/cwd`);
          } catch { /* no access */ }
        }
      }
    }
  }
  if (status) {
    const ramMatch = status.match(/VmRSS:\s+(\d+)\s+kB/);
    if (ramMatch) ramMib = Math.round(parseInt(ramMatch[1]) / 1024);
    const uidMatch = status.match(/Uid:\s+(\d+)/);
    if (uidMatch) uid = parseInt(uidMatch[1]);
  }

  // Read start time from /proc/[pid]/stat — field 22 (starttime in clock ticks since boot)
  const statLine = readProcFile(`/proc/${pid}/stat`);
  if (statLine) {
    // Format: pid (comm) state ... field22 — comm may contain spaces/parens, skip past closing paren
    const afterComm = statLine.indexOf(") ");
    if (afterComm > 0) {
      const fields = statLine.substring(afterComm + 2).split(" ");
      // fields[0]=state, fields[1]=ppid, ... fields[19]=starttime (0-indexed from after state)
      const startTicks = parseInt(fields[19]);
      if (!isNaN(startTicks)) {
        const bootMs = getBootTimeMs();
        const clkTck = getClkTck();
        if (bootMs > 0) {
          startTime = bootMs + Math.round((startTicks / clkTck) * 1000);
        }
      }
    }
  }

  return { cmdline, cwd, ramMib, uid, startTime };
}

// Resolve real cwd for processes inside containers using NSpid + docker exec
async function resolveContainerCwd(
  procs: GpuProcess[],
): Promise<void> {
  const docker = (await findBinary("docker")) || "docker";
  const promises = procs
    .filter((p) => (!p.cwd || p.cwd === "?") && p.containerId)
    .map(async (p) => {
      try {
        // Read NSpid (namespace PID) from /proc status — last value is the container-internal PID
        // Format: "NSpid:\t<host_pid>" or "NSpid:\t<host_pid>\t<ns_pid>"
        const status = readProcFile(`/proc/${p.pid}/status`);
        const nspidMatch = status?.match(/NSpid:\s+(.+)$/m);
        if (!nspidMatch) return;
        const nspidParts = nspidMatch[1].trim().split(/\s+/);
        const nspid = nspidParts[nspidParts.length - 1];
        const { stdout } = await execCommand(
          `${docker} exec ${p.containerId} readlink /proc/${nspid}/cwd`,
        );
        const cwd = stdout.trim();
        if (cwd) p.cwd = cwd;
      } catch { /* ignore — container may not allow exec */ }
    });
  await Promise.all(promises);
}

// ── docker-based resolution (fallback for container environments) ──

interface DockerPidDetail {
  container: { id: string; name: string };
  user: string;
  uid: number;
  rssMib: number;
  cmdline: string;
}

interface DockerPidMap {
  pidToDetail: Map<number, DockerPidDetail>;
}

// PID map cache — avoids docker top spam
let _cachedPidMap: DockerPidMap | null = null;
let _pidMapTime = 0;
const PID_MAP_CACHE_TTL = 25_000; // 25s — matches stats cache TTL

async function buildDockerPidMap(
  docker: string,
  cnameMap: Map<string, string>,
): Promise<DockerPidMap> {
  // Return cached map if fresh
  if (_cachedPidMap && Date.now() - _pidMapTime < PID_MAP_CACHE_TTL) {
    return _cachedPidMap;
  }

  const pidToDetail = new Map<number, DockerPidDetail>();

  try {
    // Reuse the container name map passed in (already from docker ps)
    const entries = Array.from(cnameMap.entries());
    if (entries.length === 0) {
      return { pidToDetail };
    }

    const platform = detectPlatform();

    // For each container, get rich per-PID detail via docker top
    // Limit concurrency to avoid spawning too many processes
    const BATCH_SIZE = 5;
    for (let b = 0; b < entries.length; b += BATCH_SIZE) {
      const batch = entries.slice(b, b + BATCH_SIZE);
      const promises = batch.map(async ([cid, name]) => {
        try {
          const topCmd = platform === "darwin"
            ? `${docker} top ${cid} -o pid,user,uid,rss,args`
            : `${docker} top ${cid} -eo pid,user,uid,rss,args`;
          let topOut = "";
          try {
            const result = await execCommand(topCmd, { timeout: 5000 });
            topOut = result.stdout;
          } catch {
            // Skip this container on failure — don't retry with default format
            return;
          }
          const topLines = topOut.trim().split("\n");
          if (topLines.length < 2) return;

          const header = topLines[0];
          const argsCol = header.indexOf("ARGS") >= 0 ? header.indexOf("ARGS") : header.indexOf("COMMAND");
          if (argsCol < 0) return;

          for (let i = 1; i < topLines.length; i++) {
            const row = topLines[i];
            if (!row.trim()) continue;

            const fields = row.trim().split(/\s+/);
            const pid = parseInt(fields[0]);
            if (isNaN(pid)) continue;

            const user = fields[1] || "?";
            const uid = parseInt(fields[2]) || -1;
            const rssKb = parseInt(fields[3]) || 0;
            const cmdline = argsCol < row.length ? row.substring(argsCol).trim() : fields.slice(4).join(" ");

            pidToDetail.set(pid, {
              container: { id: cid, name: cnameMap.get(cid) || name },
              user,
              uid,
              rssMib: Math.round(rssKb / 1024),
              cmdline,
            });
          }
        } catch (e) {
          logDebug(`[pidmap] docker top failed for container ${cid}: ${e}`);
        }
      });
      await Promise.all(promises);
    }
  } catch (e) {
    logDebug(`[pidmap] buildDockerPidMap failed: ${e}`);
  }

  _cachedPidMap = { pidToDetail };
  _pidMapTime = Date.now();
  return _cachedPidMap;
}

// ── NvidiaCollector ────────────────────────────────────────────

export class NvidiaCollector implements IGpuCollector {
  private smiPath: string | null = null;
  private uuidToIndex = new Map<string, number>();
  private _procAccessible: boolean | null = null;

  async isAvailable(): Promise<boolean> {
    this.smiPath = await findBinary("nvidia-smi");
    return this.smiPath !== null;
  }

  async collectGpus(): Promise<GpuInfo[]> {
    if (!this.smiPath) return [];
    const gpus: GpuInfo[] = [];

    try {
      const { stdout } = await execCommand(
        `${this.smiPath} --query-gpu=index,name,memory.used,memory.total,memory.free,utilization.gpu,temperature.gpu,power.draw,uuid --format=csv,noheader,nounits`,
      );
      this.uuidToIndex.clear();
      for (const line of stdout.trim().split("\n")) {
        const p = line.split(",").map((s) => s.trim());
        if (p.length < 9) continue;
        const index = parseInt(p[0]);
        gpus.push({
          index,
          name: p[1],
          vendor: "nvidia",
          memUsed: parseInt(p[2]),
          memTotal: parseInt(p[3]),
          memFree: parseInt(p[4]),
          util: parseInt(p[5]),
          temp: parseInt(p[6]),
          power: parseFloat(p[7]),
        });
        this.uuidToIndex.set(p[8], index);
      }
    } catch (e) {
      log(`nvidia-smi GPU query failed: ${e}`);
    }

    return gpus;
  }

  async collectProcesses(containerNameMap: Map<string, string>, podIndex?: PodIndex): Promise<GpuProcess[]> {
    if (!this.smiPath) return [];
    const processes: GpuProcess[] = [];

    try {
      // Query process memory and per-process SM utilization in parallel.
      // util.gpu is NOT exposed by --query-compute-apps; only `pmon` provides
      // per-process SM%. pmon -c 1 blocks ~1s (its sampling window), so we run
      // it concurrently with the (instant) memory query.
      const [{ stdout: procCsv }, pmonMap] = await Promise.all([
        execCommand(
          `${this.smiPath} --query-compute-apps=pid,used_memory,gpu_uuid,process_name --format=csv,noheader,nounits`,
        ).catch(() => ({ stdout: "", stderr: "" })),
        this.collectPmonUtil(),
      ]);

      const rawProcs: Array<{ pid: number; mem: number; gpuIdx: number; pname: string }> = [];
      for (const line of procCsv.trim().split("\n")) {
        if (!line.trim()) continue;
        const p = line.split(",", 4).map((s) => s.trim());
        if (p.length < 4 || !p[0]) continue;
        const pid = parseInt(p[0]),
          mem = parseInt(p[1]);
        if (isNaN(pid) || isNaN(mem)) continue;
        rawProcs.push({ pid, mem, gpuIdx: this.uuidToIndex.get(p[2]) ?? -1, pname: p[3] });
      }
      rawProcs.sort((a, b) => b.mem - a.mem);

      if (rawProcs.length === 0) return [];

      // Check if /proc is accessible (cache result)
      if (this._procAccessible === null) {
        this._procAccessible = canAccessHostProc(rawProcs[0].pid);
        if (!this._procAccessible) {
          logDebug("[nvidia] /proc not accessible, using docker fallback for process resolution");
        }
      }

      if (this._procAccessible) {
        // Fast path: direct /proc access
        const detailPromises = rawProcs.map(async (r) => {
          const container = resolveContainerFromPid(r.pid, containerNameMap, podIndex);
          const detail = getProcessDetailFromProc(r.pid);
          const username = detail.uid >= 0 ? await resolveUidAsync(detail.uid) : "?";
          const nvName = r.pname.split("/").pop() || r.pname;
          // Prefer a name derived from the (parent-recovered) cmdline; fall back to nvidia's.
          const processName = deriveProcessName(detail.cmdline, nvName);
          return {
            pid: r.pid,
            gpuIndex: r.gpuIdx,
            memMib: r.mem,
            processName,
            containerId: container.id,
            containerName: container.name,
            cmdline: detail.cmdline || r.pname,
            cwd: detail.cwd || "?",
            cpuPercent: 0,
            gpuUtil: pmonMap.get(`${r.gpuIdx}:${r.pid}`) ?? pmonMap.get(`*:${r.pid}`) ?? 0,
            ramMib: detail.ramMib,
            uid: detail.uid,
            username,
            startTime: detail.startTime,
          } as GpuProcess;
        });
        const resolved = await Promise.all(detailPromises);

        // For processes with unknown cwd inside containers, resolve via docker exec + NSpid
        await resolveContainerCwd(resolved);

        processes.push(...resolved);
      } else {
        // In-container fallback. nvidia-smi reports HOST pids that don't exist in our
        // PID namespace, so /proc is useless here. Two recovery paths, best first:
        //   1) host /proc bridge via a helper container (resolves owner + container/pod
        //      via cgroup for ALL host pids, including k8s/containerd pods);
        //   2) docker top (only sees docker containers — misses pods & host procs).
        const docker = (await findBinary("docker")) || "docker";
        const [hostProc, pidMap] = await Promise.all([
          readHostProcViaDocker(docker, rawProcs.map((r) => r.pid)),
          buildDockerPidMap(docker, containerNameMap),
        ]);

        for (const r of rawProcs) {
          const hp = hostProc.get(r.pid);
          const topDetail = pidMap.pidToDetail.get(r.pid);

          // Container/pod attribution: prefer cgroup (host /proc) → pod/container,
          // then docker top, else host.
          let container = { id: "", name: "host" };
          if (hp?.cgroup) {
            const cid = extractContainerShortId(hp.cgroup);
            if (cid) {
              const pod = podIndex?.get(cid);
              container = pod ? { id: pod.id, name: pod.name } : { id: cid, name: containerNameMap.get(cid) || cid };
            }
          }
          if (!container.id && topDetail?.container) container = topDetail.container;

          const username = hp?.username || topDetail?.user || "?";
          const uid = (hp && hp.uid >= 0 ? hp.uid : undefined) ?? topDetail?.uid ?? -1;
          const ramMib = hp?.rssMib || topDetail?.rssMib || 0;

          // Use cmdline from host /proc or docker top when nvidia-smi returns [Not Found]
          const nvidiaName = r.pname;
          const isNotFound = !nvidiaName || nvidiaName === "[Not Found]";
          let realCmdline = hp?.cmdline || topDetail?.cmdline || (isNotFound ? "" : nvidiaName);
          // Recover the real command for setproctitle-renamed processes (e.g. vLLM's
          // "VLLM::EngineCore") from the parent cmdline captured by the host /proc bridge.
          if (looksRenamed(realCmdline) && hp?.parentCmdline && !isShimOrInit(hp.parentCmdline)) {
            realCmdline = `[parent] ${hp.parentCmdline}`;
          }
          // Friendly display name derived from the (recovered) cmdline; fall back to nvidia's.
          const fallbackName = isNotFound ? "unknown" : (nvidiaName.split("/").pop() || nvidiaName);
          const processName = deriveProcessName(realCmdline, fallbackName);
          processes.push({
            pid: r.pid,
            gpuIndex: r.gpuIdx,
            memMib: r.mem,
            processName,
            containerId: container.id,
            containerName: container.name,
            cmdline: realCmdline || processName,
            cwd: hp?.cwd || "?",
            cpuPercent: 0,
            gpuUtil: pmonMap.get(`${r.gpuIdx}:${r.pid}`) ?? pmonMap.get(`*:${r.pid}`) ?? 0,
            ramMib,
            uid,
            username,
            startTime: hp?.startTime || 0,
          });
        }
      }
    } catch (e) {
      log(`nvidia-smi process query failed: ${e}`);
    }

    // Always hand processes back sorted by VRAM (largest first) so every consumer
    // (webview groups, sidebar, status bar) shows the heaviest allocations on top.
    processes.sort((a, b) => b.memMib - a.memMib);
    return processes;
  }

  /**
   * Per-process GPU SM utilization via `nvidia-smi pmon -c 1`.
   * Returns a map keyed by both `gpuIndex:pid` (exact) and `*:pid` (max across
   * GPUs, used as a fallback when the GPU index can't be resolved from the UUID).
   * SM% is sampled over pmon's ~1s window; a `-` means no activity that sample.
   * Returns an empty map on any failure (pmon unsupported / no permission).
   */
  private async collectPmonUtil(): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (!this.smiPath) return map;
    try {
      const { stdout } = await execCommand(`${this.smiPath} pmon -c 1`, { timeout: 8000 });
      for (const line of stdout.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue; // skip header/unit rows
        const cols = t.split(/\s+/);
        // Layout: gpu pid type sm mem enc dec [jpg ofa] command
        if (cols.length < 4) continue;
        const gpuIdx = parseInt(cols[0]);
        const pid = parseInt(cols[1]);
        if (isNaN(pid)) continue;
        const sm = cols[3] === "-" ? 0 : parseInt(cols[3]);
        const smVal = isNaN(sm) ? 0 : sm;
        if (!isNaN(gpuIdx)) map.set(`${gpuIdx}:${pid}`, smVal);
        // Track max SM across GPUs for pid-only fallback
        const wildKey = `*:${pid}`;
        map.set(wildKey, Math.max(map.get(wildKey) ?? 0, smVal));
      }
    } catch (e) {
      logDebug(`[nvidia] pmon util query failed: ${e}`);
    }
    return map;
  }
}
