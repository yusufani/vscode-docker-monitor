import * as vscode from "vscode";
import { execCommand, execCommandWithInput } from "./exec";
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
 *
 * This reads other host users' command lines and working directories, so it is gated
 * behind explicit consent (`dockerMonitor.hostProcHelper.mode`, default "ask"). The
 * caller degrades to `docker top` attribution when consent is absent — nothing breaks,
 * it just resolves fewer processes.
 *
 * The gate that decides whether this path runs at all lives in nvidiaCollector: it
 * probes whether host pids are readable via /proc directly. On a host, or in a
 * container with /proc bind-mounted, this module is never reached.
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
const RUN_TIMEOUT = 30_000; // a loaded host can take well over 15s to start a container
const NAME_PREFIX = "devpulse-hostproc-";
const CONSENT_KEY = "devpulse.hostProcHelper.consent";

let _cache: Map<number, HostProcDetail> | null = null;
let _cacheKey = "";
let _cacheTime = 0;

// Resolved helper image, cached for the session ("" = not yet resolved, null = none found)
let _helperImage: string | null | undefined = undefined;

// Monotonic suffix so concurrent refreshes never collide on a container name.
let _runSeq = 0;

// ── Consent ────────────────────────────────────────────────────────────────────

let _globalState: vscode.Memento | undefined;
let _promptOpen = false;
let _deferredThisSession = false;

/** Wire up persisted consent + sweep any containers a previous session stranded. */
export function initHostProcHelper(context: vscode.ExtensionContext): void {
  _globalState = context.globalState;
}

/**
 * Remove helper containers left behind by an earlier session.
 *
 * `docker run --rm` only auto-removes once the container has *exited*. If the CLI is
 * killed between the create and start calls (our own timeout used to do exactly this),
 * the container is stranded in "created" forever. Named containers make those findable.
 */
export async function sweepHostProcLeftovers(docker: string): Promise<void> {
  try {
    const { stdout } = await execCommand(`${docker} ps -aq --filter name=${NAME_PREFIX}`, {
      timeout: 10_000,
    });
    const ids = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) return;
    await execCommand(`${docker} rm -f ${ids.join(" ")}`, { timeout: 30_000 });
    log(`[hostproc] removed ${ids.length} leftover helper container(s)`);
  } catch (e) {
    logDebug(`[hostproc] leftover sweep failed: ${e}`);
  }
}

type ConsentMode = "ask" | "always" | "never";

function consentMode(): ConsentMode {
  return vscode.workspace
    .getConfiguration("dockerMonitor")
    .get<ConsentMode>("hostProcHelper.mode", "ask");
}

/**
 * Decide whether we may run the helper right now.
 *
 * Never blocks: when consent has not been given yet it fires the prompt and reports
 * `false` for this refresh, so the caller falls back to `docker top` immediately. Once
 * the user allows it, the next refresh (≤30s later) picks it up.
 */
function mayRunHelper(image: string): boolean {
  const mode = consentMode();
  if (mode === "never") return false;
  if (mode === "always") return true;

  if (_globalState?.get<string>(CONSENT_KEY) === "granted") return true;
  if (_promptOpen || _deferredThisSession) return false;

  _promptOpen = true;
  void promptForConsent(image).finally(() => {
    _promptOpen = false;
  });
  return false;
}

async function promptForConsent(image: string): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    "DevPulse can resolve the owner of GPU processes by starting a short-lived helper " +
      `container (${image}) that mounts the host's /proc and /etc/passwd read-only. ` +
      "This exposes the command lines and working directories of other users' processes " +
      "on this machine. Without it, attribution falls back to `docker top` and resolves fewer processes.",
    { modal: false },
    "Allow",
    "Not now",
    "Never",
  );

  if (choice === "Allow") {
    await _globalState?.update(CONSENT_KEY, "granted");
    log("[hostproc] host /proc helper allowed by the user");
  } else if (choice === "Never") {
    await vscode.workspace
      .getConfiguration("dockerMonitor")
      .update("hostProcHelper.mode", "never", vscode.ConfigurationTarget.Global);
    log("[hostproc] host /proc helper disabled by the user");
  } else {
    // "Not now" or dismissed — stay quiet until the window is reloaded.
    _deferredThisSession = true;
  }
}

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
    // Only images we can be confident ship a POSIX `sh`. Falling back to "whatever
    // is first in the list" used to pull in arbitrary application images — slow to
    // start, often missing `sh`, and a surprising thing to hand the host's /proc to.
    _helperImage = images.find((i) => /alpine|busybox/i.test(i)) || null;
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
  if (!mayRunHelper(image)) return new Map();

  const map = new Map<number, HostProcDetail>();
  // Named so a stranded container is findable and removable — see sweepHostProcLeftovers.
  const name = `${NAME_PREFIX}${process.pid}-${_runSeq++}`;
  try {
    // The script goes in over stdin (`sh -s`) rather than the command line: no quoting
    // problems, and nothing that reads like an obfuscated payload in the process table.
    const cmd =
      `${docker} run --rm -i --name ${name} --entrypoint sh ` +
      `-v /proc:/hostproc:ro -v /etc/passwd:/hostpasswd:ro ` +
      `${image} -s`;
    const { stdout } = await execCommandWithInput(cmd, buildScript(pids), {
      timeout: RUN_TIMEOUT,
    });

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
    // A timeout kills the docker CLI, which may have created the container without
    // ever starting it — `--rm` never fires for those. Clean up explicitly.
    await execCommand(`${docker} rm -f ${name}`, { timeout: 10_000 }).catch(() => undefined);
    return new Map();
  }

  _cache = map;
  _cacheKey = key;
  _cacheTime = Date.now();
  return map;
}
