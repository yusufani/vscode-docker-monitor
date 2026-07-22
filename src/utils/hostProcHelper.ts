import * as vscode from "vscode";
import { execCommand } from "./exec";
import { log, logDebug } from "./logger";

/**
 * Host /proc bridge for the in-container case.
 *
 * When the extension host itself runs inside a container, nvidia-smi still reports
 * HOST pids, but those pids do not exist in the container's PID namespace, so
 * /proc/<pid> is unreadable and process owner / container / pod attribution breaks.
 *
 * If the container has the Docker socket mounted (very common for dev containers),
 * we can recover full attribution by launching a short-lived helper container that
 * bind-mounts the host's /proc (and /etc/passwd) read-only and dumps the few files
 * we need for a batch of pids. One `docker run` per refresh, cached for 25s.
 */

export interface HostProcDetail {
  /** Raw /proc/<pid>/cgroup body (newlines replaced with '|') — feed to extractContainerShortId. */
  cgroup: string;
  uid: number;
  username: string;
  rssMib: number;
  cmdline: string;
  cwd: string;
  startTime: number; // epoch ms, 0 if unknown
  /** Parent process cmdline — used to recover the real command when cmdline is a
   *  prctl/setproctitle-renamed title (e.g. vLLM's "VLLM::EngineCore"). "" if unknown. */
  parentCmdline: string;
}

const CACHE_TTL = 25_000; // matches the docker stats / pid-map cache cadence
const CLK_TCK = 100; // Linux default; helper images don't expose getconf reliably

let _cache: Map<number, HostProcDetail> | null = null;
let _cacheKey = "";
let _cacheTime = 0;

// Resolved helper image, cached for the session ("" = not yet resolved, null = none found)
let _helperImage: string | null | undefined = undefined;

/** Pick a local image that can run busybox/POSIX `sh`. Prefers alpine/busybox-based. */
async function resolveHelperImage(docker: string): Promise<string | null> {
  if (_helperImage !== undefined) return _helperImage;

  const configured = vscode.workspace
    .getConfiguration("dockerMonitor")
    .get<string>("hostProcHelperImage", "")
    .trim();
  if (configured) {
    _helperImage = configured;
    return configured;
  }

  try {
    const { stdout } = await execCommand(`${docker} images --format "{{.Repository}}:{{.Tag}}"`, {
      timeout: 5000,
    });
    const images = stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("<none>"));
    // Prefer the smallest, most-likely-to-have-busybox images first.
    const preferred = images.find((i) => /alpine|busybox/i.test(i));
    _helperImage = preferred || images[0] || null;
  } catch (e) {
    logDebug(`[hostproc] could not list docker images: ${e}`);
    _helperImage = null;
  }
  if (!_helperImage) {
    log("[hostproc] no local image available for the host /proc helper — owner attribution degraded");
  }
  return _helperImage;
}

/** Build the shell script the helper runs; output is parsed back by readHostProcViaDocker. */
function buildScript(pids: number[]): string {
  // base64-encoded and decoded inside the helper to avoid all shell-quoting issues.
  return [
    `for p in ${pids.join(" ")}; do`,
    `  echo "@@PID $p"`,
    `  echo "@@CG $(cat /hostproc/$p/cgroup 2>/dev/null | tr '\\n' '|')"`,
    `  u=$(awk '/^Uid:/{print $2; exit}' /hostproc/$p/status 2>/dev/null)`,
    `  echo "@@UID $u"`,
    `  echo "@@USER $(awk -F: -v x="$u" '$3==x{print $1; exit}' /hostpasswd 2>/dev/null)"`,
    `  echo "@@RSS $(awk '/^VmRSS:/{print $2; exit}' /hostproc/$p/status 2>/dev/null)"`,
    `  echo "@@CMD $(tr '\\0' ' ' < /hostproc/$p/cmdline 2>/dev/null)"`,
    `  echo "@@CWD $(readlink /hostproc/$p/cwd 2>/dev/null)"`,
    `  echo "@@STAT $(cat /hostproc/$p/stat 2>/dev/null)"`,
    // Parent cmdline — lets us recover the real command for setproctitle-renamed
    // processes (e.g. vLLM engine cores whose own cmdline is just "VLLM::EngineCore").
    `  pp=$(awk '/^PPid:/{print $2; exit}' /hostproc/$p/status 2>/dev/null)`,
    `  echo "@@PCMD $(tr '\\0' ' ' < /hostproc/$pp/cmdline 2>/dev/null)"`,
    `done`,
    `echo "@@BTIME $(awk '/^btime/{print $2; exit}' /hostproc/stat 2>/dev/null)"`,
  ].join("\n");
}

