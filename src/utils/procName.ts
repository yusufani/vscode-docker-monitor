// Human-friendly process naming for GPU compute apps.
//
// nvidia-smi reports the process `comm` (e.g. "VLLM::EngineCore", "tritonserver"),
// which is often a prctl/setproctitle-renamed title that hides the real command.
// These helpers recover a meaningful name from the full cmdline (peeling interpreter
// wrappers and pulling out the served model), shared by every GPU code path.

const basename = (s: string): string => s.split("/").pop() || s;

/**
 * True when a cmdline looks like a prctl/setproctitle-renamed title rather than a
 * real command: a single bare token with no path separator and no arguments
 * (e.g. "VLLM::EngineCore", "ray::IDLE", "").  In that case the real command must
 * be recovered from the parent process.
 */
export function looksRenamed(cmdline: string): boolean {
  const t = (cmdline || "").trim();
  if (!t) return true;
  return !t.includes("/") && !t.includes(" ");
}

/** Container/init shim cmdlines that should never be shown as a workload's command. */
export function isShimOrInit(cmdline: string): boolean {
  const t = (cmdline || "").trim();
  if (!t) return true;
  return /containerd-shim|runc\b|\/pause\b|^\/init\b|^\/sbin\/init\b|systemd\b/.test(t);
}

const INTERP_RE = /^(python[\d.]*|python|pypy[\d.]*|node|bash|sh|dash|java|torchrun|accelerate|deepspeed|ray|uvicorn|gunicorn)$/i;

/** Read the value of a `--flag=value` or `--flag value` option from tokens. */
function flagValue(tokens: string[], names: string[]): string {
  for (const t of tokens) {
    for (const n of names) {
      if (t.startsWith(n + "=")) return t.slice(n.length + 1);
    }
  }
  for (let i = 0; i < tokens.length - 1; i++) {
    if (names.includes(tokens[i])) return tokens[i + 1];
  }
  return "";
}

/**
 * Derive a short, human-friendly name from a process cmdline.
 * Recognizes common ML-serving stacks (vLLM, Triton, TGI, sglang) and otherwise
 * falls back to the invoked script/binary basename. `fallback` is used when the
 * cmdline is empty or yields nothing useful.
 */
export function deriveProcessName(cmdline: string, fallback = "process"): string {
  const raw = (cmdline || "").replace(/^\[parent\]\s*/, "").trim();
  if (!raw) return (fallback || "process").trim();

  const tokens = raw.split(/\s+/).filter(Boolean);

  // ── vLLM: `... vllm serve <model>` or `-m vllm.entrypoints...` ──
  const vllmIdx = tokens.findIndex((t) => basename(t).toLowerCase() === "vllm");
  if (vllmIdx >= 0) {
    if (tokens[vllmIdx + 1] === "serve" && tokens[vllmIdx + 2] && !tokens[vllmIdx + 2].startsWith("-")) {
      return `vllm: ${basename(tokens[vllmIdx + 2])}`;
    }
    const model = flagValue(tokens, ["--model", "--model-name"]);
    return model ? `vllm: ${basename(model)}` : "vllm";
  }
  if (raw.includes("vllm.entrypoints") || raw.includes("vllm.")) {
    const model = flagValue(tokens, ["--model", "--served-model-name"]);
    return model ? `vllm: ${basename(model)}` : "vllm";
  }

  // ── Triton Inference Server ──
  const tritonIdx = tokens.findIndex((t) => basename(t).toLowerCase().startsWith("tritonserver"));
  if (tritonIdx >= 0) {
    const loaded = flagValue(tokens, ["--load-model"]);
    if (loaded) return `triton: ${loaded}`;
    const repo = flagValue(tokens, ["--model-repository", "--model-store"]);
    return repo ? `triton: ${basename(repo)}` : "tritonserver";
  }

  // ── HuggingFace TGI / text-generation-launcher ──
  if (tokens.some((t) => /text-generation-(launcher|server)/.test(basename(t)))) {
    const model = flagValue(tokens, ["--model-id", "--model"]);
    return model ? `tgi: ${basename(model)}` : "text-generation";
  }

  // ── sglang ──
  if (raw.includes("sglang")) {
    const model = flagValue(tokens, ["--model-path", "--model"]);
    return model ? `sglang: ${basename(model)}` : "sglang";
  }

  // ── Peel an interpreter wrapper (python/node/bash + flags) to find the script ──
  let idx = 0;
  if (tokens.length > 1 && INTERP_RE.test(basename(tokens[0]))) {
    idx = 1;
    while (idx < tokens.length && tokens[idx].startsWith("-")) {
      if ((tokens[idx] === "-m" || tokens[idx] === "-c") && idx + 1 < tokens.length) {
        return basename(tokens[idx + 1]); // module / inline target
      }
      idx++;
    }
  }

  const prog = tokens[idx] || tokens[0];
  const base = basename(prog);
  // Bare interpreter with no script (e.g. "/usr/local/bin/python3.11") — keep it.
  return base || (fallback || "process").trim();
}
