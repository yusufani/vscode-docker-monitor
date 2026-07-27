# DevPulse Monitor

VS Code extension for real-time GPU, CPU, RAM, and Docker container monitoring.

## Build & Test Workflow

**Easiest:** run `./scripts/deploy.sh` — it compiles, packages, **uninstalls** whatever
is installed, and installs the fresh build onto the running Stable server. Then restart
the extension host.

**Do NOT bump the version to deploy.** The script deploys the version already in
`package.json` and never touches it, so the working tree stays in sync with git and
release-please stays the only thing that moves the version number. (It used to
auto-bump on every run; those bumps were never committed, so the installed copy drifted
to 1.21.x while git said 1.17.0 — and VS Code then rejected every new build as "older
than what is installed". Uninstall-then-install removes the need for a bump entirely.)

Manual steps (if you need finer control):

```bash
# 1. Compile
npm run compile

# 2. Package VSIX (bump version in package.json first if needed)
npx vsce package --no-dependencies

# 3. Install on the running VS Code Server (Stable — see note below)
VSCODE_AGENT_FOLDER=/tier01/data/labhome/yani/vscode-server-fix/.vscode-server \
  /tier01/data/labhome/yani/vscode-server-fix/.vscode-server/cli/servers/Stable-8761a5560cfd65fdd19ce7e2bd18dab5c0a4d84e/server/bin/code-server --install-extension devpulse-monitor-*.vsix

# 4. User restarts the extension host: Ctrl+Shift+P -> Developer: Restart Extension Host
#    (a plain "Reload Window" sometimes keeps the OLD extension host warm, so the
#     new build appears installed but the running code doesn't change. A version
#     footer is shown at the bottom of both DevPulse panels to confirm the live build.)
```

**Heads-up — the server commit hash changes:** VS Code Server self-updates, so the
`cli/servers/Stable-<hash>/` path drifts (it was `8761a55…`, now `fcf6047…`). The
hardcoded one-liner below can go stale. Prefer `./scripts/deploy.sh`, which detects the
*running* server binary from its process instead of hardcoding the commit.

**Important — which server is actually running:** The user runs the **Stable** server at `vscode-server-fix/.vscode-server`, launched with `VSCODE_AGENT_FOLDER` pointing there. The `code-server` CLI defaults its extensions dir to `~/.vscode-server/extensions` (empty / root-owned here), so you MUST pass `VSCODE_AGENT_FOLDER=.../vscode-server-fix/.vscode-server` or the install fails with "Unable to resolve nonexistent file '.../.vscode-server/extensions'". The old Insiders path (`.vscode-server-insiders/.../code-server-insiders`) installs to a server that is NOT running — extensions land there but the user never sees them. To find the live server + folder: `pgrep -af extensionHost` and read its `/proc/<pid>/environ` for `VSCODE_AGENT_FOLDER`.

**Important — reinstalling the same version:** VS Code keeps the highest installed version
and treats installing an equal one as a no-op, so a plain `--install-extension` appears to
succeed while the old code keeps running. Always `--uninstall-extension anisoft.devpulse-monitor`
first (this is what `deploy.sh` does); bumping the version to work around it is what caused
the git-vs-installed drift described above. Verify with
`code-server --list-extensions --show-versions` — there must be exactly one copy, matching
`package.json`, and the sidebar's version footer must show the same number.

## One-liner (compile + package + install)

```bash
npm run compile && npx vsce package --no-dependencies && VSCODE_AGENT_FOLDER=/tier01/data/labhome/yani/vscode-server-fix/.vscode-server /tier01/data/labhome/yani/vscode-server-fix/.vscode-server/cli/servers/Stable-8761a5560cfd65fdd19ce7e2bd18dab5c0a4d84e/server/bin/code-server --install-extension devpulse-monitor-*.vsix
```

## Architecture

- `src/collectors/` - Data collectors (nvidia, apple, rocm, docker, system)
- `src/services/` - MonitorService orchestrates all collectors
- `src/views/` - UI: sidebar tree view, webview panel, status bar, container table
- `src/views/webview/` - Webview HTML/JS (GPU Monitor panel)
- `src/views/treeItems.ts` - Sidebar tree item classes
- `src/views/gpuSidebar.ts` - Sidebar tree data provider
- `src/utils/` - Shared utilities (format, logger)
- `package.json` - Commands, menus, keybindings, configuration

## Sidebar Tree View Notes

- Adding buttons to sidebar items requires: command in `package.json` contributes.commands, menu entry in `contributes.menus.view/item/context` with `group: "inline"`, matching `contextValue` on the TreeItem, and command handler in `extension.ts`
- Webview (HTML panel) and sidebar (TreeView API) are completely different - HTML/CSS/JS only works in webview

## Webview Notes

- `navigator.clipboard` does NOT work in VS Code webviews. Use `vscode.postMessage({command:'copyText', text})` and handle in panel with `vscode.env.clipboard.writeText()`
- First render uses `getGpuMonitorHtml()`, subsequent updates use `postMessage` for incremental DOM updates
- `retainContextWhenHidden: true` means old HTML persists - panel must be closed and reopened to see structural HTML changes