function parseStartTime(statLine: string, btimeSec: number): number {
  if (!statLine || !btimeSec) return 0;
  const afterComm = statLine.indexOf(") ");
  if (afterComm < 0) return 0;
  const fields = statLine.substring(afterComm + 2).split(" ");
  const startTicks = parseInt(fields[19]); // field 22 (starttime), 0-indexed after state
  if (isNaN(startTicks)) return 0;
  return btimeSec * 1000 + Math.round((startTicks / CLK_TCK) * 1000);
}

/**
 * Resolve host /proc detail for the given pids by running a helper container.
 * Returns an empty map (and logs) if docker / a helper image is unavailable.
 */
export async function readHostProcViaDocker(
  docker: string,
  pids: number[],
): Promise<Map<number, HostProcDetail>> {
  if (pids.length === 0) return new Map();

  const key = pids.slice().sort((a, b) => a - b).join(",");
  if (_cache && _cacheKey === key && Date.now() - _cacheTime < CACHE_TTL) {
    return _cache;
  }

  const image = await resolveHelperImage(docker);
  if (!image) return new Map();

  const map = new Map<number, HostProcDetail>();
  try {
    const scriptB64 = Buffer.from(buildScript(pids), "utf-8").toString("base64");
    const cmd =
      `${docker} run --rm --entrypoint sh ` +
      `-v /proc:/hostproc:ro -v /etc/passwd:/hostpasswd:ro ` +
      `${image} -c 'echo ${scriptB64} | base64 -d | sh'`;
    const { stdout } = await execCommand(cmd, { timeout: 15000 });

    // Collect raw records first; startTime needs btime which arrives on the last line.
    interface Raw { pid: number; cgroup: string; uid: number; username: string; rssMib: number; cmdline: string; cwd: string; stat: string; parentCmdline: string; }
    const raws: Raw[] = [];
    let btimeSec = 0;
    let cur: Raw | null = null;
    const blank = (pid: number): Raw => ({ pid, cgroup: "", uid: -1, username: "", rssMib: 0, cmdline: "", cwd: "", stat: "", parentCmdline: "" });

    for (const line of stdout.split("\n")) {
      if (line.startsWith("@@PID ")) {
        if (cur) raws.push(cur);
        cur = blank(parseInt(line.slice(6).trim()));
      } else if (!cur) {
        if (line.startsWith("@@BTIME ")) btimeSec = parseInt(line.slice(8).trim()) || 0;
      } else if (line.startsWith("@@CG ")) cur.cgroup = line.slice(5).replace(/\|/g, "\n"); // restore newlines flattened by the helper
      else if (line.startsWith("@@UID ")) cur.uid = parseInt(line.slice(6).trim());
      else if (line.startsWith("@@USER ")) cur.username = line.slice(7).trim();
      else if (line.startsWith("@@RSS ")) cur.rssMib = Math.round((parseInt(line.slice(6).trim()) || 0) / 1024);
      else if (line.startsWith("@@CMD ")) cur.cmdline = line.slice(6).trim();
      else if (line.startsWith("@@CWD ")) cur.cwd = line.slice(6).trim();
      else if (line.startsWith("@@STAT ")) cur.stat = line.slice(7);
      else if (line.startsWith("@@PCMD ")) cur.parentCmdline = line.slice(7).trim();
      else if (line.startsWith("@@BTIME ")) btimeSec = parseInt(line.slice(8).trim()) || 0;
    }
    if (cur) raws.push(cur);

    for (const r of raws) {
      if (isNaN(r.pid)) continue;
      map.set(r.pid, {
        cgroup: r.cgroup,
        uid: r.uid,
        username: r.username,
        rssMib: r.rssMib,
        cmdline: r.cmdline,
        cwd: r.cwd,
        startTime: parseStartTime(r.stat, btimeSec),
        parentCmdline: r.parentCmdline,
      });
    }
  } catch (e) {
    logDebug(`[hostproc] helper run failed (image=${image}): ${e}`);
    return new Map();
  }

  _cache = map;
  _cacheKey = key;
  _cacheTime = Date.now();
  return map;
}
