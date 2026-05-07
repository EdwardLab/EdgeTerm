import JSZip from "jszip";
import { ASSET_BASE, CLOUD_ENABLED, PAGE_KIND, assetUrl } from "../cloud/config.js";

export function bootstrapEdgeTerm() {

      const WORKSPACE_KEY = "edgeterm.workspaces.v1";
      const ACTIVE_KEY = "edgeterm.activeWorkspace.v1";
      const CLOUD_TOKEN_KEY = "edgeterm.cloud.token.v1";
      const AUTO_SYNC_KEY = "edgeterm.cloud.autoSync.v1";
      const AUTO_SYNC_MODE_KEY = "edgeterm.cloud.autoSync.mode.v1";
      const AUTO_SYNC_MINUTES_KEY = "edgeterm.cloud.autoSync.minutes.v1";
      const BACKUP_RETENTION_KEY = "edgeterm.cloud.keepLastBackups.v1";
      const SNAPSHOT_PAGE_SIZE_KEY = "edgeterm.cloud.snapshotPageSize.v1";
      const ADMIN_USERS_PAGE_SIZE_KEY = "edgeterm.admin.usersPageSize.v1";
      const ADMIN_SNAPSHOTS_PAGE_SIZE_KEY = "edgeterm.admin.snapshotsPageSize.v1";
      const ADMIN_SHARES_PAGE_SIZE_KEY = "edgeterm.admin.sharesPageSize.v1";
      const ADMIN_TIERS_PAGE_SIZE_KEY = "edgeterm.admin.tiersPageSize.v1";
      const APP_THEME_KEY = "edgeterm.theme.v1";
      const ISOLATED_WORKSPACE_STORAGE_KEY = "edgeterm.workspaceStorage.isolated.v1";
      const APPMODE_COOKIE_STORE_KEY = "edgeterm.appmode.cookies.v1";
      const APPMODE_SITE_DATA_STORE_KEY = "edgeterm.appmode.siteData.v1";
        const DEFAULT_ROOTFS_VERSION = "EdgeTerm django-isolate-v57";
      const DEFAULT_APP_MODE_CONFIG = {
        enabled: false,
        runtime: "python",
        entrypoint: "/home/user/app.py",
        staticRoot: "/home/user/public",
        workingDirectory: "/home/user",
        fullscreen: true,
        autoStart: true,
        preserveStateOnExit: true,
        showLoadingOverlay: true,
        exit: {
          method: "hotkey",
          hotkey: "Escape",
          confirmBeforeExit: false,
        },
        ui: {
          hideWorkspaceChrome: true,
          allowDebugTerminal: false,
          debugTerminalHotkey: "Ctrl+`",
        },
        python: {
          appObject: "app",
          appSpec: "",
          framework: "edgeterm",
          routePrefix: "/",
          allowFilesystemAccess: true,
        },
        static: {
          indexFile: "index.html",
          allowInlineScripts: true,
        },
      };
      const ROOT_RESERVED_ENTRIES = new Set([
        ".",
        "..",
        "bin",
        "boot",
        "dev",
        "etc",
        "home",
        "lib",
        "lib64",
        "mnt",
        "overlay",
        "packages",
        "proc",
        "tmp",
        "usr",
        "var",
        "workspace-store",
      ]);
      const WORKSPACE_JOURNAL_DB = "edgeterm.workspaceJournal.v1";
      const WORKSPACE_JOURNAL_STORE = "entries";

        let pyodide;
        let term;
        let editor;
        let splitEditor = null;
        let workspaces = [];
        let activeWorkspaceId = "";
        let currentPath = "/home/user";
        let appTheme = localStorage.getItem(APP_THEME_KEY) || "light";
        let editorTheme = appTheme === "dark" ? "vs-dark" : "vs";
        let editorMenuItems = new Map();
        let editorCommands = [];
        let editorSaveShortcutInFlight = null;
        let snapshotPage = 1;
        let snapshotPageSize = Math.min(200, Math.max(15, Number(localStorage.getItem(SNAPSHOT_PAGE_SIZE_KEY) || 15)));
        let adminUsersPage = 1;
        let adminUsersPageSize = Math.min(500, Math.max(15, Number(localStorage.getItem(ADMIN_USERS_PAGE_SIZE_KEY) || 15)));
        let adminSnapshotsPage = 1;
        let adminSnapshotsPageSize = Math.min(500, Math.max(15, Number(localStorage.getItem(ADMIN_SNAPSHOTS_PAGE_SIZE_KEY) || 15)));
        let adminSharesPage = 1;
        let adminSharesPageSize = Math.min(500, Math.max(15, Number(localStorage.getItem(ADMIN_SHARES_PAGE_SIZE_KEY) || 15)));
        let adminTiersPage = 1;
        let adminTiersPageSize = Math.min(500, Math.max(15, Number(localStorage.getItem(ADMIN_TIERS_PAGE_SIZE_KEY) || 15)));
        let cloudSettings = {};
        let editorToolbarButtons = [];
        let editorPaletteSelection = 0;
        let editorPaletteMode = "commands";
      let editorSplitEnabled = false;
      let splitEditorPath = "/home/user/notes.txt";
      let editorMenuOpen = null;
      let persistTimeout = null;
      let persistInFlight = null;
      let pendingPersistAfterInFlight = false;
      let syncfsChain = Promise.resolve();
      let workspaceFlushTimeout = null;
      let workspaceFlushInFlight = null;
      let pendingWorkspaceFlushAfterInFlight = false;
      let workspaceJournalDbPromise = null;
      let workspaceJournalFlushTimeout = null;
      let workspaceJournalFlushInFlight = null;
      let pendingWorkspaceJournalFlushAfterInFlight = false;
      let queuedWorkspaceJournalEntries = new Map();
      let mountedWorkspaceId = "";
      let edgeTermShell = null;
        let busyCount = 0;
        let previewObjectUrl = null;
        let previewPath = "";
        let wasmCommandLinks = new Set();
        let selectedPath = "";
      let cloudToken = localStorage.getItem(CLOUD_TOKEN_KEY) || "";
      let cloudUser = null;
      let cloudOnline = false;
      let cloudSnapshots = [];
      let selectedSnapshotIds = new Set();
      let cloudShares = [];
      let cloudTiers = {};
      let cloudBackend = "offline";
      let adminUsers = [];
      let adminPlatformShares = [];
      let adminPlatformSnapshots = [];
      let workspaceShareOrigins = new Map();
      let autoSyncTimer = null;
      let sidebarWidth = Number(localStorage.getItem("edgeterm.sidebar.width") || 260);
      let sidebarResizeState = null;
      let selectedPaths = new Set();
      let clipboard = null;
      let terminalCopyHandlerInstalled = false;
      let mountedUsers = new Set(["user"]);
      let contextTargetPath = "";
      let marqueeState = null;
      let suppressFileClick = false;
      let displayInputQueue = [];
      let displayMessageHistory = [];
      let displayState = {
        mode: "empty",
        width: 960,
        height: 640,
        fullscreen: false,
        lastType: "clear",
      };
      let browserLoadingToken = 0;
      let browserLoadingHideTimer = null;
      let appModeState = {
        active: false,
        booting: false,
        config: null,
        runtime: null,
        previousView: "terminalView",
        currentPath: "/",
        htmlPath: "",
        blobUrls: [],
        staticTextCache: new Map(),
        shareRoute: null,
        localRoute: null,
        renderTarget: "shell",
        siteKey: "",
        siteLabel: "",
        siteScope: null,
        cookieJar: new Map(),
        siteLocalStorage: new Map(),
        siteSessionStorage: new Map(),
        browserHistory: [],
        browserHistoryIndex: -1,
        browserTabs: new Map(),
        activeBrowserTabId: "",
      };

      const DEFAULT_TOS_HTML = `
        <p>By creating an EdgeTerm Cloud account, you agree to use the service lawfully, keep your credentials secure, and avoid uploading or sharing harmful, illegal, or abusive content.</p>
        <p>Cloud features store rootfs snapshots and metadata, but EdgeTerm does not execute your code on the server. You remain responsible for the data and applications you upload, share, or publish through your account.</p>
        <p>Service availability, storage limits, and features may change over time. If you do not agree with these terms, please continue using the offline edition instead of registering for cloud access.</p>
      `.trim();

      const $id = (id) => document.getElementById(id);

      function formatError(err) {
        const text = [
          err?.name,
          err?.message,
          err?.errno !== undefined ? `errno=${err.errno}` : "",
          err?.code !== undefined ? `code=${err.code}` : "",
          err?.stack,
        ]
          .filter(Boolean)
          .join("\n");
        if (text) return text;
        if (typeof err === "string") return err;
        try {
          const json = JSON.stringify(err);
          if (json && json !== "{}") return json;
        } catch {}
        return String(err || "Unknown error");
      }

      let noticeTimer = null;
      function showNotice(message) {
        const notice = $id("notice");
        notice.textContent = message;
        notice.classList.add("show");
        clearTimeout(noticeTimer);
        noticeTimer = setTimeout(() => notice.classList.remove("show"), 2600);
      }

      function downloadBlobAs(blob, filename) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename || "download.bin";
        link.click();
        URL.revokeObjectURL(url);
      }

      function publicShareUrl(share) {
        if (share?.url) return new URL(share.url, location.origin).toString();
        if (share?.publicPath) return `${location.origin}${share.publicPath}`;
        return `${location.origin}/?share=${encodeURIComponent(share?.id || "")}`;
      }

      function parseSharedAppRoute(pathname = location.pathname, search = location.search) {
        if (!CLOUD_ENABLED) return null;
        const normalizedPath = String(pathname || "");
        if (!normalizedPath.startsWith("/s/")) return null;
        const rest = normalizedPath.slice(3);
        if (!rest) return null;
        const slashIndex = rest.indexOf("/");
        const rawShareId = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
        if (!rawShareId) return null;
        const shareId = decodeURIComponent(rawShareId);
        let routePath = slashIndex === -1 ? "/" : rest.slice(slashIndex);
        if (!routePath) routePath = "/";
        if (!routePath.startsWith("/")) routePath = `/${routePath}`;
        return {
          kind: "app-share",
          value: shareId,
          shareId,
          routePath,
          queryString: String(search || "").replace(/^\?/, ""),
          path: normalizedPath,
        };
      }

      function appRouteRequestUrl(routePath = "/", queryString = "") {
        const path = normalizePath(routePath || "/");
        const query = String(queryString || "").replace(/^\?/, "");
        return query ? `${path}?${query}` : path;
      }

      function encodeBrowserPath(path = "/") {
        const normalized = normalizePath(path || "/");
        const trailingSlash = normalized.length > 1 && normalized.endsWith("/");
        const encoded = normalized
          .split("/")
          .map((segment, index) => (index === 0 ? "" : encodeURIComponent(segment)))
          .join("/");
        if (trailingSlash && !encoded.endsWith("/")) return `${encoded}/`;
        return encoded || "/";
      }

      function sharedAppBrowserUrl(shareId, routePath = "/", queryString = "") {
        if (!shareId) return "/";
        const base = `/s/${encodeURIComponent(shareId)}`;
        const encodedPath = encodeBrowserPath(routePath || "/");
        const path = encodedPath === "/" ? `${base}/` : `${base}${encodedPath}`;
        const query = String(queryString || "").replace(/^\?/, "");
        return query ? `${path}?${query}` : path;
      }

      function workspaceSlug(workspace) {
        return safeName(workspace?.name || "workspace").toLowerCase();
      }

      function parseLocalAppRoute(pathname = location.pathname, search = location.search) {
        const normalizedPath = String(pathname || "");
        if (normalizedPath === "/app" || normalizedPath === "/app/") {
          return { kind: "local-app", mode: "active", workspaceSlug: "", routePath: "/", queryString: String(search || "").replace(/^\?/, ""), path: normalizedPath };
        }
        if (normalizedPath.startsWith("/app/")) {
          const routePath = normalizedPath.slice("/app".length) || "/";
          return { kind: "local-app", mode: "active", workspaceSlug: "", routePath: routePath.startsWith("/") ? routePath : `/${routePath}`, queryString: String(search || "").replace(/^\?/, ""), path: normalizedPath };
        }
        if (normalizedPath === "/w") return null;
        if (normalizedPath.startsWith("/w/")) {
          const rest = normalizedPath.slice(3);
          const slashIndex = rest.indexOf("/");
          const rawWorkspaceSlug = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
          if (!rawWorkspaceSlug) return null;
          const routePath = slashIndex === -1 ? "/" : rest.slice(slashIndex);
          return {
            kind: "local-app",
            mode: "named",
            workspaceSlug: decodeURIComponent(rawWorkspaceSlug),
            routePath: routePath && routePath.startsWith("/") ? routePath : "/",
            queryString: String(search || "").replace(/^\?/, ""),
            path: normalizedPath,
          };
        }
        return null;
      }

      function localAppBrowserUrl(context, routePath = "/", queryString = "") {
        if (!context) return "/";
        const encodedPath = encodeBrowserPath(routePath || "/");
        const base = context.mode === "named" && context.workspaceSlug
          ? `/w/${encodeURIComponent(context.workspaceSlug)}`
          : "/app";
        const path = encodedPath === "/" ? `${base}/` : `${base}${encodedPath}`;
        const query = String(queryString || "").replace(/^\?/, "");
        return query ? `${path}?${query}` : path;
      }

      function configureLocalAppRouting(workspace, locator = null) {
        if (!workspace?.id) {
          appModeState.localRoute = null;
          return null;
        }
        const context = {
          workspaceId: workspace.id,
          workspaceSlug: locator?.workspaceSlug || workspaceSlug(workspace),
          mode: locator?.mode || "active",
          fallbackUrl: "/",
        };
        appModeState.localRoute = context;
        return context;
      }

      function clearLocalAppRouting() {
        appModeState.localRoute = null;
      }

      function syncLocalAppBrowserRoute(routePath = "/", queryString = "", mode = "push") {
        const localRoute = appModeState.localRoute;
        if (!localRoute?.workspaceId) return;
        const nextUrl = localAppBrowserUrl(localRoute, routePath, queryString);
        const currentUrl = `${location.pathname}${location.search}`;
        if (nextUrl === currentUrl) return;
        const method = mode === "replace" ? "replaceState" : "pushState";
        history[method]({ edgetermLocalApp: true, workspaceId: localRoute.workspaceId }, "", nextUrl);
      }

      function shareWorkspaceFallbackUrl(meta) {
        if (meta?.share?.publicPath) return meta.share.publicPath;
        if (meta?.share?.id) return `/?share=${encodeURIComponent(meta.share.id)}`;
        return "/";
      }

      function configureSharedAppRouting(meta, locator = null) {
        const shareId = meta?.share?.id || locator?.shareId || locator?.value || "";
        if (!shareId) {
          appModeState.shareRoute = null;
          return null;
        }
        const context = {
          shareId,
          basePath: `/s/${encodeURIComponent(shareId)}`,
          fallbackUrl: shareWorkspaceFallbackUrl(meta),
          deferredWorkspaceBoot: false,
        };
        appModeState.shareRoute = context;
        return context;
      }

      function clearSharedAppRouting() {
        appModeState.shareRoute = null;
      }

      function syncSharedAppBrowserRoute(routePath = "/", queryString = "", mode = "push") {
        const shareRoute = appModeState.shareRoute;
        if (!shareRoute?.shareId) return;
        const nextUrl = sharedAppBrowserUrl(shareRoute.shareId, routePath, queryString);
        const currentUrl = `${location.pathname}${location.search}`;
        if (nextUrl === currentUrl) return;
        const method = mode === "replace" ? "replaceState" : "pushState";
        history[method]({ edgetermShareApp: true, shareId: shareRoute.shareId }, "", nextUrl);
      }

      function currentShareLocator() {
        const localAppRoute = parseLocalAppRoute();
        if (localAppRoute) return localAppRoute;
        if (!CLOUD_ENABLED) return null;
        const sharedAppRoute = parseSharedAppRoute();
        if (sharedAppRoute) return sharedAppRoute;
        const queryShareId = new URLSearchParams(location.search).get("share");
        if (queryShareId) return { kind: "id", value: queryShareId };
        const path = location.pathname;
        if (path && path !== "/" && path !== "/index.html" && path !== "/admin") {
          const parts = path.split("/").filter(Boolean);
          if (parts.length === 2) return { kind: "path", value: path };
        }
        return null;
      }

      function applyEditionMode() {
        document.body.dataset.cloudEnabled = CLOUD_ENABLED ? "true" : "false";
        const cloudTab = document.querySelector('[data-view="cloudView"]');
        const adminTab = $id("adminTab");
        const cloudView = $id("cloudView");
        const adminView = $id("adminView");
        cloudTab?.classList.toggle("hidden", !CLOUD_ENABLED);
        adminTab?.classList.toggle("hidden", !CLOUD_ENABLED || cloudUser?.role !== "admin");
        cloudView?.classList.toggle("hidden", !CLOUD_ENABLED);
        adminView?.classList.toggle("hidden", !CLOUD_ENABLED);
      }

      function openDialog({ title, message = "", fields = [], confirmLabel = "Continue", danger = false }) {
        return new Promise((resolve) => {
          const host = $id("dialogHost");
          host.classList.remove("hidden");
          host.innerHTML = `
            <form class="dialog">
              <h2></h2>
              <p class="dialog-message"></p>
              <div class="dialog-fields"></div>
              <div class="dialog-actions">
                <button type="button" class="dialog-cancel">Cancel</button>
                <button type="submit" class="${danger ? "button-danger" : "button-primary"}"></button>
              </div>
            </form>
          `;
          const form = host.querySelector("form");
          form.querySelector("h2").textContent = title;
          form.querySelector(".dialog-message").textContent = message;
          form.querySelector(".dialog-message").classList.toggle("hidden", !message);
          form.querySelector("button[type='submit']").textContent = confirmLabel;
          const fieldWrap = form.querySelector(".dialog-fields");
          for (const field of fields) {
            const wrapper = document.createElement("div");
            wrapper.className = field.type === "checkbox" ? "dialog-checkbox" : "setting-field";
            let input;
            if (field.type === "select") {
              wrapper.innerHTML = `<label></label>`;
              wrapper.querySelector("label").textContent = field.label;
              input = document.createElement("select");
              for (const option of field.options || []) {
                const opt = document.createElement("option");
                opt.value = typeof option === "string" ? option : option.value;
                opt.textContent = typeof option === "string" ? option : option.label;
                input.appendChild(opt);
              }
            } else if (field.type === "checkbox") {
              const label = document.createElement("label");
              label.textContent = field.label;
              input = document.createElement("input");
              input.type = "checkbox";
              input.checked = field.checked ?? (field.value === true || field.value === "true");
              wrapper.appendChild(input);
              wrapper.appendChild(label);
            } else if (field.type === "textarea") {
              wrapper.innerHTML = `<label></label>`;
              wrapper.querySelector("label").textContent = field.label;
              input = document.createElement("textarea");
            } else {
              wrapper.innerHTML = `<label></label>`;
              wrapper.querySelector("label").textContent = field.label;
              input = document.createElement("input");
              input.type = field.type || "text";
            }
            input.name = field.name;
            if (field.type !== "checkbox") input.value = field.value || "";
            input.placeholder = field.placeholder || "";
            if (field.required !== false) input.required = true;
            if (field.type !== "checkbox") wrapper.appendChild(input);
            fieldWrap.appendChild(wrapper);
          }
          const close = (value) => {
            host.classList.add("hidden");
            host.textContent = "";
            resolve(value);
          };
          form.querySelector(".dialog-cancel").addEventListener("click", () => close(null));
          host.addEventListener("click", (event) => {
            if (event.target === host) close(null);
          }, { once: true });
          form.addEventListener("submit", (event) => {
            event.preventDefault();
            const data = Object.fromEntries(new FormData(form).entries());
            for (const field of fields) {
              if (field.type === "checkbox") data[field.name] = !!form.elements[field.name]?.checked;
            }
            close(fields.length ? data : true);
          });
          form.querySelector("input, button[type='submit']")?.focus();
        });
      }

      async function askText(title, label, value = "", options = {}) {
        const result = await openDialog({
          title,
          message: options.message || "",
          confirmLabel: options.confirmLabel || "Save",
          fields: [{ name: "value", label, value, placeholder: options.placeholder || "", required: options.required !== false }],
        });
        return result ? String(result.value || "") : "";
      }

      async function askFields(title, fields, options = {}) {
        return await openDialog({
          title,
          message: options.message || "",
          confirmLabel: options.confirmLabel || "Save",
          fields,
        });
      }

      async function askConfirm(title, message, options = {}) {
        return !!(await openDialog({
          title,
          message,
          confirmLabel: options.confirmLabel || "Continue",
          danger: !!options.danger,
        }));
      }

      function setBusy(active, message = "Working...") {
        const overlay = $id("loading");
        const label = $id("loadingLabel");
        if (active) {
          busyCount += 1;
          overlay.classList.remove("hidden");
          if (busyCount === 1) resetLoadingTransfer();
          setLoadingMessage(message);
          showLoadingIndeterminate(message, "Preparing transfer or local processing...");
          return;
        }
        busyCount = Math.max(0, busyCount - 1);
        if (busyCount === 0) {
          resetLoadingTransfer();
          overlay.classList.add("hidden");
        }
      }

      function revealApp() {
        busyCount = 0;
        resetLoadingTransfer();
        $id("loading")?.classList.add("hidden");
        $id("app")?.classList.remove("hidden");
      }

      function setLoadingMessage(message = "Working...") {
        const label = $id("loadingLabel");
        if (label) label.textContent = String(message || "Working...");
      }

      function resetLoadingTransfer() {
        const wrap = $id("loadingTransfer");
        const fill = $id("loadingProgressFill");
        const progress = $id("loadingProgressText");
        const speed = $id("loadingSpeedText");
        const meta = $id("loadingTransferMeta");
        wrap?.classList.add("hidden");
        wrap?.classList.remove("indeterminate");
        if (fill) fill.style.width = "0%";
        if (progress) progress.textContent = "0%";
        if (speed) {
          speed.textContent = "";
          speed.style.visibility = "hidden";
        }
        if (meta) meta.textContent = "Waiting for transfer...";
      }

      function showLoadingIndeterminate(phase = "Working...", detail = "Local processing...", speedText = "") {
        const wrap = $id("loadingTransfer");
        const fill = $id("loadingProgressFill");
        const progress = $id("loadingProgressText");
        const speed = $id("loadingSpeedText");
        const meta = $id("loadingTransferMeta");
        if (!wrap) return;
        wrap.classList.remove("hidden");
        wrap.classList.add("indeterminate");
        if (fill) fill.style.width = "32%";
        if (progress) progress.textContent = phase;
        if (speed) {
          speed.textContent = speedText;
          speed.style.visibility = speedText ? "visible" : "hidden";
        }
        if (meta) meta.textContent = detail;
      }

      function formatRate(bytesPerSecond) {
        if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "0 B/s";
        return `${formatBytes(Math.round(bytesPerSecond))}/s`;
      }

      function updateLoadingTransfer({ loaded = 0, total = 0, bytesPerSecond = 0, phase = "Transferring rootfs..." } = {}) {
        const wrap = $id("loadingTransfer");
        const fill = $id("loadingProgressFill");
        const progress = $id("loadingProgressText");
        const speed = $id("loadingSpeedText");
        const meta = $id("loadingTransferMeta");
        if (!wrap) return;
        const hasTotal = Number.isFinite(total) && total > 0;
        const safeLoaded = Math.max(0, Number(loaded) || 0);
        const safeTotal = hasTotal ? Math.max(safeLoaded, Number(total) || 0) : 0;
        wrap.classList.remove("hidden");
        wrap.classList.toggle("indeterminate", !hasTotal);
        if (fill) fill.style.width = hasTotal ? `${Math.min(100, (safeLoaded / safeTotal) * 100)}%` : "32%";
        if (progress) progress.textContent = hasTotal ? `${Math.round((safeLoaded / safeTotal) * 100)}%` : formatBytes(safeLoaded);
        if (speed) {
          speed.textContent = formatRate(bytesPerSecond);
          speed.style.visibility = "visible";
        }
        if (meta) {
          meta.textContent = hasTotal
            ? `${phase} ${formatBytes(safeLoaded)} / ${formatBytes(safeTotal)}`
            : `${phase} ${formatBytes(safeLoaded)} transferred`;
        }
      }

      async function readResponseBlobWithProgress(response, phase) {
        if (!response.body) return await response.blob();
        const total = Number(response.headers.get("Content-Length") || 0);
        const reader = response.body.getReader();
        const chunks = [];
        let loaded = 0;
        const startedAt = performance.now();
        updateLoadingTransfer({ loaded: 0, total, bytesPerSecond: 0, phase });
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            loaded += value.byteLength;
            const elapsedSeconds = Math.max(0.001, (performance.now() - startedAt) / 1000);
            updateLoadingTransfer({
              loaded,
              total,
              bytesPerSecond: loaded / elapsedSeconds,
              phase,
            });
          }
        }
        return new Blob(chunks, { type: response.headers.get("Content-Type") || "application/octet-stream" });
      }

      function xhrRequestWithProgress(url, { method = "GET", headers = {}, body = null, phase = "Transferring rootfs..." } = {}) {
        return new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          const total = body?.size || body?.byteLength || 0;
          const startedAt = performance.now();
          xhr.open(method, url, true);
          Object.entries(headers || {}).forEach(([key, value]) => {
            if (value != null) xhr.setRequestHeader(key, value);
          });
          updateLoadingTransfer({ loaded: 0, total, bytesPerSecond: 0, phase });
          xhr.upload.onprogress = (event) => {
            const loaded = Number(event.loaded || 0);
            const knownTotal = event.lengthComputable ? Number(event.total || total) : total;
            const elapsedSeconds = Math.max(0.001, (performance.now() - startedAt) / 1000);
            updateLoadingTransfer({
              loaded,
              total: knownTotal,
              bytesPerSecond: loaded / elapsedSeconds,
              phase,
            });
          };
          xhr.onload = () => {
            resolve({
              ok: xhr.status >= 200 && xhr.status < 300,
              status: xhr.status,
              responseText: xhr.responseText,
            });
          };
          xhr.onerror = () => reject(new Error("Network transfer failed"));
          xhr.send(body);
        });
      }

      function showBootStatus(message, isError = false) {
        setLoadingMessage(String(message || "").split("\n")[0] || "Loading EdgeTerm runtime...");
        if (term) {
          const writer = isError ? term.error.bind(term) : term.echo.bind(term);
          writer(message);
          return;
        }
        const terminalNode = $id("terminal");
        if (!terminalNode) return;
        terminalNode.textContent = message;
        terminalNode.style.padding = "12px";
        terminalNode.style.whiteSpace = "pre-wrap";
        terminalNode.style.color = isError ? "#ff7b72" : "#8b949e";
        terminalNode.style.font = '14px/1.5 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace';
      }

      function applySidebarWidth(width = sidebarWidth) {
        sidebarWidth = Math.max(220, Math.min(420, Number(width) || 260));
        $id("app")?.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
        localStorage.setItem("edgeterm.sidebar.width", String(sidebarWidth));
      }

      function setSidebarOpen(open) {
        const app = $id("app");
        const backdrop = $id("sidebarBackdrop");
        const mobile = window.innerWidth <= 820;
        if (mobile) {
          const shouldOpen = !!open;
          app?.classList.toggle("sidebar-open", shouldOpen);
          app?.classList.remove("sidebar-collapsed");
          backdrop?.classList.toggle("hidden", !shouldOpen);
          return;
        }
        app?.classList.remove("sidebar-open");
        app?.classList.toggle("sidebar-collapsed", !open);
        backdrop?.classList.add("hidden");
      }

      function cleanTerminalCopyText(text) {
        const hiddenTextareaLabels = new Set([
          "Clipbard textarea for jQuery Terminal",
          "Clipboard textarea for jQuery Terminal",
        ]);
        return String(text)
          .split(/\r?\n/)
          .filter((line) => !hiddenTextareaLabels.has(line.trim()))
          .join("\n");
      }

      function selectionTouchesTerminal(selection) {
        const terminalNode = $id("terminal");
        if (!terminalNode || !selection?.rangeCount) return false;
        const containsNode = (node) => {
          const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
          return !!element && terminalNode.contains(element);
        };
        return containsNode(selection.anchorNode) || containsNode(selection.focusNode) || containsNode(document.activeElement);
      }

      function installTerminalCopySanitizer() {
        if (terminalCopyHandlerInstalled) return;
        terminalCopyHandlerInstalled = true;
        document.addEventListener(
          "copy",
          (event) => {
            const selection = window.getSelection();
            if (!selectionTouchesTerminal(selection)) return;
            const copiedText = cleanTerminalCopyText(selection.toString());
            if (copiedText === selection.toString()) return;
            event.clipboardData?.setData("text/plain", copiedText);
            event.preventDefault();
          },
          true
        );
      }

      function initializeTerminal() {
        if (term) return;
        $id("terminal").textContent = "";
        term = $("#terminal").terminal(
          async (command) => {
            if (!pyodide || !edgeTermShell) {
              term.error("EdgeTerm runtime is still loading. Please try again in a moment.");
              return;
            }
            return await runCommand(command);
          },
          {
            name: "edgeterm-workspace",
            history: true,
            greetings: false,
            prompt: "loading... ",
          }
        );
        installTerminalCopySanitizer();

        // Bridge for synchronous stdin from Python/Pyodide.
        // Python posts {type:"stdin_request", prompt:"..."} and polls
        // window.__edgeterm_stdin_result while time.sleep() yields.
        window.addEventListener("message", async (event) => {
          const data = event.data || {};
          if (data.type !== "stdin_request") return;
          try {
            const input = await window.terminal.input(data.prompt || "") || "";
            window.__edgeterm_stdin_result = input;
          } catch {
            window.__edgeterm_stdin_result = "";
          }
        });
      }

      async function withBusy(message, work) {
        setBusy(true, message);
        try {
          return await work();
        } finally {
          setBusy(false);
        }
      }

      function syncfs(load = false) {
        const run = () => new Promise((resolve, reject) => {
          pyodide.FS.syncfs(load, (err) => (err ? reject(err) : resolve()));
        });
        const next = syncfsChain.catch(() => {}).then(run);
        syncfsChain = next.catch(() => {});
        return next;
      }

      function safeName(value) {
        const clean = value.trim().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
        return clean || "workspace";
      }

      function stableShortHash(value) {
        let first = 0x811c9dc5;
        let second = 0x01000193;
        const source = String(value || "");
        for (let index = 0; index < source.length; index += 1) {
          const code = source.charCodeAt(index);
          first ^= code;
          first = Math.imul(first, 0x01000193);
          second ^= code + index;
          second = Math.imul(second, 0x811c9dc5);
        }
        return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`.slice(0, 10);
      }

      function normalizeEdgeServeRouteMode(mode) {
        const value = String(mode || "wsgi").trim().toLowerCase();
        if (value === "fastapi" || value === "starlette" || value === "asgi") return "asgi";
        if (value === "static") return "static";
        return "wsgi";
      }

      function stableEdgeServeIdentity(mode, spec, cwd) {
        const routeMode = normalizeEdgeServeRouteMode(mode);
        const basis = JSON.stringify({
          workspaceId: activeWorkspaceId || activeWorkspace()?.id || "",
          mode: String(mode || "").trim().toLowerCase(),
          spec: String(spec || "").trim(),
          cwd: normalizePath(cwd || "/"),
        });
        const instanceId = stableShortHash(basis);
        return { instanceId, routePrefix: `/${routeMode}-${instanceId}` };
      }

      function workspacePath(id, child = "") {
        return `/workspace-store/${id}${child}`;
      }

      function isWorkspaceStorageMounted(id) {
        return !!id && mountedWorkspaceId === id;
      }

      function loadIsolatedWorkspaceMap() {
        try {
          return JSON.parse(localStorage.getItem(ISOLATED_WORKSPACE_STORAGE_KEY) || "{}") || {};
        } catch {
          return {};
        }
      }

      function isWorkspaceStorageIsolated(id) {
        return !!loadIsolatedWorkspaceMap()[id];
      }

      function markWorkspaceStorageIsolated(id) {
        const map = loadIsolatedWorkspaceMap();
        map[id] = true;
        localStorage.setItem(ISOLATED_WORKSPACE_STORAGE_KEY, JSON.stringify(map));
      }

      function workspaceTreeHasData(path) {
        const fs = pyodide.FS;
        if (!fs.analyzePath(path).exists) return false;
        try {
          return fs.readdir(path).some((entry) => entry !== "." && entry !== "..");
        } catch {
          return false;
        }
      }

      async function migrateLegacyWorkspaceStorage(id) {
        if (!id || isWorkspaceStorageIsolated(id)) return;
        const sourcePath = workspacePath(id);
        const migrationTempPath = `/tmp/edgeterm-migrate-${id}`;
        ensureDir("/tmp");
        removeTree(migrationTempPath);
        ensureDir("/workspace-store");

        let copiedLegacyData = false;
        try {
          pyodide.FS.mount(pyodide.FS.filesystems.IDBFS, {}, "/workspace-store");
          await syncfs(true);
          if (workspaceTreeHasData(sourcePath)) {
            copyTree(sourcePath, migrationTempPath);
            copiedLegacyData = true;
          }
        } catch (err) {
          console.warn("[PERSIST] Legacy workspace migration skipped:", err);
        } finally {
          try {
            pyodide.FS.unmount("/workspace-store");
          } catch (err) {
            console.warn("[PERSIST] Legacy workspace unmount skipped:", err);
          }
        }

        ensureDir("/workspace-store");
        ensureDir(sourcePath);
        pyodide.FS.mount(pyodide.FS.filesystems.IDBFS, {}, sourcePath);
        mountedWorkspaceId = id;
        await syncfs(true);
        if (copiedLegacyData && workspaceTreeHasData(migrationTempPath)) {
          clearDirectory(sourcePath);
          copyTree(migrationTempPath, sourcePath);
          await syncfs(false);
        }
        try {
          pyodide.FS.unmount(sourcePath);
        } catch (err) {
          console.warn("[PERSIST] Migrated workspace unmount skipped:", err);
        }
        mountedWorkspaceId = "";
        removeTree(migrationTempPath);
        markWorkspaceStorageIsolated(id);
      }

      async function mountWorkspaceStorage(id, options = {}) {
        const workspace = workspaces.find((item) => item.id === id);
        if (mountedWorkspaceId && mountedWorkspaceId !== id) {
          try {
            pyodide.FS.unmount(workspacePath(mountedWorkspaceId));
          } catch (err) {
            console.warn("[PERSIST] Workspace unmount skipped:", err);
          }
          mountedWorkspaceId = "";
        }
        if (!workspace || workspace.transient) {
          mountedWorkspaceId = "";
          ensureDir(workspacePath(id));
          return;
        }
        if (isWorkspaceStorageMounted(id)) return;
        if (options.migrate !== false) await migrateLegacyWorkspaceStorage(id);
        ensureDir("/workspace-store");
        ensureDir(workspacePath(id));
        pyodide.FS.mount(pyodide.FS.filesystems.IDBFS, {}, workspacePath(id));
        mountedWorkspaceId = id;
        if (options.load !== false) await syncfs(true);
      }

      function workspaceJournalKey(workspaceId, relativePath) {
        return `${workspaceId}:${relativePath}`;
      }

      function workspaceRelativePathFromTarget(target, workspaceId = activeWorkspaceId) {
        const root = workspacePath(workspaceId);
        const normalizedTarget = normalizePath(target);
        if (!normalizedTarget.startsWith(root)) return "";
        return normalizePath(normalizedTarget.slice(root.length) || "/");
      }

      function idbTransactionDone(tx) {
        return new Promise((resolve, reject) => {
          tx.addEventListener("complete", () => resolve(), { once: true });
          tx.addEventListener("abort", () => reject(tx.error || new Error("IndexedDB transaction aborted")), { once: true });
          tx.addEventListener("error", () => reject(tx.error || new Error("IndexedDB transaction failed")), { once: true });
        });
      }

      async function openWorkspaceJournalDb() {
        if (typeof indexedDB === "undefined") return null;
        if (!workspaceJournalDbPromise) {
          workspaceJournalDbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(WORKSPACE_JOURNAL_DB, 1);
            request.onupgradeneeded = () => {
              const db = request.result;
              const store = db.objectStoreNames.contains(WORKSPACE_JOURNAL_STORE)
                ? request.transaction.objectStore(WORKSPACE_JOURNAL_STORE)
                : db.createObjectStore(WORKSPACE_JOURNAL_STORE, { keyPath: "key" });
              if (!store.indexNames.contains("workspaceId")) {
                store.createIndex("workspaceId", "workspaceId", { unique: false });
              }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => {
              workspaceJournalDbPromise = null;
              reject(request.error || new Error("Failed to open workspace journal"));
            };
          }).catch((err) => {
            console.warn("[PERSIST] Workspace journal unavailable:", err);
            return null;
          });
        }
        return await workspaceJournalDbPromise;
      }

      async function readWorkspaceJournalRecords(workspaceId) {
        const db = await openWorkspaceJournalDb();
        if (!db) return [];
        const tx = db.transaction(WORKSPACE_JOURNAL_STORE, "readonly");
        const index = tx.objectStore(WORKSPACE_JOURNAL_STORE).index("workspaceId");
        const records = [];
        await new Promise((resolve, reject) => {
          const request = index.openCursor(IDBKeyRange.only(workspaceId));
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
              resolve();
              return;
            }
            records.push(cursor.value);
            cursor.continue();
          };
          request.onerror = () => reject(request.error || new Error("Failed to read workspace journal"));
        });
        await idbTransactionDone(tx);
        return records;
      }

      async function writeWorkspaceJournalEntries(entries) {
        if (!entries.length) return false;
        const db = await openWorkspaceJournalDb();
        if (!db) return false;
        const tx = db.transaction(WORKSPACE_JOURNAL_STORE, "readwrite");
        const store = tx.objectStore(WORKSPACE_JOURNAL_STORE);
        for (const entry of entries) store.put(entry);
        await idbTransactionDone(tx);
        return true;
      }

      function cloneWorkspaceJournalEntry(entry) {
        const cloned = { ...entry };
        if (entry?.bytes !== undefined) {
          const bytes = entry.bytes instanceof Uint8Array ? entry.bytes : new Uint8Array(entry.bytes || new ArrayBuffer(0));
          cloned.bytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        }
        return cloned;
      }

      async function clearWorkspaceJournal(workspaceId) {
        const db = await openWorkspaceJournalDb();
        if (!db) return;
        const records = await readWorkspaceJournalRecords(workspaceId);
        if (!records.length) return;
        const tx = db.transaction(WORKSPACE_JOURNAL_STORE, "readwrite");
        const store = tx.objectStore(WORKSPACE_JOURNAL_STORE);
        for (const record of records) store.delete(record.key);
        await idbTransactionDone(tx);
      }

      async function clearAllWorkspaceJournal() {
        const db = await openWorkspaceJournalDb();
        if (!db) return;
        const tx = db.transaction(WORKSPACE_JOURNAL_STORE, "readwrite");
        tx.objectStore(WORKSPACE_JOURNAL_STORE).clear();
        await idbTransactionDone(tx);
      }

      function buildWorkspaceJournalEntriesForTargets(targets, workspaceId = activeWorkspaceId, fileBytesByTarget = null) {
        const workspace = workspaces.find((item) => item.id === workspaceId);
        if (!workspace || workspace.transient) return [];
        const fs = pyodide.FS;
        const entries = [];
        const seen = new Set();
        for (const target of targets.map((value) => normalizePath(value)).filter(Boolean)) {
          if (seen.has(target)) continue;
          seen.add(target);
          const relativePath = workspaceRelativePathFromTarget(target, workspaceId);
          if (!relativePath) continue;
          const base = {
            key: workspaceJournalKey(workspaceId, relativePath),
            workspaceId,
            path: relativePath,
            updatedAt: Date.now(),
          };
          if (!fs.analyzePath(target).exists) {
            entries.push({ ...base, kind: "delete" });
            continue;
          }
          const stat = fs.lstat(target);
          if (fs.isDir(stat.mode) && !fs.isLink(stat.mode)) {
            entries.push({ ...base, kind: "dir" });
            continue;
          }
          const explicitBytes = fileBytesByTarget instanceof Map ? fileBytesByTarget.get(target) : null;
          const bytes = explicitBytes ?? fs.readFile(target);
          entries.push({
            ...base,
            kind: "file",
            bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          });
        }
        return entries;
      }

      async function persistWorkspaceMirrorTargets(targets, workspaceId = activeWorkspaceId, fileBytesByTarget = null) {
        const entries = buildWorkspaceJournalEntriesForTargets(targets, workspaceId, fileBytesByTarget);
        if (!entries.length) return false;
        return await writeWorkspaceJournalEntries(entries);
      }

      async function flushQueuedWorkspaceJournalEntries() {
        if (!queuedWorkspaceJournalEntries.size) return false;
        const entries = Array.from(queuedWorkspaceJournalEntries.values(), cloneWorkspaceJournalEntry);
        queuedWorkspaceJournalEntries.clear();
        return await writeWorkspaceJournalEntries(entries);
      }

      function scheduleWorkspaceJournalFlush(delay = 40) {
        if (workspaceJournalFlushTimeout) clearTimeout(workspaceJournalFlushTimeout);
        workspaceJournalFlushTimeout = setTimeout(() => {
          workspaceJournalFlushTimeout = null;
          if (workspaceJournalFlushInFlight) {
            pendingWorkspaceJournalFlushAfterInFlight = true;
            return;
          }
          workspaceJournalFlushInFlight = flushQueuedWorkspaceJournalEntries()
            .catch((err) => {
              console.error("[PERSIST] Workspace journal flush failed:", err);
            })
            .finally(() => {
              workspaceJournalFlushInFlight = null;
              if (pendingWorkspaceJournalFlushAfterInFlight) {
                pendingWorkspaceJournalFlushAfterInFlight = false;
                scheduleWorkspaceJournalFlush(80);
              }
            });
        }, delay);
      }

      function queueWorkspaceMirrorTargets(targets, workspaceId = activeWorkspaceId, fileBytesByTarget = null, delay = 40) {
        const entries = buildWorkspaceJournalEntriesForTargets(targets, workspaceId, fileBytesByTarget);
        if (!entries.length) return false;
        for (const entry of entries) {
          queuedWorkspaceJournalEntries.set(entry.key, cloneWorkspaceJournalEntry(entry));
        }
        scheduleWorkspaceJournalFlush(delay);
        return true;
      }

      function queuedWorkspaceJournalEntryForRuntimePath(path, workspaceId = activeWorkspaceId) {
        const mirrorTarget = workspaceMirrorPathForRuntimePath(path);
        if (!mirrorTarget) return null;
        const relativePath = workspaceRelativePathFromTarget(mirrorTarget, workspaceId);
        if (!relativePath) return null;
        return queuedWorkspaceJournalEntries.get(workspaceJournalKey(workspaceId, relativePath)) || null;
      }

      function encodeFileContent(content) {
        if (content instanceof Uint8Array) return content;
        if (content instanceof ArrayBuffer) return new Uint8Array(content);
        return new TextEncoder().encode(String(content ?? ""));
      }

      async function writeRuntimeFileAndMirror(path, content) {
        const normalizedPath = normalizePath(path);
        const bytes = encodeFileContent(content);
        ensureDir(normalizedPath.split("/").slice(0, -1).join("/") || "/");
        pyodide.FS.writeFile(normalizedPath, bytes);
        const mirrorTarget = workspaceMirrorPathForRuntimePath(normalizedPath);
        if (mirrorTarget) {
          ensureDir(mirrorTarget.split("/").slice(0, -1).join("/") || "/");
          pyodide.FS.writeFile(mirrorTarget, bytes);
          await persistWorkspaceMirrorTargets([mirrorTarget], activeWorkspaceId, new Map([[mirrorTarget, bytes]]));
        } else {
          schedulePersistActiveWorkspace(750);
        }
        return bytes;
      }

      async function restoreWorkspaceJournal(workspaceId) {
        const records = await readWorkspaceJournalRecords(workspaceId);
        if (!records.length) return;
        records.sort((left, right) => left.path.localeCompare(right.path));
        for (const record of records) {
          const target = workspacePath(workspaceId, record.path || "/");
          if (record.kind === "delete") {
            removeTree(target);
            continue;
          }
          if (record.kind === "dir") {
            ensureDir(target);
            continue;
          }
          ensureDir(target.split("/").slice(0, -1).join("/") || "/");
          pyodide.FS.writeFile(target, new Uint8Array(record.bytes || new ArrayBuffer(0)));
        }
      }

      function packageManifestPath(packageName) {
        return `/packages/${packageName}/package.json`;
      }

      function packageRootPath(packageName) {
        return `/packages/${packageName}`;
      }

      function activeWorkspace() {
        return workspaces.find((workspace) => workspace.id === activeWorkspaceId);
      }

      function activeUser() {
        return activeWorkspace()?.userName || "user";
      }

      function loadWorkspaceRegistry() {
        try {
          workspaces = JSON.parse(localStorage.getItem(WORKSPACE_KEY) || "[]");
        } catch {
          workspaces = [];
        }

        if (workspaces.length === 0) {
          const id = `ws-${Date.now()}`;
          workspaces = [{ id, name: "Default Workspace", createdAt: Date.now(), rootfsVersion: "", users: ["user"], userName: "user" }];
          localStorage.setItem(WORKSPACE_KEY, JSON.stringify(workspaces));
          localStorage.setItem(ACTIVE_KEY, id);
        }

        workspaces = workspaces.map((workspace) => ({
          ...workspace,
          users: Array.isArray(workspace.users) && workspace.users.length ? workspace.users : ["user"],
          userName: workspace.userName || "user",
        }));

        workspaceShareOrigins = new Map(
          workspaces
            .filter((workspace) => workspace?.shareOrigin?.share?.id)
            .map((workspace) => [workspace.id, workspace.shareOrigin])
        );

        activeWorkspaceId = localStorage.getItem(ACTIVE_KEY) || workspaces[0].id;
        if (!workspaces.some((workspace) => workspace.id === activeWorkspaceId)) {
          activeWorkspaceId = workspaces[0].id;
          localStorage.setItem(ACTIVE_KEY, activeWorkspaceId);
        }
      }

      function saveWorkspaceRegistry() {
        localStorage.setItem(WORKSPACE_KEY, JSON.stringify(workspaces.filter((workspace) => !workspace.transient)));
        localStorage.setItem(ACTIVE_KEY, activeWorkspaceId);
      }

      function readJsonFile(path) {
        return JSON.parse(pyodide.FS.readFile(path, { encoding: "utf8" }));
      }

      function writeTextFile(path, value) {
        ensureDir(path.split("/").slice(0, -1).join("/") || "/");
        pyodide.FS.writeFile(path, String(value));
      }

      function writeJsonFile(path, value) {
        writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
      }

      function cloneValue(value) {
        return JSON.parse(JSON.stringify(value));
      }

      function deepMerge(base, extra) {
        if (Array.isArray(base) || Array.isArray(extra)) return cloneValue(extra ?? base);
        const output = { ...(base || {}) };
        for (const [key, value] of Object.entries(extra || {})) {
          if (value && typeof value === "object" && !Array.isArray(value) && output[key] && typeof output[key] === "object" && !Array.isArray(output[key])) {
            output[key] = deepMerge(output[key], value);
          } else {
            output[key] = cloneValue(value);
          }
        }
        return output;
      }

      function appModeConfigPath() {
        return "/etc/appmode/config.json";
      }

      function defaultAppModeConfig() {
        return cloneValue(DEFAULT_APP_MODE_CONFIG);
      }

      function normalizeAppModeConfig(raw = {}) {
        const merged = deepMerge(DEFAULT_APP_MODE_CONFIG, raw || {});
        merged.runtime = ["python", "static"].includes(merged.runtime) ? merged.runtime : "python";
        merged.entrypoint = String(merged.entrypoint || (merged.runtime === "static" ? "/home/user/index.html" : "/home/user/app.py"));
        merged.staticRoot = String(merged.staticRoot || "/home/user/public");
        merged.workingDirectory = String(merged.workingDirectory || "/home/user");
        merged.fullscreen = merged.fullscreen !== false;
        merged.autoStart = merged.autoStart !== false;
        merged.preserveStateOnExit = merged.preserveStateOnExit !== false;
        merged.showLoadingOverlay = merged.showLoadingOverlay !== false;
        merged.exit = deepMerge(DEFAULT_APP_MODE_CONFIG.exit, merged.exit || {});
        merged.ui = deepMerge(DEFAULT_APP_MODE_CONFIG.ui, merged.ui || {});
        merged.python = deepMerge(DEFAULT_APP_MODE_CONFIG.python, merged.python || {});
        merged.static = deepMerge(DEFAULT_APP_MODE_CONFIG.static, merged.static || {});
        merged.exit.hotkey = String(merged.exit.hotkey || "Escape");
        merged.ui.debugTerminalHotkey = String(merged.ui.debugTerminalHotkey || "Ctrl+`");
        merged.python.appObject = String(merged.python.appObject || "app");
        merged.python.appSpec = String(merged.python.appSpec || "");
        merged.python.framework = String(merged.python.framework || "edgeterm");
        merged.python.routePrefix = String(merged.python.routePrefix || "/");
        merged.static.indexFile = String(merged.static.indexFile || "index.html");
        return merged;
      }

      function ensureAppModeConfigFile() {
        const path = appModeConfigPath();
        ensureDir("/etc/appmode");
        if (!pyodide.FS.analyzePath(path).exists) writeJsonFile(path, defaultAppModeConfig());
      }

      function readAppModeConfig() {
        ensureAppModeConfigFile();
        try {
          return normalizeAppModeConfig(readJsonFile(appModeConfigPath()));
        } catch (err) {
          console.error("[APPMODE] Failed to read config:", err);
          const fallback = defaultAppModeConfig();
          writeJsonFile(appModeConfigPath(), fallback);
          return fallback;
        }
      }

      async function saveAppModeConfig(config) {
        const normalized = normalizeAppModeConfig(config);
        writeJsonFile(appModeConfigPath(), normalized);
        await persistActiveWorkspace();
        appModeState.config = normalized;
        return normalized;
      }

      function currentViewId() {
        return document.querySelector(".view.active")?.id || "terminalView";
      }

      function filesViewIsActive() {
        return currentViewId() === "filesView";
      }

      function refreshFilesIfVisible(path = currentPath) {
        if (filesViewIsActive()) refreshFiles(path);
      }

      function setAppModeLoading(visible, message = "Preparing workspace app...", title = "Starting App Mode") {
        $id("appModeLoadingTitle").textContent = title;
        $id("appModeLoadingMessage").textContent = message;
        $id("appModeLoadingHint").textContent = `Press ${(appModeState.config?.exit?.hotkey || "Escape")} to leave App Mode.`;
        $id("appModeLoading").classList.toggle("hidden", !visible);
      }

      function revokeAppModeBlobs() {
        for (const url of appModeState.blobUrls) {
          try {
            URL.revokeObjectURL(url);
          } catch {}
        }
        appModeState.blobUrls = [];
      }

      function clearAppModeFrame() {
        revokeAppModeBlobs();
        const frame = $id("appModeFrame");
        frame.srcdoc = "<!doctype html><title>EdgeTerm App Mode</title>";
        appModeState.currentPath = "/";
        appModeState.htmlPath = "";
      }

      function setAppModeVisible(visible, config = appModeState.config) {
        const shell = $id("appModeShell");
        if (appModeState.renderTarget === "display") {
          shell.classList.add("hidden");
          shell.classList.remove("windowed");
          document.body.classList.remove("app-mode-active");
          return;
        }
        shell.classList.toggle("hidden", !visible);
        shell.classList.toggle("windowed", !!visible && config?.fullscreen === false);
        document.body.classList.toggle("app-mode-active", !!visible && !!config?.ui?.hideWorkspaceChrome);
      }

      function showAppModeError(summary, detail = "") {
        $id("appModeErrorSummary").textContent = summary || "The workspace app could not be loaded.";
        $id("appModeErrorDetail").textContent = detail || "";
        $id("appModeError").classList.remove("hidden");
        setAppModeLoading(false);
      }

      function hideAppModeError() {
        $id("appModeError").classList.add("hidden");
      }

      function isImagePath(path) {
        return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(path);
      }

      function isHtmlPath(path) {
        return /\.(html?|xhtml)$/i.test(path);
      }

      function isPreviewablePath(path) {
        return isImagePath(path) || isHtmlPath(path);
      }

      function closePreview() {
        $id("previewModal").classList.add("hidden");
        $id("previewStage").innerHTML = "";
        if (previewObjectUrl) {
          URL.revokeObjectURL(previewObjectUrl);
          previewObjectUrl = null;
        }
        previewPath = "";
      }

      async function openPreview(path) {
        const target = normalizePath(path);
        if (!pyodide.FS.analyzePath(target).exists || !isPreviewablePath(target)) {
          showNotice("Preview is available for image and HTML files");
          return;
        }
        closePreview();
        previewPath = target;
        $id("previewPath").value = target;
        const bytes = pyodide.FS.readFile(target);
        const mime = isHtmlPath(target)
          ? "text/html"
          : target.toLowerCase().endsWith(".svg")
            ? "image/svg+xml"
            : target.toLowerCase().endsWith(".png")
              ? "image/png"
              : target.toLowerCase().endsWith(".gif")
                ? "image/gif"
                : target.toLowerCase().endsWith(".webp")
                  ? "image/webp"
                  : target.toLowerCase().endsWith(".bmp")
                    ? "image/bmp"
                    : "image/jpeg";
        previewObjectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
        $id("previewStage").innerHTML = isHtmlPath(target)
          ? `<iframe class="preview-iframe" sandbox="allow-same-origin" src="${previewObjectUrl}"></iframe>`
          : `<img class="preview-image" src="${previewObjectUrl}" alt="${target}" />`;
        $id("previewModal").classList.remove("hidden");
        window.lucide?.createIcons();
      }

      function clearEdgeTermStorageKeys() {
        const keys = [];
        for (let i = 0; i < localStorage.length; i += 1) {
          const key = localStorage.key(i);
          if (!key) continue;
          if (key === WORKSPACE_KEY || key === ACTIVE_KEY || key.startsWith("edgeterm.")) {
            keys.push(key);
          }
        }
        for (const key of keys) localStorage.removeItem(key);
      }

      function serializeSiteDataMap(map) {
        return [...(map || new Map()).entries()]
          .filter(([key]) => !!key)
          .map(([key, value]) => [String(key), String(value)])
          .sort(([left], [right]) => left.localeCompare(right));
      }

      function deserializeSiteDataMap(entries) {
        return new Map(
          (Array.isArray(entries) ? entries : [])
            .filter((entry) => Array.isArray(entry) && entry.length >= 2 && entry[0])
            .map(([key, value]) => [String(key), String(value)])
        );
      }

      function readLegacyAppModeCookieStore() {
        try {
          const parsed = JSON.parse(localStorage.getItem(APPMODE_COOKIE_STORE_KEY) || "{}");
          return parsed && typeof parsed === "object" ? parsed : {};
        } catch {
          return {};
        }
      }

      function writeLegacyAppModeCookieStore(store) {
        try {
          const keys = Object.keys(store || {});
          if (keys.length) localStorage.setItem(APPMODE_COOKIE_STORE_KEY, JSON.stringify(store || {}));
          else localStorage.removeItem(APPMODE_COOKIE_STORE_KEY);
        } catch (err) {
          console.warn("[APPMODE] Failed to persist legacy cookie data:", err);
        }
      }

      function normalizeAppModeSiteRecord(key, record = {}) {
        return {
          key: String(key || ""),
          label: String(record.label || "Site"),
          scope: record.scope && typeof record.scope === "object" ? record.scope : {},
          cookies: serializeSiteDataMap(deserializeSiteDataMap(record.cookies)),
          localStorage: serializeSiteDataMap(deserializeSiteDataMap(record.localStorage)),
          sessionStorage: serializeSiteDataMap(deserializeSiteDataMap(record.sessionStorage)),
          updatedAt: Number(record.updatedAt || Date.now()),
        };
      }

      function readRawAppModeSiteDataStore() {
        let parsed = {};
        try {
          parsed = JSON.parse(localStorage.getItem(APPMODE_SITE_DATA_STORE_KEY) || "{}") || {};
        } catch {
          parsed = {};
        }
        const store = {};
        for (const [key, value] of Object.entries(parsed || {})) {
          store[key] = normalizeAppModeSiteRecord(key, value);
        }
        return store;
      }

      function readAppModeSiteDataStore() {
        const store = readRawAppModeSiteDataStore();
        const legacyCookies = readLegacyAppModeCookieStore();
        for (const [key, cookies] of Object.entries(legacyCookies || {})) {
          if (store[key]) continue;
          store[key] = normalizeAppModeSiteRecord(key, { cookies });
        }
        return store;
      }

      function writeAppModeSiteDataStore(store) {
        try {
          const keys = Object.keys(store || {});
          if (keys.length) localStorage.setItem(APPMODE_SITE_DATA_STORE_KEY, JSON.stringify(store || {}));
          else localStorage.removeItem(APPMODE_SITE_DATA_STORE_KEY);
        } catch (err) {
          console.warn("[APPMODE] Failed to persist site data:", err);
        }
      }

      function findCompatibleAppModeSiteRecord(store, identity) {
        const key = String(identity?.key || "");
        if (!key || !store || store[key]) return store?.[key] || null;
        for (const variant of appModeSiteKeyVariants(key)) {
          if (store[variant]) return store[variant];
        }
        return null;
      }

      function appModeSiteKeyVariants(key) {
        const variants = new Set([String(key || "")].filter(Boolean));
        let scope = null;
        try {
          scope = JSON.parse(String(key || ""));
        } catch {
          return [...variants];
        }
        if (!scope || typeof scope !== "object") return [...variants];
        if (scope.serveMode) {
          const withoutServeMode = { ...scope };
          delete withoutServeMode.serveMode;
          variants.add(JSON.stringify(withoutServeMode));
        }
        if (scope.framework === "edgeserve" && scope.appSpec) {
          variants.add(JSON.stringify({ ...scope, framework: "edgeterm" }));
          const withoutServeMode = { ...scope, framework: "edgeterm" };
          delete withoutServeMode.serveMode;
          variants.add(JSON.stringify(withoutServeMode));
        }
        if (scope.framework === "edgeterm" && scope.appSpec) {
          variants.add(JSON.stringify({ ...scope, framework: "edgeserve" }));
        }
        return [...variants];
      }

      function parseAppModeSiteKey(key) {
        try {
          const parsed = JSON.parse(String(key || ""));
          return parsed && typeof parsed === "object" ? parsed : null;
        } catch {
          return null;
        }
      }

      function appModeSiteRecordMatchesKey(record, targetKey) {
        const recordKey = String(record?.key || "");
        if (!recordKey || !targetKey) return false;
        if (appModeSiteKeyVariants(targetKey).includes(recordKey)) return true;
        const targetScope = parseAppModeSiteKey(targetKey);
        const recordScope = parseAppModeSiteKey(recordKey) || record?.scope || {};
        if (!targetScope || !recordScope || typeof recordScope !== "object") return false;
        const targetApp = String(targetScope.appSpec || targetScope.entrypoint || targetScope.staticRoot || "");
        const recordApp = String(recordScope.appSpec || recordScope.entrypoint || recordScope.staticRoot || "");
        return (
          String(targetScope.workspaceId || "") === String(recordScope.workspaceId || "") &&
          String(targetScope.runtime || "") === String(recordScope.runtime || "") &&
          normalizePath(targetScope.workingDirectory || "/") === normalizePath(recordScope.workingDirectory || "/") &&
          targetApp &&
          targetApp === recordApp
        );
      }

      function describeAppModeSite(config = appModeState.config || readAppModeConfig(), instance = null) {
        const resolved = normalizeAppModeConfig(config || readAppModeConfig());
        const scope = {
          workspaceId: activeWorkspaceId || activeWorkspace()?.id || "",
          runtime: String(resolved.runtime || "python"),
          workingDirectory: normalizePath(instance?.workingDirectory || resolved.workingDirectory || "/"),
          shareId: appModeState.shareRoute?.shareId || "",
          localWorkspaceId: appModeState.localRoute?.workspaceId || "",
        };
        let label = activeWorkspace()?.name || "Site";
        if (resolved.runtime === "static") {
          scope.kind = "static";
          scope.staticRoot = normalizePath(resolved.staticRoot || "/home/user/public");
          scope.entrypoint = String(resolved.entrypoint || "");
          label = `static ${scope.entrypoint || scope.staticRoot}`;
        } else {
          scope.kind = "python";
          scope.framework = String(resolved.python?.framework || instance?.mode || "edgeterm");
          scope.appSpec = String(resolved.python?.appSpec || instance?.label || "");
          scope.appObject = String(resolved.python?.appObject || "app");
          if (!scope.appSpec) scope.entrypoint = String(resolved.entrypoint || "");
          if (resolved.python?.framework === "edgeserve" && (instance?.mode || resolved.python?.serveMode)) {
            scope.serveMode = String(instance?.mode || resolved.python?.serveMode || "app");
          }
          label = scope.appSpec || scope.entrypoint || scope.framework || label;
        }
        return {
          key: JSON.stringify(scope),
          label: String(label || "Site"),
          scope,
        };
      }

      function loadAppModeSiteData(identity, fallback = {}) {
        const key = String(identity?.key || "");
        const store = readAppModeSiteDataStore();
        const record = (key && store[key]) || findCompatibleAppModeSiteRecord(store, identity) || normalizeAppModeSiteRecord(key, { label: identity?.label, scope: identity?.scope });
        const fallbackCookies = fallback.cookies instanceof Map && fallback.cookies.size ? fallback.cookies : null;
        const fallbackLocalStorage = fallback.localStorage instanceof Map && fallback.localStorage.size ? fallback.localStorage : null;
        const fallbackSessionStorage = fallback.sessionStorage instanceof Map && fallback.sessionStorage.size ? fallback.sessionStorage : null;
        appModeState.siteKey = key;
        appModeState.siteLabel = String(identity?.label || record.label || "Site");
        appModeState.siteScope = identity?.scope || record.scope || {};
        appModeState.cookieJar = fallbackCookies ? new Map(fallbackCookies) : deserializeSiteDataMap(record.cookies);
        appModeState.siteLocalStorage = fallbackLocalStorage ? new Map(fallbackLocalStorage) : deserializeSiteDataMap(record.localStorage);
        appModeState.siteSessionStorage = fallbackSessionStorage ? new Map(fallbackSessionStorage) : deserializeSiteDataMap(record.sessionStorage);
        renderBrowserSiteSettings();
      }

      function persistAppModeSiteData(identity = { key: appModeState.siteKey, label: appModeState.siteLabel, scope: appModeState.siteScope }) {
        const key = String(identity?.key || "");
        if (!key) return;
        const store = readRawAppModeSiteDataStore();
        const cookies = serializeSiteDataMap(appModeState.cookieJar);
        const localStorageEntries = serializeSiteDataMap(appModeState.siteLocalStorage);
        const sessionStorageEntries = serializeSiteDataMap(appModeState.siteSessionStorage);
        if (cookies.length || localStorageEntries.length || sessionStorageEntries.length) {
          store[key] = normalizeAppModeSiteRecord(key, {
            label: identity?.label || appModeState.siteLabel,
            scope: identity?.scope || appModeState.siteScope,
            cookies,
            localStorage: localStorageEntries,
            sessionStorage: sessionStorageEntries,
            updatedAt: Date.now(),
          });
        } else {
          delete store[key];
        }
        writeAppModeSiteDataStore(store);
        renderBrowserSiteSettings();
      }

      function clearStoredAppModeSiteData(key) {
        if (!key) return false;
        let deleted = false;
        const store = readRawAppModeSiteDataStore();
        for (const record of Object.values(store)) {
          if (appModeSiteRecordMatchesKey(record, key)) {
            delete store[record.key];
            deleted = true;
          }
        }
        writeAppModeSiteDataStore(store);
        const legacyStore = readLegacyAppModeCookieStore();
        for (const [legacyKey, cookies] of Object.entries(legacyStore || {})) {
          const record = normalizeAppModeSiteRecord(legacyKey, { cookies });
          if (appModeSiteRecordMatchesKey(record, key)) {
            delete legacyStore[legacyKey];
            deleted = true;
          }
        }
        writeLegacyAppModeCookieStore(legacyStore);
        return deleted;
      }

      function clearAllStoredAppModeSiteData() {
        try {
          localStorage.removeItem(APPMODE_SITE_DATA_STORE_KEY);
          localStorage.removeItem(APPMODE_COOKIE_STORE_KEY);
        } catch (err) {
          console.warn("[APPMODE] Failed to clear stored site data:", err);
        }
      }

      function currentAppModeSiteIdentity() {
        if (appModeState.renderTarget === "display") {
          const tab = activeDisplayBrowserTab();
          if (tab?.siteKey) return { key: tab.siteKey, label: tab.siteLabel || tab.title || "Site", scope: tab.siteScope || {} };
        }
        const resolved = describeAppModeSite(appModeState.config || readAppModeConfig());
        return { key: resolved.key, label: resolved.label, scope: resolved.scope };
      }

      function currentAppModeUrl() {
        if (appModeState.renderTarget === "display") {
          return appModeState.browserHistory[appModeState.browserHistoryIndex] || appModeState.currentPath || "/";
        }
        return appModeState.currentPath || "/";
      }

      async function reloadCurrentAppModeSite() {
        if (!appModeState.active) return;
        try {
          await navigateAppMode(currentAppModeUrl(), {
            updateHistory: false,
            skipDisplayHistory: appModeState.renderTarget === "display",
            replaceDisplayHistory: appModeState.renderTarget === "display",
          });
        } catch (err) {
          console.warn("[APPMODE] Site reload after data reset failed:", err);
        }
      }

      function describeSiteScope(scope = {}) {
        const parts = [];
        if (scope.shareId) parts.push(`share ${String(scope.shareId).slice(0, 8)}`);
        else if (scope.workspaceId) parts.push(`workspace ${String(scope.workspaceId).slice(-8)}`);
        if (scope.kind === "edgeserve") {
          parts.push(scope.mode || "app");
          if (scope.label) parts.push(String(scope.label));
        } else if (scope.appSpec) {
          parts.push(String(scope.appSpec));
        } else if (scope.entrypoint) {
          parts.push(String(scope.entrypoint));
        } else if (scope.staticRoot) {
          parts.push(String(scope.staticRoot));
        }
        return parts.filter(Boolean).join(" • ") || "No active site";
      }

      function renderSiteDataEntries(targetId, entries, emptyLabel) {
        const node = $id(targetId);
        if (!node) return;
        const list = Array.isArray(entries) ? entries : [];
        if (!list.length) {
          node.innerHTML = `<div class="site-data-empty">${encodeHtml(emptyLabel)}</div>`;
          return;
        }
        node.innerHTML = list
          .map(([key, value]) => `<div class="site-data-item"><code>${encodeHtml(String(key))}</code><pre>${encodeHtml(String(value))}</pre></div>`)
          .join("");
      }

      function renderBrowserSiteSettings() {
        const currentIdentity = currentAppModeSiteIdentity();
        const currentKey = String(currentIdentity?.key || appModeState.siteKey || "");
        const store = readAppModeSiteDataStore();
        const currentRecord = currentKey ? (store[currentKey] || normalizeAppModeSiteRecord(currentKey, {
          label: currentIdentity?.label || appModeState.siteLabel || "Site",
          scope: currentIdentity?.scope || appModeState.siteScope || {},
          cookies: serializeSiteDataMap(appModeState.cookieJar),
          localStorage: serializeSiteDataMap(appModeState.siteLocalStorage),
          sessionStorage: serializeSiteDataMap(appModeState.siteSessionStorage),
        })) : null;
        const currentLabel = currentRecord?.label || currentIdentity?.label || "No active site";
        const currentScope = currentRecord?.scope || currentIdentity?.scope || {};
        const cookies = currentRecord?.cookies || [];
        const localStorageEntries = currentRecord?.localStorage || [];
        const sessionStorageEntries = currentRecord?.sessionStorage || [];
        if ($id("browserSiteCurrentName")) $id("browserSiteCurrentName").textContent = currentLabel;
        if ($id("browserSiteCurrentScope")) $id("browserSiteCurrentScope").textContent = describeSiteScope(currentScope);
        if ($id("browserSiteCookieCount")) $id("browserSiteCookieCount").textContent = String(cookies.length);
        if ($id("browserSiteLocalStorageCount")) $id("browserSiteLocalStorageCount").textContent = String(localStorageEntries.length);
        if ($id("browserSiteSessionStorageCount")) $id("browserSiteSessionStorageCount").textContent = String(sessionStorageEntries.length);
        renderSiteDataEntries("browserSiteCookies", cookies, "No cookies stored for this site.");
        renderSiteDataEntries("browserSiteLocalStorage", localStorageEntries, "No local storage stored for this site.");
        renderSiteDataEntries("browserSiteSessionStorage", sessionStorageEntries, "No session storage stored for this site.");
        const sites = Object.values(store).sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
        const list = $id("browserSiteStoredList");
        if (!list) return;
        if (!sites.length) {
          list.innerHTML = `<div class="site-data-empty">No stored browser sites yet.</div>`;
          return;
        }
        list.innerHTML = sites
          .map((site) => {
            const isActive = currentKey && site.key === currentKey;
            return `
              <div class="site-record${isActive ? " active" : ""}">
                <div class="site-record-copy">
                  <strong>${encodeHtml(site.label || "Site")}</strong>
                  <span>${encodeHtml(describeSiteScope(site.scope || {}))}</span>
                </div>
                <div class="site-record-meta">
                  <code>${encodeHtml(`${(site.cookies || []).length}c / ${(site.localStorage || []).length}l / ${(site.sessionStorage || []).length}s`)}</code>
                  <button type="button" class="icon-only site-record-action" data-site-delete="${encodeHtml(site.key)}" title="Delete site data" aria-label="Delete site data"><i data-lucide="trash-2"></i></button>
                </div>
              </div>
            `;
          })
          .join("");
        window.lucide?.createIcons();
      }

      function applyAppModeCookieString(cookie) {
        const source = String(cookie || "");
        const pair = source.split(";", 1)[0];
        const index = pair.indexOf("=");
        if (index <= 0) return false;
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1);
        if (!name) return false;
        if (/;\s*max-age=0\b/i.test(source) || /;\s*expires=thu,\s*01 jan 1970/i.test(source)) {
          return appModeState.cookieJar.delete(name);
        }
        if (appModeState.cookieJar.get(name) === value) return false;
        appModeState.cookieJar.set(name, value);
        return true;
      }

      function applySyncedSiteData(payload = {}) {
        const cookieMutations = Array.isArray(payload.cookieMutations)
          ? payload.cookieMutations
          : payload.cookieMutation
            ? [payload.cookieMutation]
            : [];
        for (const cookie of cookieMutations) applyAppModeCookieString(cookie);
        appModeState.siteLocalStorage = deserializeSiteDataMap(payload.localStorage);
        appModeState.siteSessionStorage = deserializeSiteDataMap(payload.sessionStorage);
        if (appModeState.renderTarget === "display") saveDisplayBrowserTabState();
        else persistAppModeSiteData();
        renderBrowserSiteSettings();
      }

      async function clearCurrentBrowserSiteData(mode = "all") {
        const identity = currentAppModeSiteIdentity();
        if (!identity?.key) {
          showNotice("No active browser site");
          return;
        }
        if (mode === "cookies" || mode === "all") appModeState.cookieJar = new Map();
        if (mode === "storage" || mode === "all") {
          appModeState.siteLocalStorage = new Map();
          appModeState.siteSessionStorage = new Map();
        }
        if (mode === "cache" || mode === "all") {
          appModeState.staticTextCache.clear();
          revokeAppModeBlobs();
        }
        if (appModeState.renderTarget === "display") saveDisplayBrowserTabState();
        else persistAppModeSiteData(identity);
        if (mode === "all" || (!appModeState.cookieJar.size && !appModeState.siteLocalStorage.size && !appModeState.siteSessionStorage.size)) {
          clearStoredAppModeSiteData(identity.key);
        }
        renderBrowserSiteSettings();
        await reloadCurrentAppModeSite();
        showNotice(mode === "all" ? "Cleared current site data" : `Cleared current site ${mode}`);
      }

      async function clearAllBrowserData() {
        clearAllStoredAppModeSiteData();
        appModeState.cookieJar = new Map();
        appModeState.siteLocalStorage = new Map();
        appModeState.siteSessionStorage = new Map();
        appModeState.staticTextCache.clear();
        if (appModeState.renderTarget === "display") {
          for (const tab of appModeState.browserTabs.values()) {
            tab.cookieJar = new Map();
            tab.siteLocalStorage = new Map();
            tab.siteSessionStorage = new Map();
          }
        }
        renderBrowserSiteSettings();
        await reloadCurrentAppModeSite();
        showNotice("Cleared all browser site data");
      }

      function ensureDir(path) {
        if (!pyodide.FS.analyzePath(path).exists) {
          pyodide.FS.mkdirTree(path);
        }
      }

      function isNotFoundError(err) {
        return err?.errno === 2 || err?.code === "ENOENT" || /ENOENT|no such file/i.test(String(err?.message || err || ""));
      }

      function copyTree(source, target) {
        const fs = pyodide.FS;
        if (!fs.analyzePath(source).exists) return;

        const stat = fs.stat(source);
        if (fs.isDir(stat.mode)) {
          ensureDir(target);
          for (const entry of fs.readdir(source)) {
            if (entry === "." || entry === "..") continue;
            copyTree(`${source}/${entry}`, `${target}/${entry}`);
          }
          return;
        }

        ensureDir(target.split("/").slice(0, -1).join("/") || "/");
        fs.writeFile(target, fs.readFile(source));
      }

      function syncTree(source, target) {
        const fs = pyodide.FS;
        if (!fs.analyzePath(source).exists) {
          removeTree(target);
          return;
        }

        let sourceStat;
        try {
          sourceStat = fs.lstat(source);
        } catch (err) {
          if (isNotFoundError(err)) return;
          throw err;
        }
        const sourceIsDir = fs.isDir(sourceStat.mode) && !fs.isLink(sourceStat.mode);
        const targetInfo = fs.analyzePath(target);
        if (sourceIsDir) {
          if (targetInfo.exists) {
            let targetStat = null;
            try {
              targetStat = fs.lstat(target);
            } catch (err) {
              if (!isNotFoundError(err)) throw err;
            }
            if (!targetStat) {
              ensureDir(target);
            } else
            if (!fs.isDir(targetStat.mode) || fs.isLink(targetStat.mode)) {
              removeTree(target);
              ensureDir(target);
            }
          } else {
            ensureDir(target);
          }

          let sourceEntryList = [];
          try {
            sourceEntryList = fs.readdir(source);
          } catch (err) {
            if (isNotFoundError(err)) return;
            throw err;
          }
          const sourceEntries = new Set(sourceEntryList.filter((entry) => entry !== "." && entry !== ".."));
          let targetEntries = [];
          try {
            targetEntries = fs.readdir(target);
          } catch (err) {
            if (!isNotFoundError(err)) throw err;
            ensureDir(target);
            targetEntries = [];
          }
          for (const entry of targetEntries) {
            if (entry === "." || entry === "..") continue;
            if (!sourceEntries.has(entry)) removeTree(`${target}/${entry}`);
          }
          for (const entry of sourceEntries) syncTree(`${source}/${entry}`, `${target}/${entry}`);
          return;
        }

        ensureDir(target.split("/").slice(0, -1).join("/") || "/");
        if (targetInfo.exists) {
          try {
            const targetStat = fs.lstat(target);
            if (fs.isDir(targetStat.mode) && !fs.isLink(targetStat.mode)) {
              removeTree(target);
            } else if (targetStat.size === sourceStat.size && Number(targetStat.mtime) >= Number(sourceStat.mtime)) {
              return;
            }
          } catch (err) {
            if (!isNotFoundError(err)) throw err;
          }
        }
        let bytes;
        try {
          bytes = fs.readFile(source);
        } catch (err) {
          if (isNotFoundError(err)) return;
          throw err;
        }
        fs.writeFile(target, bytes);
      }

      function removeTree(path) {
        const fs = pyodide.FS;
        if (!fs.analyzePath(path).exists) return;

        let stat;
        try {
          stat = fs.lstat(path);
        } catch (err) {
          if (isNotFoundError(err)) return;
          throw err;
        }
        if (fs.isDir(stat.mode) && !fs.isLink(stat.mode)) {
          let entries = [];
          try {
            entries = fs.readdir(path);
          } catch (err) {
            if (isNotFoundError(err)) return;
            throw err;
          }
          for (const entry of entries) {
            if (entry === "." || entry === "..") continue;
            removeTree(`${path}/${entry}`);
          }
          try {
            fs.rmdir(path);
          } catch (err) {
            if (!isNotFoundError(err)) throw err;
          }
          return;
        }

        try {
          fs.unlink(path);
        } catch (err) {
          if (!isNotFoundError(err)) throw err;
        }
      }

      function clearDirectory(path) {
        const fs = pyodide.FS;
        ensureDir(path);
        for (const entry of fs.readdir(path)) {
          if (entry === "." || entry === "..") continue;
          removeTree(`${path}/${entry}`);
        }
      }

      function isRootOverlayEntry(name) {
        return !ROOT_RESERVED_ENTRIES.has(name);
      }

      function removeRootOverlayEntries() {
        for (const entry of pyodide.FS.readdir("/").filter(isRootOverlayEntry)) {
          removeTree(`/${entry}`);
        }
      }

      function restoreRootOverlayFromWorkspace() {
        const upperPath = workspacePath(activeWorkspaceId, "/overlay/upper");
        ensureDir(upperPath);

        for (const entry of pyodide.FS.readdir(upperPath)) {
          if (!isRootOverlayEntry(entry)) continue;
          copyTree(`${upperPath}/${entry}`, `/${entry}`);
        }
      }

      function syncRootOverlayToWorkspace() {
        const upperPath = workspacePath(activeWorkspaceId, "/overlay/upper");
        ensureDir(upperPath);
        const rootEntries = new Set(pyodide.FS.readdir("/").filter(isRootOverlayEntry));

        for (const entry of pyodide.FS.readdir(upperPath)) {
          if (entry === "." || entry === "..") continue;
          if (!rootEntries.has(entry)) removeTree(`${upperPath}/${entry}`);
        }

        for (const entry of rootEntries) {
          const target = `${upperPath}/${entry}`;
          syncTree(`/${entry}`, target);
        }
      }

      function syncHomeToWorkspace() {
        const workspace = activeWorkspace();
        for (const user of workspace.users) {
          const source = `/home/${user}`;
          if (!pyodide.FS.analyzePath(source).exists) continue;
          const target = workspacePath(activeWorkspaceId, `/home/${user}`);
          syncTree(source, target);
        }
      }

      function workspaceMirrorPathForRuntimePath(path) {
        const normalized = normalizePath(path);
        const workspace = activeWorkspace();
        if (!workspace || workspace.transient) return "";
        for (const user of workspace.users) {
          const home = `/home/${user}`;
          if (normalized === home || normalized.startsWith(`${home}/`)) {
            return workspacePath(activeWorkspaceId, normalized);
          }
        }
        if (isRootOverlayEntry(normalized.split("/").filter(Boolean)[0] || "")) {
          return workspacePath(activeWorkspaceId, `/overlay/upper${normalized}`);
        }
        return "";
      }

      function syncRuntimePathToWorkspace(path) {
        const target = workspaceMirrorPathForRuntimePath(path);
        if (!target) return false;
        const source = normalizePath(path);
        if (!pyodide.FS.analyzePath(source).exists) {
          removeTree(target);
          return true;
        }
        syncTree(source, target);
        return true;
      }

      function scheduleWorkspaceFlush(delay = 250) {
        if (activeWorkspace()?.transient) return;
        if (workspaceFlushTimeout) clearTimeout(workspaceFlushTimeout);
        workspaceFlushTimeout = setTimeout(() => {
          workspaceFlushTimeout = null;
          if (workspaceFlushInFlight) {
            pendingWorkspaceFlushAfterInFlight = true;
            return;
          }
          workspaceFlushInFlight = syncfs(false)
            .catch((err) => {
              console.error("[PERSIST] Workspace flush failed:", err);
            })
            .finally(() => {
              workspaceFlushInFlight = null;
              if (pendingWorkspaceFlushAfterInFlight) {
                pendingWorkspaceFlushAfterInFlight = false;
                scheduleWorkspaceFlush(500);
              }
            });
        }, delay);
      }

      async function persistActiveWorkspace() {
        if (activeWorkspace()?.transient) return;
        if (persistTimeout) {
          clearTimeout(persistTimeout);
          persistTimeout = null;
        }
        if (workspaceFlushTimeout) {
          clearTimeout(workspaceFlushTimeout);
          workspaceFlushTimeout = null;
        }
        while (persistInFlight) {
          await persistInFlight;
        }
        syncRootOverlayToWorkspace();
        syncHomeToWorkspace();
        await flushQueuedWorkspaceJournalEntries();
        await syncfs(false);
        await clearWorkspaceJournal(activeWorkspaceId);
      }

      function schedulePersistActiveWorkspace(delay = 120) {
        if (persistTimeout) clearTimeout(persistTimeout);
        persistTimeout = setTimeout(() => {
          persistTimeout = null;
          if (persistInFlight) {
            pendingPersistAfterInFlight = true;
            return;
          }
          persistInFlight = persistActiveWorkspace()
            .catch((err) => {
              console.error("[PERSIST] Background sync failed:", err);
            })
            .finally(() => {
              persistInFlight = null;
              if (pendingPersistAfterInFlight) {
                pendingPersistAfterInFlight = false;
                schedulePersistActiveWorkspace(250);
              }
            });
        }, delay);
      }

      async function extractZipTo(zip, target) {
        ensureDir(target);
        for (const [path, entry] of Object.entries(zip.files)) {
          const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
          if (!normalized) continue;
          const fullPath = `${target}/${normalized}`;
          if (entry.dir) {
            ensureDir(fullPath);
          } else {
            ensureDir(fullPath.split("/").slice(0, -1).join("/"));
            pyodide.FS.writeFile(fullPath, await entry.async("uint8array"));
          }
        }
      }

      function normalizeZipEntries(zip) {
        return Object.keys(zip.files)
          .map((path) => path.replaceAll("\\", "/").replace(/^\/+/, ""))
          .filter(Boolean);
      }

      function detectWorkspaceArchive(zip) {
        const entries = normalizeZipEntries(zip);
        const candidates = new Set([""]);
        for (const entry of entries) {
          const parts = entry.split("/");
          if (parts.length >= 2) candidates.add(parts[0]);
        }
        for (const prefix of candidates) {
          const base = prefix ? `${prefix}/` : "";
          const hasRootfs = entries.some((entry) => entry.startsWith(`${base}rootfs/`));
          const hasHome = entries.some((entry) => entry.startsWith(`${base}home/`));
          const hasOverlay = entries.some((entry) => entry.startsWith(`${base}overlay/`));
          if (hasRootfs && (hasHome || hasOverlay)) return prefix;
        }
        return null;
      }

      async function extractWorkspaceArchive(zip, workspaceRoot, prefix = "") {
        const base = prefix ? `${prefix}/` : "";
        ensureDir(workspaceRoot);
        for (const [path, entry] of Object.entries(zip.files)) {
          const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
          if (!normalized) continue;
          if (base && !normalized.startsWith(base)) continue;
          const relative = base ? normalized.slice(base.length) : normalized;
          if (!relative) continue;
          const fullPath = `${workspaceRoot}/${relative}`;
          if (entry.dir) {
            ensureDir(fullPath);
          } else {
            ensureDir(fullPath.split("/").slice(0, -1).join("/"));
            pyodide.FS.writeFile(fullPath, await entry.async("uint8array"));
          }
        }
      }

      function listWorkspaceUsers(id) {
        const homePath = workspacePath(id, "/home");
        if (!pyodide.FS.analyzePath(homePath).exists) return ["user"];
        const users = pyodide.FS
          .readdir(homePath)
          .filter((entry) => entry !== "." && entry !== "..")
          .filter((entry) => {
            try {
              return pyodide.FS.isDir(pyodide.FS.stat(`${homePath}/${entry}`).mode);
            } catch {
              return false;
            }
          });
        return users.length ? users : ["user"];
      }

      function formatInitError(err) {
        if (!err) return "Unknown init error";
        if (typeof err === "string") return err;
        if (err.message && err.stack) return `${err.message}\n${err.stack}`;
        if (err.stack) return err.stack;
        if (err.message) return err.message;
        try {
          return JSON.stringify(err, null, 2);
        } catch {
          return String(err);
        }
      }

      function mimeTypeForPath(path) {
        const lower = String(path || "").toLowerCase();
        if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html; charset=utf-8";
        if (lower.endsWith(".css")) return "text/css; charset=utf-8";
        if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "text/javascript; charset=utf-8";
        if (lower.endsWith(".json")) return "application/json; charset=utf-8";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".gif")) return "image/gif";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".ico")) return "image/x-icon";
        if (lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".py") || lower.endsWith(".sh")) return "text/plain; charset=utf-8";
        return "application/octet-stream";
      }

      function isTextMimeType(mime) {
        return /^text\//i.test(mime) || /json|javascript|xml|svg/i.test(mime);
      }

      function encodeHtml(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }

      function dirname(path) {
        const normalized = normalizePath(path);
        const parts = normalized.split("/").slice(0, -1);
        return parts.length ? parts.join("/") || "/" : "/";
      }

      function resolveWorkspacePath(basePath, target) {
        const input = String(target || "").trim();
        if (!input) return normalizePath(basePath || "/");
        if (input.startsWith("/")) return normalizePath(input);
        const stack = dirname(basePath || "/").split("/").filter(Boolean);
        for (const part of input.split("/")) {
          if (!part || part === ".") continue;
          if (part === "..") stack.pop();
          else stack.push(part);
        }
        return `/${stack.join("/")}` || "/";
      }

      function resolveWorkspaceDirectory(baseDir, target) {
        const input = String(target || "").trim();
        const stack = normalizePath(baseDir || "/").split("/").filter(Boolean);
        for (const part of input.split("/")) {
          if (!part || part === ".") continue;
          if (part === "..") stack.pop();
          else stack.push(part);
        }
        return `/${stack.join("/")}` || "/";
      }

      function resolveAppRequestUrl(input, currentPath = "/") {
        const raw = typeof input === "string" ? input : input?.url || "/";
        const url = new URL(raw, `https://edgeterm.local${currentPath || "/"}`);
        return { path: url.pathname || "/", query: url.search.replace(/^\?/, "") };
      }

      function isVirtualAppRequest(url) {
        if (!url) return true;
        if (url.startsWith("#")) return false;
        if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("javascript:") || url.startsWith("mailto:")) return false;
        if (/^https?:\/\//i.test(url)) {
          try {
            const parsed = new URL(url);
            return parsed.hostname === "edgeterm.local";
          } catch {
            return false;
          }
        }
        return true;
      }

      function normalizeHotkey(hotkey) {
        const tokens = String(hotkey || "")
          .split("+")
          .map((token) => token.trim().toLowerCase())
          .filter(Boolean);
        const modifiers = {
          ctrl: tokens.includes("ctrl") || tokens.includes("control"),
          alt: tokens.includes("alt") || tokens.includes("option"),
          shift: tokens.includes("shift"),
          meta: tokens.includes("meta") || tokens.includes("cmd") || tokens.includes("command"),
        };
        const key = tokens.find((token) => !["ctrl", "control", "alt", "option", "shift", "meta", "cmd", "command"].includes(token)) || "";
        return { ...modifiers, key };
      }

      function matchesHotkey(event, hotkey) {
        const normalized = normalizeHotkey(hotkey);
        const key = String(event.key || "").toLowerCase();
        return (
          !!normalized.key &&
          normalized.key === key &&
          !!normalized.ctrl === !!event.ctrlKey &&
          !!normalized.alt === !!event.altKey &&
          !!normalized.shift === !!event.shiftKey &&
          !!normalized.meta === !!event.metaKey
        );
      }

      function validateAppModeConfig(config) {
        if (!config.enabled) return;
        if (!["python", "static"].includes(config.runtime)) throw new Error(`Unsupported App Mode runtime: ${config.runtime}`);
        if (!pyodide.FS.analyzePath(config.workingDirectory).exists) throw new Error(`Working directory does not exist: ${config.workingDirectory}`);
        if (config.runtime === "python" && !config.python?.appSpec && !pyodide.FS.analyzePath(config.entrypoint).exists) {
          throw new Error(`Python entrypoint does not exist: ${config.entrypoint}`);
        }
        if (config.runtime === "static") {
          const staticCandidate = resolveStaticEntrypoint(config, config.entrypoint);
          if (!pyodide.FS.analyzePath(staticCandidate).exists) throw new Error(`Static entrypoint does not exist: ${staticCandidate}`);
        }
      }

      function resolveStaticEntrypoint(config, requestedPath = "") {
        const input = String(requestedPath || "").trim();
        if (input && /\.(html?|xhtml)$/i.test(input)) return normalizePath(input);
        const root = normalizePath(config.staticRoot || "/home/user/public");
        return resolveWorkspacePath(`${root}/${config.static.indexFile}`, input || config.static.indexFile || "index.html");
      }

      function staticRoutePathForFsPath(fsPath, config) {
        const root = normalizePath(config.staticRoot || "/home/user/public");
        const normalized = normalizePath(fsPath);
        if (!normalized.startsWith(root)) return "/";
        let relative = normalized.slice(root.length) || "/";
        if (!relative.startsWith("/")) relative = `/${relative}`;
        if (relative.endsWith(`/${config.static.indexFile}`)) relative = relative.slice(0, -(`/${config.static.indexFile}`).length) || "/";
        return relative || "/";
      }

      function readFsText(path) {
        return pyodide.FS.readFile(path, { encoding: "utf8" });
      }

      function readFsBytes(path) {
        return pyodide.FS.readFile(path);
      }

      function registerAppModeBlob(blob) {
        const url = URL.createObjectURL(blob);
        appModeState.blobUrls.push(url);
        return url;
      }

      function createStaticAssetUrl(fsPath) {
        if (!pyodide.FS.analyzePath(fsPath).exists) return "";
        const bytes = readFsBytes(fsPath);
        return registerAppModeBlob(new Blob([bytes], { type: mimeTypeForPath(fsPath) }));
      }

      function resolveLocalAssetPath(rawUrl, documentFsPath, config) {
        if (!rawUrl || !isVirtualAppRequest(rawUrl)) return "";
        if (rawUrl.startsWith("/")) {
          if (config.runtime === "static") {
            const root = normalizePath(config.staticRoot || "/home/user/public");
            return resolveWorkspaceDirectory(root, `.${rawUrl}`);
          }
          return resolveWorkspaceDirectory(config.staticRoot || "/home/user/public", `.${rawUrl}`);
        }
        return resolveWorkspacePath(documentFsPath, rawUrl);
      }

      function buildAppModeClientScript({ currentPath, exitHotkey, debugHotkey, allowDebugTerminal, siteData }) {
        return `
(() => {
  const currentPath = ${JSON.stringify(currentPath || "/")};
  const exitHotkey = ${JSON.stringify(exitHotkey || "Escape")};
  const debugHotkey = ${JSON.stringify(debugHotkey || "Ctrl+`")};
  const allowDebugTerminal = ${allowDebugTerminal ? "true" : "false"};
  const initialSiteData = ${JSON.stringify({
    cookies: serializeSiteDataMap(siteData?.cookies),
    localStorage: serializeSiteDataMap(siteData?.localStorage),
    sessionStorage: serializeSiteDataMap(siteData?.sessionStorage),
  })};
  const cookieStore = new Map(initialSiteData.cookies || []);
  const localStore = new Map(initialSiteData.localStorage || []);
  const sessionStore = new Map(initialSiteData.sessionStorage || []);
  const serializeStorageData = () => ({
    localStorage: [...localStore.entries()],
    sessionStorage: [...sessionStore.entries()],
  });
  const syncSiteData = (extra = {}) => {
    parent.EdgeTermAppModeBridge.syncSiteData({ ...serializeStorageData(), ...extra });
  };
  const createStorageProxy = (backingStore) => new Proxy({
    get length() {
      return backingStore.size;
    },
    key(index) {
      return [...backingStore.keys()][Number(index)] ?? null;
    },
    getItem(key) {
      return backingStore.has(String(key)) ? backingStore.get(String(key)) : null;
    },
    setItem(key, value) {
      backingStore.set(String(key), String(value));
      syncSiteData();
    },
    removeItem(key) {
      backingStore.delete(String(key));
      syncSiteData();
    },
    clear() {
      backingStore.clear();
      syncSiteData();
    },
  }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return backingStore.get(String(prop));
    },
    set(target, prop, value) {
      if (prop in target) {
        target[prop] = value;
      } else {
        backingStore.set(String(prop), String(value));
        syncSiteData();
      }
      return true;
    },
    deleteProperty(target, prop) {
      if (prop in target) return delete target[prop];
      const deleted = backingStore.delete(String(prop));
      if (deleted) syncSiteData();
      return true;
    },
    ownKeys(target) {
      return Reflect.ownKeys(target).concat([...backingStore.keys()]);
    },
    getOwnPropertyDescriptor(target, prop) {
      if (prop in target) return Object.getOwnPropertyDescriptor(target, prop);
      if (!backingStore.has(String(prop))) return undefined;
      return { configurable: true, enumerable: true, writable: true, value: backingStore.get(String(prop)) };
    },
  });
  const localStorageProxy = createStorageProxy(localStore);
  const sessionStorageProxy = createStorageProxy(sessionStore);
  const cookieString = () => [...cookieStore.entries()].map(([key, value]) => \`\${key}=\${value}\`).join("; ");
  const setCookie = (rawValue) => {
    const source = String(rawValue || "");
    const pair = source.split(";", 1)[0] || "";
    const index = pair.indexOf("=");
    if (index <= 0) return;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1);
    if (!name) return;
    if (/;\\s*max-age=0\\b/i.test(source) || /;\\s*expires=thu,\\s*01 jan 1970/i.test(source)) {
      cookieStore.delete(name);
    } else {
      cookieStore.set(name, value);
    }
    syncSiteData({ cookieMutation: source });
  };
  try {
    Object.defineProperty(window, "localStorage", { configurable: true, value: localStorageProxy });
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: sessionStorageProxy });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorageProxy });
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: sessionStorageProxy });
    Object.defineProperty(Object.getPrototypeOf(document), "cookie", {
      configurable: true,
      get() {
        return cookieString();
      },
      set(value) {
        setCookie(value);
      },
    });
  } catch {}
  const shouldIntercept = (url) => {
    if (!url) return false;
    if (url.startsWith("#") || url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("javascript:") || url.startsWith("mailto:")) return false;
    if (/^https?:\\/\\//i.test(url)) {
      try {
        const parsed = new URL(url);
        return parsed.hostname === "edgeterm.local";
      } catch {
        return false;
      }
    }
    return true;
  };
  const originalFetch = window.fetch.bind(window);
  const bridgeFetch = async (url, init = {}) => {
    const result = await parent.EdgeTermAppModeBridge.fetch({
      url,
      method: (init.method || "GET").toUpperCase(),
      headers: init.headers || {},
      body: init.body ?? null,
      currentPath,
    });
    const payload = result.bodyBase64
      ? Uint8Array.from(atob(result.bodyBase64), (char) => char.charCodeAt(0))
      : result.body;
    return new Response(payload, { status: result.status, headers: result.headers });
  };
  const hydrateAssets = () => {
    const targets = [...document.querySelectorAll("[data-edgeterm-asset-url], img[src], script[src], link[rel~='stylesheet'][href], source[src], video[src], audio[src], video[poster]")];
    for (const node of targets) {
      const attr = node.getAttribute("data-edgeterm-asset-attr") || (node.hasAttribute("href") ? "href" : node.hasAttribute("poster") ? "poster" : "src");
      const url = node.getAttribute("data-edgeterm-asset-url") || node.getAttribute(attr);
      if (!shouldIntercept(url)) continue;
      bridgeFetch(url)
        .then((response) => response.ok ? response.blob() : null)
        .then((blob) => {
          if (!blob) return;
          node.setAttribute(attr, URL.createObjectURL(blob));
          node.removeAttribute("data-edgeterm-asset-url");
          node.removeAttribute("data-edgeterm-asset-attr");
        })
        .catch(() => {});
    }
  };
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url || "";
    if (!shouldIntercept(url)) return originalFetch(input, init);
    const headers = Object.fromEntries(new Headers(init.headers || (typeof input === "string" ? {} : input.headers || {})).entries());
    const method = (init.method || (typeof input === "string" ? "GET" : input.method) || "GET").toUpperCase();
    let body = init.body ?? null;
    if (body instanceof URLSearchParams) {
      headers["content-type"] ||= "application/x-www-form-urlencoded;charset=UTF-8";
      body = body.toString();
    } else if (body && typeof body !== "string") {
      if (!(body instanceof FormData) && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) {
        body = String(body);
      }
    }
    return bridgeFetch(url, { method, headers, body });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hydrateAssets, { once: true });
  else hydrateAssets();
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[href]");
    if (!link) return;
    const href = link.getAttribute("href");
    if (!shouldIntercept(href) || link.target === "_blank" || event.defaultPrevented) return;
    event.preventDefault();
    parent.EdgeTermAppModeBridge.navigate(href);
  });
  document.addEventListener("submit", async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    const action = form.getAttribute("action") || currentPath;
    const method = (form.getAttribute("method") || "GET").toUpperCase();
    const formData = new URLSearchParams(new FormData(form)).toString();
    if (method === "GET") {
      const next = formData ? \`\${action}\${action.includes("?") ? "&" : "?"}\${formData}\` : action;
      await parent.EdgeTermAppModeBridge.navigate(next);
      return;
    }
    const enctype = String(form.enctype || form.getAttribute("enctype") || "").toLowerCase();
    if (enctype.includes("multipart/form-data")) {
      await parent.EdgeTermAppModeBridge.navigate(action, {
        method,
        headers: {},
        body: new FormData(form),
      });
      return;
    }
    await parent.EdgeTermAppModeBridge.navigate(action, {
      method,
      headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: formData,
    });
  });
  window.addEventListener("keydown", (event) => {
    parent.EdgeTermAppModeBridge.keydown({
      key: event.key,
      ctrlKey: !!event.ctrlKey,
      altKey: !!event.altKey,
      shiftKey: !!event.shiftKey,
      metaKey: !!event.metaKey,
      exitHotkey,
      debugHotkey,
      allowDebugTerminal,
    });
  }, true);
  window.addEventListener("beforeunload", () => syncSiteData());
})();
`;
      }

      async function dispatchPythonAppRequest(url, options, config) {
        const { path, query } = resolveAppRequestUrl(url, options.currentPath || appModeState.currentPath || "/");
        let dispatchPath = path || "/";
        const requestMethod = (options.method || "GET").toUpperCase();
        const matchedInstance = findEdgeServeInstanceForPath(dispatchPath);
        const activeTab = appModeState.renderTarget === "display" ? activeDisplayBrowserTab() : null;
        const activeInstanceId = matchedInstance?.id || activeTab?.instanceId || config.python?.instanceId || "";
        const routePrefix = normalizePath(matchedInstance?.routePrefix || activeTab?.routePrefix || config.python?.routePrefix || "/");
        if (routePrefix !== "/" && dispatchPath.startsWith(routePrefix)) {
          dispatchPath = dispatchPath.slice(routePrefix.length) || "/";
          if (!dispatchPath.startsWith("/")) dispatchPath = `/${dispatchPath}`;
        }
        const serialized = await serializeAppModeRequestBody(
          requestMethod,
          appModeRequestHeaders(options.headers || {}),
          options.body ?? null
        );
        const payload = {
          path: dispatchPath,
          method: requestMethod,
          query_string: query,
          headers: serialized.headers,
          body: serialized.body,
          bodyBase64: serialized.bodyBase64,
          instanceId: activeInstanceId,
        };
        pyodide.globals.set("__edgeterm_app_request_json", JSON.stringify(payload));
        const raw = await pyodide.runPythonAsync(`
import json
import os
import sys
import base64

rootfs_lib = globals().get("__edgeterm_rootfs_lib", "") or os.environ.get("EDGETERM_ROOTFS_LIB", "")
if rootfs_lib and os.path.isdir(rootfs_lib) and rootfs_lib not in sys.path:
    sys.path.insert(0, rootfs_lib)
if os.path.isdir("/usr/lib") and "/usr/lib" not in sys.path:
    sys.path.insert(0, "/usr/lib")

import edgeterm
request_data = json.loads(__edgeterm_app_request_json)
request_body = request_data.get("body", "")
request_body_b64 = request_data.get("bodyBase64", "")
if request_body_b64:
    request_body = base64.b64decode(request_body_b64)
instance_id = request_data.get("instanceId") or ""
if instance_id:
    import edgeterm_wsgi

    result = await edgeterm_wsgi.dispatch_instance(
        instance_id,
        path=request_data.get("path", "/"),
        method=request_data.get("method", "GET"),
        query_string=request_data.get("query_string", ""),
        headers=request_data.get("headers", {}),
        body=request_body,
    )
else:
    result = edgeterm.dispatch_request(
        path=request_data.get("path", "/"),
        method=request_data.get("method", "GET"),
        query_string=request_data.get("query_string", ""),
        headers=request_data.get("headers", {}),
        body=request_body,
    )
json.dumps(result)
`);
        const result = JSON.parse(String(raw));
        if (appModeRequestMayMutateWorkspace(requestMethod)) {
          await persistActiveWorkspace();
        }
        if (result.status === 404 && dispatchPath.length > 1 && dispatchPath.endsWith("/")) {
          const retried = await dispatchPythonAppRequest(dispatchPath.slice(0, -1) + (query ? `?${query}` : ""), options, config);
          if (retried.status !== 404) return retried;
        }
        if (result.status === 404 && config.staticRoot) {
          const fallback = await dispatchStaticRequest(url, options, config, { allowHtml: false, silentNotFound: true });
          if (fallback.status !== 404) return fallback;
        }
        return result;
      }

      function findEdgeServeInstanceForPath(path) {
        const instances = window.EdgeTermServe?.instances;
        if (!instances?.size) return null;
        const routePath = normalizePath(path || "/");
        let best = null;
        for (const instance of instances.values()) {
          const prefix = normalizePath(instance.routePrefix || "/");
          if (prefix === "/") continue;
          if (routePath === prefix || routePath.startsWith(`${prefix}/`)) {
            if (!best || prefix.length > normalizePath(best.routePrefix || "/").length) best = instance;
          }
        }
        return best;
      }

      function appModeRequestHeaders(headers = {}) {
        const normalized = { ...headers };
        if (appModeState.cookieJar?.size && !Object.keys(normalized).some((key) => key.toLowerCase() === "cookie")) {
          normalized.cookie = [...appModeState.cookieJar.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
        }
        return normalized;
      }

      function appModeRequestMayMutateWorkspace(method = "GET") {
        return !["GET", "HEAD", "OPTIONS", "TRACE"].includes(String(method || "GET").toUpperCase());
      }

      function bytesToBase64(bytes) {
        let output = "";
        const chunkSize = 32768;
        for (let index = 0; index < bytes.length; index += chunkSize) {
          const chunk = bytes.subarray(index, index + chunkSize);
          output += String.fromCharCode(...chunk);
        }
        return btoa(output);
      }

      function objectTag(value) {
        return Object.prototype.toString.call(value);
      }

      function isFormDataLike(value) {
        return !!value && objectTag(value) === "[object FormData]";
      }

      function isBlobLike(value) {
        const tag = objectTag(value);
        return !!value && (tag === "[object Blob]" || tag === "[object File]");
      }

      function isArrayBufferLike(value) {
        return !!value && objectTag(value) === "[object ArrayBuffer]";
      }

      function isArrayBufferViewLike(value) {
        return !!value && ArrayBuffer.isView(value);
      }

      async function serializeAppModeRequestBody(method, headers, body) {
        const upperMethod = String(method || "GET").toUpperCase();
        const normalizedHeaders = { ...(headers || {}) };
        if (body == null || upperMethod === "GET" || upperMethod === "HEAD") {
          return { headers: normalizedHeaders, body: "", bodyBase64: "" };
        }
        if (typeof body === "string") {
          return { headers: normalizedHeaders, body, bodyBase64: "" };
        }
        if (body instanceof URLSearchParams) {
          normalizedHeaders["content-type"] ||= "application/x-www-form-urlencoded;charset=UTF-8";
          return { headers: normalizedHeaders, body: body.toString(), bodyBase64: "" };
        }
        if (isFormDataLike(body) || isBlobLike(body) || isArrayBufferLike(body) || isArrayBufferViewLike(body)) {
          const request = new Request("https://edgeterm.local/__edgeflask__", {
            method: upperMethod,
            headers: new Headers(normalizedHeaders),
            body,
          });
          const requestHeaders = Object.fromEntries(request.headers.entries());
          const bytes = new Uint8Array(await request.arrayBuffer());
          return { headers: requestHeaders, body: "", bodyBase64: bytesToBase64(bytes) };
        }
        return { headers: normalizedHeaders, body: String(body), bodyBase64: "" };
      }

      function rememberAppModeCookies(response) {
        const raw = response.headers?.["set-cookie"] || response.headers?.["Set-Cookie"] || response.headerList?.filter?.(([key]) => String(key).toLowerCase() === "set-cookie").map(([, value]) => value);
        const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
        let changed = false;
        for (const cookie of cookies) changed = applyAppModeCookieString(cookie) || changed;
        if (changed) {
          if (appModeState.renderTarget === "display") saveDisplayBrowserTabState();
          else persistAppModeSiteData();
        }
      }

      async function dispatchStaticRequest(url, options, config, extra = {}) {
        const { path } = resolveAppRequestUrl(url, options.currentPath || appModeState.currentPath || "/");
        const root = normalizePath(config.staticRoot || "/home/user/public");
        let fsPath = path === "/" ? resolveStaticEntrypoint(config) : resolveWorkspaceDirectory(root, `.${path}`);
        if (pyodide.FS.analyzePath(fsPath).exists) {
          try {
            const stat = pyodide.FS.stat(fsPath);
            if (pyodide.FS.isDir(stat.mode)) fsPath = resolveWorkspacePath(fsPath, config.static.indexFile || "index.html");
          } catch {}
        }
        if (!pyodide.FS.analyzePath(fsPath).exists) {
          if (path.length > 1 && path.endsWith("/")) {
            return await dispatchStaticRequest(path.slice(0, -1), options, config, extra);
          }
          return extra.silentNotFound
            ? { status: 404, headers: { "content-type": "text/plain; charset=utf-8" }, body: "Not found" }
            : {
                status: 404,
                headers: { "content-type": "text/html; charset=utf-8" },
                body: `<h1>404 Not Found</h1><p>No static app file for <code>${encodeHtml(path)}</code>.</p>`,
              };
        }
        const mime = mimeTypeForPath(fsPath);
        const body = isTextMimeType(mime) ? readFsText(fsPath) : "";
        return {
          status: 200,
          headers: { "content-type": mime, "x-edgeterm-fs-path": fsPath },
          body,
        };
      }

      async function dispatchAppModeRequest(url, options = {}) {
        const config = appModeState.config || readAppModeConfig();
        if (config.runtime === "python") return await dispatchPythonAppRequest(url, options, config);
        return await dispatchStaticRequest(url, options, config);
      }

      function rewriteAppModeAssets(doc, documentFsPath, config) {
        for (const selector of ["img[src]", "script[src]", "link[href]", "source[src]", "audio[src]", "video[src]", "video[poster]"]) {
          doc.querySelectorAll(selector).forEach((node) => {
            const attr = node.hasAttribute("src") ? "src" : "href";
            if (selector.endsWith("[poster]")) {
              const poster = node.getAttribute("poster");
              const posterPath = resolveLocalAssetPath(poster, documentFsPath, config);
              if (posterPath && pyodide.FS.analyzePath(posterPath).exists) node.setAttribute("poster", createStaticAssetUrl(posterPath));
              return;
            }
            const value = node.getAttribute(attr);
            const fsPath = resolveLocalAssetPath(value, documentFsPath, config);
            if (fsPath && pyodide.FS.analyzePath(fsPath).exists) node.setAttribute(attr, createStaticAssetUrl(fsPath));
          });
        }
        if (config.runtime === "static" && config.static?.allowInlineScripts === false) {
          doc.querySelectorAll("script:not([src])").forEach((node) => node.remove());
        }
      }

      function shouldBridgeAppModeAssetUrl(value) {
        const url = String(value || "").trim();
        if (!url || url.startsWith("#") || /^(data|blob|javascript|mailto):/i.test(url)) return false;
        if (/^https?:\/\//i.test(url)) {
          try {
            return new URL(url).hostname === "edgeterm.local";
          } catch {
            return false;
          }
        }
        return true;
      }

      function responseBodyText(response) {
        if (!response) return "";
        if (response.bodyBase64) {
          const bytes = Uint8Array.from(atob(response.bodyBase64), (char) => char.charCodeAt(0));
          return new TextDecoder().decode(bytes);
        }
        return String(response.body || "");
      }

      function responseBlobUrl(response) {
        if (!response) return "";
        const contentType = String(response.headers?.["content-type"] || response.headers?.["Content-Type"] || "application/octet-stream");
        const payload = response.bodyBase64
          ? Uint8Array.from(atob(response.bodyBase64), (char) => char.charCodeAt(0))
          : response.body || "";
        return registerAppModeBlob(new Blob([payload], { type: contentType }));
      }

      function copyElementAttributes(source, target, excluded = new Set()) {
        for (const attr of Array.from(source.attributes || [])) {
          if (excluded.has(attr.name.toLowerCase())) continue;
          target.setAttribute(attr.name, attr.value);
        }
      }

      async function inlineBridgeLoadedAssets(doc, routePath, config) {
        const fetchAsset = async (url) => {
          try {
            const response = await dispatchAppModeRequest(url, {
              method: "GET",
              currentPath: routePath || "/",
              headers: {},
              body: null,
            });
            return response?.status >= 200 && response.status < 300 ? response : null;
          } catch (err) {
            console.warn("[APPMODE] Asset inline failed:", url, err);
            return null;
          }
        };

        for (const link of Array.from(doc.querySelectorAll("link[rel~='stylesheet'][href]"))) {
          const href = link.getAttribute("href");
          if (!shouldBridgeAppModeAssetUrl(href)) continue;
          const response = await fetchAsset(href);
          if (!response) continue;
          const style = doc.createElement("style");
          copyElementAttributes(link, style, new Set(["href", "rel", "integrity", "crossorigin"]));
          style.setAttribute("data-edgeterm-inlined-href", href);
          style.textContent = responseBodyText(response);
          link.replaceWith(style);
        }

        for (const script of Array.from(doc.querySelectorAll("script[src]"))) {
          const src = script.getAttribute("src");
          if (!shouldBridgeAppModeAssetUrl(src)) continue;
          const response = await fetchAsset(src);
          if (!response) continue;
          const inline = doc.createElement("script");
          copyElementAttributes(script, inline, new Set(["src", "integrity", "crossorigin"]));
          inline.setAttribute("data-edgeterm-inlined-src", src);
          inline.textContent = responseBodyText(response).replaceAll("</script", "<\\/script");
          script.replaceWith(inline);
        }

        for (const selector of ["img[src]", "source[src]", "audio[src]", "video[src]", "video[poster]"]) {
          for (const node of Array.from(doc.querySelectorAll(selector))) {
            const attr = selector.endsWith("[poster]") ? "poster" : "src";
            const value = node.getAttribute(attr);
            if (!shouldBridgeAppModeAssetUrl(value)) continue;
            const response = await fetchAsset(value);
            if (!response) continue;
            node.setAttribute(attr, responseBlobUrl(response));
          }
        }
      }

      function deferBridgeLoadedAssets(doc) {
        for (const selector of ["img[src]", "script[src]", "link[rel~='stylesheet'][href]", "source[src]", "audio[src]", "video[src]", "video[poster]"]) {
          doc.querySelectorAll(selector).forEach((node) => {
            const attr = selector.endsWith("[poster]") ? "poster" : node.hasAttribute("href") ? "href" : "src";
            const value = node.getAttribute(attr);
            if (!shouldBridgeAppModeAssetUrl(value)) return;
            node.setAttribute("data-edgeterm-asset-url", value);
            node.setAttribute("data-edgeterm-asset-attr", attr);
            node.removeAttribute(attr);
          });
        }
      }

      async function buildRenderedDocument(html, routePath, documentFsPath, config) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(String(html || ""), "text/html");
        rewriteAppModeAssets(doc, documentFsPath, config);
        await inlineBridgeLoadedAssets(doc, routePath || "/", config);
        deferBridgeLoadedAssets(doc);
        const hook = doc.createElement("script");
        hook.textContent = buildAppModeClientScript({
          currentPath: routePath || "/",
          exitHotkey: config.exit?.hotkey || "Escape",
          debugHotkey: config.ui?.debugTerminalHotkey || "Ctrl+`",
          allowDebugTerminal: !!config.ui?.allowDebugTerminal,
          siteData: {
            cookies: appModeState.cookieJar,
            localStorage: appModeState.siteLocalStorage,
            sessionStorage: appModeState.siteSessionStorage,
          },
        });
        doc.body.appendChild(hook);
        return "<!doctype html>\n" + doc.documentElement.outerHTML;
      }

      function ensureDisplayAppModeFrame() {
        const content = $id("browserContent");
        setView("browserView");
        setBrowserVisibility("content");
        content.className = "display-content app-browser";
        setDisplayBrowserEnabled(true);
        const tab = activeDisplayBrowserTab();
        if (!$id("displayAppBrowserTabs")) {
          content.innerHTML = "";
          const tabs = document.createElement("div");
          tabs.id = "displayAppBrowserTabs";
          tabs.className = "app-browser-tabs";
          const frames = document.createElement("div");
          frames.id = "displayAppBrowserFrames";
          frames.className = "app-browser-frames";
          content.append(tabs, frames);
        }
        renderDisplayBrowserTabs();
        let frame = $id(displayBrowserFrameId(tab.id));
        if (!frame) {
          const frames = $id("displayAppBrowserFrames");
          frame = document.createElement("iframe");
          frame.id = displayBrowserFrameId(tab.id);
          frame.className = "app-browser-frame";
          frame.title = tab.title || "EdgeServe Preview";
          frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-downloads");
          frames.appendChild(frame);
        }
        for (const node of content.querySelectorAll(".app-browser-frame")) {
          node.classList.toggle("active", node.id === frame.id);
        }
        return frame;
      }

      function displayBrowserFrameId(tabId) {
        return `displayAppModeFrame-${String(tabId || "default").replace(/[^A-Za-z0-9_-]/g, "_")}`;
      }

      function nextDisplayBrowserTabId(instanceId = "tab") {
        let index = appModeState.browserTabs.size + 1;
        let id = "";
        do {
          id = `${instanceId || "tab"}-tab-${Date.now().toString(36)}-${index++}`;
        } while (appModeState.browserTabs.has(id));
        return id;
      }

      function activeDisplayBrowserTab() {
        if (!appModeState.activeBrowserTabId || !appModeState.browserTabs.has(appModeState.activeBrowserTabId)) {
          const instanceId = appModeState.config?.python?.instanceId || "";
          const id = appModeState.activeBrowserTabId || nextDisplayBrowserTabId(instanceId || "default");
          const site = describeAppModeSite(appModeState.config, {
            mode: appModeState.config?.python?.framework || "app",
            label: appModeState.config?.python?.appSpec || appModeState.config?.entrypoint || "",
            workingDirectory: appModeState.config?.workingDirectory || "/",
          });
          appModeState.activeBrowserTabId = id;
          appModeState.browserTabs.set(id, {
            id,
            instanceId,
            routePrefix: appModeState.config?.python?.routePrefix || "/",
            title: "EdgeServe",
            currentPath: appModeState.currentPath || "/",
            htmlPath: appModeState.htmlPath || "",
            cookieJar: appModeState.cookieJar || new Map(),
            siteLocalStorage: appModeState.siteLocalStorage || new Map(),
            siteSessionStorage: appModeState.siteSessionStorage || new Map(),
            siteKey: site.key,
            siteLabel: site.label,
            siteScope: site.scope,
            browserHistory: appModeState.browserHistory || [],
            browserHistoryIndex: appModeState.browserHistoryIndex ?? -1,
          });
        }
        const tab = appModeState.browserTabs.get(appModeState.activeBrowserTabId);
        return tab;
      }

      function loadDisplayBrowserTabState(tab) {
        if (!tab) return;
        appModeState.currentPath = tab.currentPath || "/";
        appModeState.htmlPath = tab.htmlPath || "";
        loadAppModeSiteData(
          {
            key: tab.siteKey || "",
            label: tab.siteLabel || tab.title || "Site",
            scope: tab.siteScope || {},
          },
          {
            cookies: tab.cookieJar instanceof Map ? tab.cookieJar : new Map(),
            localStorage: tab.siteLocalStorage instanceof Map ? tab.siteLocalStorage : new Map(),
            sessionStorage: tab.siteSessionStorage instanceof Map ? tab.siteSessionStorage : new Map(),
          }
        );
        appModeState.browserHistory = tab.browserHistory || [];
        appModeState.browserHistoryIndex = tab.browserHistoryIndex ?? -1;
      }

      function saveDisplayBrowserTabState(tab = activeDisplayBrowserTab()) {
        if (!tab) return;
        tab.currentPath = appModeState.currentPath || "/";
        tab.htmlPath = appModeState.htmlPath || "";
        tab.cookieJar = appModeState.cookieJar || new Map();
        tab.siteLocalStorage = appModeState.siteLocalStorage || new Map();
        tab.siteSessionStorage = appModeState.siteSessionStorage || new Map();
        tab.siteKey = appModeState.siteKey || tab.siteKey || "";
        tab.siteLabel = appModeState.siteLabel || tab.siteLabel || tab.title || "Site";
        tab.siteScope = appModeState.siteScope || tab.siteScope || {};
        tab.browserHistory = appModeState.browserHistory || [];
        tab.browserHistoryIndex = appModeState.browserHistoryIndex ?? -1;
        persistAppModeSiteData({ key: tab.siteKey, label: tab.siteLabel, scope: tab.siteScope });
      }

      function createOrActivateDisplayBrowserTab(instance, initialUrl = "", options = {}) {
        const instanceId = String(instance?.id || "default");
        const id = options.newTab ? nextDisplayBrowserTabId(instanceId) : instanceId;
        if (appModeState.activeBrowserTabId && appModeState.browserTabs.has(appModeState.activeBrowserTabId)) {
          saveDisplayBrowserTabState(appModeState.browserTabs.get(appModeState.activeBrowserTabId));
        }
        const existing = options.newTab ? null : appModeState.browserTabs.get(id);
        const routePrefix = normalizePath(instance?.routePrefix || "/");
        const site = describeAppModeSite(appModeState.config, instance);
        const existingCount = [...appModeState.browserTabs.values()].filter((tab) => tab.instanceId === instanceId).length;
        const title = `${instance?.mode || "app"} ${instanceId.slice(-5)}${options.newTab || existingCount ? `:${existingCount + 1}` : ""}`;
        const tab =
          existing ||
          {
            id,
            instanceId: instanceId === "default" ? "" : instanceId,
            routePrefix,
            title,
            currentPath: initialUrl || `${routePrefix}/`,
            htmlPath: "",
            cookieJar: new Map(),
            siteLocalStorage: new Map(),
            siteSessionStorage: new Map(),
            siteKey: site.key,
            siteLabel: site.label,
            siteScope: site.scope,
            browserHistory: [],
            browserHistoryIndex: -1,
          };
        tab.routePrefix = routePrefix;
        tab.title = title;
        tab.siteKey = site.key;
        tab.siteLabel = site.label;
        tab.siteScope = site.scope;
        appModeState.browserTabs.set(id, tab);
        appModeState.activeBrowserTabId = id;
        loadDisplayBrowserTabState(tab);
        renderDisplayBrowserTabs();
        syncDisplayBrowserButtons();
        updateDisplayBrowserUrl(tab.currentPath || `${routePrefix}/`);
        return tab;
      }

      async function activateDisplayBrowserTab(tabId) {
        if (appModeState.activeBrowserTabId && appModeState.browserTabs.has(appModeState.activeBrowserTabId)) {
          saveDisplayBrowserTabState(appModeState.browserTabs.get(appModeState.activeBrowserTabId));
        }
        const tab = appModeState.browserTabs.get(tabId);
        if (!tab) return;
        appModeState.activeBrowserTabId = tab.id;
        loadDisplayBrowserTabState(tab);
        ensureDisplayAppModeFrame();
        updateDisplayBrowserUrl(tab.currentPath || tab.routePrefix || "/");
        syncDisplayBrowserButtons();
      }

      function closeDisplayBrowserTab(tabId = appModeState.activeBrowserTabId) {
        const id = String(tabId || "");
        if (!id || !appModeState.browserTabs.has(id)) return false;
        const ids = [...appModeState.browserTabs.keys()];
        const index = Math.max(0, ids.indexOf(id));
        appModeState.browserTabs.delete(id);
        $id(displayBrowserFrameId(id))?.remove();
        if (!appModeState.browserTabs.size) {
          appModeState.activeBrowserTabId = "";
          appModeState.browserHistory = [];
          appModeState.browserHistoryIndex = -1;
          appModeState.cookieJar = new Map();
          appModeState.siteLocalStorage = new Map();
          appModeState.siteSessionStorage = new Map();
          appModeState.siteKey = "";
          appModeState.siteLabel = "";
          appModeState.siteScope = null;
          appModeState.active = false;
          appModeState.renderTarget = "shell";
          const content = $id("browserContent");
          if (content) {
            content.innerHTML = "";
            content.className = "display-content hidden";
          }
          setDisplayBrowserEnabled(false);
          setBrowserVisibility("empty");
          updateBrowserStatus("EdgeTerm Browser");
          syncDisplayBrowserButtons();
          renderBrowserSiteSettings();
          return true;
        }
        const nextId = ids[index + 1] && appModeState.browserTabs.has(ids[index + 1]) ? ids[index + 1] : [...appModeState.browserTabs.keys()][Math.max(0, index - 1)];
        void activateDisplayBrowserTab(nextId);
        return true;
      }

      async function openDisplayBrowserTabChooser() {
        const instances = [...(window.EdgeTermServe?.instances?.values?.() || [])];
        if (!instances.length) {
          showNotice("No running EdgeServe instances");
          return;
        }
        const result = await askFields(
          "Open EdgeServe Tab",
          [
            {
              name: "instanceId",
              label: "Running instance",
              type: "select",
              value: instances[0].id,
              options: instances.map((instance) => ({
                value: instance.id,
                label: `${instance.mode || "app"} ${instance.id.slice(-5)} ${instance.routePrefix || "/"}`,
              })),
            },
          ],
          { confirmLabel: "Open" }
        );
        const instance = instances.find((item) => item.id === result?.instanceId);
        if (!instance) return;
        createOrActivateDisplayBrowserTab(instance, `${instance.routePrefix}/`, { newTab: true });
        appModeState.renderTarget = "display";
        appModeState.active = true;
        await navigateAppMode(appModeState.currentPath || `${instance.routePrefix}/`, { updateHistory: false, replaceDisplayHistory: true });
      }

      function renderDisplayBrowserTabs() {
        const tabs = $id("displayAppBrowserTabs");
        if (!tabs) return;
        tabs.innerHTML = "";
        for (const tab of appModeState.browserTabs.values()) {
          const item = document.createElement("div");
          item.className = "app-browser-tab";
          item.classList.toggle("active", tab.id === appModeState.activeBrowserTabId);
          item.title = `${tab.routePrefix || "/"} (${tab.id})`;
          const label = document.createElement("button");
          label.type = "button";
          label.className = "app-browser-tab-label";
          label.textContent = tab.title || tab.id;
          label.addEventListener("click", () => void activateDisplayBrowserTab(tab.id));
          const close = document.createElement("button");
          close.type = "button";
          close.className = "app-browser-tab-close";
          close.title = "Close tab";
          close.setAttribute("aria-label", "Close tab");
          close.innerHTML = "&times;";
          close.addEventListener("click", (event) => {
            event.stopPropagation();
            closeDisplayBrowserTab(tab.id);
          });
          item.append(label, close);
          tabs.appendChild(item);
        }
        const add = document.createElement("button");
        add.type = "button";
        add.className = "app-browser-tab-add";
        add.title = "Open running instance";
        add.setAttribute("aria-label", "Open running instance");
        add.textContent = "+";
        add.addEventListener("click", () => void openDisplayBrowserTabChooser());
        tabs.appendChild(add);
      }

      function updateDisplayBrowserUrl(path = "/", query = "") {
        const input = $id("displayUrlInput");
        if (!input) return;
        const matchedInstance = findEdgeServeInstanceForPath(path);
        const activeTab = appModeState.renderTarget === "display" ? activeDisplayBrowserTab() : null;
        const routePrefix = normalizePath(matchedInstance?.routePrefix || activeTab?.routePrefix || appModeState.config?.python?.routePrefix || "/");
        const routePath = normalizePath(path || "/");
        const displayPath = routePath.startsWith(routePrefix)
          ? routePath
          : `${routePrefix === "/" ? "" : routePrefix}${routePath === "/" ? "/" : routePath}`;
        input.value = `${displayPath}${query ? `?${query}` : ""}`;
      }

      function setDisplayBrowserEnabled(enabled) {
        $id("displayBrowserBar")?.classList.toggle("hidden", !enabled);
        $id("displayBackButton")?.classList.toggle("hidden", !enabled);
        $id("displayRefreshButton")?.classList.toggle("hidden", !enabled);
      }

      function syncDisplayBrowserButtons() {
        const backButton = $id("displayBackButton");
        if (backButton) backButton.disabled = appModeState.browserHistoryIndex <= 0;
      }

      function rememberDisplayBrowserHistory(url, options = {}) {
        const target = String(url || "").trim();
        if (!target) return;
        if (options.replaceCurrent && appModeState.browserHistoryIndex >= 0) {
          appModeState.browserHistory[appModeState.browserHistoryIndex] = target;
          syncDisplayBrowserButtons();
          if (appModeState.renderTarget === "display") saveDisplayBrowserTabState();
          return;
        }
        if (options.skipHistory) {
          syncDisplayBrowserButtons();
          if (appModeState.renderTarget === "display") saveDisplayBrowserTabState();
          return;
        }
        const nextHistory = appModeState.browserHistory.slice(0, appModeState.browserHistoryIndex + 1);
        nextHistory.push(target);
        appModeState.browserHistory = nextHistory.slice(-100);
        appModeState.browserHistoryIndex = appModeState.browserHistory.length - 1;
        syncDisplayBrowserButtons();
        if (appModeState.renderTarget === "display") saveDisplayBrowserTabState();
      }

      function normalizeDisplayBrowserUrl(raw) {
        const source = String(raw || "").trim() || "/";
        let path = source;
        let query = "";
        try {
          const parsed = new URL(source, "https://edgeterm.local");
          path = parsed.pathname || "/";
          query = parsed.search.replace(/^\?/, "");
        } catch {}
        const activeTab = appModeState.renderTarget === "display" ? activeDisplayBrowserTab() : null;
        const routePrefix = normalizePath(activeTab?.routePrefix || appModeState.config?.python?.routePrefix || "/");
        const matchedInstance = findEdgeServeInstanceForPath(path);
        if (!matchedInstance && routePrefix !== "/" && !path.startsWith(`${routePrefix}/`) && path !== routePrefix) {
          path = `${routePrefix}${path.startsWith("/") ? path : `/${path}`}`;
        }
        return `${path || "/"}${query ? `?${query}` : ""}`;
      }

      async function renderAppModeResponse(response, routePath, documentFsPath, options = {}) {
        const tab = appModeState.renderTarget === "display" ? activeDisplayBrowserTab() : null;
        const frame = options.frame || (appModeState.renderTarget === "display" ? ensureDisplayAppModeFrame() : $id("appModeFrame"));
        const contentType = String(response.headers?.["content-type"] || response.headers?.["Content-Type"] || "text/html");
        appModeState.currentPath = routePath || "/";
        appModeState.htmlPath = documentFsPath || appModeState.htmlPath || "";
        if (tab) {
          tab.currentPath = appModeState.currentPath;
          tab.htmlPath = appModeState.htmlPath;
        }
        revokeAppModeBlobs();

        if (/text\/html|application\/xhtml\+xml/i.test(contentType)) {
          frame.srcdoc = await buildRenderedDocument(response.body || "", routePath, documentFsPath, appModeState.config);
          return;
        }
        if (options.expectHtml) {
          throw new Error(`App Mode root must return HTML, but received ${contentType}. Check the configured entrypoint and runtime.`);
        }
        if (response.bodyBase64) {
          const bytes = Uint8Array.from(atob(response.bodyBase64), (char) => char.charCodeAt(0));
          const blobUrl = registerAppModeBlob(new Blob([bytes], { type: contentType }));
          if (/^image\//i.test(contentType)) {
            frame.srcdoc = `<!doctype html><html><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#fff;"><img src="${blobUrl}" style="max-width:100%;max-height:100vh;" /></body></html>`;
          } else {
            frame.srcdoc = `<!doctype html><html><body style="margin:0;padding:20px;font:14px system-ui,sans-serif;"><a href="${blobUrl}" target="_blank" rel="noopener">Open response</a></body></html>`;
          }
          return;
        }

        const pretty = /json/i.test(contentType)
          ? (() => {
              try {
                return JSON.stringify(JSON.parse(response.body || "{}"), null, 2);
              } catch {
                return response.body || "";
              }
            })()
          : String(response.body || "");
        const appModeHook = buildAppModeClientScript({
          currentPath: routePath || "/",
          exitHotkey: appModeState.config?.exit?.hotkey || "Escape",
          debugHotkey: appModeState.config?.ui?.debugTerminalHotkey || "Ctrl+`",
          allowDebugTerminal: !!appModeState.config?.ui?.allowDebugTerminal,
          siteData: {
            cookies: appModeState.cookieJar,
            localStorage: appModeState.siteLocalStorage,
            sessionStorage: appModeState.siteSessionStorage,
          },
        });
        frame.srcdoc = `<!doctype html><html><body style="margin:0;background:#0f172a;color:#e2e8f0;font:14px/1.5 ui-monospace,Consolas,monospace;"><pre style="margin:0;padding:20px;white-space:pre-wrap;">${encodeHtml(pretty)}</pre><scr` +
          `ipt>${appModeHook.replaceAll("</scr" + "ipt>", "<\\\\/script>")}</scr` +
          `ipt></body></html>`;
      }

      async function dispatchAppModeRoute(routePath = "/", queryString = "", options = {}) {
        const target = appRouteRequestUrl(routePath, queryString);
        return await navigateAppMode(target, options);
      }

      async function navigateAppMode(url = "/", options = {}) {
        const showBrowserProgress = appModeState.renderTarget === "display" && options.showProgress !== false;
        const progressToken = showBrowserProgress ? options.browserProgressToken || startBrowserLoading("Loading page...") : 0;
        const ownsProgress = showBrowserProgress && !options.browserProgressToken;
        try {
          updateBrowserLoading(progressToken, 16, "Requesting page...");
          const response = await dispatchAppModeRequest(url, options);
          updateBrowserLoading(progressToken, 42, "Receiving response...");
          rememberAppModeCookies(response);
          const redirectLocation = response.headers?.location || response.headers?.Location;
          if (
            redirectLocation &&
            response.status >= 300 &&
            response.status < 400 &&
            options.followRedirects !== false &&
            (options.redirectDepth || 0) < 10
          ) {
            updateBrowserLoading(progressToken, 58, "Following redirect...");
            const redirected = await navigateAppMode(redirectLocation, {
              ...options,
              method: "GET",
              body: "",
              headers: {},
              currentPath: appModeState.currentPath,
              redirectDepth: (options.redirectDepth || 0) + 1,
              browserProgressToken: progressToken,
            });
            if (ownsProgress) finishBrowserLoading(progressToken, "EdgeServe preview");
            return redirected;
          }
          const { path, query } = resolveAppRequestUrl(url, options.currentPath || appModeState.currentPath || "/");
          let documentFsPath = response.headers?.["x-edgeterm-fs-path"] || response.headers?.["X-EdgeTerm-Fs-Path"] || appModeState.htmlPath;
          if (!documentFsPath && appModeState.config?.runtime === "static") {
            documentFsPath = resolveStaticEntrypoint(appModeState.config, path === "/" ? "" : path);
          }
          updateBrowserLoading(progressToken, 72, "Rendering page...");
          await renderAppModeResponse(response, path, documentFsPath, options);
          updateBrowserLoading(progressToken, 90, "Finalizing page...");
          if (appModeState.renderTarget === "display") {
            updateBrowserStatus("EdgeServe preview");
            updateDisplayBrowserUrl(path, query);
            rememberDisplayBrowserHistory(`${path}${query ? `?${query}` : ""}`, {
              skipHistory: options.skipDisplayHistory,
              replaceCurrent: options.replaceDisplayHistory,
            });
            saveDisplayBrowserTabState();
            renderDisplayBrowserTabs();
          }
          if (appModeState.shareRoute?.shareId && options.updateHistory !== false && String(options.method || "GET").toUpperCase() === "GET") {
            syncSharedAppBrowserRoute(path, query, options.historyMode || "push");
          }
          if (appModeState.localRoute?.workspaceId && options.updateHistory !== false && String(options.method || "GET").toUpperCase() === "GET") {
            syncLocalAppBrowserRoute(path, query, options.historyMode || "push");
          }
          if (ownsProgress) finishBrowserLoading(progressToken, "EdgeServe preview");
          return response;
        } catch (err) {
          if (ownsProgress) failBrowserLoading(progressToken, "Page load failed");
          throw err;
        }
      }

      async function startPythonAppMode(config, initialUrl = "") {
        pyodide.globals.set("__edgeterm_user", activeUser());
        pyodide.globals.set("__edgeterm_rootfs_lib", workspacePath(activeWorkspaceId, "/rootfs/usr/lib"));
        pyodide.globals.set("__edgeterm_appmode_config_json", JSON.stringify(config));
        await pyodide.runPythonAsync(`
import builtins
import json
import os
import runpy
import sys

config = json.loads(__edgeterm_appmode_config_json)
entrypoint = config.get("entrypoint") or "/home/user/app.py"
working_directory = config.get("workingDirectory") or os.path.dirname(entrypoint) or "/home/user"
python_cfg = config.get("python") or {}
app_object_name = python_cfg.get("appObject") or "app"
app_spec = python_cfg.get("appSpec") or ""
framework = python_cfg.get("framework") or "edgeterm"
instance_id = python_cfg.get("instanceId") or ""
rootfs_lib = globals().get("__edgeterm_rootfs_lib", "") or os.environ.get("EDGETERM_ROOTFS_LIB", "")
edge_user = globals().get("__edgeterm_user", "") or os.environ.get("EDGE_USER", "user")

if not instance_id and not app_spec and not os.path.isfile(entrypoint):
    raise FileNotFoundError(f"App Mode entrypoint not found: {entrypoint}")
if working_directory and not os.path.isdir(working_directory):
    raise NotADirectoryError(f"App Mode working directory not found: {working_directory}")

os.environ["EDGE_USER"] = str(edge_user or "user")
if rootfs_lib:
    os.environ["EDGETERM_ROOTFS_LIB"] = rootfs_lib
if rootfs_lib and os.path.isdir(rootfs_lib) and rootfs_lib not in sys.path:
    sys.path.insert(0, rootfs_lib)
if os.path.isdir("/usr/lib") and "/usr/lib" not in sys.path:
    sys.path.insert(0, "/usr/lib")

import edgeterm

os.environ["EDGETERM_APPMODE"] = "1"
os.chdir(working_directory)
if instance_id:
    import edgeterm_wsgi

    instance = edgeterm_wsgi.get_instance(instance_id)
    builtins.EDGETERM_APPMODE = {
        "runtime": "edgeserve",
        "instanceId": instance.id,
        "routePrefix": instance.route_prefix,
        "mode": instance.mode,
        "cwd": working_directory,
    }
elif app_spec or framework == "wsgi":
    edgeterm.reset_app()
    import edgeterm_wsgi

    edgeterm.set_wsgi_app(edgeterm_wsgi.load_app(app_spec, working_directory))
    builtins.EDGETERM_APPMODE = {"runtime": "wsgi", "appSpec": app_spec, "cwd": working_directory}
else:
    edgeterm.reset_app()
    entry_dir = os.path.dirname(entrypoint)
    if entry_dir and entry_dir not in sys.path:
        sys.path.insert(0, entry_dir)
    namespace = runpy.run_path(entrypoint, run_name="__main__")
    candidate = namespace.get(app_object_name)
    if candidate is not None and hasattr(candidate, "dispatch"):
        edgeterm.app = candidate
    builtins.EDGETERM_APPMODE = {"runtime": "python", "entrypoint": entrypoint, "cwd": working_directory}
`);
        const routePrefix = normalizePath(config.python?.routePrefix || "/");
        await navigateAppMode(initialUrl || routePrefix || "/", { expectHtml: !initialUrl, updateHistory: false });
      }

      async function startStaticAppMode(config, initialUrl = "") {
        if (initialUrl) {
          await navigateAppMode(initialUrl, { expectHtml: false, updateHistory: false });
          return;
        }
        const entrypoint = resolveStaticEntrypoint(config, config.entrypoint);
        const routePath = staticRoutePathForFsPath(entrypoint, config);
        await navigateAppMode(routePath, { expectHtml: true, updateHistory: false });
      }

      async function enterAppMode(config = null, options = {}) {
        const resolved = normalizeAppModeConfig(config || readAppModeConfig());
        validateAppModeConfig(resolved);
        hideAppModeError();
        appModeState.config = resolved;
        const site = describeAppModeSite(resolved);
        loadAppModeSiteData(site);
        appModeState.previousView = currentViewId();
        appModeState.booting = true;
        appModeState.active = true;
        setAppModeVisible(true, resolved);
        setAppModeLoading(!!resolved.showLoadingOverlay, `Loading ${resolved.runtime} app for ${activeWorkspace().name}...`);
        try {
          if (!resolved.preserveStateOnExit || options.forceReload) clearAppModeFrame();
          if (resolved.runtime === "python") await startPythonAppMode(resolved, options.initialUrl || "");
          else await startStaticAppMode(resolved, options.initialUrl || "");
          setAppModeLoading(false);
        } catch (err) {
          console.error("[APPMODE] Failed:", err);
          showAppModeError("App Mode startup failed.", formatInitError(err));
          if (options.throwOnError) throw err;
        } finally {
          appModeState.booting = false;
        }
      }

      async function exitAppMode(options = {}) {
        if (!appModeState.active && !appModeState.booting) return;
        const config = appModeState.config || readAppModeConfig();
        if (
          !options.force &&
          config.exit?.confirmBeforeExit &&
          !(await askConfirm("Exit App Mode", "Return to the EdgeTerm workspace?", { confirmLabel: "Exit App Mode" }))
        ) return;
        appModeState.active = false;
        appModeState.booting = false;
        setAppModeLoading(false);
        hideAppModeError();
        setAppModeVisible(false, config);
        appModeState.renderTarget = "shell";
        if (!config.preserveStateOnExit || options.resetSurface) clearAppModeFrame();
        const shareRoute = appModeState.shareRoute;
        if (shareRoute?.shareId) {
          history.replaceState({ edgetermShare: true, shareId: shareRoute.shareId }, "", shareRoute.fallbackUrl || `/?share=${encodeURIComponent(shareRoute.shareId)}`);
        }
        const localRoute = appModeState.localRoute;
        if (localRoute?.workspaceId) {
          history.replaceState({ edgetermLocalApp: true, workspaceId: localRoute.workspaceId }, "", localRoute.fallbackUrl || "/");
        }
        if (shareRoute?.deferredWorkspaceBoot) {
          await bootShell();
          refreshFiles(`/home/${activeUser()}`);
          shareRoute.deferredWorkspaceBoot = false;
        }
        clearSharedAppRouting();
        clearLocalAppRouting();
        if (options.toDebugTerminal !== false) {
          setView(options.view || appModeState.previousView || "terminalView");
        }
      }

      async function maybeAutoStartAppMode() {
        const config = readAppModeConfig();
        appModeState.config = config;
        if (config.enabled && config.autoStart) await enterAppMode(config);
      }

      function populateAppModeSettings(config = readAppModeConfig()) {
        $id("appModeEnabled").checked = !!config.enabled;
        $id("appModeRuntime").value = config.runtime;
        $id("appModeEntrypoint").value = config.entrypoint;
        $id("appModeStaticRoot").value = config.staticRoot;
        $id("appModeWorkingDirectory").value = config.workingDirectory;
        $id("appModeFullscreen").checked = !!config.fullscreen;
        $id("appModeAutoStart").checked = !!config.autoStart;
        $id("appModePreserveState").checked = !!config.preserveStateOnExit;
        $id("appModeShowLoading").checked = !!config.showLoadingOverlay;
        $id("appModeExitHotkey").value = config.exit?.hotkey || "Escape";
        $id("appModeConfirmExit").checked = !!config.exit?.confirmBeforeExit;
        $id("appModeHideChrome").checked = !!config.ui?.hideWorkspaceChrome;
        $id("appModeAllowDebugTerminal").checked = !!config.ui?.allowDebugTerminal;
        $id("appModeDebugHotkey").value = config.ui?.debugTerminalHotkey || "Ctrl+`";
        $id("appModePythonObject").value = config.python?.appObject || "app";
        $id("appModeRoutePrefix").value = config.python?.routePrefix || "/";
        $id("appModePythonFs").checked = !!config.python?.allowFilesystemAccess;
        $id("appModeStaticIndexFile").value = config.static?.indexFile || "index.html";
        $id("appModeAllowInlineScripts").checked = !!config.static?.allowInlineScripts;
      }

      function collectAppModeSettings() {
        return normalizeAppModeConfig({
          enabled: $id("appModeEnabled").checked,
          runtime: $id("appModeRuntime").value,
          entrypoint: normalizePath($id("appModeEntrypoint").value || (String($id("appModeRuntime").value) === "static" ? "/home/user/index.html" : "/home/user/app.py")),
          staticRoot: normalizePath($id("appModeStaticRoot").value || "/home/user/public"),
          workingDirectory: normalizePath($id("appModeWorkingDirectory").value || "/home/user"),
          fullscreen: $id("appModeFullscreen").checked,
          autoStart: $id("appModeAutoStart").checked,
          preserveStateOnExit: $id("appModePreserveState").checked,
          showLoadingOverlay: $id("appModeShowLoading").checked,
          exit: {
            method: "hotkey",
            hotkey: $id("appModeExitHotkey").value || "Escape",
            confirmBeforeExit: $id("appModeConfirmExit").checked,
          },
          ui: {
            hideWorkspaceChrome: $id("appModeHideChrome").checked,
            allowDebugTerminal: $id("appModeAllowDebugTerminal").checked,
            debugTerminalHotkey: $id("appModeDebugHotkey").value || "Ctrl+`",
          },
          python: {
            appObject: $id("appModePythonObject").value || "app",
            routePrefix: $id("appModeRoutePrefix").value || "/",
            allowFilesystemAccess: $id("appModePythonFs").checked,
          },
          static: {
            indexFile: $id("appModeStaticIndexFile").value || "index.html",
            allowInlineScripts: $id("appModeAllowInlineScripts").checked,
          },
        });
      }

      async function seedDefaultRootfs(id, force = false) {
        const rootfsPath = workspacePath(id, "/rootfs");
        const shellPath = `${rootfsPath}/bin/shell.py`;
        const shellEnginePath = `${rootfsPath}/usr/lib/edgeterm_shell.py`;
        const workspace = workspaces.find((item) => item.id === id);
        const hasRootfs = pyodide.FS.analyzePath(`${rootfsPath}/bin/shell.py`).exists;
        const hasCurrentShell =
          pyodide.FS.analyzePath(shellPath).exists &&
          pyodide.FS.readFile(shellPath, { encoding: "utf8" }).includes("EDGETERM_SHELL") &&
          pyodide.FS.analyzePath(shellEnginePath).exists &&
          pyodide.FS.readFile(shellEnginePath, { encoding: "utf8" }).includes("class EdgeTermShell");
        const isCustomRootfs = workspace?.rootfsVersion === "custom";
        const hasCurrentRootfs = workspace?.rootfsVersion === DEFAULT_ROOTFS_VERSION && hasCurrentShell;

        if (!force && (isCustomRootfs || (hasRootfs && hasCurrentRootfs))) return;

        clearDirectory(rootfsPath);
        const rootfsUrl = `${assetUrl("rootfs.zip")}?v=${encodeURIComponent(DEFAULT_ROOTFS_VERSION)}`;
        setLoadingMessage("Downloading rootfs...");
        const resp = await fetch(rootfsUrl, { cache: "no-store" });
        if (!resp.ok) throw new Error("Failed to fetch rootfs.zip");
        const zip = await JSZip.loadAsync(await readResponseBlobWithProgress(resp, "Downloading rootfs..."));
        await extractZipTo(zip, rootfsPath);
        if (workspace) workspace.rootfsVersion = DEFAULT_ROOTFS_VERSION;
      }

      async function ensureWorkspaceLayout(id) {
        for (const dir of [
          workspacePath(id),
          workspacePath(id, "/rootfs"),
          workspacePath(id, "/home/user"),
          workspacePath(id, "/overlay/upper"),
          workspacePath(id, "/overlay/work"),
        ]) {
          ensureDir(dir);
        }
        const workspace = workspaces.find((item) => item.id === id);
        for (const user of workspace.users || ["user"]) {
          ensureDir(workspacePath(id, `/home/${user}`));
        }
        await seedDefaultRootfs(id);
        ensureAppModeStarterFiles(id);
      }

      function ensureAppModeStarterFiles(id) {
        const pythonSamplePath = workspacePath(id, "/home/user/app.py");
        const staticDir = workspacePath(id, "/home/user/public");
        const staticSamplePath = `${staticDir}/index.html`;
        ensureDir(staticDir);
        if (!pyodide.FS.analyzePath(pythonSamplePath).exists) {
          pyodide.FS.writeFile(
            pythonSamplePath,
            `from edgeterm import app, request

@app.route("/")
def index():
    return """
    <main style="min-height:100vh;display:grid;place-items:center;background:#020617;color:#e2e8f0;font-family:Inter,system-ui,sans-serif;">
      <div style="width:min(720px,92vw);padding:32px;border:1px solid rgba(148,163,184,.18);border-radius:18px;background:rgba(15,23,42,.92);box-shadow:0 24px 60px rgba(2,6,23,.45);">
        <p style="margin:0 0 10px;color:#7dd3fc;font-size:14px;">EdgeTerm App Mode</p>
        <h1 style="margin:0 0 14px;font-size:32px;">Hello from EdgeTerm</h1>
        <p style="margin:0 0 18px;color:#cbd5e1;">Edit <code>/home/user/app.py</code> and reload App Mode to build your Python app.</p>
        <p style="margin:0;"><a href="/api/data" style="color:#38bdf8;">Open JSON demo route</a></p>
      </div>
    </main>
    """

@app.route("/api/data")
def data():
    return {"value": 123, "query": request.args}
`,
            { encoding: "utf8" }
          );
        }
        if (!pyodide.FS.analyzePath(staticSamplePath).exists) {
          pyodide.FS.writeFile(
            staticSamplePath,
            `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>EdgeTerm Static App</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #020617; color: #e2e8f0; font-family: Inter, system-ui, sans-serif; }
      main { width: min(720px, 92vw); padding: 32px; border: 1px solid rgba(148,163,184,.18); border-radius: 18px; background: rgba(15,23,42,.92); box-shadow: 0 24px 60px rgba(2,6,23,.45); }
      h1 { margin: 0 0 14px; font-size: 32px; }
      p { color: #cbd5e1; }
      code, a { color: #38bdf8; }
    </style>
  </head>
  <body>
    <main>
      <p>EdgeTerm App Mode</p>
      <h1>Hello from Static App Mode</h1>
      <p>Edit <code>/home/user/public/index.html</code> to customize this app.</p>
    </main>
  </body>
</html>
`,
            { encoding: "utf8" }
          );
        }
      }

      function createRootLinks() {
        const fs = pyodide.FS;
        const links = ["boot", "bin", "etc", "packages", "usr", "var"];

        for (const dir of links) {
          const link = `/${dir}`;
          const target = workspacePath(activeWorkspaceId, `/rootfs/${dir}`);
          ensureDir(target);

          try {
            const stat = fs.lstat(link);
            if (fs.isLink(stat.mode)) fs.unlink(link);
            else continue;
          } catch (err) {
            if (err?.errno !== 44) continue;
          }

          fs.symlink(target, link);
        }
      }

      function prepareActiveMounts() {
        ensureDir("/workspace-store");
        ensureDir("/home");
        ensureDir("/overlay");
        ensureDir("/overlay/upper");
        ensureDir("/overlay/work");
        for (const user of mountedUsers) {
          const path = `/home/${user}`;
          if (pyodide.FS.analyzePath(path).exists) clearDirectory(path);
        }
        mountedUsers = new Set(activeWorkspace().users);
        for (const user of mountedUsers) ensureDir(`/home/${user}`);
        removeRootOverlayEntries();
        clearDirectory("/overlay/upper");
        for (const user of mountedUsers) {
          copyTree(workspacePath(activeWorkspaceId, `/home/${user}`), `/home/${user}`);
        }
        copyTree(workspacePath(activeWorkspaceId, "/overlay/upper"), "/overlay/upper");
        createRootLinks();
        restoreRootOverlayFromWorkspace();
        refreshWasmCommandLinks();
        pyodide.FS.chdir(`/home/${activeUser()}`);
      }

      function recordDisplayEvent(event) {
        displayInputQueue.push({ ...event, ts: Date.now() });
        if (displayInputQueue.length > 200) displayInputQueue = displayInputQueue.slice(-200);
      }

      function updateDisplayStatus(message) {
        $id("displayStatus").textContent = message;
      }

      function setDisplayVisibility(mode) {
        $id("displayEmpty").classList.toggle("hidden", mode !== "empty");
        $id("displayCanvas").classList.toggle("hidden", mode !== "canvas");
        $id("displayContent").classList.toggle("hidden", mode === "empty" || mode === "canvas");
      }

      function setBrowserVisibility(mode) {
        $id("browserEmpty")?.classList.toggle("hidden", mode !== "empty");
        $id("browserContent")?.classList.toggle("hidden", mode !== "content");
      }

      function updateBrowserStatus(message) {
        const status = $id("browserStatus");
        if (status) status.textContent = message;
      }

      function setBrowserLoadingProgress(percent = 0, message = "") {
        const wrap = $id("browserLoadingProgress");
        const fill = $id("browserLoadingProgressFill");
        if (!wrap || !fill) return;
        const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
        wrap.classList.add("active");
        fill.style.width = `${safePercent}%`;
        if (message) updateBrowserStatus(message);
      }

      function startBrowserLoading(message = "Loading page...") {
        browserLoadingToken += 1;
        clearTimeout(browserLoadingHideTimer);
        const wrap = $id("browserLoadingProgress");
        const fill = $id("browserLoadingProgressFill");
        if (wrap && fill) {
          wrap.classList.add("active");
          fill.style.transition = "none";
          fill.style.width = "0%";
          fill.getBoundingClientRect();
          fill.style.transition = "";
        }
        setBrowserLoadingProgress(8, message);
        return browserLoadingToken;
      }

      function updateBrowserLoading(token, percent, message = "") {
        if (!token || token !== browserLoadingToken) return;
        setBrowserLoadingProgress(percent, message);
      }

      function finishBrowserLoading(token, message = "") {
        if (!token || token !== browserLoadingToken) return;
        setBrowserLoadingProgress(100, message);
        clearTimeout(browserLoadingHideTimer);
        browserLoadingHideTimer = setTimeout(() => {
          if (token !== browserLoadingToken) return;
          const wrap = $id("browserLoadingProgress");
          const fill = $id("browserLoadingProgressFill");
          wrap?.classList.remove("active");
          if (fill) fill.style.width = "0%";
        }, 360);
      }

      function failBrowserLoading(token, message = "Page load failed") {
        if (!token || token !== browserLoadingToken) return;
        clearTimeout(browserLoadingHideTimer);
        const wrap = $id("browserLoadingProgress");
        wrap?.classList.remove("active");
        const fill = $id("browserLoadingProgressFill");
        if (fill) fill.style.width = "0%";
        if (message) updateBrowserStatus(message);
      }

      function setDisplayFullscreen(enabled) {
        displayState.fullscreen = !!enabled;
        $id("displayView").classList.toggle("display-fullscreen", !!enabled);
        const button = $id("fullscreenDisplay");
        if (button) {
          button.innerHTML = enabled ? '<i data-lucide="shrink"></i>' : '<i data-lucide="expand"></i>';
          button.title = enabled ? "Exit fullscreen display" : "Fullscreen display";
          button.setAttribute("aria-label", button.title);
        }
        const browserButton = $id("fullscreenBrowser");
        if (browserButton) {
          browserButton.innerHTML = enabled ? '<i data-lucide="shrink"></i>' : '<i data-lucide="expand"></i>';
          browserButton.title = enabled ? "Exit fullscreen browser" : "Fullscreen browser";
          browserButton.setAttribute("aria-label", browserButton.title);
        }
        window.lucide?.createIcons();
      }

      async function toggleDisplayViewportFullscreen() {
        const target = currentViewId() === "browserView" ? $id("browserView") : $id("displayView");
        const isFullscreen = document.fullscreenElement === target;
        if (isFullscreen) {
          await document.exitFullscreen?.();
          setDisplayFullscreen(false);
          return;
        }
        await target.requestFullscreen?.();
        setDisplayFullscreen(true);
      }

      function clearDisplaySurface(message = "Display cleared") {
        const canvas = $id("displayCanvas");
        const content = $id("displayContent");
        setDisplayVisibility("empty");
        content.innerHTML = "";
        content.className = "display-content hidden";
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width || 1, canvas.height || 1);
        displayState.mode = "empty";
        displayState.lastType = "clear";
        updateDisplayStatus(message);
      }

      function setCanvasSize(width = 960, height = 640, background = "#ffffff") {
        const canvas = $id("displayCanvas");
        const safeWidth = Math.max(1, Number(width) || 960);
        const safeHeight = Math.max(1, Number(height) || 640);
        canvas.width = safeWidth;
        canvas.height = safeHeight;
        canvas.style.background = background || "#ffffff";
        displayState.width = safeWidth;
        displayState.height = safeHeight;
        return canvas;
      }

      function bindSDLCanvas() {
        const canvas = $id("displayCanvas");
        try {
          if (pyodide?._api) pyodide._api._skip_unwind_fatal_error = true;
          pyodide?.canvas?.setCanvas2D?.(canvas);
          canvas.focus();
          updateDisplayStatus(`SDL canvas ${canvas.width}x${canvas.height}`);
        } catch (err) {
          console.error("[DISPLAY] SDL bind failed:", err);
          showNotice(`SDL bind failed: ${err.message || err}`);
        }
        return canvas;
      }

      function renderDisplayTable(message) {
        const content = $id("displayContent");
        const columns =
          Array.isArray(message.columns) && message.columns.length
            ? message.columns
            : Array.isArray(message.rows) && message.rows.length && !Array.isArray(message.rows[0])
              ? Object.keys(message.rows[0])
              : [];
        const rows = Array.isArray(message.rows) ? message.rows : [];
        const thead = columns.length
          ? `<thead><tr>${columns.map((column) => `<th>${column}</th>`).join("")}</tr></thead>`
          : "";
        const tbody = rows
          .map((row) => {
            if (Array.isArray(row)) {
              return `<tr>${row.map((value) => `<td>${value ?? ""}</td>`).join("")}</tr>`;
            }
            return `<tr>${columns.map((column) => `<td>${row?.[column] ?? ""}</td>`).join("")}</tr>`;
          })
          .join("");
        content.innerHTML = `<table class="display-table">${thead}<tbody>${tbody}</tbody></table>`;
      }

      function renderDisplayMessage(message) {
        const canvas = $id("displayCanvas");
        const content = $id("displayContent");
        const normalized = typeof message === "string" ? JSON.parse(message) : message;
        if (!normalized || typeof normalized !== "object") throw new Error("Display payload must be an object");
        displayMessageHistory.push(normalized);
        if (displayMessageHistory.length > 50) displayMessageHistory = displayMessageHistory.slice(-50);

        if (normalized.type === "fullscreen") {
          setDisplayFullscreen(normalized.enabled !== false);
          return;
        }

        if (normalized.type === "switch") {
          setView("displayView");
          if (normalized.focus !== false) $id("displayCanvas").focus();
          updateDisplayStatus(normalized.message || "Display tab active");
          return;
        }

        if (normalized.type === "clear") {
          clearDisplaySurface(normalized.message || "Display cleared");
          return;
        }

        if (normalized.type === "resize") {
          setCanvasSize(normalized.width || displayState.width, normalized.height || displayState.height, normalized.background);
          updateDisplayStatus(`Display resized to ${displayState.width}x${displayState.height}`);
          return;
        }

        setView("displayView");

        if (normalized.type === "canvas") {
          setDisplayVisibility("canvas");
          setCanvasSize(normalized.width, normalized.height, normalized.background);
          if (normalized.bindSDL || normalized.sdl) bindSDLCanvas();
          if (normalized.action === "draw_demo") {
            const ctx = canvas.getContext("2d");
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = "#0f172a";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = "#22c55e";
            ctx.beginPath();
            ctx.arc(canvas.width * 0.25, canvas.height * 0.35, 46, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#ffffff";
            ctx.font = "24px Inter, sans-serif";
            ctx.fillText("Canvas OK", canvas.width * 0.44, canvas.height * 0.4);
            ctx.strokeStyle = "#38bdf8";
            ctx.lineWidth = 5;
            ctx.strokeRect(canvas.width * 0.12, canvas.height * 0.58, canvas.width * 0.72, canvas.height * 0.18);
          }
          if (normalized.focus !== false) canvas.focus();
          displayState.mode = "canvas";
          displayState.lastType = "canvas";
          updateDisplayStatus(`Canvas ${canvas.width}x${canvas.height}`);
          return;
        }

        setDisplayVisibility("content");
        content.className = "display-content";

        if (normalized.type === "svg") {
          content.innerHTML = normalized.content || normalized.svg || "";
        } else if (normalized.type === "image") {
          const src = normalized.src || normalized.data || "";
          const alt = normalized.alt || "Display image";
          content.innerHTML = `<img class="display-media" src="${src}" alt="${alt}" />`;
        } else if (normalized.type === "html") {
          content.classList.add("display-html");
          content.innerHTML = normalized.content || normalized.html || "";
        } else if (normalized.type === "table") {
          renderDisplayTable(normalized);
        } else {
          throw new Error(`Unsupported display type: ${normalized.type}`);
        }

        displayState.mode = normalized.type;
        displayState.lastType = normalized.type;
        updateDisplayStatus(`${normalized.type} output`);
      }

      function configureDisplayBridge() {
        const surface = $id("displaySurface");
        const canvas = $id("displayCanvas");

        const recordPointer = (eventName, event) => {
          const rect = canvas.getBoundingClientRect();
          recordDisplayEvent({
            type: eventName,
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
            button: event.button,
            buttons: event.buttons,
            key: event.key || null,
            deltaX: event.deltaX || 0,
            deltaY: event.deltaY || 0,
          });
        };

        canvas.addEventListener("pointerdown", (event) => {
          canvas.focus();
          recordPointer("pointerdown", event);
        });
        canvas.addEventListener("pointermove", (event) => recordPointer("pointermove", event));
        canvas.addEventListener("pointerup", (event) => recordPointer("pointerup", event));
        canvas.addEventListener("wheel", (event) => recordPointer("wheel", event));
        canvas.addEventListener("keydown", (event) => recordDisplayEvent({ type: "keydown", key: event.key, code: event.code }));
        canvas.addEventListener("keyup", (event) => recordDisplayEvent({ type: "keyup", key: event.key, code: event.code }));
        surface.addEventListener("dblclick", () => canvas.focus());

        window.EdgeTermDisplay = {
          send: renderDisplayMessage,
          clear: clearDisplaySurface,
          switchTab: (focus = true) => renderDisplayMessage({ type: "switch", focus }),
          focus: () => canvas.focus(),
          getCanvas: () => canvas,
          bindSDLCanvas,
          consumeInputEvents: () => {
            const events = [...displayInputQueue];
            displayInputQueue = [];
            return events;
          },
          state: () => ({ ...displayState }),
          history: () => [...displayMessageHistory],
        };
      }

      function editorContext() {
        const path = normalizePath($id("editorPath")?.value || "/home/user/notes.txt");
        return {
          path,
          splitPath: normalizePath($id("editorSplitPath")?.value || splitEditorPath || path),
          isPython: path.endsWith(".py"),
          hasSelection: !!editor?.getSelection() && !editor.getSelection().isEmpty(),
          split: editorSplitEnabled,
          theme: editorTheme,
        };
      }

      function setEditorStatus(message) {
        $id("editorStatus").textContent = message;
      }

      function setSplitEditorStatus(message) {
        $id("editorSplitStatus").textContent = message;
      }

      function monacoThemeForAppTheme(theme = appTheme) {
        return theme === "dark" ? "vs-dark" : "vs";
      }

      function applyAppTheme(theme = appTheme) {
        appTheme = theme === "dark" ? "dark" : "light";
        localStorage.setItem(APP_THEME_KEY, appTheme);
        document.body.dataset.theme = appTheme;
        editorTheme = monacoThemeForAppTheme(appTheme);
        if (window.monaco?.editor) monaco.editor.setTheme(editorTheme);
        const toggle = $id("toggleTheme");
        const settingsToggle = $id("settingsToggleTheme");
        const icon = appTheme === "dark" ? "sun-medium" : "moon-star";
        const label = appTheme === "dark" ? "dark" : "light";
        $id("themeModeLabel") && ($id("themeModeLabel").textContent = label);
        if (toggle) {
          toggle.title = `Switch to ${appTheme === "dark" ? "light" : "dark"} theme`;
          toggle.setAttribute("aria-label", toggle.title);
          toggle.innerHTML = `<i data-lucide="${icon}"></i>`;
        }
        if (settingsToggle) {
          settingsToggle.innerHTML = `<i data-lucide="${icon}"></i>${appTheme === "dark" ? "Light" : "Dark"}`;
        }
        window.lucide?.createIcons();
      }

      function toggleAppTheme() {
        applyAppTheme(appTheme === "dark" ? "light" : "dark");
        setEditorStatus(`Theme: ${appTheme}`);
      }

      function defaultEditorPath() {
        return `/home/${activeUser()}/notes.txt`;
      }

      function editorInstanceForTarget(target = "main") {
        return target === "split" ? splitEditor : editor;
      }

      function editorPathFieldForTarget(target = "main") {
        return $id(target === "split" ? "editorSplitPath" : "editorPath");
      }

      function currentEditorPath(target = "main") {
        const fallback = target === "split" ? splitEditorPath || defaultEditorPath() : defaultEditorPath();
        return normalizePath(editorPathFieldForTarget(target)?.value || fallback);
      }

      function createEditorModel(path, content) {
        return monaco.editor.createModel(content, editorLanguageForPath(path));
      }

      function replaceEditorModel(target, model) {
        const instance = editorInstanceForTarget(target);
        if (!instance) return;
        const oldModel = instance.getModel();
        instance.setModel(model);
        if (oldModel && oldModel !== model) oldModel.dispose();
      }

      function loadEditorFile(path) {
        const fs = pyodide.FS;
        const target = normalizePath(path);
        const queuedEntry = queuedWorkspaceJournalEntryForRuntimePath(target);
        if (queuedEntry?.kind === "file") {
          const bytes = new Uint8Array(queuedEntry.bytes || new ArrayBuffer(0));
          ensureDir(target.split("/").slice(0, -1).join("/") || "/");
          fs.writeFile(target, bytes);
          return { created: false, path: target, content: new TextDecoder().decode(bytes) };
        }
        if (!fs.analyzePath(target).exists) {
          ensureDir(target.split("/").slice(0, -1).join("/") || "/");
          fs.writeFile(target, "");
          return { created: true, path: target, content: "" };
        }
        return { created: false, path: target, content: fs.readFile(target, { encoding: "utf8" }) };
      }

      function hideEditorMenu() {
        editorMenuOpen = null;
        $id("editorMenuPopover").classList.add("hidden");
        document.querySelectorAll(".menu-button").forEach((button) => button.classList.remove("active"));
      }

      function registerEditorCommand(command) {
        editorCommands = editorCommands.filter((item) => item.id !== command.id);
        editorCommands.push(command);
      }

      function registerEditorMenu(menu) {
        editorMenuItems.set(menu.id, menu);
      }

      function registerEditorToolbarButton(button) {
        editorToolbarButtons = editorToolbarButtons.filter((item) => item.id !== button.id);
        editorToolbarButtons.push(button);
      }

      function getEditorCommandsForPalette(query = "") {
        const text = query.trim().toLowerCase();
        const ctx = editorContext();
        return editorCommands.filter((command) => {
          if (command.when && !command.when(ctx)) return false;
          if (!text) return true;
          return [command.label, command.menu, command.shortcut, command.id].filter(Boolean).join(" ").toLowerCase().includes(text);
        });
      }

      function renderCommandPalette() {
        const modal = $id("editorCommandPalette");
        if (modal.classList.contains("hidden")) return;
        const list = $id("commandPaletteList");
        const query = $id("commandPaletteInput").value;
        const items =
          editorPaletteMode === "files"
            ? (pyodide.FS.analyzePath(currentPath).exists ? pyodide.FS.readdir(currentPath) : [])
                .filter((entry) => entry !== "." && entry !== "..")
                .map((name) => ({
                  id: `file:${name}`,
                  label: name,
                  icon: "file-code-2",
                  execute: () => openEditor(`${currentPath === "/" ? "" : currentPath}/${name}`),
                  shortcut: currentPath,
                }))
                .filter((item) => item.label.toLowerCase().includes(query.trim().toLowerCase()))
            : getEditorCommandsForPalette(query);
        editorPaletteSelection = Math.min(editorPaletteSelection, Math.max(items.length - 1, 0));
        list.innerHTML = "";
        if (!items.length) {
          if (editorPaletteMode === "files" && query.trim()) {
            list.innerHTML = `
              <button class="palette-item active">
                <i data-lucide="folder-open"></i>
                <span>Open ${query.trim()}</span>
                <span class="menu-shortcut">path</span>
              </button>
            `;
            list.querySelector("button").addEventListener("click", async () => {
              await openEditor(query.trim());
              closeCommandPalette();
            });
            window.lucide?.createIcons();
            return;
          }
          list.innerHTML = '<div class="file-muted px-4 py-3">No matching commands</div>';
          return;
        }
        items.forEach((item, index) => {
          const button = document.createElement("button");
          button.className = `palette-item${index === editorPaletteSelection ? " active" : ""}`;
          button.innerHTML = `
            <i data-lucide="${item.icon || "command"}"></i>
            <span>${item.label}</span>
            <span class="menu-shortcut">${item.shortcut || ""}</span>
          `;
          button.addEventListener("click", async () => {
            await item.execute?.();
            closeCommandPalette();
          });
          list.appendChild(button);
        });
        list.dataset.items = JSON.stringify(items.map((item) => item.id));
        window.lucide?.createIcons();
      }

      function openCommandPalette(mode = "commands") {
        editorPaletteMode = mode;
        editorPaletteSelection = 0;
        $id("editorCommandPalette").classList.remove("hidden");
        $id("commandPaletteInput").value = "";
        renderCommandPalette();
        $id("commandPaletteInput").focus();
      }

      function closeCommandPalette() {
        $id("editorCommandPalette").classList.add("hidden");
        editor?.focus();
      }

      async function executeEditorCommand(id) {
        const command = editorCommands.find((item) => item.id === id);
        if (!command) return;
        if (command.when && !command.when(editorContext())) {
          showNotice(`${command.label} is not available right now`);
          return;
        }
        hideEditorMenu();
        await command.execute?.();
        renderEditorChrome();
      }

      async function executeInTerminal(command, options = {}) {
        if (!command?.trim()) return;
        if (options.switchView !== false) setView("terminalView");
        term.echo(`${await getShellPromptPath()} $ ${command}`);
        await runCommand(command, options);
      }

      function currentEditorSelectionText() {
        if (!editor) return "";
        const selection = editor.getSelection();
        return selection && !selection.isEmpty() ? editor.getModel().getValueInRange(selection) : "";
      }

      async function saveEditorAs(path = null) {
        const requested = path || await askText("Save File As", "Path", $id("editorPath").value, { confirmLabel: "Save" });
        const target = normalizePath(requested || "");
        if (!target) return;
        $id("editorPath").value = target;
        await saveEditor();
        setEditorStatus(`Saved as ${target}`);
      }

      async function renameEditorFile() {
        const path = normalizePath($id("editorPath").value);
        if (!pyodide.FS.analyzePath(path).exists) {
          showNotice("File does not exist yet");
          return;
        }
        const currentName = path.split("/").filter(Boolean).pop();
        const nextName = await askText("Rename File", "New file name", currentName, { confirmLabel: "Rename" });
        if (!nextName) return;
        const target = `${path.split("/").slice(0, -1).join("/")}/${nextName}`;
        pyodide.FS.rename(path, target);
        $id("editorPath").value = target;
        await persistActiveWorkspace();
        refreshFiles(currentPath);
        setEditorStatus(`Renamed to ${nextName}`);
        showNotice(`Renamed to ${nextName}`);
      }

      async function downloadCurrentEditorFile() {
        const path = normalizePath($id("editorPath").value);
        await saveEditor();
        await downloadPath(path);
        showNotice(`Downloaded ${path}`);
      }

      async function uploadIntoEditor() {
        $id("editorUploader").click();
      }

      async function closeEditorTab() {
        replaceEditorModel("main", createEditorModel(defaultEditorPath(), ""));
        $id("editorPath").value = `/home/${activeUser()}/untitled.txt`;
        setEditorStatus("Editor cleared");
        showNotice("Closed editor tab");
      }

      function applyEditorOptions() {
        const wrap = localStorage.getItem("edgeterm.editor.wrap") === "1" ? "on" : "off";
        const minimap = localStorage.getItem("edgeterm.editor.minimap") !== "0";
        editor?.updateOptions({ wordWrap: wrap, minimap: { enabled: minimap } });
        splitEditor?.updateOptions({ wordWrap: wrap, minimap: { enabled: false }, readOnly: false });
      }

      function syncSplitEditor() {
        splitEditor?.layout();
      }

      function toggleSplitEditor() {
        editorSplitEnabled = !editorSplitEnabled;
        $id("editorMain").classList.toggle("split", editorSplitEnabled);
        $id("editorSplitPane").classList.toggle("hidden", !editorSplitEnabled);
        if (editorSplitEnabled && !splitEditor?.getModel()) {
          void openEditorInTarget(currentEditorPath("main"), { target: "split", quiet: true, switchView: false });
        }
        editor?.layout();
        splitEditor?.layout();
        setEditorStatus(editorSplitEnabled ? "Split editor enabled" : "Split editor disabled");
      }

      function toggleEditorFullscreen() {
        $id("editorView").classList.toggle("editor-fullscreen");
        editor?.layout();
        splitEditor?.layout();
      }

      function cycleEditorTheme() {
        toggleAppTheme();
      }

      function toggleWordWrap() {
        const next = localStorage.getItem("edgeterm.editor.wrap") === "1" ? "0" : "1";
        localStorage.setItem("edgeterm.editor.wrap", next);
        applyEditorOptions();
        setEditorStatus(next === "1" ? "Word wrap on" : "Word wrap off");
      }

      function toggleMinimap() {
        const next = localStorage.getItem("edgeterm.editor.minimap") === "0" ? "1" : "0";
        localStorage.setItem("edgeterm.editor.minimap", next);
        applyEditorOptions();
        setEditorStatus(next === "1" ? "Minimap on" : "Minimap off");
      }

      async function restartRuntime() {
        await persistActiveWorkspace();
        await bootShell();
        setView("terminalView");
        setEditorStatus("Runtime restarted");
        showNotice("Runtime restarted");
      }

      async function runCurrentFile(runArgs = "") {
        const path = normalizePath($id("editorPath").value);
        await saveEditor();
        if (!path.endsWith(".py")) {
          showNotice("Run Current File currently supports .py files");
          return;
        }
        await executeInTerminal(`python ${path}${runArgs ? ` ${runArgs}` : ""}`, { postRunSync: false });
      }

      async function runSelection() {
        const code = currentEditorSelectionText();
        if (!code.trim()) {
          showNotice("Select some code first");
          return;
        }
        const tempPath = `/tmp/edgeterm-selection-${Date.now()}.py`;
        ensureDir("/tmp");
        pyodide.FS.writeFile(tempPath, code);
        await executeInTerminal(`python ${tempPath}`, { postRunSync: false });
      }

      async function runWithArguments() {
        const args = await askText("Run With Arguments", "Arguments", "", { required: false, confirmLabel: "Run" });
        await runCurrentFile(args.trim());
      }

      function stopProgram() {
        showNotice("Stop Program is not available yet in the browser runtime");
      }

      async function runInDisplayMode() {
        setView("displayView");
        await runCurrentFile();
      }

      async function pipInstallPrompt() {
        const pkg = await askText("Install Python Package", "Package", "requests", { confirmLabel: "Install" });
        if (!pkg) return;
        await executeInTerminal(`pip install ${pkg}`);
      }

      function renderEditorToolbar() {
        const container = $id("editorToolbarPrimary");
        container.innerHTML = "";
        editorToolbarButtons.forEach((button) => {
          if (button.when && !button.when(editorContext())) return;
          const el = document.createElement("button");
          el.className = `icon-only${button.primary ? " primary" : ""}`;
          el.title = button.label;
          el.setAttribute("aria-label", button.label);
          el.innerHTML = `<i data-lucide="${button.icon}"></i>`;
          el.addEventListener("click", () => executeEditorCommand(button.command));
          container.appendChild(el);
        });
      }

      function openEditorMenu(id, anchor) {
        const menu = editorMenuItems.get(id);
        if (!menu) return;
        const popover = $id("editorMenuPopover");
        editorMenuOpen = id;
        document.querySelectorAll(".menu-button").forEach((button) => button.classList.toggle("active", button.dataset.menu === id));
        popover.innerHTML = "";
        menu.items.forEach((item) => {
          if (item === "separator") {
            const separator = document.createElement("div");
            separator.className = "menu-separator";
            popover.appendChild(separator);
            return;
          }
          const command = editorCommands.find((entry) => entry.id === item.command);
          if (!command || (command.when && !command.when(editorContext()))) return;
          const button = document.createElement("button");
          button.className = "menu-item";
          button.innerHTML = `
            <i data-lucide="${item.icon || command.icon || "command"}"></i>
            <span>${item.label || command.label}</span>
            <span class="menu-shortcut">${item.shortcut || command.shortcut || ""}</span>
          `;
          button.addEventListener("click", () => executeEditorCommand(command.id));
          popover.appendChild(button);
        });
        const rect = anchor.getBoundingClientRect();
        popover.style.left = `${rect.left}px`;
        popover.style.top = `${rect.bottom + 6}px`;
        popover.classList.remove("hidden");
        window.lucide?.createIcons();
      }

      function renderEditorMenuBar() {
        const container = $id("editorMenuBar");
        container.innerHTML = "";
        Array.from(editorMenuItems.values()).forEach((menu) => {
          const button = document.createElement("button");
          button.className = "menu-button";
          button.dataset.menu = menu.id;
          button.textContent = menu.label;
          button.addEventListener("click", (event) => {
            event.stopPropagation();
            if (editorMenuOpen === menu.id) hideEditorMenu();
            else openEditorMenu(menu.id, button);
          });
          container.appendChild(button);
        });
      }

      function renderEditorChrome() {
        renderEditorMenuBar();
        renderEditorToolbar();
        window.lucide?.createIcons();
      }

      function registerDefaultEditorCommands() {
        const add = registerEditorCommand;
        add({ id: "file.new", label: "New File", menu: "File", icon: "file-plus-2", shortcut: "Ctrl+N", execute: async () => {
          const target = await askText("New File", "Path", `/home/${activeUser()}/untitled.txt`, { confirmLabel: "Create" });
          if (!target) return;
          $id("editorPath").value = normalizePath(target);
          replaceEditorModel("main", createEditorModel(normalizePath(target), ""));
          setView("editorView");
          editor.focus();
          setEditorStatus("New file");
        }});
        add({ id: "file.open", label: "Open File", menu: "File", icon: "folder-open", shortcut: "Ctrl+P", execute: async () => openEditor($id("editorPath").value) });
        add({ id: "file.save", label: "Save", menu: "File", icon: "save", shortcut: "Ctrl+S", execute: saveEditor });
        add({ id: "file.saveAs", label: "Save As", menu: "File", icon: "save-all", execute: () => saveEditorAs() });
        add({ id: "file.rename", label: "Rename", menu: "File", icon: "pencil", execute: renameEditorFile });
        add({ id: "file.download", label: "Download", menu: "File", icon: "download", execute: downloadCurrentEditorFile });
        add({ id: "file.upload", label: "Upload", menu: "File", icon: "upload", execute: uploadIntoEditor });
        add({ id: "file.close", label: "Close Tab", menu: "File", icon: "x", execute: closeEditorTab });
        add({ id: "file.exportWorkspace", label: "Export Workspace", menu: "File", icon: "archive", execute: exportActiveWorkspace });
        add({ id: "edit.undo", label: "Undo", menu: "Edit", icon: "undo-2", shortcut: "Ctrl+Z", execute: () => editor.trigger("keyboard", "undo", null) });
        add({ id: "edit.redo", label: "Redo", menu: "Edit", icon: "redo-2", shortcut: "Ctrl+Y", execute: () => editor.trigger("keyboard", "redo", null) });
        add({ id: "edit.cut", label: "Cut", menu: "Edit", icon: "scissors", execute: () => document.execCommand("cut") });
        add({ id: "edit.copy", label: "Copy", menu: "Edit", icon: "copy", execute: () => document.execCommand("copy") });
        add({ id: "edit.paste", label: "Paste", menu: "Edit", icon: "clipboard-paste", execute: () => document.execCommand("paste") });
        add({ id: "edit.selectAll", label: "Select All", menu: "Edit", icon: "text-select", shortcut: "Ctrl+A", execute: () => editor.trigger("keyboard", "editor.action.selectAll", null) });
        add({ id: "edit.find", label: "Find", menu: "Edit", icon: "search", shortcut: "Ctrl+F", execute: () => editor.getAction("actions.find")?.run() });
        add({ id: "edit.replace", label: "Replace", menu: "Edit", icon: "replace", shortcut: "Ctrl+H", execute: () => editor.getAction("editor.action.startFindReplaceAction")?.run() });
        add({ id: "edit.gotoLine", label: "Go to Line", menu: "Edit", icon: "list-collapse", execute: async () => {
          const value = await askText("Go to Line", "Line number", String(editor.getPosition()?.lineNumber || 1), { confirmLabel: "Go" });
          const line = Number(value);
          if (!line) return;
          editor.setPosition({ lineNumber: line, column: 1 });
          editor.revealLineInCenter(line);
          editor.focus();
        }});
        add({ id: "edit.format", label: "Format Document", menu: "Edit", icon: "align-justify", execute: async () => {
          const action = editor.getAction("editor.action.formatDocument");
          if (action) await action.run();
          else showNotice("No formatter available for this file");
        }});
        add({ id: "edit.comment", label: "Toggle Comment", menu: "Edit", icon: "message-square-code", execute: () => editor.getAction("editor.action.commentLine")?.run() });
        add({ id: "edit.palette", label: "Command Palette", menu: "Edit", icon: "command", shortcut: "Ctrl+Shift+P", execute: () => openCommandPalette("commands") });
        add({ id: "run.current", label: "Run Current File", menu: "Run", icon: "play", shortcut: "Ctrl+Enter", when: (ctx) => ctx.isPython, execute: () => runCurrentFile() });
        add({ id: "run.selection", label: "Run Selection", menu: "Run", icon: "play-circle", when: () => !!currentEditorSelectionText().trim(), execute: runSelection });
        add({ id: "run.args", label: "Run With Arguments", menu: "Run", icon: "list-tree", when: (ctx) => ctx.isPython, execute: runWithArguments });
        add({ id: "run.stop", label: "Stop Program", menu: "Run", icon: "square", execute: stopProgram });
        add({ id: "run.restart", label: "Restart Runtime", menu: "Run", icon: "rotate-ccw", execute: restartRuntime });
        add({ id: "run.display", label: "Run in Display Mode", menu: "Run", icon: "monitor-play", when: (ctx) => ctx.isPython, execute: runInDisplayMode });
        add({ id: "view.terminal", label: "Toggle Terminal", menu: "View", icon: "terminal", execute: () => setView("terminalView") });
        add({ id: "view.display", label: "Toggle Display", menu: "View", icon: "monitor-play", execute: () => setView("displayView") });
        add({ id: "view.browser", label: "EdgeTerm Browser", menu: "View", icon: "globe-2", execute: () => setView("browserView") });
        add({ id: "view.files", label: "Toggle File Manager", menu: "View", icon: "folder-tree", execute: () => setView("filesView") });
        add({ id: "view.split", label: "Split Editor", menu: "View", icon: "columns-2", execute: toggleSplitEditor });
        add({ id: "view.fullscreen", label: "Fullscreen Editor", menu: "View", icon: "maximize-2", execute: toggleEditorFullscreen });
        add({ id: "view.wrap", label: "Word Wrap", menu: "View", icon: "wrap-text", execute: toggleWordWrap });
        add({ id: "view.minimap", label: "Minimap", menu: "View", icon: "panel-right-open", execute: toggleMinimap });
        add({ id: "view.theme", label: "Theme", menu: "View", icon: "palette", execute: cycleEditorTheme });
        add({ id: "tools.pipInstall", label: "Pip Install", menu: "Tools", icon: "package-plus", execute: pipInstallPrompt });
        add({ id: "tools.packageManager", label: "Package Manager", menu: "Tools", icon: "boxes", execute: () => executeInTerminal("pip list") });
        add({ id: "tools.pythonRepl", label: "Open Python REPL", menu: "Tools", icon: "terminal-square", execute: () => executeInTerminal("python") });
        add({ id: "tools.clearTerminal", label: "Clear Terminal", menu: "Tools", icon: "eraser", execute: () => { term.clear(); updatePrompt(); } });
        add({ id: "tools.clearDisplay", label: "Clear Display", menu: "Tools", icon: "monitor-x", execute: () => clearDisplaySurface() });
        add({ id: "tools.settings", label: "Workspace Settings", menu: "Tools", icon: "settings", execute: () => setView("settingsView") });
        add({ id: "tools.snapshot", label: "Snapshot/Share Workspace", menu: "Tools", icon: "share-2", execute: exportActiveWorkspace });
        add({ id: "help.palette", label: "Command Palette", menu: "Help", icon: "command", execute: () => openCommandPalette("commands") });
        add({ id: "help.shortcuts", label: "Keyboard Shortcuts", menu: "Help", icon: "keyboard", execute: () => showNotice("Ctrl+S Save, Ctrl+F Find, Ctrl+H Replace, Ctrl+Enter Run, Ctrl+P Quick Open, Ctrl+Shift+P Palette") });
        add({ id: "help.docs", label: "Display API Docs", menu: "Help", icon: "book-open", execute: () => showNotice("Open EdgeTerm Display API.md from the project root in the file manager or host editor") });

        [
          { id: "file", label: "File", items: [{ command: "file.new" }, { command: "file.open" }, { command: "file.save" }, { command: "file.saveAs" }, { command: "file.rename" }, { command: "file.download" }, { command: "file.upload" }, "separator", { command: "file.close" }, { command: "file.exportWorkspace" }] },
          { id: "edit", label: "Edit", items: [{ command: "edit.undo" }, { command: "edit.redo" }, "separator", { command: "edit.cut" }, { command: "edit.copy" }, { command: "edit.paste" }, { command: "edit.selectAll" }, "separator", { command: "edit.find" }, { command: "edit.replace" }, { command: "edit.gotoLine" }, { command: "edit.format" }, { command: "edit.comment" }, { command: "edit.palette" }] },
          { id: "run", label: "Run", items: [{ command: "run.current" }, { command: "run.selection" }, { command: "run.args" }, "separator", { command: "run.stop" }, { command: "run.restart" }, { command: "run.display" }] },
          { id: "view", label: "View", items: [{ command: "view.terminal" }, { command: "view.display" }, { command: "view.files" }, "separator", { command: "view.split" }, { command: "view.fullscreen" }, { command: "view.wrap" }, { command: "view.minimap" }, { command: "view.theme" }] },
          { id: "tools", label: "Tools", items: [{ command: "tools.pipInstall" }, { command: "tools.packageManager" }, { command: "tools.pythonRepl" }, { command: "tools.clearTerminal" }, { command: "tools.clearDisplay" }, { command: "tools.settings" }, { command: "tools.snapshot" }] },
          { id: "help", label: "Help", items: [{ command: "help.palette" }, { command: "help.shortcuts" }, { command: "help.docs" }] },
        ].forEach(registerEditorMenu);

        [
          { id: "toolbar.new", icon: "file-plus-2", label: "New File", command: "file.new" },
          { id: "toolbar.open", icon: "folder-open", label: "Open File", command: "file.open" },
          { id: "toolbar.save", icon: "save", label: "Save", command: "file.save" },
          { id: "toolbar.run", icon: "play", label: "Run Current File", command: "run.current", primary: true, when: (ctx) => ctx.isPython },
          { id: "toolbar.split", icon: "columns-2", label: "Split Editor", command: "view.split" },
          { id: "toolbar.terminal", icon: "terminal", label: "Show Terminal", command: "view.terminal" },
          { id: "toolbar.display", icon: "monitor-play", label: "Show Display", command: "view.display" },
          { id: "toolbar.files", icon: "folder-tree", label: "Show Files", command: "view.files" },
          { id: "toolbar.palette", icon: "command", label: "Command Palette", command: "edit.palette" },
        ].forEach(registerEditorToolbarButton);
      }

      function renderWorkspaces() {
        const list = $id("workspaceList");
        list.textContent = "";

        for (const workspace of workspaces.filter((item) => !item.transient)) {
          const item = document.createElement("div");
          item.className = `workspace-item${workspace.id === activeWorkspaceId ? " active" : ""}`;
          item.dataset.workspaceId = workspace.id;
          item.innerHTML = `
            <div>
              <div class="workspace-name"></div>
              <div class="workspace-meta"></div>
            </div>
            <div class="flex gap-2">
              <button type="button" class="icon-only rename-workspace" title="Rename workspace" aria-label="Rename workspace"><i data-lucide="pencil"></i></button>
              <button type="button" class="icon-only open-workspace" title="Open workspace" aria-label="Open workspace"><i data-lucide="folder-open"></i></button>
            </div>
          `;
          item.querySelector(".workspace-name").textContent = workspace.name;
          item.querySelector(".workspace-meta").textContent = new Date(workspace.createdAt).toLocaleString();
          item.querySelector(".open-workspace").addEventListener("click", () => switchWorkspace(workspace.id));
          item.querySelector(".rename-workspace").addEventListener("click", async (event) => {
            event.stopPropagation();
            await renameWorkspace(workspace.id);
          });
          list.appendChild(item);
        }

        const active = activeWorkspace();
        if ($id("activeTitle")) $id("activeTitle").textContent = active ? active.name : "";
        renderUsers();
        renderSettings();
        window.lucide?.createIcons();
      }

      function setFullscreen(enabled) {
        $id("terminalView").classList.toggle("terminal-fullscreen", enabled);
        $id("exitFullscreen").classList.toggle("hidden", !enabled);
        $id("toggleFullscreen").innerHTML = enabled
          ? '<i data-lucide="minimize-2"></i>Exit'
          : '<i data-lucide="maximize-2"></i>Fullscreen';
        window.lucide?.createIcons();
        term?.resize();
        term?.focus();
      }

      function renderUsers() {
        const list = $id("userList");
        if (!list) return;
        const workspace = activeWorkspace();
        list.textContent = "";

        for (const user of workspace.users) {
          const row = document.createElement("div");
          row.className = "user-row";
          row.innerHTML = `
            <div>
              <strong></strong>
              <div class="file-muted"></div>
            </div>
            <div class="flex gap-2">
              <button class="icon-button switch-user"><i data-lucide="log-in"></i>Switch</button>
              <button class="icon-only delete-user" title="Delete user"><i data-lucide="trash-2"></i></button>
            </div>
          `;
          row.querySelector("strong").textContent = user;
          row.querySelector(".file-muted").textContent = `/home/${user}`;
          row.querySelector(".switch-user").disabled = user === workspace.userName;
          row.querySelector(".switch-user").addEventListener("click", () => switchWorkspaceUser(user));
          row.querySelector(".delete-user").disabled = workspace.users.length <= 1 || user === workspace.userName;
          row.querySelector(".delete-user").addEventListener("click", () => deleteWorkspaceUser(user));
          list.appendChild(row);
        }

        if ($id("activeUserLabel")) $id("activeUserLabel").textContent = activeUser();
        if ($id("activeHomeLabel")) $id("activeHomeLabel").textContent = `/home/${activeUser()}`;
      }

      function renderSettings() {
        const workspace = activeWorkspace();
        if (!workspace) return;
        if ($id("settingsWorkspaceName")) $id("settingsWorkspaceName").textContent = workspace.name;
        if ($id("settingsRootfs")) $id("settingsRootfs").textContent = workspace.rootfsVersion || DEFAULT_ROOTFS_VERSION;
        if ($id("themeModeLabel")) $id("themeModeLabel").textContent = appTheme;
        if (pyodide?.FS) populateAppModeSettings();
      }

      async function renameWorkspace(workspaceId = activeWorkspaceId) {
        const workspace = workspaces.find((item) => item.id === workspaceId);
        if (!workspace) return;
        const nextName = await askText("Rename Workspace", "Workspace name", workspace.name, { confirmLabel: "Rename" });
        if (!nextName) return;
        const trimmed = String(nextName).trim();
        if (!trimmed) {
          showNotice("Workspace name cannot be empty");
          return;
        }
        if (trimmed === workspace.name) return;
        workspace.name = trimmed;
        workspace.updatedAt = Date.now();
        saveWorkspaceRegistry();
        renderWorkspaces();
        showNotice("Workspace renamed");
      }

      function getSelectedPaths() {
        if (selectedPaths.size > 0) return Array.from(selectedPaths);
        return selectedPath ? [selectedPath] : [];
      }

      function syncRowSelectionUI() {
        document.querySelectorAll(".file-row").forEach((row) => {
          const path = row.dataset.path;
          const checked = selectedPaths.has(path);
          row.classList.toggle("selected", checked || path === selectedPath);
          const checkbox = row.querySelector(".file-check");
          if (checkbox) checkbox.checked = checked;
        });
      }

      function setPrimarySelection(path) {
        selectedPath = path;
        if (path) selectedPaths.add(path);
        syncRowSelectionUI();
      }

      function clearSelection() {
        selectedPath = "";
        selectedPaths.clear();
        syncRowSelectionUI();
      }

      function hideContextMenu() {
        $id("contextMenu").classList.add("hidden");
        contextTargetPath = "";
      }

      function updateContextPreviewVisibility() {
        const button = $id("contextMenu").querySelector('[data-action="preview"]');
        if (!button) return;
        button.classList.toggle("hidden", !isPreviewablePath(contextTargetPath));
      }

      function removeMarqueeBox() {
        document.querySelector(".marquee-box")?.remove();
      }

      function updateMarqueeSelection(clientX, clientY) {
        if (!marqueeState) return;
        const list = $id("fileList");
        const rect = list.getBoundingClientRect();
        const currentX = Math.max(rect.left, Math.min(clientX, rect.right));
        const currentY = Math.max(rect.top, Math.min(clientY, rect.bottom));
        const left = Math.min(marqueeState.startX, currentX);
        const top = Math.min(marqueeState.startY, currentY);
        const width = Math.abs(currentX - marqueeState.startX);
        const height = Math.abs(currentY - marqueeState.startY);

        if (!marqueeState.active && width + height > 6) {
          marqueeState.active = true;
          suppressFileClick = true;
          if (!marqueeState.preserveExisting) selectedPaths.clear();
        }
        if (!marqueeState.active) return;

        const box = marqueeState.box;
        box.style.left = `${left - rect.left + list.scrollLeft}px`;
        box.style.top = `${top - rect.top + list.scrollTop}px`;
        box.style.width = `${width}px`;
        box.style.height = `${height}px`;

        const selection = marqueeState.preserveExisting ? new Set(marqueeState.baseSelection) : new Set();
        for (const row of list.querySelectorAll(".file-row")) {
          const rowRect = row.getBoundingClientRect();
          const intersects =
            rowRect.left < left + width &&
            rowRect.right > left &&
            rowRect.top < top + height &&
            rowRect.bottom > top;
          if (intersects) selection.add(row.dataset.path);
        }
        selectedPaths = selection;
        selectedPath = selectedPaths.size ? Array.from(selectedPaths).at(-1) : "";
        syncRowSelectionUI();
      }

      function stopMarqueeSelection() {
        if (!marqueeState) return;
        document.removeEventListener("mousemove", marqueeState.onMove);
        document.removeEventListener("mouseup", marqueeState.onUp);
        removeMarqueeBox();
        marqueeState = null;
        setTimeout(() => {
          suppressFileClick = false;
        }, 0);
      }

      function startMarqueeSelection(event) {
        if (event.button !== 0) return;
        if (event.target.closest("button, input, .file-name")) return;
        const list = $id("fileList");
        const rect = list.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
        hideContextMenu();

        const box = document.createElement("div");
        box.className = "marquee-box";
        list.appendChild(box);

        marqueeState = {
          startX: event.clientX,
          startY: event.clientY,
          active: false,
          box,
          preserveExisting: event.ctrlKey || event.metaKey,
          baseSelection: new Set(selectedPaths),
        };
        marqueeState.onMove = (moveEvent) => updateMarqueeSelection(moveEvent.clientX, moveEvent.clientY);
        marqueeState.onUp = () => stopMarqueeSelection();
        document.addEventListener("mousemove", marqueeState.onMove);
        document.addEventListener("mouseup", marqueeState.onUp, { once: true });
      }

      function showContextMenu(x, y, path) {
        const menu = $id("contextMenu");
        contextTargetPath = path;
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        updateContextPreviewVisibility();
        menu.classList.remove("hidden");
        window.lucide?.createIcons();
      }

      function setView(id) {
        if (!CLOUD_ENABLED && (id === "cloudView" || id === "adminView")) id = "terminalView";
        document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === id));
        document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === id));
        if (window.innerWidth <= 820) setSidebarOpen(false);
        if (id !== "displayView" && id !== "browserView" && displayState.fullscreen) setDisplayFullscreen(false);
        if (id === "displayView") $id("displayCanvas")?.focus();
        if (id === "filesView") refreshFiles();
        if (id === "editorView") {
          renderEditorChrome();
          editor?.layout();
          splitEditor?.layout();
        }
        if (id === "usersView") renderUsers();
        if (id === "cloudView") {
          renderCloud();
          void refreshCloudState();
        }
        if (id === "adminView") void refreshAdmin();
        if (id === "settingsView") renderSettings();
        window.lucide?.createIcons();
      }

      function normalizePath(path) {
        if (!path.trim()) return "/";
        return path.startsWith("/") ? path : `${currentPath}/${path}`;
      }

      function editorLanguageForPath(path) {
        const lower = path.toLowerCase();
        if (lower.endsWith(".py")) return "python";
        if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
        if (lower.endsWith(".ts")) return "typescript";
        if (lower.endsWith(".json")) return "json";
        if (lower.endsWith(".md")) return "markdown";
        if (lower.endsWith(".html")) return "html";
        if (lower.endsWith(".css")) return "css";
        if (lower.endsWith(".sh")) return "shell";
        return "plaintext";
      }

      function formatBytes(size) {
        if (size < 1024) return `${size} B`;
        if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
        if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MiB`;
        return `${(size / 1024 / 1024 / 1024).toFixed(1)} GiB`;
      }

      function paginateItems(items = [], page = 1, pageSize = 15) {
        const total = Array.isArray(items) ? items.length : 0;
        const safePageSize = Math.min(500, Math.max(15, Number(pageSize) || 15));
        const totalPages = Math.max(1, Math.ceil(total / safePageSize));
        const safePage = Math.min(Math.max(1, Number(page) || 1), totalPages);
        const start = (safePage - 1) * safePageSize;
        const pageItems = items.slice(start, start + safePageSize);
        return {
          total,
          pageSize: safePageSize,
          page: safePage,
          totalPages,
          start,
          end: Math.min(start + pageItems.length, total),
          pageItems,
        };
      }

      function updatePagerUi(prefix, label, pagination) {
        if ($id(`${prefix}RangeLabel`)) $id(`${prefix}RangeLabel`).textContent = pagination.total ? `${pagination.start + 1}-${pagination.end} of ${pagination.total} ${label}` : `0 ${label}`;
        if ($id(`${prefix}PageLabel`)) $id(`${prefix}PageLabel`).textContent = `Page ${pagination.page} of ${pagination.totalPages}`;
        if ($id(`${prefix}PrevPage`)) $id(`${prefix}PrevPage`).disabled = pagination.page <= 1;
        if ($id(`${prefix}NextPage`)) $id(`${prefix}NextPage`).disabled = pagination.page >= pagination.totalPages;
      }

      function cloudHeaders(extra = {}) {
        return {
          ...extra,
          ...(cloudToken ? { Authorization: `Bearer ${cloudToken}` } : {}),
        };
      }

      async function cloudJson(path, options = {}) {
        if (!CLOUD_ENABLED) throw new Error("Cloud Edition is disabled in this build");
        const response = await fetch(path, {
          ...options,
          headers: cloudHeaders({
            "Content-Type": "application/json",
            ...(options.headers || {}),
          }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `Cloud request failed (${response.status})`);
        return payload;
      }

      async function refreshCloudState() {
        if (!CLOUD_ENABLED) {
          cloudOnline = false;
          cloudUser = null;
          cloudSettings = {};
          cloudSnapshots = [];
          cloudShares = [];
          cloudTiers = {};
          cloudBackend = "offline";
          configureAutoSync();
          renderCloud();
          return;
        }
        try {
          const payload = await cloudJson("/api/me", { method: "GET" });
          cloudOnline = true;
          cloudUser = payload.user;
          cloudSettings = payload.settings || {};
          cloudTiers = payload.tiers || {};
          cloudBackend = payload.backend?.driver || "online";
          if (cloudUser) {
            const [snapshotPayload, sharePayload] = await Promise.all([
              cloudJson("/api/snapshot/list", { method: "GET" }),
              cloudJson("/api/share/list", { method: "GET" }),
            ]);
            cloudSnapshots = snapshotPayload.snapshots || [];
            cloudShares = sharePayload.shares || [];
          } else {
            cloudSnapshots = [];
            cloudShares = [];
          }
        } catch (err) {
          cloudOnline = false;
          cloudUser = null;
          cloudSettings = {};
          cloudSnapshots = [];
          cloudShares = [];
          cloudTiers = {};
          cloudBackend = "offline";
          console.warn("[CLOUD] Backend unavailable:", err);
        }
        configureAutoSync();
        renderCloud();
      }

      function renderCloud() {
        applyEditionMode();
        const status = $id("cloudStatus");
        const authForms = $id("authForms");
        const profilePanel = $id("profilePanel");
        const cloudAuthGate = $id("cloudAuthGate");
        const cloudFeatureGrid = $id("cloudFeatureGrid");
        const cloudNoticeBlock = $id("cloudNoticeBlock");
        const cloudNoticeContent = $id("cloudNoticeContent");
        const cloudTosBlock = $id("cloudTosBlock");
        const cloudTosContent = $id("cloudTosContent");
        const cloudAuthTosPreview = $id("cloudAuthTosPreview");
        const cloudAuthTosContent = $id("cloudAuthTosContent");
        const guestShareWritebackPanel = $id("guestShareWritebackPanel");
        const guestShareWritebackStatus = $id("guestShareWritebackStatus");
        const guestShareWritebackMessage = $id("guestShareWritebackMessage");
        const adminTab = $id("adminTab");
        if (!status) return;
        const shareOrigin = activeShareOrigin();
        const guestShareWriteable =
          !!(!cloudUser && shareOrigin?.share?.visibility === "public" && shareOrigin?.share?.mode === "read-write" && !shareOrigin?.share?.tempMode);
        adminTab?.classList.toggle("hidden", !CLOUD_ENABLED || cloudUser?.role !== "admin");
        status.textContent = !cloudOnline
          ? "Cloud backend unavailable. EdgeTerm is running local-only."
          : cloudUser
            ? "Logged in. Cloud sync is enabled for this browser."
            : guestShareWriteable
              ? "Guest mode. This public read-write share can be saved back without login."
              : "Guest mode. Local workspaces stay offline until login.";
        authForms?.classList.toggle("hidden", !!cloudUser);
        cloudAuthGate?.classList.toggle("hidden", !!cloudUser);
        cloudFeatureGrid?.classList.toggle("hidden", !cloudUser);
        profilePanel?.classList.toggle("hidden", !cloudUser);
        guestShareWritebackPanel?.classList.toggle("hidden", !guestShareWriteable);
        if (guestShareWritebackStatus) guestShareWritebackStatus.textContent = guestShareWriteable ? "Guest write-back enabled" : "Unavailable";
        if (guestShareWritebackMessage) {
          guestShareWritebackMessage.textContent = guestShareWriteable
            ? "Anyone with this public read-write share can save the current workspace back to the shared rootfs without logging in."
            : "Open a public read-write shared workspace to save changes back without logging in.";
        }
        const guestStrategy = $id("guestShareWritebackStrategy");
        const guestButton = $id("guestShareWriteback");
        if (guestStrategy) guestStrategy.disabled = !guestShareWriteable;
        if (guestButton) guestButton.disabled = !guestShareWriteable;
        const noticeHtml = String(cloudSettings?.cloudNoticeHtml || "").trim();
        cloudNoticeBlock?.classList.toggle("hidden", !noticeHtml);
        if (cloudNoticeContent) cloudNoticeContent.innerHTML = noticeHtml;
        const tosHtml = String(cloudSettings?.tosHtml || "").trim() || DEFAULT_TOS_HTML;
        const showInlineAuthTos = !cloudUser;
        cloudTosBlock?.classList.toggle("hidden", !tosHtml || showInlineAuthTos);
        cloudAuthTosPreview?.classList.toggle("hidden", !tosHtml || !showInlineAuthTos);
        if (cloudTosContent) cloudTosContent.innerHTML = tosHtml;
        if (cloudAuthTosContent) cloudAuthTosContent.innerHTML = tosHtml;
        if (cloudUser) {
          if ($id("profileEmail")) $id("profileEmail").textContent = cloudUser.email;
          if ($id("profileTier")) $id("profileTier").textContent = cloudUser.tier;
          if ($id("profileStorage")) $id("profileStorage").textContent = `${formatBytes(cloudUser.storageUsed || 0)} / ${formatBytes(cloudUser.permissions.storageQuota || 0)}`;
          if ($id("profileMaxSnapshots")) $id("profileMaxSnapshots").textContent = String(cloudUser.permissions.maxSnapshots || 0);
          if ($id("profileAutoSync")) $id("profileAutoSync").textContent = cloudUser.permissions.autoSyncEnabled ? "Yes" : "No";
          const savedRetention = localStorage.getItem(BACKUP_RETENTION_KEY);
          const effectiveRetention = savedRetention == null ? String(cloudUser.permissions.keepLastBackups || "") : savedRetention;
          if ($id("profileKeepBackups")) $id("profileKeepBackups").textContent = effectiveRetention === "0" ? "Unlimited" : String(effectiveRetention || cloudUser.permissions.keepLastBackups || cloudUser.permissions.maxSnapshots || 0);
          const retentionEnabled = effectiveRetention !== "0";
          if ($id("backupRetentionEnabled")) $id("backupRetentionEnabled").checked = retentionEnabled;
        if ($id("backupRetentionCount")) {
          $id("backupRetentionCount").disabled = !retentionEnabled;
          $id("backupRetentionCount").value = retentionEnabled ? effectiveRetention : "";
        }
        if ($id("snapshotPageSize")) $id("snapshotPageSize").value = String(snapshotPageSize);
      }
      if (!cloudUser && $id("profileMaxSnapshots")) $id("profileMaxSnapshots").textContent = "0";
      syncShareWritebackState();
      syncShareFormState();
      renderSnapshots();
      renderShares();
      window.lucide?.createIcons();
    }

      function syncShareFormState() {
        const readWrite = $id("shareReadWrite");
        const cloudWriteBack = $id("shareCloudWriteBack");
        const modeHint = $id("shareModeHint");
        const writeBackHint = $id("shareCloudWriteBackHint");
        if (!readWrite || !cloudWriteBack) return;
        const writable = !!readWrite.checked;
        if (!writable) cloudWriteBack.checked = false;
        cloudWriteBack.disabled = !writable;
        if (modeHint) {
          modeHint.textContent = writable
            ? "Read-write shares can edit the shared workspace and may save changes back if write-back is enabled."
            : "Read-only shares can be opened and run, but they cannot save changes back.";
        }
        if (writeBackHint) {
          writeBackHint.innerHTML = writable
            ? "When enabled, writable shares may push edits back to the shared cloud snapshot."
            : "Requires <code>Read-write</code>. Turn on writable mode first.";
        }
      }

      function renderSnapshots() {
        const list = $id("snapshotList");
        const select = $id("shareSnapshot");
        if (!list || !select) return;
        list.textContent = "";
        select.textContent = "";
        if (!cloudUser) {
          selectedSnapshotIds = new Set();
          list.innerHTML = `<div class="file-muted">Login to list cloud backups.</div>`;
          syncSnapshotSelectionUi([]);
          return;
        }
        const validIds = new Set(cloudSnapshots.map((snapshot) => snapshot.id));
        selectedSnapshotIds = new Set([...selectedSnapshotIds].filter((snapshotId) => validIds.has(snapshotId)));
        const total = cloudSnapshots.length;
        const totalPages = Math.max(1, Math.ceil(total / snapshotPageSize));
        snapshotPage = Math.min(snapshotPage, totalPages);
        const start = (snapshotPage - 1) * snapshotPageSize;
        const pageItems = cloudSnapshots.slice(start, start + snapshotPageSize);
        for (const snapshot of cloudSnapshots) {
          const option = document.createElement("option");
          option.value = snapshot.id;
          option.textContent = `${snapshot.name} - ${new Date(snapshot.createdAt).toLocaleString()}`;
          select.appendChild(option);
        }
        for (const snapshot of pageItems) {
          const item = document.createElement("div");
          item.className = "backup-card";
          item.innerHTML = `
            <input class="backup-card-select" type="checkbox" />
            <div>
              <div class="workspace-name"></div>
              <div class="backup-card-meta"></div>
            </div>
            <div class="flex gap-2">
              <button class="icon-only download" title="Download backup"><i data-lucide="download"></i></button>
              <button class="icon-only restore" title="Restore"><i data-lucide="download-cloud"></i></button>
              <button class="icon-only delete" title="Delete"><i data-lucide="trash-2"></i></button>
            </div>
          `;
          const selectBox = item.querySelector(".backup-card-select");
          selectBox.checked = selectedSnapshotIds.has(snapshot.id);
          selectBox.addEventListener("change", () => {
            if (selectBox.checked) selectedSnapshotIds.add(snapshot.id);
            else selectedSnapshotIds.delete(snapshot.id);
            syncSnapshotSelectionUi(pageItems);
          });
          item.querySelector(".workspace-name").textContent = snapshot.name;
          item.querySelector(".backup-card-meta").textContent = `${formatBytes(snapshot.size)} - v${snapshot.version || 1} - ${new Date(snapshot.createdAt).toLocaleString()}`;
          item.querySelector(".download").addEventListener("click", () => downloadCloudSnapshot(snapshot.id));
          item.querySelector(".restore").addEventListener("click", () => restoreSnapshot(snapshot.id));
          item.querySelector(".delete").addEventListener("click", () => deleteSnapshot(snapshot.id));
          list.appendChild(item);
        }
        if (!cloudSnapshots.length) list.innerHTML = `<div class="file-muted">No cloud backups yet.</div>`;
        const startLabel = total ? start + 1 : 0;
        const endLabel = Math.min(start + pageItems.length, total);
        if ($id("snapshotRangeLabel")) $id("snapshotRangeLabel").textContent = total ? `${startLabel}-${endLabel} of ${total} backups` : "0 backups";
        if ($id("snapshotPageLabel")) $id("snapshotPageLabel").textContent = `Page ${snapshotPage} of ${totalPages}`;
        if ($id("snapshotPrevPage")) $id("snapshotPrevPage").disabled = snapshotPage <= 1;
        if ($id("snapshotNextPage")) $id("snapshotNextPage").disabled = snapshotPage >= totalPages;
        syncSnapshotSelectionUi(pageItems);
      }

      function syncSnapshotSelectionUi(pageItems = []) {
        const selectPage = $id("snapshotSelectPage");
        const deleteSelected = $id("deleteSelectedSnapshots");
        const visibleIds = pageItems.map((snapshot) => snapshot.id);
        const selectedVisible = visibleIds.filter((snapshotId) => selectedSnapshotIds.has(snapshotId));
        if (selectPage) {
          selectPage.disabled = !visibleIds.length;
          selectPage.checked = !!visibleIds.length && selectedVisible.length === visibleIds.length;
          selectPage.indeterminate = selectedVisible.length > 0 && selectedVisible.length < visibleIds.length;
        }
        if (deleteSelected) {
          deleteSelected.disabled = selectedSnapshotIds.size === 0;
          deleteSelected.title = selectedSnapshotIds.size ? `Delete ${selectedSnapshotIds.size} selected backup${selectedSnapshotIds.size === 1 ? "" : "s"}` : "Select backups to delete";
        }
      }

      function renderShares() {
        const list = $id("shareList");
        if (!list) return;
        list.textContent = "";
        if (!cloudUser) {
          list.innerHTML = `<div class="file-muted">Login to create share links.</div>`;
          return;
        }
        for (const share of cloudShares) {
          const item = document.createElement("div");
          item.className = "workspace-item";
          const url = publicShareUrl(share);
          item.innerHTML = `
            <div>
              <div class="workspace-name"></div>
              <div class="workspace-meta"></div>
            </div>
            <div class="flex gap-2">
              <button class="icon-only edit" title="Edit share"><i data-lucide="pencil"></i></button>
              <button class="icon-only copy" title="Copy link"><i data-lucide="copy"></i></button>
              <button class="icon-only delete" title="Delete share"><i data-lucide="trash-2"></i></button>
            </div>
          `;
          item.querySelector(".workspace-name").textContent = `${share.visibility} ${share.mode}${share.tempMode ? " temp" : ""}${share.revoked ? " (revoked)" : ""}`;
          item.querySelector(".workspace-meta").textContent = `${url}${share.expiresAt ? ` - expires ${new Date(share.expiresAt).toLocaleString()}` : " - no expiry"}`;
          item.querySelector(".edit").addEventListener("click", () => editShare(share));
          item.querySelector(".copy").addEventListener("click", async () => {
            await navigator.clipboard?.writeText(url);
            showNotice("Copied share link");
          });
          item.querySelector(".delete").addEventListener("click", () => deleteShare(share.id));
          list.appendChild(item);
        }
        if (!cloudShares.length) list.innerHTML = `<div class="file-muted">No share links yet.</div>`;
      }

      async function loginOrRegister(mode) {
        const email = $id("cloudEmail").value.trim();
        const password = $id("cloudPassword").value;
        const acceptedTos = !!$id("cloudAcceptTos")?.checked;
        if (mode === "register" && !acceptedTos) {
          showNotice("Please agree to the Terms of Service before registering");
          return;
        }
        await loginWithCredentials(mode, email, password, acceptedTos);
      }

      async function loginWithCredentials(mode, email, password, acceptedTos = false) {
        try {
          const payload = await cloudJson(`/api/${mode}`, {
            method: "POST",
            body: JSON.stringify({ email, password, acceptedTos }),
          });
          cloudToken = payload.token;
          localStorage.setItem(CLOUD_TOKEN_KEY, cloudToken);
          cloudUser = payload.user;
          showNotice(mode === "login" ? "Logged in" : "Registered and logged in");
          await refreshCloudState();
        } catch (err) {
          showNotice(err.message);
        }
      }

      async function logoutCloud() {
        try {
          await cloudJson("/api/logout", { method: "POST", body: "{}" });
        } catch {}
        cloudToken = "";
        localStorage.removeItem(CLOUD_TOKEN_KEY);
        cloudUser = null;
        await refreshCloudState();
      }

      async function buildWorkspaceBlob() {
        await persistActiveWorkspace();
        const workspace = activeWorkspace();
        const zip = new JSZip();
        addPathToZip(zip, workspacePath(activeWorkspaceId), workspace.name.replace(/[^\w.-]+/g, "-"));
        return zip.generateAsync({ type: "blob" });
      }

      async function importZipIntoWorkspace(id, file) {
        const zip = await JSZip.loadAsync(await file.arrayBuffer());
        const workspace = workspaces.find((item) => item.id === id);
        const archivePrefix = detectWorkspaceArchive(zip);
        if (archivePrefix !== null) {
          clearDirectory(workspacePath(id));
          ensureDir(workspacePath(id));
          await extractWorkspaceArchive(zip, workspacePath(id), archivePrefix);
          if (workspace) {
            workspace.rootfsVersion = "custom";
            workspace.users = listWorkspaceUsers(id);
            workspace.userName = workspace.users.includes("user") ? "user" : workspace.users[0];
          }
        } else {
          clearDirectory(workspacePath(id, "/rootfs"));
          await extractZipTo(zip, workspacePath(id, "/rootfs"));
          if (workspace) workspace.rootfsVersion = "custom";
        }
      }

      async function syncActiveWorkspaceToCloud({ silent = false } = {}) {
        if (!cloudUser) {
          if (!silent) showNotice("Login to use cloud sync");
          return;
        }
        await withBusy("Syncing workspace to cloud...", async () => {
          const workspace = activeWorkspace();
          const blob = await buildWorkspaceBlob();
          const config = readAppModeConfig();
          const keepLastBackups = localStorage.getItem(BACKUP_RETENTION_KEY);
          const hasRetention = keepLastBackups != null;
          const response = await xhrRequestWithProgress(`/api/snapshot/upload?name=${encodeURIComponent(workspace.name)}&workspaceId=${encodeURIComponent(workspace.id)}${hasRetention ? `&keepLastBackups=${encodeURIComponent(keepLastBackups)}` : ""}`, {
            method: "POST",
            headers: cloudHeaders({
              "Content-Type": "application/zip",
              "X-EdgeTerm-Name": workspace.name,
              "X-EdgeTerm-Workspace": workspace.id,
              "X-EdgeTerm-App-Mode": String(!!config.enabled),
              ...(hasRetention ? { "X-EdgeTerm-Keep-Last-Backups": keepLastBackups } : {}),
            }),
            body: blob,
            phase: "Uploading rootfs backup...",
          });
          const payload = JSON.parse(response.responseText || "{}");
          if (!response.ok) throw new Error(payload.error || "Cloud sync failed");
          cloudUser.storageUsed = payload.storageUsed;
          showNotice(payload.prunedSnapshots?.length ? `Workspace synced. Removed ${payload.prunedSnapshots.length} old backups.` : "Workspace synced to cloud");
          await refreshCloudState();
        }).catch((err) => showNotice(err.message));
      }

      async function restoreSnapshot(snapshotId) {
        if (!(await askConfirm("Restore Cloud Backup", "Restore this backup into a new local workspace?", { confirmLabel: "Restore" }))) return;
        await withBusy("Restoring cloud backup...", async () => {
          const response = await fetch(`/api/snapshot/download/${encodeURIComponent(snapshotId)}`, {
            headers: cloudHeaders(),
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.error || "Restore failed");
          }
          const snapshot = cloudSnapshots.find((item) => item.id === snapshotId);
          const file = new File([await readResponseBlobWithProgress(response, "Downloading rootfs backup...")], `${snapshot?.name || "cloud-restore"}.workspace.zip`, { type: "application/zip" });
          await createWorkspaceFromZip(`${snapshot?.name || "Cloud Restore"} (Cloud)`, file);
        }).catch((err) => showNotice(err.message));
      }

      async function downloadCloudSnapshot(snapshotId) {
        await withBusy("Downloading cloud backup...", async () => {
          const response = await fetch(`/api/snapshot/download/${encodeURIComponent(snapshotId)}`, {
            headers: cloudHeaders(),
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.error || "Download failed");
          }
          const snapshot = cloudSnapshots.find((item) => item.id === snapshotId);
          const blob = await readResponseBlobWithProgress(response, "Downloading rootfs backup...");
          downloadBlobAs(blob, `${snapshot?.name || "cloud-backup"}.workspace.zip`);
          showNotice("Cloud backup downloaded");
        }).catch((err) => showNotice(err.message));
      }

      async function deleteSnapshot(snapshotId) {
        if (!(await askConfirm("Delete Cloud Backup", "Delete this cloud backup permanently?", { confirmLabel: "Delete", danger: true }))) return;
        try {
          await fetch(`/api/snapshot/${encodeURIComponent(snapshotId)}`, { method: "DELETE", headers: cloudHeaders() }).then(async (response) => {
            if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Delete failed");
          });
          selectedSnapshotIds.delete(snapshotId);
          showNotice("Cloud backup deleted");
          await refreshCloudState();
        } catch (err) {
          showNotice(err.message);
        }
      }

      async function deleteSelectedSnapshots() {
        if (!selectedSnapshotIds.size) return showNotice("Select backups to delete");
        const ids = [...selectedSnapshotIds];
        if (!(await askConfirm("Delete Selected Backups", `Delete ${ids.length} cloud backup${ids.length === 1 ? "" : "s"} permanently?`, { confirmLabel: "Delete", danger: true }))) return;
        try {
          const payload = await cloudJson("/api/snapshot/batch-delete", {
            method: "POST",
            body: JSON.stringify({ snapshotIds: ids }),
          });
          selectedSnapshotIds = new Set();
          showNotice(`Deleted ${payload.count || 0} backup${payload.count === 1 ? "" : "s"}`);
          await refreshCloudState();
        } catch (err) {
          showNotice(err.message);
        }
      }

      async function deleteAllSnapshots() {
        if (!cloudSnapshots.length) return showNotice("No cloud backups to delete");
        if (!(await askConfirm("Delete All Backups", `Delete all ${cloudSnapshots.length} cloud backups permanently?`, { confirmLabel: "Delete All", danger: true }))) return;
        try {
          const payload = await fetch("/api/snapshot", { method: "DELETE", headers: cloudHeaders() }).then(async (response) => {
            const body = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(body.error || "Delete all failed");
            return body;
          });
          selectedSnapshotIds = new Set();
          showNotice(`Deleted ${payload.count || 0} backup${payload.count === 1 ? "" : "s"}`);
          await refreshCloudState();
        } catch (err) {
          showNotice(err.message);
        }
      }

      async function createShareLink() {
        if (!cloudUser) return showNotice("Login to share");
        const snapshotId = $id("shareSnapshot").value;
        if (!snapshotId) return showNotice("Create a cloud backup first");
        try {
          const expirationDays = Number($id("shareExpirationDays").value || 0);
          const payload = await cloudJson("/api/share/create", {
            method: "POST",
            body: JSON.stringify({
              snapshotId,
              visibility: $id("shareVisibility").value,
              readWrite: $id("shareReadWrite").checked,
              tempMode: $id("shareTempMode").checked,
              allowFork: $id("shareAllowFork").checked,
              allowCloudWriteBack: $id("shareReadWrite").checked && $id("shareCloudWriteBack").checked,
              appMode: $id("shareAppMode").checked,
              customSlug: $id("shareCustomSlug").value.trim(),
              allowedUsers: $id("shareAllowedUsers").value.split(",").map((item) => item.trim()).filter(Boolean),
              expiresInSeconds: expirationDays > 0 ? expirationDays * 24 * 60 * 60 : undefined,
            }),
          });
          await navigator.clipboard?.writeText(publicShareUrl(payload.share));
          showNotice("Created share link");
          await refreshCloudState();
        } catch (err) {
          showNotice(err.message);
        }
      }

      async function deleteShare(shareId) {
        if (!(await askConfirm("Delete Share", "Delete this share link permanently?", { confirmLabel: "Delete", danger: true }))) return;
        try {
          await fetch(`/api/share/${encodeURIComponent(shareId)}`, { method: "DELETE", headers: cloudHeaders() }).then(async (response) => {
            if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Delete failed");
          });
          showNotice("Share deleted");
          await refreshCloudState();
        } catch (err) {
          showNotice(err.message);
        }
      }

      function configureAutoSync() {
        const legacyValue = localStorage.getItem(AUTO_SYNC_KEY) || "off";
        const savedMode = localStorage.getItem(AUTO_SYNC_MODE_KEY) || (/^\d+$/.test(legacyValue) ? "interval" : legacyValue);
        const savedMinutes = localStorage.getItem(AUTO_SYNC_MINUTES_KEY) || (/^\d+$/.test(legacyValue) ? legacyValue : "5");
        const mode = savedMode || "off";
        const input = $id("autoSyncMinutes");
        const requested = Math.max(1, Number(savedMinutes || 5));
        if (autoSyncTimer) clearInterval(autoSyncTimer);
        autoSyncTimer = null;
        const select = $id("autoSyncMode");
        const allowed = !!cloudUser?.permissions?.autoSyncEnabled;
        const minimumMinutes = Math.max(1, Number(cloudUser?.permissions?.minimumAutoSyncMinutes || 1));
        if (select) select.value = mode;
        if (select) select.disabled = !!cloudUser && !allowed;
        if (input) {
          input.value = String(requested);
          input.min = String(minimumMinutes);
          if (requested < minimumMinutes) input.value = String(minimumMinutes);
        }
        syncAutoSyncFormState();
        if (!cloudUser || !allowed) return;
        if (mode === "interval") {
          const minutes = Math.max(minimumMinutes, requested);
          if (input) input.value = String(minutes);
          localStorage.setItem(AUTO_SYNC_MINUTES_KEY, String(minutes));
          autoSyncTimer = setInterval(() => syncActiveWorkspaceToCloud({ silent: true }), minutes * 60 * 1000);
        }
      }

      function syncAutoSyncFormState() {
        const select = $id("autoSyncMode");
        const input = $id("autoSyncMinutes");
        if (!select || !input) return;
        const mode = select.value || "off";
        const allowed = !!cloudUser?.permissions?.autoSyncEnabled;
        input.disabled = !cloudUser || !allowed || mode !== "interval";
      }

      function saveCloudBackupPreferences() {
        const mode = $id("autoSyncMode")?.value || "off";
        const minimumMinutes = Math.max(1, Number(cloudUser?.permissions?.minimumAutoSyncMinutes || 1));
        const requestedMinutes = Math.max(minimumMinutes, Number($id("autoSyncMinutes")?.value || minimumMinutes));
        const retentionEnabled = !!$id("backupRetentionEnabled")?.checked;
        const retentionCount = Math.max(1, Number($id("backupRetentionCount")?.value || 1));
        localStorage.setItem(AUTO_SYNC_MODE_KEY, mode);
        localStorage.setItem(AUTO_SYNC_KEY, mode);
        localStorage.setItem(AUTO_SYNC_MINUTES_KEY, String(requestedMinutes));
        localStorage.setItem(BACKUP_RETENTION_KEY, retentionEnabled ? String(retentionCount) : "0");
        configureAutoSync();
        renderCloud();
        showNotice("Cloud backup settings saved");
      }

      function activeShareOrigin() {
        return workspaceShareOrigins.get(activeWorkspaceId) || activeWorkspace()?.shareOrigin || null;
      }

      async function fetchShareMetaFromLocator(locator) {
        if (!locator) return null;
        return locator.kind === "path"
          ? await cloudJson(`/api/share/resolve?path=${encodeURIComponent(locator.value)}`, { method: "GET" })
          : await cloudJson(`/api/share/${encodeURIComponent(locator.value)}`, { method: "GET" });
      }

      function showSharedAppLoadError(message, detail = "") {
        const config = appModeState.config || normalizeAppModeConfig(readAppModeConfig());
        appModeState.config = config;
        appModeState.active = true;
        appModeState.booting = false;
        setAppModeVisible(true, config);
        showAppModeError(message, detail);
      }

      async function rehydrateActiveShareOrigin() {
        if (!CLOUD_ENABLED) return null;
        const workspace = activeWorkspace();
        if (!workspace) return null;
        const existing = activeShareOrigin();
        if (existing?.share?.id) return existing;

        let locator = null;
        if (workspace.shareRef) {
          const ref = String(workspace.shareRef);
          locator = ref.startsWith("share:")
            ? { kind: "id", value: ref.slice("share:".length) }
            : { kind: "path", value: ref };
        } else if (/\(Shared\)/.test(String(workspace.name || ""))) {
          locator = currentShareLocator();
        }
        if (!locator) return null;
        try {
          const meta = await fetchShareMetaFromLocator(locator);
          if (!meta?.share?.id) return null;
          workspace.shareRef = shareWorkspaceKey(meta);
          workspace.shareOrigin = meta;
          workspace.transient = !!meta.share.tempMode;
          workspaceShareOrigins.set(workspace.id, meta);
          saveWorkspaceRegistry();
          return meta;
        } catch (err) {
          console.warn("[SHARE] Could not rehydrate shared workspace metadata:", err);
          return null;
        }
      }

      function shareWorkspaceKey(meta) {
        return meta?.share?.publicPath || `share:${meta?.share?.id || ""}`;
      }

      function findWorkspaceForShare(meta) {
        const key = shareWorkspaceKey(meta);
        return workspaces.find((workspace) => workspace.shareRef === key) || null;
      }

      function workspaceHasRestoredRootfs(workspaceId) {
        if (!pyodide?.FS || !workspaceId) return false;
        try {
          return !!pyodide.FS.analyzePath(workspacePath(workspaceId, "/rootfs/usr/lib/edgeterm.py")).exists;
        } catch {
          return false;
        }
      }

      function canReuseSharedWorkspace(existingWorkspace, meta) {
        if (!existingWorkspace?.id || !meta?.snapshot?.id) return false;
        if (!workspaceHasRestoredRootfs(existingWorkspace.id)) return false;
        const existingMeta = workspaceShareOrigins.get(existingWorkspace.id) || existingWorkspace.shareOrigin || {};
        const existingSnapshot = existingMeta?.snapshot || {};
        return (
          String(existingSnapshot.id || "") === String(meta.snapshot.id || "") &&
          Number(existingSnapshot.version || 0) === Number(meta.snapshot.version || 0)
        );
      }

      async function syncShareWritebackState() {
        const button = $id("shareWriteback");
        const guestButton = $id("guestShareWriteback");
        const topbarButton = $id("topbarShareWriteback");
        const shareOrigin = activeShareOrigin() || await rehydrateActiveShareOrigin();
        const publicGuestWriteable =
          !!(shareOrigin?.share?.visibility === "public" && shareOrigin?.share?.mode === "read-write" && !shareOrigin?.share?.tempMode);
        const enabled = !!(
          shareOrigin?.share?.mode === "read-write" &&
          (
            (cloudUser && shareOrigin?.share?.allowCloudWriteBack) ||
            publicGuestWriteable
          )
        );
        if (button) button.disabled = !enabled;
        if (guestButton) guestButton.disabled = !publicGuestWriteable;
        if (topbarButton) {
          topbarButton.disabled = !enabled;
          topbarButton.classList.toggle("hidden", !enabled);
        }
        if (button) {
          button.title = enabled
            ? "Save this shared workspace back to cloud"
            : "Open a public read-write shared workspace or one with cloud write-back enabled";
        }
        if (guestButton) guestButton.title = publicGuestWriteable ? "Save this public shared workspace back without login" : "Open a public read-write shared workspace first";
        if (topbarButton) topbarButton.title = publicGuestWriteable ? "Save this public shared workspace back without login" : "Save this shared workspace back to cloud";
      }

      async function writeBackSharedWorkspace() {
        const shareOrigin = activeShareOrigin();
        if (!shareOrigin?.share?.id) return showNotice("This workspace is not linked to a writable share");
        const publicGuestWriteable =
          !!(shareOrigin?.share?.visibility === "public" && shareOrigin?.share?.mode === "read-write" && !shareOrigin?.share?.tempMode);
        const strategy = publicGuestWriteable ? "overwrite" : ($id("shareWritebackStrategy").value || "overwrite");
        await withBusy("Saving shared workspace back to cloud...", async () => {
          const workspace = activeWorkspace();
          const blob = await buildWorkspaceBlob();
          const response = await xhrRequestWithProgress(`/api/share/writeback/${encodeURIComponent(shareOrigin.share.id)}?strategy=${encodeURIComponent(strategy)}`, {
            method: "POST",
            headers: cloudHeaders({
              "Content-Type": "application/zip",
              "X-EdgeTerm-Base-Version": String(shareOrigin.snapshot?.version || 1),
              "X-EdgeTerm-Conflict-Strategy": strategy,
            }),
            body: blob,
            phase: "Uploading shared rootfs...",
          });
          const payload = JSON.parse(response.responseText || "{}");
          if (!response.ok) throw new Error(payload.error || "Write-back failed");
          if (payload.snapshot) {
            shareOrigin.snapshot = payload.snapshot;
            workspaceShareOrigins.set(workspace.id, shareOrigin);
            workspace.shareOrigin = shareOrigin;
            saveWorkspaceRegistry();
          }
          showNotice(
            payload.mode === "fork"
              ? "Shared workspace forked to your cloud backups"
              : payload.publicGuestWriteback
                ? "Shared workspace saved back to the public share"
                : "Shared workspace saved back to cloud"
          );
          if (cloudUser) await refreshCloudState();
          else syncShareWritebackState();
        }).catch((err) => showNotice(err.message));
      }

      async function writeBackSharedWorkspaceAsGuest() {
        const shareOrigin = activeShareOrigin();
        const guestAllowed =
          !!(!cloudUser && shareOrigin?.share?.visibility === "public" && shareOrigin?.share?.mode === "read-write" && !shareOrigin?.share?.tempMode);
        if (!guestAllowed) return showNotice("Open a public read-write shared workspace first");
        await writeBackSharedWorkspace();
      }

      async function openShareFromUrl(locatorOverride = null) {
        const locator = locatorOverride || currentShareLocator();
        if (!locator) return;
        if (locator.kind === "local-app") {
          try {
            await withBusy("Opening local app workspace...", async () => {
              const targetWorkspace =
                locator.mode === "named"
                  ? workspaces.find((workspace) => workspaceSlug(workspace) === String(locator.workspaceSlug || "").toLowerCase())
                  : activeWorkspace();
              if (!targetWorkspace) throw new Error(locator.mode === "named" ? `Workspace not found: ${locator.workspaceSlug}` : "No active workspace found");
              const routeContext = configureLocalAppRouting(targetWorkspace, locator);
              await switchWorkspace(targetWorkspace.id, { skipBootShell: true, skipRefreshFiles: true, skipAutoStartAppMode: true });
              const config = readAppModeConfig();
              if (!config.enabled) throw new Error(`App Mode is not enabled for "${targetWorkspace.name}"`);
              if (routeContext) routeContext.fallbackUrl = "/";
              await enterAppMode(config, {
                forceReload: true,
                initialUrl: appRouteRequestUrl(locator.routePath || "/", locator.queryString || ""),
              });
              showNotice(`Opened ${targetWorkspace.name} in App Mode`);
            });
          } catch (err) {
            document.body.classList.remove("app-mode-active");
            showSharedAppLoadError("Local App Mode failed to load.", err.message || String(err));
          }
          return;
        }
        if (!CLOUD_ENABLED) return;
        try {
          await withBusy("Opening shared workspace...", async () => {
            const meta = await fetchShareMetaFromLocator(locator);
            const existingWorkspace = findWorkspaceForShare(meta);
            const directSharedAppRoute = locator.kind === "app-share" && !!meta.share.appMode;
            const reuseExisting = canReuseSharedWorkspace(existingWorkspace, meta);
            const switchOptions = directSharedAppRoute ? { skipBootShell: true, skipRefreshFiles: true, skipAutoStartAppMode: true } : {};
            let workspaceId = existingWorkspace?.id || "";
            if (reuseExisting) {
              await switchWorkspace(existingWorkspace.id, switchOptions);
            } else {
              const response = await fetch(`/api/share/${encodeURIComponent(meta.share.id)}?download=1`, { headers: cloudHeaders() });
              if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Could not download share");
              const file = new File([await readResponseBlobWithProgress(response, "Downloading shared rootfs...")], `${meta.snapshot.name}.workspace.zip`, { type: "application/zip" });
              workspaceId = await createWorkspaceFromZip(`${meta.snapshot.name} (Shared)`, file, {
                workspaceId: existingWorkspace?.id,
                persistRegistry: !meta.share.tempMode,
                shareRef: shareWorkspaceKey(meta),
                transient: !!meta.share.tempMode,
                switchOptions,
              });
            }
            const workspace = workspaces.find((item) => item.id === workspaceId);
            if (workspace) {
              workspace.name = `${meta.snapshot.name} (Shared)`;
              workspace.shareRef = shareWorkspaceKey(meta);
              workspace.transient = !!meta.share.tempMode;
              workspace.shareOrigin = meta;
            }
            workspaceShareOrigins.set(workspaceId, meta);
            saveWorkspaceRegistry();
            if (meta.share.appMode) {
              const config = readAppModeConfig();
              config.enabled = true;
              if (locator.kind === "app-share") {
                config.fullscreen = true;
                config.autoStart = true;
                config.showLoadingOverlay = true;
                config.ui = { ...(config.ui || {}), hideWorkspaceChrome: true };
              }
              await saveAppModeConfig(config);
              const shareRouteContext = locator.kind === "app-share" ? configureSharedAppRouting(meta, locator) : null;
              if (shareRouteContext && directSharedAppRoute) shareRouteContext.deferredWorkspaceBoot = true;
              await enterAppMode(config, {
                forceReload: true,
                initialUrl: locator.kind === "app-share" ? appRouteRequestUrl(locator.routePath || "/", locator.queryString || "") : "",
              });
            } else {
              clearSharedAppRouting();
              if (locator.kind === "app-share") document.body.classList.remove("app-mode-active");
              if (locator.kind === "app-share") {
                history.replaceState({ edgetermShare: true, shareId: meta.share.id }, "", shareWorkspaceFallbackUrl(meta));
              }
            }
            syncShareWritebackState();
            showNotice(
              meta.share.tempMode
                ? (reuseExisting ? "Temporary shared workspace reopened from local cache" : "Temporary shared workspace opened")
                : reuseExisting
                  ? "Shared workspace reopened from local cache"
                  : (existingWorkspace ? "Shared workspace refreshed" : "Shared workspace restored locally")
            );
          });
        } catch (err) {
          if (locator.kind === "app-share") document.body.classList.remove("app-mode-active");
          if (locator.kind === "app-share") showSharedAppLoadError("Shared app failed to load.", err.message || String(err));
          else showNotice(err.message);
        }
      }

      async function refreshAdmin() {
        if (!CLOUD_ENABLED) return;
        const status = $id("adminStatus");
        const loginPanel = $id("adminLoginPanel");
        const dashboard = $id("adminDashboard");
        const isAdmin = cloudUser?.role === "admin";
        status.textContent = isAdmin ? "Admin session active" : "Admin login required";
        loginPanel?.classList.toggle("hidden", isAdmin);
        dashboard?.classList.toggle("hidden", !isAdmin);
        if (!isAdmin) return;
        try {
          const userQuery = encodeURIComponent(($id("adminUserSearch")?.value || "").trim());
          const shareQuery = encodeURIComponent(($id("adminShareSearch")?.value || "").trim());
          const snapshotQuery = encodeURIComponent(($id("adminSnapshotSearch")?.value || "").trim());
          const snapshotUser = encodeURIComponent(($id("adminSnapshotUserFilter")?.value || "").trim());
          const [users, storage, shares, snapshots, tiers, me] = await Promise.all([
            cloudJson(`/api/admin/users${userQuery ? `?q=${userQuery}` : ""}`, { method: "GET" }),
            cloudJson(`/api/admin/storage${userQuery ? `?q=${userQuery}` : ""}`, { method: "GET" }),
            cloudJson(`/api/admin/shares${shareQuery ? `?q=${shareQuery}` : ""}`, { method: "GET" }),
            cloudJson(`/api/admin/snapshots${snapshotQuery || snapshotUser ? `?${[
              snapshotQuery ? `q=${snapshotQuery}` : "",
              snapshotUser ? `userId=${snapshotUser}` : "",
            ].filter(Boolean).join("&")}` : ""}`, { method: "GET" }),
            cloudJson("/api/admin/tiers", { method: "GET" }),
            cloudJson("/api/me", { method: "GET" }),
          ]);
          cloudTiers = tiers.tiers || {};
          adminUsers = users.users || [];
          adminPlatformShares = shares.shares || [];
          adminPlatformSnapshots = snapshots.snapshots || [];
          $id("adminSharingEnabled").checked = !!me.settings.sharingEnabled;
          $id("adminAppModeEnabled").checked = !!me.settings.appModeEnabled;
          $id("adminCloudNoticeHtml").value = me.settings.cloudNoticeHtml || "";
          if ($id("adminTosHtml")) $id("adminTosHtml").value = me.settings.tosHtml || "";
          renderAdminUsers(adminUsers);
          renderAdminSnapshotUserFilter(adminUsers);
          renderAdminShares(adminPlatformShares);
          renderAdminSnapshots(adminPlatformSnapshots);
          renderAdminStorage(storage, adminUsers, adminPlatformSnapshots, adminPlatformShares);
          renderAdminTiers(cloudTiers);
          updatePagerUi("adminUsers", "users", paginateItems(adminUsers, adminUsersPage, adminUsersPageSize));
          updatePagerUi("adminSnapshots", "backups", paginateItems(adminPlatformSnapshots, adminSnapshotsPage, adminSnapshotsPageSize));
          updatePagerUi("adminShares", "share links", paginateItems(adminPlatformShares, adminSharesPage, adminSharesPageSize));
          updatePagerUi("adminTiers", "tiers", paginateItems(Object.entries(cloudTiers || {}), adminTiersPage, adminTiersPageSize));
          if ($id("adminMetricUsers")) $id("adminMetricUsers").textContent = String(adminUsers.length);
          if ($id("adminMetricSnapshots")) $id("adminMetricSnapshots").textContent = String(adminPlatformSnapshots.length);
          if ($id("adminMetricShares")) $id("adminMetricShares").textContent = String(adminPlatformShares.length);
          if ($id("adminMetricStorage")) $id("adminMetricStorage").textContent = formatBytes(storage.totalStorageUsed || 0);
          window.lucide?.createIcons();
        } catch (err) {
          showNotice(err.message);
        }
      }

      function renderAdminUsers(users = []) {
        const userList = $id("adminUserList");
        if (!userList) return;
        userList.textContent = "";
        if ($id("adminUsersPageSize")) $id("adminUsersPageSize").value = String(adminUsersPageSize);
        if (!users.length) {
          userList.innerHTML = `<div class="file-muted">No matching users.</div>`;
          updatePagerUi("adminUsers", "users", paginateItems([], 1, adminUsersPageSize));
          return;
        }
        const pagination = paginateItems(users, adminUsersPage, adminUsersPageSize);
        adminUsersPage = pagination.page;
        for (const user of pagination.pageItems) {
          const item = document.createElement("div");
          item.className = "workspace-item";
          item.innerHTML = `<div><div class="workspace-name"></div><div class="workspace-meta"></div></div><div class="flex gap-2"><button class="icon-only edit" title="Edit user"><i data-lucide="pencil"></i></button><button class="icon-only delete" title="Delete user"><i data-lucide="trash-2"></i></button></div>`;
          const expiry = user.tierExpiresAt ? ` - expires ${new Date(user.tierExpiresAt).toLocaleString()}` : "";
          item.querySelector(".workspace-name").textContent = `${user.name || user.email} (${user.email})`;
          item.querySelector(".workspace-meta").textContent = `${user.role} - ${user.tier}${expiry} - ${formatBytes(user.storageUsed || 0)} / ${formatBytes(user.permissions?.storageQuota || 0)}`;
          item.querySelector(".edit").addEventListener("click", () => adminEditUser(user));
          item.querySelector(".delete").addEventListener("click", () => adminDeleteUser(user.id));
          userList.appendChild(item);
        }
        updatePagerUi("adminUsers", "users", pagination);
      }

      function renderAdminSnapshotUserFilter(users = []) {
        const select = $id("adminSnapshotUserFilter");
        if (!select) return;
        const currentValue = select.value;
        select.textContent = "";
        const allOption = document.createElement("option");
        allOption.value = "";
        allOption.textContent = "All users";
        select.appendChild(allOption);
        for (const user of users) {
          const option = document.createElement("option");
          option.value = user.id;
          option.textContent = user.email;
          select.appendChild(option);
        }
        select.value = [...select.options].some((option) => option.value === currentValue) ? currentValue : "";
      }

      function renderAdminShares(shares = []) {
        const shareList = $id("adminShareList");
        if (!shareList) return;
        shareList.textContent = "";
        if ($id("adminSharesPageSize")) $id("adminSharesPageSize").value = String(adminSharesPageSize);
        if (!shares.length) {
          shareList.innerHTML = `<div class="file-muted">No matching share links.</div>`;
          updatePagerUi("adminShares", "share links", paginateItems([], 1, adminSharesPageSize));
          return;
        }
        const pagination = paginateItems(shares, adminSharesPage, adminSharesPageSize);
        adminSharesPage = pagination.page;
        for (const share of pagination.pageItems) {
          const item = document.createElement("div");
          item.className = "workspace-item";
          item.innerHTML = `<div><div class="workspace-name"></div><div class="workspace-meta"></div></div><div class="flex gap-2"><button class="icon-only copy" title="Copy share link"><i data-lucide="copy"></i></button><button class="icon-only edit" title="Edit share"><i data-lucide="pencil"></i></button><button class="icon-only delete" title="Delete share"><i data-lucide="trash-2"></i></button></div>`;
          const ownerLabel = share.owner?.email ? `${share.owner.email} - ` : "";
          item.querySelector(".workspace-name").textContent = `${ownerLabel}${share.visibility} ${share.mode}${share.appMode ? " app" : ""}${share.tempMode ? " temp" : ""}`;
          item.querySelector(".workspace-meta").textContent = `${publicShareUrl(share)}${share.expiresAt ? ` - expires ${new Date(share.expiresAt).toLocaleString()}` : ""}`;
          item.querySelector(".copy").addEventListener("click", async () => {
            await navigator.clipboard.writeText(publicShareUrl(share));
            showNotice("Share link copied");
          });
          item.querySelector(".edit").addEventListener("click", () => adminEditShare(share));
          item.querySelector(".delete").addEventListener("click", () => adminDeleteShare(share.id));
          shareList.appendChild(item);
        }
        updatePagerUi("adminShares", "share links", pagination);
      }

      function renderAdminSnapshots(snapshots = []) {
        const snapshotList = $id("adminSnapshotList");
        if (!snapshotList) return;
        snapshotList.textContent = "";
        if ($id("adminSnapshotsPageSize")) $id("adminSnapshotsPageSize").value = String(adminSnapshotsPageSize);
        if (!snapshots.length) {
          snapshotList.innerHTML = `<div class="file-muted">No matching backups.</div>`;
          updatePagerUi("adminSnapshots", "backups", paginateItems([], 1, adminSnapshotsPageSize));
          return;
        }
        const pagination = paginateItems(snapshots, adminSnapshotsPage, adminSnapshotsPageSize);
        adminSnapshotsPage = pagination.page;
        for (const snapshot of pagination.pageItems) {
          const item = document.createElement("div");
          item.className = "workspace-item";
          item.innerHTML = `<div><div class="workspace-name"></div><div class="workspace-meta"></div></div><div class="flex gap-2"><button class="icon-only download" title="Download backup"><i data-lucide="download"></i></button><button class="icon-only restore" title="Restore to local workspace"><i data-lucide="rotate-ccw"></i></button><button class="icon-only delete" title="Delete backup"><i data-lucide="trash-2"></i></button></div>`;
          item.querySelector(".workspace-name").textContent = `${snapshot.name} - ${snapshot.owner?.email || "Unknown owner"}`;
          item.querySelector(".workspace-meta").textContent = `${formatBytes(snapshot.size)} - v${snapshot.version || 1} - ${new Date(snapshot.updatedAt || snapshot.createdAt).toLocaleString()}${snapshot.appMode ? " - App Mode" : ""}`;
          item.querySelector(".download").addEventListener("click", () => adminDownloadSnapshot(snapshot));
          item.querySelector(".restore").addEventListener("click", () => adminRestoreSnapshot(snapshot));
          item.querySelector(".delete").addEventListener("click", () => adminDeleteSnapshot(snapshot.id));
          snapshotList.appendChild(item);
        }
        updatePagerUi("adminSnapshots", "backups", pagination);
      }

      function renderAdminStorage(storage = {}, users = [], snapshots = [], shares = []) {
        const el = $id("adminStorage");
        if (!el) return;
        el.innerHTML = `
          <div class="setting-row"><span>Total usage</span><code>${formatBytes(storage.totalStorageUsed || 0)}</code></div>
          <div class="setting-row"><span>Visible users</span><code>${users.length}</code></div>
          <div class="setting-row"><span>Visible backups</span><code>${snapshots.length}</code></div>
          <div class="setting-row"><span>Visible share links</span><code>${shares.length}</code></div>
        `;
      }

      async function adminCreateUser() {
        const values = await askFields("Create User", [
          { name: "email", label: "Email", type: "email" },
          { name: "password", label: "Temporary password", type: "password", value: "ChangeMe123" },
          { name: "tier", label: "Tier", type: "select", value: "free", options: Object.keys(cloudTiers).length ? Object.keys(cloudTiers) : ["free", "plus", "pro", "custom"] },
          { name: "role", label: "Role", type: "select", value: "user", options: ["user", "admin"], required: false },
          { name: "tierExpiresAt", label: "Tier expiry (optional)", type: "datetime-local", value: "", required: false },
          { name: "tierFallback", label: "Tier after expiry", type: "select", value: "free", options: Object.keys(cloudTiers).length ? Object.keys(cloudTiers) : ["free", "plus", "pro", "custom"], required: false },
        ], { confirmLabel: "Create" });
        if (!values) return;
        const { email, password, tier, role } = values;
        try {
          await cloudJson("/api/admin/users", {
            method: "POST",
            body: JSON.stringify({
              email,
              password,
              tier,
              role,
              tierExpiresAt: values.tierExpiresAt ? new Date(values.tierExpiresAt).getTime() : null,
              tierFallback: values.tierFallback || "free",
            }),
          });
          await refreshAdmin();
        } catch (err) {
          showNotice(err.message);
        }
      }

      function tierFormFields(tierId = "", tier = {}) {
        return [
          { name: "id", label: "Tier ID", value: tierId, required: true },
          { name: "storageQuotaMb", label: "Storage quota (MB)", type: "number", value: String(Math.round((tier.storageQuota || 100 * 1024 * 1024) / (1024 * 1024))) },
          { name: "maxSnapshots", label: "Max snapshots", type: "number", value: String(tier.maxSnapshots || 5) },
          { name: "keepLastBackups", label: "Keep latest backups", type: "number", value: String(tier.keepLastBackups || 5) },
          { name: "minimumAutoSyncMinutes", label: "Fastest auto-sync interval (0 = disabled)", type: "number", value: String(tier.minimumAutoSyncMinutes || 0) },
          { name: "maxShareLinks", label: "Max share links", type: "number", value: String(tier.maxShareLinks || 2) },
          { name: "defaultExpirationDays", label: "Default share expiration (days)", type: "number", value: String(Math.round((tier.defaultExpirationSeconds || 604800) / 86400)) },
          { name: "autoSyncEnabled", label: "Auto-sync enabled", type: "checkbox", checked: !!tier.autoSyncEnabled, required: false },
          { name: "appModeAllowed", label: "App Mode allowed", type: "checkbox", checked: tier.appModeAllowed !== false, required: false },
          { name: "isDefault", label: "Default tier for new signups", type: "checkbox", checked: !!tier.isDefault, required: false },
          { name: "sharePermissions", label: "Share visibility csv", value: (tier.sharePermissions || ["private"]).join(","), required: true },
        ];
      }

      function tierPayload(values) {
        return {
          id: values.id,
          storageQuota: Number(values.storageQuotaMb) * 1024 * 1024,
          maxSnapshots: Number(values.maxSnapshots),
          keepLastBackups: Number(values.keepLastBackups),
          minimumAutoSyncMinutes: Number(values.minimumAutoSyncMinutes),
          maxShareLinks: Number(values.maxShareLinks),
          defaultExpirationSeconds: Number(values.defaultExpirationDays) * 24 * 60 * 60,
          autoSyncEnabled: !!values.autoSyncEnabled,
          appModeAllowed: !!values.appModeAllowed,
          isDefault: !!values.isDefault,
          sharePermissions: values.sharePermissions.split(",").filter(Boolean),
        };
      }

      function renderAdminTiers(tiers) {
        const list = $id("adminTierList");
        if (!list) return;
        list.textContent = "";
        const entries = Object.entries(tiers || {});
        if ($id("adminTiersPageSize")) $id("adminTiersPageSize").value = String(adminTiersPageSize);
        if (!entries.length) {
          list.innerHTML = `<div class="file-muted">No tiers found.</div>`;
          updatePagerUi("adminTiers", "tiers", paginateItems([], 1, adminTiersPageSize));
          return;
        }
        const pagination = paginateItems(entries, adminTiersPage, adminTiersPageSize);
        adminTiersPage = pagination.page;
        for (const [id, tier] of pagination.pageItems) {
          const item = document.createElement("div");
          item.className = "workspace-item";
          item.innerHTML = `<div><div class="workspace-name"></div><div class="workspace-meta"></div></div><div class="flex gap-2"><button class="icon-only edit" title="Edit tier"><i data-lucide="pencil"></i></button><button class="icon-only delete" title="Delete tier"><i data-lucide="trash-2"></i></button></div>`;
          item.querySelector(".workspace-name").textContent = id;
          item.querySelector(".workspace-meta").textContent = `${formatBytes(tier.storageQuota || 0)} - ${tier.maxSnapshots || 0} snapshots - keep ${tier.keepLastBackups || tier.maxSnapshots || 0}`;
          item.querySelector(".edit").addEventListener("click", () => adminEditTier(id, tier));
          item.querySelector(".delete").disabled = ["free", "plus", "pro"].includes(id);
          item.querySelector(".delete").addEventListener("click", () => adminDeleteTier(id));
          list.appendChild(item);
        }
        updatePagerUi("adminTiers", "tiers", pagination);
      }

      async function adminEditTier(id = "", tier = {}) {
        const values = await askFields(id ? "Edit Tier" : "Create Tier", tierFormFields(id, tier), { confirmLabel: "Save" });
        if (!values) return;
        try {
          await cloudJson("/api/admin/tiers", { method: "POST", body: JSON.stringify(tierPayload(values)) });
          showNotice("Tier saved");
          await refreshAdmin();
          await refreshCloudState();
        } catch (err) {
          showNotice(err.message);
        }
      }

      async function adminDeleteTier(id) {
        if (!(await askConfirm("Delete Tier", `Delete tier "${id}"? Users on this tier move to free.`, { confirmLabel: "Delete", danger: true }))) return;
        try {
          await fetch(`/api/admin/tiers/${encodeURIComponent(id)}`, { method: "DELETE", headers: cloudHeaders() }).then(async (response) => {
            if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Delete failed");
          });
          showNotice("Tier deleted");
          await refreshAdmin();
          await refreshCloudState();
        } catch (err) {
          showNotice(err.message);
        }
      }

      async function adminEditUser(user) {
        const values = await askFields("Edit User", [
          { name: "email", label: "Email", type: "email", value: user.email },
          { name: "name", label: "Name", value: user.name || "", required: false },
          { name: "role", label: "Role", type: "select", value: user.role || "user", options: ["user", "admin"] },
          { name: "tier", label: "Tier", type: "select", value: user.tier || "free", options: Object.keys(cloudTiers).length ? Object.keys(cloudTiers) : ["free", "plus", "pro", "custom"] },
          { name: "tierExpiresAt", label: "Tier expiry date/time", type: "datetime-local", value: user.tierExpiresAt ? new Date(user.tierExpiresAt).toISOString().slice(0, 16) : "", required: false },
          { name: "tierFallback", label: "Tier after expiry", type: "select", value: user.tierFallback || "free", options: Object.keys(cloudTiers).length ? Object.keys(cloudTiers) : ["free", "plus", "pro", "custom"], required: false },
          { name: "password", label: "Reset password (leave blank to keep)", type: "password", value: "", required: false },
          { name: "storageQuota", label: "Storage quota override", type: "select", value: user.overrides?.storageQuota ? String(Math.round(user.overrides.storageQuota / (1024 * 1024))) : "", required: false, options: [{ value: "", label: "Use tier default" }, { value: "100", label: "100 MB" }, { value: "1024", label: "1 GB" }, { value: "10240", label: "10 GB" }, { value: "51200", label: "50 GB" }] },
          { name: "maxSnapshots", label: "Max snapshots override", type: "select", value: user.overrides?.maxSnapshots ? String(user.overrides.maxSnapshots) : "", required: false, options: [{ value: "", label: "Use tier default" }, "5", "10", "25", "50", "100"] },
          { name: "keepLastBackups", label: "Keep latest backups override", type: "select", value: user.overrides?.keepLastBackups ? String(user.overrides.keepLastBackups) : "", required: false, options: [{ value: "", label: "Use tier default" }, "3", "5", "10", "25", "50"] },
          { name: "minimumAutoSyncMinutes", label: "Fastest auto-sync override", type: "select", value: user.overrides?.minimumAutoSyncMinutes != null ? String(user.overrides.minimumAutoSyncMinutes) : "", required: false, options: [{ value: "", label: "Use tier default" }, { value: "0", label: "Disabled" }, { value: "1", label: "1 minute" }, { value: "5", label: "5 minutes" }, { value: "15", label: "15 minutes" }, { value: "30", label: "30 minutes" }] },
          { name: "maxShareLinks", label: "Max share links override", type: "select", value: user.overrides?.maxShareLinks ? String(user.overrides.maxShareLinks) : "", required: false, options: [{ value: "", label: "Use tier default" }, "0", "2", "10", "20", "100"] },
          { name: "sharePermissions", label: "Share visibility override", type: "select", value: Array.isArray(user.overrides?.sharePermissions) ? user.overrides.sharePermissions.join(",") : "", required: false, options: [{ value: "", label: "Use tier default" }, { value: "private", label: "Private only" }, { value: "private,restricted", label: "Private + restricted" }, { value: "private,restricted,public", label: "Private + restricted + public" }] },
          { name: "defaultExpirationDays", label: "Default expiration override", type: "select", value: user.overrides?.defaultExpirationSeconds ? String(Math.round(user.overrides.defaultExpirationSeconds / 86400)) : "", required: false, options: [{ value: "", label: "Use tier default" }, { value: "1", label: "1 day" }, { value: "7", label: "7 days" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }] },
          { name: "autoSyncEnabled", label: "Auto-sync override", type: "select", value: user.overrides?.autoSyncEnabled == null ? "" : String(!!user.overrides.autoSyncEnabled), required: false, options: [{ value: "", label: "Use tier default" }, { value: "true", label: "Enabled" }, { value: "false", label: "Disabled" }] },
          { name: "appModeAllowed", label: "App Mode override", type: "select", value: user.overrides?.appModeAllowed == null ? "" : String(!!user.overrides.appModeAllowed), required: false, options: [{ value: "", label: "Use tier default" }, { value: "true", label: "Allowed" }, { value: "false", label: "Blocked" }] },
          { name: "sharingEnabled", label: "Sharing override", type: "select", value: user.overrides?.sharingEnabled == null ? "" : String(!!user.overrides.sharingEnabled), required: false, options: [{ value: "", label: "Use tier default" }, { value: "true", label: "Enabled" }, { value: "false", label: "Disabled" }] },
        ], { confirmLabel: "Save" });
        if (!values) return;
        const parseBool = (value) => value === "" ? undefined : /^true$/i.test(String(value).trim());
        const overrides = {};
        if (values.storageQuota) overrides.storageQuota = Number(values.storageQuota) * 1024 * 1024;
        if (values.maxSnapshots) overrides.maxSnapshots = Number(values.maxSnapshots);
        if (values.keepLastBackups) overrides.keepLastBackups = Number(values.keepLastBackups);
        if (values.minimumAutoSyncMinutes !== "") overrides.minimumAutoSyncMinutes = Number(values.minimumAutoSyncMinutes);
        if (values.maxShareLinks) overrides.maxShareLinks = Number(values.maxShareLinks);
        if (values.sharePermissions) overrides.sharePermissions = values.sharePermissions.split(",").map((item) => item.trim()).filter(Boolean);
        if (values.defaultExpirationDays) overrides.defaultExpirationSeconds = Number(values.defaultExpirationDays) * 24 * 60 * 60;
        if (parseBool(values.autoSyncEnabled) !== undefined) overrides.autoSyncEnabled = parseBool(values.autoSyncEnabled);
        if (parseBool(values.appModeAllowed) !== undefined) overrides.appModeAllowed = parseBool(values.appModeAllowed);
        if (parseBool(values.sharingEnabled) !== undefined) overrides.sharingEnabled = parseBool(values.sharingEnabled);
        try {
          await cloudJson(`/api/admin/users/${encodeURIComponent(user.id)}`, {
            method: "POST",
            body: JSON.stringify({
              email: values.email,
              name: values.name,
              role: values.role,
              tier: values.tier,
              tierExpiresAt: values.tierExpiresAt ? new Date(values.tierExpiresAt).getTime() : null,
              tierFallback: values.tierFallback || "free",
              password: values.password || undefined,
              overrides,
            }),
          });
          showNotice("User updated");
          await refreshAdmin();
        } catch (err) {
          showNotice(err.message);
        }
      }

      async function adminDeleteUser(userId) {
        if (!(await askConfirm("Delete User", "Delete this user and all cloud data?", { confirmLabel: "Delete", danger: true }))) return;
        await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, { method: "DELETE", headers: cloudHeaders() });
        await refreshAdmin();
      }

      async function editShare(share) {
        const values = await askFields("Edit Share", [
          { name: "visibility", label: "Visibility", type: "select", value: share.visibility || "private", options: ["private", "restricted", "public"] },
          { name: "expiresInDays", label: "Expiration", type: "select", value: share.expiresAt ? String(Math.max(0, Math.round((share.expiresAt - Date.now()) / 86400000))) : "0", required: false, options: [{ value: "0", label: "Never" }, { value: "1", label: "1 day" }, { value: "7", label: "7 days" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }] },
          { name: "allowedUsers", label: "Restricted users csv", value: (share.allowedUsers || []).join(", "), required: false },
          { name: "customSlug", label: "Custom share URL slug", value: share.customSlug || "", required: false },
          { name: "readWrite", label: "Mode (read-only blocks save-back)", type: "select", value: String(share.mode === "read-write"), options: [{ value: "false", label: "read-only" }, { value: "true", label: "read-write" }], required: false },
          { name: "tempMode", label: "Temp mode", type: "select", value: String(!!share.tempMode), options: [{ value: "true", label: "true" }, { value: "false", label: "false" }], required: false },
          { name: "allowFork", label: "Allow fork", type: "select", value: String(!!share.allowFork), options: [{ value: "true", label: "true" }, { value: "false", label: "false" }], required: false },
          { name: "allowCloudWriteBack", label: "Allow cloud write-back (requires read-write)", type: "select", value: String(!!share.allowCloudWriteBack), options: [{ value: "true", label: "true" }, { value: "false", label: "false" }], required: false },
          { name: "appMode", label: "Open in App Mode", type: "select", value: String(!!share.appMode), options: [{ value: "true", label: "true" }, { value: "false", label: "false" }], required: false },
        ], { confirmLabel: "Save" });
        if (!values) return;
        try {
          const readWrite = /^true$/i.test(values.readWrite || "false");
          await cloudJson(`/api/share/update/${encodeURIComponent(share.id)}`, {
            method: "POST",
            body: JSON.stringify({
              visibility: values.visibility,
              expiresInSeconds: Number(values.expiresInDays || 0) > 0 ? Number(values.expiresInDays) * 24 * 60 * 60 : 0,
              allowedUsers: values.allowedUsers.split(",").map((item) => item.trim()).filter(Boolean),
              customSlug: values.customSlug,
              readWrite,
              tempMode: /^true$/i.test(values.tempMode || "false"),
              allowFork: /^true$/i.test(values.allowFork || "false"),
              allowCloudWriteBack: readWrite && /^true$/i.test(values.allowCloudWriteBack || "false"),
              appMode: /^true$/i.test(values.appMode || "false"),
            }),
          });
          showNotice("Share updated");
          await refreshCloudState();
          if (cloudUser?.role === "admin") await refreshAdmin();
        } catch (err) {
          showNotice(err.message);
        }
      }

      async function adminEditShare(share) {
        const values = await askFields("Admin Edit Share", [
          { name: "visibility", label: "Visibility", type: "select", value: share.visibility || "private", options: ["private", "restricted", "public"] },
          { name: "expiresAt", label: "Expiration date/time (leave blank for none)", value: share.expiresAt ? new Date(share.expiresAt).toISOString().slice(0, 16) : "", required: false },
          { name: "allowedUsers", label: "Restricted users csv", value: (share.allowedUsers || []).join(", "), required: false },
          { name: "customSlug", label: "Custom share URL slug", value: share.customSlug || "", required: false },
          { name: "mode", label: "Mode", type: "select", value: share.mode || "read-only", options: ["read-only", "read-write"] },
          { name: "tempMode", label: "Temp mode", type: "select", value: String(!!share.tempMode), options: [{ value: "true", label: "true" }, { value: "false", label: "false" }], required: false },
          { name: "allowFork", label: "Allow fork", type: "select", value: String(!!share.allowFork), options: [{ value: "true", label: "true" }, { value: "false", label: "false" }], required: false },
          { name: "allowCloudWriteBack", label: "Allow cloud write-back (requires read-write)", type: "select", value: String(!!share.allowCloudWriteBack), options: [{ value: "true", label: "true" }, { value: "false", label: "false" }], required: false },
          { name: "appMode", label: "Open in App Mode", type: "select", value: String(!!share.appMode), options: [{ value: "true", label: "true" }, { value: "false", label: "false" }], required: false },
        ], { confirmLabel: "Save" });
        if (!values) return;
        try {
          const readWrite = values.mode === "read-write";
          await cloudJson(`/api/admin/shares/${encodeURIComponent(share.id)}`, {
            method: "POST",
            body: JSON.stringify({
              visibility: values.visibility,
              expiresAt: values.expiresAt ? new Date(values.expiresAt).getTime() : null,
              allowedUsers: values.allowedUsers.split(",").map((item) => item.trim()).filter(Boolean),
              customSlug: values.customSlug,
              mode: values.mode,
              tempMode: /^true$/i.test(values.tempMode || "false"),
              allowFork: /^true$/i.test(values.allowFork || "false"),
              allowCloudWriteBack: readWrite && /^true$/i.test(values.allowCloudWriteBack || "false"),
              appMode: /^true$/i.test(values.appMode || "false"),
            }),
          });
          showNotice("Admin share updated");
          await refreshAdmin();
          await refreshCloudState();
        } catch (err) {
          showNotice(err.message);
        }
      }

      async function adminLogin() {
        const email = $id("adminEmail").value.trim();
        const password = $id("adminPassword").value;
        await loginWithCredentials("login", email, password);
        if (cloudUser?.role === "admin") {
          showNotice("Admin login ready");
          await refreshAdmin();
        } else if (cloudUser) {
          showNotice("This account is not an admin");
        }
      }

      async function adminDeleteShare(shareId) {
        if (!(await askConfirm("Delete Share", "Delete this share link permanently?", { confirmLabel: "Delete", danger: true }))) return;
        await fetch(`/api/admin/shares/${encodeURIComponent(shareId)}`, { method: "DELETE", headers: cloudHeaders() }).then(async (response) => {
          if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Delete failed");
        });
        await refreshAdmin();
        await refreshCloudState();
      }

      async function adminDownloadSnapshot(snapshot) {
        await withBusy("Downloading platform backup...", async () => {
          const response = await fetch(`/api/admin/snapshots/${encodeURIComponent(snapshot.id)}/download`, {
            headers: cloudHeaders(),
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.error || "Download failed");
          }
          const blob = await readResponseBlobWithProgress(response, "Downloading rootfs backup...");
          downloadBlobAs(blob, `${snapshot.name || "platform-backup"}.workspace.zip`);
          showNotice("Backup downloaded");
        }).catch((err) => showNotice(err.message));
      }

      async function adminRestoreSnapshot(snapshot) {
        if (!(await askConfirm("Restore User Backup", "Restore this platform backup into a new local workspace?", { confirmLabel: "Restore" }))) return;
        await withBusy("Restoring platform backup...", async () => {
          const response = await fetch(`/api/admin/snapshots/${encodeURIComponent(snapshot.id)}/download`, {
            headers: cloudHeaders(),
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.error || "Restore failed");
          }
          const file = new File([await readResponseBlobWithProgress(response, "Downloading rootfs backup...")], `${snapshot?.name || "platform-restore"}.workspace.zip`, { type: "application/zip" });
          await createWorkspaceFromZip(`${snapshot?.name || "Platform Restore"} (${snapshot?.owner?.email || "admin"})`, file);
        }).catch((err) => showNotice(err.message));
      }

      async function adminDeleteSnapshot(snapshotId) {
        if (!(await askConfirm("Delete Backup", "Delete this user's cloud backup permanently?", { confirmLabel: "Delete", danger: true }))) return;
        await fetch(`/api/admin/snapshots/${encodeURIComponent(snapshotId)}`, { method: "DELETE", headers: cloudHeaders() }).then(async (response) => {
          if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Delete failed");
        });
        await refreshAdmin();
        await refreshCloudState();
      }

      async function adminImportSnapshotFile(file) {
        if (!file) return;
        const userOptions = adminUsers.map((user) => ({ value: user.id, label: `${user.email} (${user.tier})` }));
        if (!userOptions.length) return showNotice("Create a user before importing backups");
        const values = await askFields("Import Backup To User", [
          { name: "userId", label: "Target user", type: "select", value: $id("adminSnapshotUserFilter")?.value || userOptions[0].value, options: userOptions },
          { name: "name", label: "Backup name", value: file.name.replace(/\.zip$/i, ""), required: false },
          { name: "workspaceId", label: "Workspace id label", value: "admin-import", required: false },
          { name: "appMode", label: "App Mode snapshot", type: "checkbox", checked: false, required: false },
        ], { confirmLabel: "Import" });
        if (!values) return;
        await withBusy("Importing platform backup...", async () => {
          const form = new FormData();
          form.set("file", file, file.name);
          form.set("userId", values.userId);
          form.set("name", values.name || file.name.replace(/\.zip$/i, ""));
          form.set("workspaceId", values.workspaceId || "admin-import");
          form.set("appMode", values.appMode ? "true" : "false");
          const response = await fetch("/api/admin/snapshots/import", {
            method: "POST",
            headers: cloudHeaders(),
            body: form,
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload.error || "Import failed");
          showNotice("Backup imported");
          await refreshAdmin();
        }).catch((err) => showNotice(err.message));
      }

      function refreshFiles(path = currentPath) {
        const fs = pyodide.FS;
        currentPath = normalizePath(path);
        clearSelection();
        $id("filePath").value = currentPath;
        const list = $id("fileList");
        list.textContent = "";
        hideContextMenu();

        if (!fs.analyzePath(currentPath).exists) {
          list.textContent = "Path not found.";
          return;
        }

        const fragment = document.createDocumentFragment();
        const entries = fs.readdir(currentPath).filter((entry) => entry !== "." && entry !== "..").sort();
        for (const name of entries) {
          const fullPath = currentPath === "/" ? `/${name}` : `${currentPath}/${name}`;
          const linkStat = fs.lstat(fullPath);
          const isLink = fs.isLink(linkStat.mode);
          const stat = isLink ? fs.stat(fullPath) : linkStat;
          const isDir = fs.isDir(stat.mode);
          const row = document.createElement("div");
          row.className = "file-row";
          row.dataset.path = fullPath;
          row.innerHTML = `
            <input type="checkbox" class="file-check" aria-label="Select ${name}" />
            <div class="file-icon ${isDir ? "dir" : "file"}"><i data-lucide="${isDir ? "folder" : "file-code"}"></i></div>
            <div class="file-name"></div>
            <div class="file-muted">${isDir ? "" : formatBytes(stat.size)}</div>
            <div class="file-muted">${new Date(stat.mtime).toLocaleString()}</div>
          `;
          row.querySelector(".file-name").textContent = name;
          const checkbox = row.querySelector(".file-check");
          checkbox.addEventListener("click", (event) => {
            event.stopPropagation();
            if (checkbox.checked) selectedPaths.add(fullPath);
            else selectedPaths.delete(fullPath);
            selectedPath = fullPath;
            syncRowSelectionUI();
          });
          row.addEventListener("click", () => {
            if (suppressFileClick) return;
            selectedPaths.clear();
            selectedPaths.add(fullPath);
            setPrimarySelection(fullPath);
          });
          row.addEventListener("dblclick", () => {
            if (isDir) refreshFiles(fullPath);
            else if (isPreviewablePath(fullPath)) openPreview(fullPath);
            else openEditor(fullPath);
          });
          row.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            if (!selectedPaths.has(fullPath)) {
              selectedPaths.clear();
              selectedPaths.add(fullPath);
              setPrimarySelection(fullPath);
            }
            showContextMenu(event.clientX, event.clientY, fullPath);
          });
          fragment.appendChild(row);
        }
        list.appendChild(fragment);
        window.lucide?.createIcons({ attrs: { "stroke-width": 1.8 }, root: list });
      }

      async function downloadPath(path) {
        const fs = pyodide.FS;
        if (!fs.analyzePath(path).exists) return;
        const stat = fs.stat(path);
        let blob;
        let filename = path.split("/").filter(Boolean).pop() || "root";

        if (fs.isDir(stat.mode)) {
          const zip = new JSZip();
          addPathToZip(zip, path, filename);
          blob = await zip.generateAsync({ type: "blob" });
          filename += ".zip";
        } else {
          blob = new Blob([fs.readFile(path)]);
        }

        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
      }

      async function downloadSelectedPaths(paths) {
        if (paths.length === 1) {
          await downloadPath(paths[0]);
          showNotice(`Downloaded ${paths[0]}`);
          return;
        }

        const zip = new JSZip();
        for (const path of paths) {
          const name = path.split("/").filter(Boolean).pop() || "root";
          addPathToZip(zip, path, name);
        }
        const blob = await zip.generateAsync({ type: "blob" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "edgeterm-selection.zip";
        link.click();
        URL.revokeObjectURL(url);
        showNotice(`Downloaded ${paths.length} items`);
      }

      function addPathToZip(zip, sourcePath, zipPath) {
        const fs = pyodide.FS;
        const stat = fs.stat(sourcePath);
        if (fs.isDir(stat.mode)) {
          const folder = zip.folder(zipPath);
          for (const entry of fs.readdir(sourcePath)) {
            if (entry === "." || entry === "..") continue;
            addPathToZip(folder, `${sourcePath}/${entry}`, entry);
          }
        } else {
          zip.file(zipPath, fs.readFile(sourcePath));
        }
      }

      async function exportActiveWorkspace() {
        await persistActiveWorkspace();
        const workspace = activeWorkspace();
        const zip = new JSZip();
        addPathToZip(zip, workspacePath(activeWorkspaceId), workspace.name.replace(/[^\w.-]+/g, "-"));
        const blob = await zip.generateAsync({ type: "blob" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${safeName(workspace.name)}.workspace.zip`;
        link.click();
        URL.revokeObjectURL(url);
      }

      function normalizeWasmCommandEntries(manifest, packageName) {
        const entries = [];
        const append = (commandName, definition = {}) => {
          const entry = typeof definition === "string" ? { launcher: definition } : { ...definition };
          const launcher = entry.launcher || entry.js || entry.main || manifest.launcher || manifest.main || commandName;
          const wasm = entry.wasm || manifest.wasm || `${commandName}.wasm`;
          entries.push({
            command: commandName,
            packageName,
            manifest,
            packageRoot: packageRootPath(packageName),
            launcherPath: `${packageRootPath(packageName)}/${launcher}`,
            wasmPath: `${packageRootPath(packageName)}/${wasm}`,
            factoryExport: entry.factoryExport || manifest.factoryExport || null,
            thisProgram: entry.thisProgram || manifest.thisProgram || commandName,
          });
        };

        if (typeof manifest.bin === "string") {
          append(manifest.name || packageName, { launcher: manifest.bin });
        } else if (manifest.bin && typeof manifest.bin === "object") {
          for (const [commandName, launcher] of Object.entries(manifest.bin)) append(commandName, { launcher });
        } else if (manifest.commands && typeof manifest.commands === "object") {
          for (const [commandName, definition] of Object.entries(manifest.commands)) append(commandName, definition);
        } else if (manifest.command) {
          append(manifest.command, manifest);
        }

        return entries;
      }

      function discoverWasmPackages() {
        const registry = new Map();
        if (!pyodide.FS.analyzePath("/packages").exists) return registry;
        for (const packageName of pyodide.FS.readdir("/packages")) {
          if (packageName === "." || packageName === "..") continue;
          const manifestPath = packageManifestPath(packageName);
          if (!pyodide.FS.analyzePath(manifestPath).exists) continue;
          let manifest;
          try {
            manifest = readJsonFile(manifestPath);
          } catch (err) {
            console.warn("[WASM] Invalid package manifest:", manifestPath, err);
            continue;
          }
          for (const entry of normalizeWasmCommandEntries(manifest, packageName)) registry.set(entry.command, entry);
        }
        return registry;
      }

      function clearWasmCommandLinks() {
        for (const link of wasmCommandLinks) {
          try {
            if (pyodide.FS.analyzePath(link).exists) pyodide.FS.unlink(link);
          } catch {}
        }
        wasmCommandLinks.clear();
      }

      function refreshWasmCommandLinks() {
        clearWasmCommandLinks();
        const registry = discoverWasmPackages();
        for (const [commandName, entry] of registry.entries()) {
          const linkPath = `/bin/${commandName}`;
          try {
            if (pyodide.FS.analyzePath(linkPath).exists) continue;
            pyodide.FS.symlink(entry.launcherPath, linkPath);
            wasmCommandLinks.add(linkPath);
          } catch (err) {
            console.warn("[WASM] Failed to create command link:", linkPath, err);
          }
        }
        return registry;
      }

      function createWasmRuntimeModuleFactory(source, entry) {
        const ttyHook = `
if (Module["__edgetermStdinChar"] && Module["__edgetermStdoutChar"] && Module["__edgetermStderrChar"]) {
  const __edgetermPreRun = () => {
    try {
      if (typeof FS !== "undefined" && typeof FS.init === "function") {
        FS.init(Module["__edgetermStdinChar"], Module["__edgetermStdoutChar"], Module["__edgetermStderrChar"]);
      }
    } catch {}
  };
  if (typeof Module["preRun"] === "function") {
    Module["preRun"] = [Module["preRun"]];
  } else if (!Array.isArray(Module["preRun"])) {
    Module["preRun"] = [];
  }
  Module["preRun"].push(__edgetermPreRun);
}
`;
        const stdinPatchedSource = String(source)
          .replace(/^#!.*(?:\r?\n|$)/, "")
          .replace(
            /var FS_stdin_getChar=\(\)=>\{[\s\S]*?\};var TTY=/,
            `var FS_stdin_getChar=()=>{if(!FS_stdin_getChar_buffer.length){var result=null;if(globalThis.__edgetermWasmPrompt){try{var tty=typeof TTY!="undefined"&&TTY.ttys&&TTY.ttys[1];if(tty&&tty.output&&tty.output.length){out(UTF8ArrayToString(tty.output));tty.output=[]}}catch{}result=globalThis.__edgetermWasmPrompt()}else if(ENVIRONMENT_IS_NODE){var BUFSIZE=256;var buf=Buffer.alloc(BUFSIZE);var bytesRead=0;var fd=process.stdin.fd;try{bytesRead=fs.readSync(fd,buf,0,BUFSIZE)}catch(e){if(e.toString().includes("EOF"))bytesRead=0;else throw e}if(bytesRead>0){result=buf.slice(0,bytesRead).toString("utf-8")}}else{}if(!result){return null}FS_stdin_getChar_buffer=intArrayFromString(result,true)}return FS_stdin_getChar_buffer.shift()};var TTY=`
          )
          .replace(/var Module\s*=\s*typeof Module\s*!=\s*['"]undefined['"]\s*\?\s*Module\s*:\s*\{\s*\}\s*;/, (m) => `${m}${ttyHook}`)
          .replace(/var Module=typeof Module!=['"]undefined['"]\?Module:\{\};/, (m) => `${m}${ttyHook}`)
          .replace(
            /else if\(globalThis\.window\?\.prompt\)\{result=window\.prompt\("Input: "\);if\(result!==null\)\{result\+="\\n"\}\}else\{\}/g,
            'else if(globalThis.__edgetermWasmPrompt){result=globalThis.__edgetermWasmPrompt()}else{}'
          )
          .replace(
            /else if\(globalThis\.window\?\.prompt\)\{result=window\.prompt\("Input:"\);if\(result!==null\)\{result\+="\\n"\}\}else\{\}/g,
            'else if(globalThis.__edgetermWasmPrompt){result=globalThis.__edgetermWasmPrompt()}else{}'
          )
          .replace(
            /globalThis\.window\?\.prompt\)\{result=window\.prompt\("Input: "\);if\(result!==null\)\{result\+="\\n"\}\}/g,
            'globalThis.__edgetermWasmPrompt){result=globalThis.__edgetermWasmPrompt()}'
          )
          .replace(
            /globalThis\.window\?\.prompt\)\{result=window\.prompt\("Input:"\);if\(result!==null\)\{result\+="\\n"\}\}/g,
            'globalThis.__edgetermWasmPrompt){result=globalThis.__edgetermWasmPrompt()}'
          );
        const normalizedSource = stdinPatchedSource;
        if (/var wasmExports;/.test(normalizedSource) && /createWasm\s*\(\s*\)\s*;/.test(normalizedSource) && /run\s*\(\s*\)\s*;/.test(normalizedSource)) {
          const patchedSource = normalizedSource
            .replace(/var Module\s*=\s*typeof Module\s*!=\s*['"]undefined['"]\s*\?\s*Module\s*:\s*\{\s*\}\s*;/, "var Module = moduleArg || {};")
            .replace(/var Module=typeof Module!=['"]undefined['"]\?Module:\{\};/, "var Module = moduleArg || {};")
            .replace(
              /var wasmExports;[\s\S]*$/,
              `var wasmExports;
Module["noExitRuntime"] = true;
Module["noInitialRun"] = true;
return (async () => {
  return await new Promise((resolve, reject) => {
    const originalAbort = Module["onAbort"];
    Module["onAbort"] = (what) => {
      try {
        if (typeof originalAbort === "function") originalAbort(what);
      } catch {}
      reject(new Error(String(what || "aborted")));
    };
    Module["onRuntimeInitialized"] = () => {
      Module["FS"] = FS;
      Module["callMain"] = callMain;
      Module["run"] = run;
      resolve(Module);
    };
    try {
      createWasm();
      run();
    } catch (err) {
      reject(err);
    }
  });
})();`
            );

          return async (moduleArg = {}) => {
            const nonModularRunner = new Function("moduleArg", "globalThis", patchedSource);
            return await nonModularRunner(moduleArg, globalThis);
          };
        }

        const module = { exports: {} };
        const exports = module.exports;
        const runner = new Function(
          "module",
          "exports",
          "globalThis",
          `${normalizedSource}\n; return module.exports || exports.default || exports || globalThis.Module || globalThis.createModule || null;`
        );
        const result = runner(module, exports, globalThis);
        if (typeof result === "function") return result;
        if (result && typeof result.default === "function") return result.default;
        if (result && entry.factoryExport && typeof result[entry.factoryExport] === "function") return result[entry.factoryExport];
        if (result && typeof result.createModule === "function") return result.createModule;
        if (typeof globalThis.createModule === "function") return globalThis.createModule;
        if (typeof globalThis.Module === "function") return globalThis.Module;
        return null;
      }

      function wasmRuntimeFriendlyError(err, entry) {
        let text = `${err?.message || err || "Unknown error"}`;
        if (text === "[object Object]") {
          try {
            text = JSON.stringify(err);
          } catch {}
        }
        if (/socket|network/i.test(text)) return `${entry.command}: this package needs raw networking, which EdgeTerm does not provide in the browser`;
        if (/fork|spawn|exec/i.test(text)) return `${entry.command}: this package needs process control that EdgeTerm cannot emulate`;
        if (/shared library|dynamic library|dylib|dlopen/i.test(text)) return `${entry.command}: this package needs native dynamic libraries, which are not supported here`;
        return `${entry.command}: ${text}`;
      }

      function isPotentialPathArg(arg, cwd) {
        if (!arg || arg.startsWith("-")) return false;
        if (arg === "." || arg === "..") return true;
        if (arg.startsWith("/") || arg.startsWith("./") || arg.startsWith("../")) return true;
        return pyodide.FS.analyzePath(`${cwd}/${arg}`).exists;
      }

      function collectWasmSyncRoots(cwd, args) {
        const roots = new Set(["/home", "/tmp", "/var", "/etc", "/packages"]);
        roots.add(cwd || "/");
        for (const arg of args) {
          if (!isPotentialPathArg(arg, cwd || "/")) continue;
          roots.add(arg.startsWith("/") ? arg : `${cwd}/${arg}`);
        }
        return Array.from(roots).sort();
      }

      function ensureModuleParentDirs(moduleFs, path) {
        const parts = path.split("/").filter(Boolean);
        let current = "";
        for (let i = 0; i < parts.length - 1; i += 1) {
          current += `/${parts[i]}`;
          try {
            moduleFs.mkdir(current);
          } catch {}
        }
      }

      function copyEdgePathToModule(moduleFs, sourcePath, targetPath = sourcePath) {
        const fs = pyodide.FS;
        if (!fs.analyzePath(sourcePath).exists) return;
        const stat = fs.stat(sourcePath);
        if (fs.isDir(stat.mode)) {
          try {
            moduleFs.mkdir(targetPath);
          } catch {}
          for (const entry of fs.readdir(sourcePath)) {
            if (entry === "." || entry === "..") continue;
            copyEdgePathToModule(moduleFs, `${sourcePath}/${entry}`, `${targetPath}/${entry}`);
          }
          return;
        }
        ensureModuleParentDirs(moduleFs, targetPath);
        moduleFs.writeFile(targetPath, fs.readFile(sourcePath));
      }

      function copyModulePathToEdge(moduleFs, sourcePath, targetPath = sourcePath) {
        let stat;
        try {
          stat = moduleFs.stat(sourcePath);
        } catch {
          return;
        }
        if (moduleFs.isDir(stat.mode)) {
          ensureDir(targetPath);
          for (const entry of moduleFs.readdir(sourcePath)) {
            if (entry === "." || entry === "..") continue;
            copyModulePathToEdge(moduleFs, `${sourcePath}/${entry}`, `${targetPath}/${entry}`);
          }
          return;
        }
        ensureDir(targetPath.split("/").slice(0, -1).join("/") || "/");
        pyodide.FS.writeFile(targetPath, moduleFs.readFile(sourcePath));
      }

      function serializeEdgeFsTree(sourcePath, targetPath = sourcePath, out = []) {
        const fs = pyodide.FS;
        try {
          if (!fs.analyzePath(sourcePath).exists) return out;
          const stat = fs.stat(sourcePath);
          if (fs.isDir(stat.mode)) {
            out.push({ path: targetPath, dir: true });
            for (const entry of fs.readdir(sourcePath)) {
              if (entry === "." || entry === "..") continue;
              serializeEdgeFsTree(`${sourcePath}/${entry}`, `${targetPath}/${entry}`, out);
            }
            return out;
          }
          out.push({ path: targetPath, dir: false, data: fs.readFile(sourcePath) });
        } catch (err) {
          const message = err?.message || err?.name || String(err);
          throw new Error(`failed to copy ${sourcePath} into WASM worker filesystem: ${message}`);
        }
        return out;
      }

      function applyWorkerFsEntries(entries = []) {
        for (const entry of entries) {
          if (entry.dir) {
            ensureDir(entry.path);
            continue;
          }
          ensureDir(entry.path.split("/").slice(0, -1).join("/") || "/");
          pyodide.FS.writeFile(entry.path, entry.data);
        }
      }

      async function runWasmCommandInWorker(entry, args, stdinText, cwd, env) {
        const workerUrl = new URL(assetUrl("wasm-cli-worker.js"));
        workerUrl.searchParams.set("v", DEFAULT_ROOTFS_VERSION);
        const worker = new Worker(workerUrl);
        const syncRoots = collectWasmSyncRoots(cwd, args);
        const fsEntries = [];
        for (const root of syncRoots) serializeEdgeFsTree(root, root, fsEntries);
        const useSharedStdin = false;
        const ttySessionId = `tty-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const ttyBrokerUrl = location.origin;
        const stdinControlBuffer = useSharedStdin ? new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2) : null;
        const stdinDataBuffer = useSharedStdin ? new SharedArrayBuffer(65536) : null;
        const stdinControl = useSharedStdin ? new Int32Array(stdinControlBuffer) : null;

        return await new Promise((resolve) => {
          let interactiveSession = false;
          let stdinReadActive = false;
          let settled = false;
          const watchdog = setTimeout(() => {
            finish({
              found: true,
              code: 1,
              stdout: "",
              stderr: `${entry.command}: WASM runtime did not request stdin or exit in time. This package may need Asyncify or a different Emscripten build for interactive browser use.\n`,
            });
          }, stdinText ? 15000 : 5000);

          const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(watchdog);
            worker.terminate();
            if (!useSharedStdin) {
              fetch(`${ttyBrokerUrl}/__edgeterm_tty?id=${encodeURIComponent(ttySessionId)}`, { method: "DELETE" }).catch(() => {});
            }
            resolve(result);
          };

          const sendStdinWakeup = (input) => {
            if (new URLSearchParams(location.search).has("debug")) {
              console.log("[WASM stdin_write]", entry.command, JSON.stringify(input ?? ""));
            }
            if (!useSharedStdin) {
              fetch(`${ttyBrokerUrl}/__edgeterm_tty_write?id=${encodeURIComponent(ttySessionId)}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ line: input ?? "" }),
              }).catch((err) => console.error("[WASM] TTY broker write failed:", err));
              return;
            }
            const encoded = new TextEncoder().encode(input ?? "");
            const bytes = new Uint8Array(stdinDataBuffer);
            bytes.fill(0);
            bytes.set(encoded.slice(0, bytes.length));
            Atomics.store(stdinControl, 1, Math.min(encoded.length, bytes.length));
            Atomics.store(stdinControl, 0, 1);
            Atomics.notify(stdinControl, 0, 1);
          };

          worker.onmessage = (event) => {
            const data = event.data || {};
            if (data.type === "stdin_request") {
              clearTimeout(watchdog);
              interactiveSession = true;
              if (new URLSearchParams(location.search).has("debug")) {
                console.log("[WASM stdin_request]", entry.command, JSON.stringify(data.display || ""));
              }
              if (stdinReadActive) return;
              stdinReadActive = true;
              (async () => {
                const display = String(data.display || "");
                const normalizedDisplay = display.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
                let outputText = "";
                let promptText = "> ";
                const lastNewline = normalizedDisplay.lastIndexOf("\n");
                if (lastNewline >= 0) {
                  outputText = normalizedDisplay.slice(0, lastNewline);
                  promptText = normalizedDisplay.slice(lastNewline + 1) || "> ";
                } else if (/^.*[>:$] $/.test(normalizedDisplay) && normalizedDisplay.length > 2) {
                  outputText = normalizedDisplay.slice(0, -2);
                  promptText = normalizedDisplay.slice(-2);
                } else if (normalizedDisplay) {
                  promptText = normalizedDisplay;
                }
                if (outputText) term.echo(outputText);
                try {
                  const input = await window.terminal.input(promptText);
                  sendStdinWakeup(input);
                } catch {
                  sendStdinWakeup("");
                } finally {
                  stdinReadActive = false;
                }
              })();
              return;
            }
            if (data.type === "debug") {
              console.log(`[WASM worker] ${data.message}`);
              return;
            }
            if (data.type === "done") {
              applyWorkerFsEntries(data.fsEntries || []);
              if (data.tailDisplay) term.echo(data.tailDisplay, { newline: false });
              let stdout = data.stdout || "";
              let stderr = data.stderr || "";
              if (interactiveSession) {
                stdout = "";
                stderr = "";
              }
              finish({ found: true, code: Number(data.code || 0), stdout, stderr });
              return;
            }
            if (data.type === "error") {
              if (data.tailDisplay) term.echo(data.tailDisplay, { newline: false });
              finish({ found: true, code: Number(data.code || 1), stdout: "", stderr: data.stderr || "" });
            }
          };

          worker.onerror = (event) => {
            finish({
              found: true, code: 1, stdout: "",
              stderr: `${entry.command}: worker failure: ${event.message || "unknown error"}\n`,
            });
          };

          worker.postMessage({
            type: "run",
            command: entry.command,
            args,
            stdinText: stdinText || "",
            cwd,
            env,
            launcherSource: pyodide.FS.readFile(entry.launcherPath, { encoding: "utf8" }),
            wasmBytes: pyodide.FS.readFile(entry.wasmPath),
            packageRoot: entry.packageRoot,
            thisProgram: entry.thisProgram,
            fsEntries,
            syncRoots,
            stdinControl: stdinControlBuffer,
            stdinData: stdinDataBuffer,
            ttyBrokerUrl: useSharedStdin ? "" : ttyBrokerUrl,
            ttySessionId: useSharedStdin ? "" : ttySessionId,
            debug: new URLSearchParams(location.search).has("debug"),
          });
        });
      }

      async function runWasmCommandEntry(entry, args, stdinText, cwd, env) {
        const effectiveArgs =
          entry.command === "sqlite3" && !stdinText && args.length === 0 ? ["-interactive"] : args;
        /* Use a worker for interactive stdin. It prefers SharedArrayBuffer when
         * available and falls back to the local serve-edgeterm.py TTY broker. */
        if (typeof Worker !== "undefined") {
          return await runWasmCommandInWorker(entry, effectiveArgs, stdinText, cwd, env);
        }
        if (!stdinText && args.length === 0 && ["lua", "sqlite3"].includes(entry.command)) {
          return {
            found: true,
            code: 1,
            stdout: "",
            stderr: `${entry.command}: interactive WASM stdin is unavailable in this browser context because crossOriginIsolated=false. Use serve-edgeterm.bat in a regular Chrome/Edge tab for interactive WASM CLIs, or pass a script/file/non-interactive arguments.\n`,
          };
        }
        const launcherSource = pyodide.FS.readFile(entry.launcherPath, { encoding: "utf8" });
        const wasmBytes = pyodide.FS.readFile(entry.wasmPath);
        const stdout = [];
        const stderr = [];
        const stdinBytes = new TextEncoder().encode(stdinText || "");
        let stdinIndex = 0;
        let interactiveStdinRequested = false;
        const stdinInput = () => {
          if (stdinIndex < stdinBytes.length) return stdinBytes[stdinIndex++];
          interactiveStdinRequested = true;
          return null;
        };
        const stdoutOutput = (code) => {
          if (code === null || code === undefined) return;
          stdout.push(String.fromCharCode(code));
        };
        const stderrOutput = (code) => {
          if (code === null || code === undefined) return;
          stderr.push(String.fromCharCode(code));
        };

        try {
          globalThis.__edgetermWasmPrompt = () => {
            interactiveStdinRequested = true;
            return null;
          };
          const factory = createWasmRuntimeModuleFactory(launcherSource, entry);
          if (!factory) throw new Error("package launcher did not expose an Emscripten module factory");
          const moduleInstance = await factory({
            noInitialRun: true,
            arguments: [...effectiveArgs],
            thisProgram: entry.thisProgram,
            ENV: { ...env, PWD: cwd },
            wasmBinary: wasmBytes,
            locateFile: (path) => `${entry.packageRoot}/${path}`,
            __edgetermStdinChar: stdinInput,
            __edgetermStdoutChar: stdoutOutput,
            __edgetermStderrChar: stderrOutput,
            print: (text) => stdout.push(String(text)),
            printErr: (text) => stderr.push(String(text)),
          });
          if (!moduleInstance?.FS) throw new Error("package runtime did not expose FS after initialization");
          try {
            for (const root of collectWasmSyncRoots(cwd, args)) copyEdgePathToModule(moduleInstance.FS, root);
          } catch (err) {
            throw new Error(`filesystem sync-in failed: ${wasmRuntimeFriendlyError(err, entry)}`);
          }
          try {
            ensureModuleParentDirs(moduleInstance.FS, cwd.endsWith("/") ? `${cwd}._` : `${cwd}/._`);
            try {
              moduleInstance.FS.chdir(cwd);
            } catch {
              moduleInstance.FS.chdir("/");
            }
          } catch (err) {
            throw new Error(`cwd setup failed: ${wasmRuntimeFriendlyError(err, entry)}`);
          }

          let code = 0;
          try {
            if (typeof moduleInstance.callMain === "function") moduleInstance.callMain([...effectiveArgs]);
            else if (typeof moduleInstance.main === "function") code = Number(moduleInstance.main([...effectiveArgs]) || 0);
            else throw new Error("package did not expose callMain() or main()");
          } catch (err) {
            if (err === "unwind") {
              code = 0;
            } else if (
              err?.name === "ExitStatus" ||
              err?.constructor?.name === "ExitStatus" ||
              typeof err?.status === "number" ||
              typeof err?.code === "number"
            ) {
              code = Number(err.status ?? err.code ?? 0);
            } else {
              throw err;
            }
          }

          try {
            for (const root of collectWasmSyncRoots(cwd, args)) copyModulePathToEdge(moduleInstance.FS, root);
          } catch (err) {
            throw new Error(`filesystem sync-out failed: ${wasmRuntimeFriendlyError(err, entry)}`);
          }
          if (interactiveStdinRequested && stdinBytes.length === 0) {
            stderr.push(
              `${entry.command}: interactive terminal input for generic WASM CLIs is not available in the current browser runtime. EdgeTerm blocked the browser prompt fallback, but a worker-based stdin bridge is still needed here.\n`
            );
            if (code === 0) code = 1;
          }
          return { found: true, code, stdout: stdout.join(""), stderr: stderr.join("") };
        } catch (err) {
          return {
            found: true,
            code: 1,
            stdout: stdout.join(""),
            stderr: `${stderr.join("")}${stderr.length ? "\n" : ""}${wasmRuntimeFriendlyError(err, entry)}\n`,
          };
        } finally {
          try {
            delete globalThis.__edgetermWasmPrompt;
          } catch {}
        }
      }

      function configureWasmRuntime() {
        const describeBridgeError = (err) => {
          if (!err) return "unknown error";
          if (typeof err === "string") return err;
          const parts = [];
          if (err.name) parts.push(String(err.name));
          if (err.message) parts.push(String(err.message));
          if (err.stack) parts.push(String(err.stack));
          if (parts.length) return parts.join(": ");
          try {
            const json = JSON.stringify(err);
            if (json && json !== "{}") return json;
          } catch {}
          return Object.prototype.toString.call(err);
        };

        window.EdgeTermWasmCLI = {
          which(command) {
            const registry = refreshWasmCommandLinks();
            return registry.has(command) ? `/bin/${command}` : null;
          },
          commandForPath(path) {
            const normalized = normalizePath(path);
            const registry = refreshWasmCommandLinks();
            if (normalized.startsWith("/bin/")) {
              const name = normalized.split("/").filter(Boolean).pop();
              return registry.has(name) ? name : null;
            }
            for (const [command, entry] of registry.entries()) {
              if (entry.launcherPath === normalized) return command;
            }
            return null;
          },
          isPackageCommandPath(path) {
            const normalized = normalizePath(path);
            return normalized.startsWith("/packages/") || normalized.startsWith("/bin/");
          },
          async runCommandJSON(command, argsJson, stdinText, cwd, envJson) {
            try {
              const registry = refreshWasmCommandLinks();
              const entry = registry.get(command);
              if (!entry) return JSON.stringify({ found: false, code: 127, stdout: "", stderr: "" });
              if (!pyodide.FS.analyzePath(entry.launcherPath).exists) {
                return JSON.stringify({ found: true, code: 1, stdout: "", stderr: `${command}: launcher file is missing from package ${entry.packageName}\n` });
              }
              if (!pyodide.FS.analyzePath(entry.wasmPath).exists) {
                return JSON.stringify({ found: true, code: 1, stdout: "", stderr: `${command}: wasm binary is missing from package ${entry.packageName}\n` });
              }
              const parsedArgs = JSON.parse(argsJson || "[]");
              const parsedEnv = JSON.parse(envJson || "{}");
              const result = await runWasmCommandEntry(
                entry,
                parsedArgs,
                stdinText || "",
                cwd || "/",
                parsedEnv
              );
              return JSON.stringify(result);
            } catch (err) {
              const message = describeBridgeError(err);
              console.error("[WASM] command bridge failure:", message, err);
              return JSON.stringify({
                found: true,
                code: 1,
                stdout: "",
                stderr: `${command}: EdgeTerm WASM bridge failed: ${message}\n`,
              });
            }
          },
          runCommandText(command, argsJson, stdinText, cwd, envJson) {
            return Promise.resolve()
              .then(() => window.EdgeTermWasmCLI.runCommandJSON(command, argsJson, stdinText, cwd, envJson))
              .catch((err) => {
                const message = describeBridgeError(err);
                console.error("[WASM] command text bridge failure:", message, err);
                return JSON.stringify({
                  found: true,
                  code: 1,
                  stdout: "",
                  stderr: `${command}: EdgeTerm WASM bridge failed: ${message}\n`,
                });
              });
          },
        };
      }

      async function uploadFiles(files) {
        const touchedTargets = [];
        const fileBytesByTarget = new Map();
        for (const file of files) {
          const data = new Uint8Array(await file.arrayBuffer());
          const target = `${currentPath === "/" ? "" : currentPath}/${file.name}`;
          pyodide.FS.writeFile(target, data);
          const mirrorTarget = workspaceMirrorPathForRuntimePath(target);
          if (mirrorTarget) {
            syncRuntimePathToWorkspace(target);
            touchedTargets.push(mirrorTarget);
            fileBytesByTarget.set(mirrorTarget, data);
          }
        }
        if (touchedTargets.length) await persistWorkspaceMirrorTargets(touchedTargets, activeWorkspaceId, fileBytesByTarget);
        else schedulePersistActiveWorkspace(750);
        refreshWasmCommandLinks();
        refreshFiles();
      }

      async function renameSelectedPath(path) {
        const currentName = path.split("/").filter(Boolean).pop();
        const nextName = await askText("Rename Item", "New name", currentName, { confirmLabel: "Rename" });
        if (!nextName) return;
        const target = `${path.split("/").slice(0, -1).join("/")}/${nextName}`;
        pyodide.FS.rename(path, target);
        await persistActiveWorkspace();
        refreshWasmCommandLinks();
        refreshFiles();
        showNotice(`Renamed to ${nextName}`);
      }

      async function deleteSelectedPaths(paths) {
        if (paths.length === 0) return;
        const label = paths.length === 1 ? paths[0] : `${paths.length} items`;
        if (!(await askConfirm("Delete Files", `Delete ${label}?`, { confirmLabel: "Delete", danger: true }))) return;
        for (const path of paths) removeTree(path);
        await persistActiveWorkspace();
        refreshWasmCommandLinks();
        clearSelection();
        refreshFiles();
        showNotice(paths.length === 1 ? `Deleted ${label}` : `Deleted ${paths.length} items`);
      }

      async function pasteClipboardItems() {
        if (!clipboard?.paths?.length) return;
        for (const source of clipboard.paths) {
          const name = source.split("/").filter(Boolean).pop();
          const target = `${currentPath === "/" ? "" : currentPath}/${name}`;
          if (clipboard.mode === "cut") pyodide.FS.rename(source, target);
          else {
            removeTree(target);
            copyTree(source, target);
          }
        }
        if (clipboard.mode === "cut") clipboard = null;
        await persistActiveWorkspace();
        refreshWasmCommandLinks();
        refreshFiles();
        showNotice("Paste completed");
      }

      async function handleContextAction(action) {
        const paths = contextTargetPath && !selectedPaths.has(contextTargetPath) ? [contextTargetPath] : getSelectedPaths();
        hideContextMenu();
        if (paths.length === 0) return;

        if (action === "open") {
          if (paths.length > 1) return showNotice("Open works on one item at a time");
          const stat = pyodide.FS.stat(paths[0]);
          if (pyodide.FS.isDir(stat.mode)) refreshFiles(paths[0]);
          else if (isPreviewablePath(paths[0])) await openPreview(paths[0]);
          else await openEditor(paths[0]);
          return;
        }
        if (action === "preview") {
          if (paths.length > 1) return showNotice("Preview works on one item at a time");
          return openPreview(paths[0]);
        }
        if (action === "download") return downloadSelectedPaths(paths);
        if (action === "copy") {
          clipboard = { mode: "copy", paths: [...paths] };
          return showNotice(`Copied ${paths.length === 1 ? "item" : `${paths.length} items`}`);
        }
        if (action === "cut") {
          clipboard = { mode: "cut", paths: [...paths] };
          return showNotice(`Cut ${paths.length === 1 ? "item" : `${paths.length} items`}`);
        }
        if (action === "rename") {
          if (paths.length > 1) return showNotice("Rename works on one item at a time");
          return renameSelectedPath(paths[0]);
        }
        if (action === "delete") return deleteSelectedPaths(paths);
      }

      async function openEditor(path) {
        return await openEditorInTarget(path, { target: "main" });
      }

      async function saveEditor() {
        const path = normalizePath($id("editorPath").value);
        const content = editor.getValue();
        await writeRuntimeFileAndMirror(path, content);
        refreshFilesIfVisible(currentPath);
        monaco.editor.setModelLanguage(editor.getModel(), editorLanguageForPath(path));
        setEditorStatus(`Saved ${path}`);
        showNotice(`Saved ${path}`);
      }

      function waitForEditorInputFrame() {
        return new Promise((resolve) => requestAnimationFrame(() => resolve()));
      }

      async function saveEditorFromShortcut(targetName = "main") {
        if (editorSaveShortcutInFlight) await editorSaveShortcutInFlight;
        const saveTask = (async () => {
          await waitForEditorInputFrame();
          if (targetName === "split" && editorSplitEnabled) await saveSplitEditor();
          else await saveEditor();
        })();
        editorSaveShortcutInFlight = saveTask;
        try {
          await saveTask;
        } finally {
          if (editorSaveShortcutInFlight === saveTask) editorSaveShortcutInFlight = null;
        }
      }

      function focusedEditorTargetName() {
        if (editorSplitEnabled && splitEditor?.hasTextFocus?.()) return "split";
        return "main";
      }

      async function openEditorInTarget(path, options = {}) {
        const targetName = options.target === "split" ? "split" : "main";
        const instance = editorInstanceForTarget(targetName);
        if (!instance) return;
        const loaded = loadEditorFile(path);
        if (loaded.created) {
          if (syncRuntimePathToWorkspace(loaded.path)) {
            const target = workspaceMirrorPathForRuntimePath(loaded.path);
            if (target) await persistWorkspaceMirrorTargets([target], activeWorkspaceId, new Map([[target, new Uint8Array(0)]]));
          } else {
            schedulePersistActiveWorkspace();
          }
          showNotice(`Created ${loaded.path}`);
        }
        editorPathFieldForTarget(targetName).value = loaded.path;
        if (targetName === "split") splitEditorPath = loaded.path;
        replaceEditorModel(targetName, createEditorModel(loaded.path, loaded.content));
        if (targetName === "main") {
          setEditorStatus(`Opened ${loaded.path}`);
        } else {
          setSplitEditorStatus(`Opened ${loaded.path}`);
        }
        if (options.switchView !== false) setView("editorView");
        instance.focus();
        instance.layout();
        if (!options.quiet) showNotice(`Opened ${loaded.path}`);
        return loaded.path;
      }

      window.EdgeTermEditor = {
        async open(path = "") {
          const target = path ? String(path) : currentEditorPath("main");
          return await openEditorInTarget(target, { target: "main" });
        },
      };

        window.EdgeTermServe = {
          instances: new Map(),
          async start(mode, target, workingDirectory = "") {
            const cwd = normalizePath(workingDirectory || `/home/${activeUser()}`);
            const normalizedMode = String(mode || "flask").trim().toLowerCase();
            const spec = String(target || "").trim();
            if (!spec) throw new Error("Missing app target. Use module:object or a static directory.");
            const identity = stableEdgeServeIdentity(normalizedMode, spec, cwd);
            const instanceJson = await this.createInstance(normalizedMode, spec, cwd, identity);
            const instance = JSON.parse(instanceJson);
            this.instances.set(instance.id, instance);
            const serveConfig = {
              enabled: true,
              runtime: "python",
              entrypoint: "",
              workingDirectory: cwd,
              staticRoot: cwd,
              fullscreen: false,
              autoStart: false,
              preserveStateOnExit: false,
              showLoadingOverlay: false,
              python: {
                framework: "edgeserve",
                appSpec: spec,
                instanceId: instance.id,
                routePrefix: instance.routePrefix,
                serveMode: instance.mode || normalizeEdgeServeRouteMode(normalizedMode),
              },
              ui: {
                hideWorkspaceChrome: false,
                allowDebugTerminal: true,
              },
            };
            appModeState.config = normalizeAppModeConfig(serveConfig);
            appModeState.renderTarget = "display";
            createOrActivateDisplayBrowserTab(instance, `${instance.routePrefix}/`);
            syncDisplayBrowserButtons();
          try {
            await enterAppMode(
                serveConfig,
                { initialUrl: `${instance.routePrefix}/`, forceReload: false, throwOnError: true }
              );
            } catch (err) {
              appModeState.renderTarget = "shell";
              throw err;
            }
            return instance;
          },
          async createInstance(mode, target, cwd, identity = {}) {
            pyodide.globals.set("__edgeterm_edgeserve_json", JSON.stringify({ mode, target, cwd, ...identity }));
            return await pyodide.runPythonAsync(`
import json
import os
import sys

payload = json.loads(__edgeterm_edgeserve_json)
rootfs_lib = os.environ.get("EDGETERM_ROOTFS_LIB", "")
if rootfs_lib and os.path.isdir(rootfs_lib) and rootfs_lib not in sys.path:
    sys.path.insert(0, rootfs_lib)
if os.path.isdir("/usr/lib") and "/usr/lib" not in sys.path:
    sys.path.insert(0, "/usr/lib")

import edgeterm_wsgi

info = edgeterm_wsgi.create_instance(
    payload.get("mode") or "flask",
    payload.get("target") or "",
    payload.get("cwd") or os.getcwd(),
    instance_id=payload.get("instanceId") or "",
    route_prefix=payload.get("routePrefix") or "",
)
json.dumps(info)
`);
          },
        };
        window.EdgeTermWSGI = {
          async start(appSpec, workingDirectory = "") {
            return await window.EdgeTermServe.start("flask", appSpec, workingDirectory);
          },
        };

      async function saveSplitEditor() {
        const path = currentEditorPath("split");
        const content = splitEditor.getValue();
        await writeRuntimeFileAndMirror(path, content);
        refreshFilesIfVisible(currentPath);
        monaco.editor.setModelLanguage(splitEditor.getModel(), editorLanguageForPath(path));
        splitEditorPath = path;
        setSplitEditorStatus(`Saved ${path}`);
        showNotice(`Saved ${path}`);
      }

      async function openSplitEditorPrompt() {
        const target = await askText("Open Split Editor", "Path", currentEditorPath("split"), { confirmLabel: "Open" });
        if (!target) return;
        editorSplitEnabled = true;
        $id("editorMain").classList.add("split");
        $id("editorSplitPane").classList.remove("hidden");
        await openEditorInTarget(target, { target: "split" });
      }

      async function promoteSplitEditorToPrimary() {
        const path = currentEditorPath("split");
        await openEditorInTarget(path, { target: "main", quiet: true });
        setEditorStatus(`Main editor switched to ${path}`);
        showNotice(`Main editor switched to ${path}`);
      }

      async function runCommand(command, options = {}) {
        const line = command ?? "";
        if (!line.trim()) return;
        if (line.trim() === "exit") {
          term.echo("Goodbye.");
          return;
        }

        try {
          pyodide.globals.set("__edgeterm_line", line);
          await pyodide.runPythonAsync(`
import builtins

shell = getattr(builtins, "EDGETERM_SHELL", None)
if shell is None:
    raise RuntimeError("EdgeTerm shell is not initialized. Restart the runtime or reload the workspace.")

try:
    await shell.run_line(__edgeterm_line)
except Exception as exc:
    if exc.__class__.__name__ == "ShellExit" and hasattr(exc, "code"):
        shell._set_status(exc.code)
    else:
        raise
`);
        } catch (err) {
          term.error("[ERROR] " + (err.message || err));
        }

        try {
          const mayMutateWorkspace = commandMayMutateWorkspace(line);
          if (mayMutateWorkspace && options.postRunSync !== false) schedulePersistActiveWorkspace(750);
          if (commandNeedsImmediateWorkspacePersist(line)) {
            await persistActiveWorkspace();
          }
          if (mayMutateWorkspace) refreshFilesIfVisible(currentPath);
        } catch (err) {
          term.error("[SYNC] " + formatError(err));
        }

        await updatePrompt();
      }

      function commandNeedsImmediateWorkspacePersist(line) {
        const source = String(line || "").trim();
        if (!source) return false;
        if (/^(pip|pip3)\s+(install|uninstall)\b/i.test(source)) return true;
        if (/^(python|python3)\s+-m\s+pip\s+(install|uninstall)\b/i.test(source)) return true;
        if (/^(python|python3)\s+-m\s+django\s+startproject\b/i.test(source)) return true;
        if (/^(django-admin|django-admin\.py)\s+startproject\b/i.test(source)) return true;
        if (/^(python|python3)\s+\S*manage\.py\b/i.test(source)) return true;
        return false;
      }

      function commandMayMutateWorkspace(line) {
        const source = String(line || "").trim();
        if (!source) return false;
        if (/^(pwd|ls|cat|head|tail|wc|grep|which|history|env|echo|clear|help|df|uname|whoami|edgeserve|edgeflask|edgeasgi)\b/i.test(source)) return false;
        if (/^(cd|alias|unalias|true|false|exit)\b/i.test(source)) return false;
        return true;
      }

      function normalizePackageName(name) {
        return String(name || "").trim().toLowerCase().replace(/[-_.]+/g, "-");
      }

      function pyodidePackageCandidates(name) {
        const normalized = normalizePackageName(name);
        const aliases = {
          pygame: ["pygame-ce", "pygame"],
          "pygame-ce": ["pygame-ce", "pygame"],
        };
        return [...new Set([name, normalized, normalized.replaceAll("-", "_"), ...(aliases[normalized] || [])].filter(Boolean))];
      }

      function detectDistributionName(metadataText) {
        const match = String(metadataText || "").match(/^Name:\s*(.+)$/im);
        return match ? match[1].trim() : "";
      }

      function scanNativeUserPackages() {
        const fs = pyodide.FS;
        const userSite = `/home/${activeUser()}/.local/lib/python3.12/site-packages`;
        if (!fs.analyzePath(userSite).exists) return [];
        const packages = new Map();
        const nativeHints = new Set();
        const stack = [userSite];

        while (stack.length) {
          const dir = stack.pop();
          let entries = [];
          try {
            entries = fs.readdir(dir);
          } catch {
            continue;
          }
          for (const entry of entries) {
            if (entry === "." || entry === "..") continue;
            const path = `${dir}/${entry}`;
            let stat;
            try {
              stat = fs.stat(path);
            } catch {
              continue;
            }
            if (fs.isDir(stat.mode)) {
              if (entry.endsWith(".dist-info")) {
                const metadataPath = `${path}/METADATA`;
                if (fs.analyzePath(metadataPath).exists) {
                  try {
                    const name = detectDistributionName(fs.readFile(metadataPath, { encoding: "utf8" }));
                    if (name) packages.set(normalizePackageName(name), name);
                  } catch {
                    // Keep scanning; broken metadata should not block runtime boot.
                  }
                }
              }
              stack.push(path);
              continue;
            }
            if (/\.(so|wasm|data|js)$/i.test(entry)) {
              nativeHints.add(path);
              if (/pygame/i.test(path)) packages.set("pygame-ce", "pygame-ce");
            }
          }
        }

        if (!nativeHints.size) return [];
        return [...packages.values()];
      }

      async function rehydrateBrowserRuntimePackages() {
        const attempted = [];
        const loaded = [];
        const failed = [];
        const packages = scanNativeUserPackages();
        for (const name of packages) {
          attempted.push(name);
          let restored = false;
          let lastError = null;
          for (const candidate of pyodidePackageCandidates(name)) {
            try {
              await pyodide.loadPackage(candidate);
              restored = true;
              break;
            } catch (err) {
              lastError = err;
            }
          }
          if (restored) loaded.push(name);
          else failed.push({ name, error: lastError?.message || String(lastError || "Unable to load package") });
        }
        return { attempted, loaded, failed };
      }

      async function getShellPromptPath() {
        try {
          return await pyodide.runPythonAsync(`
import builtins, os
shell = getattr(builtins, "EDGETERM_SHELL", None)
shell.env.get("PWD", getattr(shell, "logical_cwd", os.getcwd())) if shell else os.environ.get("PWD", os.getcwd())
`);
        } catch {
          return await pyodide.runPythonAsync("os.environ.get('PWD', os.getcwd())");
        }
      }

      async function updatePrompt() {
        const cwd = await getShellPromptPath();
        term.set_prompt(`${cwd} $ `);
      }

      async function bootShell() {
        const readTerminalInput = async (prompt = "") => {
          return await new Promise((resolve) => {
            term.read(prompt ?? "", (value) => resolve(value ?? ""));
            term.resume();
            term.focus();
          });
        };

        window.term = term;
        window.terminal = { input: readTerminalInput };
        pyodide.globals.set("input", pyodide.toPy(readTerminalInput));
        pyodide.globals.set("__edgeterm_user", activeUser());
        pyodide.globals.set("__edgeterm_rootfs_lib", workspacePath(activeWorkspaceId, "/rootfs/usr/lib"));
        await pyodide.runPythonAsync(`
import os
os.environ["EDGE_USER"] = __edgeterm_user
os.environ["EDGETERM_ROOTFS_LIB"] = __edgeterm_rootfs_lib
`);

        const rehydrateRuntimePackages = async () => {
          const browserReport = await rehydrateBrowserRuntimePackages();
          const reportJson = await pyodide.runPythonAsync(`
import json
import os
import sys

rootfs_lib = os.environ.get("EDGETERM_ROOTFS_LIB", "")
if rootfs_lib and os.path.isdir(rootfs_lib) and rootfs_lib not in sys.path:
    sys.path.insert(0, rootfs_lib)
if os.path.isdir("/usr/lib") and "/usr/lib" not in sys.path:
    sys.path.insert(0, "/usr/lib")

from edgeterm_pip import rehydrate_runtime_installs
json.dumps(await rehydrate_runtime_installs())
`);
          const pythonReport = JSON.parse(reportJson || "{}");
          return {
            attempted: [...(browserReport.attempted || []), ...(pythonReport.attempted || [])],
            loaded: [...new Set([...(browserReport.loaded || []), ...(pythonReport.loaded || [])])],
            failed: [...(browserReport.failed || []), ...(pythonReport.failed || [])],
          };
        };
        pyodide.setStdout({ batched: (s) => term.echo(s.replaceAll("]]", "&rsqb;&rsqb;").replaceAll("[[", "&lsqb;&lsqb;")) });
        pyodide.setStderr({ batched: (s) => term.error(s.trimEnd()) });
        await pyodide.runPythonAsync(`
import os
import sys

os.environ["TERM"] = "xterm-256color"
os.environ["COLORTERM"] = "truecolor"
os.environ["FORCE_COLOR"] = "1"
os.environ["PY_COLORS"] = "1"
os.environ["CLICOLOR"] = "1"
os.environ["CLICOLOR_FORCE"] = "1"

try:
    sys.stdout.isatty = lambda: True
    sys.stderr.isatty = lambda: True
except Exception:
    pass
`);

        term.clear();
        setDisplayFullscreen(false);
        clearDisplaySurface(`Display ready for ${activeWorkspace().name}`);
        term.echo("Project EdgeTerm Workspace, Powered by EdwardLab (https://github.com/EdwardLab, https://edwarddev.com) GPLv3.0 License");
        term.echo(`[WORKSPACE] ${activeWorkspace().name} (${activeUser()})`);
        try {
          if (edgeTermShell?.destroy) edgeTermShell.destroy();
          edgeTermShell = null;
          const code = pyodide.FS.readFile("/bin/shell.py", { encoding: "utf8" });
          edgeTermShell = await pyodide.runPythonAsync(`
${code}
import builtins
import os
import sys

rootfs_lib = os.environ.get("EDGETERM_ROOTFS_LIB", "")
if rootfs_lib and os.path.isdir(rootfs_lib) and rootfs_lib not in sys.path:
    sys.path.insert(0, rootfs_lib)
if os.path.isdir("/usr/lib") and "/usr/lib" not in sys.path:
    sys.path.insert(0, "/usr/lib")

for name in ("edgeterm_shell", "edgeterm_wasm"):
    sys.modules.pop(name, None)
globals().pop("EDGETERM_SHELL", None)
globals().pop("EdgeTermShell", None)
globals().pop("ShellExit", None)
if hasattr(builtins, "EDGETERM_SHELL"):
    del builtins.EDGETERM_SHELL
if hasattr(builtins, "EdgeTermShellExit"):
    del builtins.EdgeTermShellExit

shell = None
shell_cls = None
safe_input_fn = globals().get("safe_input") or getattr(builtins, "input", None)

from edgeterm_shell import EdgeTermShell as shell_cls
try:
    from edgeterm_shell import ShellExit
    globals()["ShellExit"] = ShellExit
except Exception:
    pass

if shell is None and shell_cls is not None and safe_input_fn is not None:
    shell = shell_cls(input_func=safe_input_fn)
    globals()["EDGETERM_SHELL"] = shell

if shell is None:
    raise RuntimeError("Shell bootstrap completed without EDGETERM_SHELL")

builtins.EDGETERM_SHELL = shell
if "ShellExit" in globals():
    builtins.EdgeTermShellExit = globals()["ShellExit"]
if "run_rc_local" not in globals():
    async def run_rc_local():
        return await shell.run_rc_local()

shell
`);
          await pyodide.runPythonAsync("await run_rc_local()");
          term.echo("Welcome to EdgeTerm!");
        } catch (err) {
          term.error("[INIT] " + formatInitError(err));
        }
        await updatePrompt();
        rehydrateRuntimePackages()
          .then((packageRehydrateReport) => {
            if (packageRehydrateReport?.loaded?.length) {
              term.echo(`[PACKAGES] Restored runtime support for ${packageRehydrateReport.loaded.join(", ")}`);
            }
            if (packageRehydrateReport?.failed?.length) {
              term.error(
                `[PACKAGES] Some installed packages still need network/package reload: ${packageRehydrateReport.failed
                  .map((item) => item.name)
                  .join(", ")}`
              );
            }
          })
          .catch((err) => console.warn("[PIP] Runtime rehydrate skipped:", err));
      }

      async function switchWorkspace(id, options = {}) {
        if (id === activeWorkspaceId) return;
        await withBusy("Switching workspace...", async () => {
          await exitAppMode({ force: true, resetSurface: true, toDebugTerminal: false });
          await persistActiveWorkspace();
          activeWorkspaceId = id;
          saveWorkspaceRegistry();
          await mountWorkspaceStorage(id);
          await ensureWorkspaceLayout(id);
          await restoreWorkspaceJournal(id);
          prepareActiveMounts();
          renderWorkspaces();
          if (!options.skipBootShell) await bootShell();
          syncShareWritebackState();
          if (!options.skipRefreshFiles) refreshFiles(`/home/${activeUser()}`);
          if (!options.skipAutoStartAppMode) await maybeAutoStartAppMode();
        });
      }

      async function createWorkspaceFromZip(name, file, options = {}) {
        let createdId = "";
        const existingId = options.workspaceId || "";
        const persistRegistry = options.persistRegistry !== false;
        await withBusy(file ? "Importing workspace..." : "Creating workspace...", async () => {
          await persistActiveWorkspace();
          const id = existingId || `ws-${Date.now()}`;
          createdId = id;
          let workspace = workspaces.find((item) => item.id === id);
          if (!workspace) {
            workspace = { id, name, createdAt: Date.now(), rootfsVersion: file ? "custom" : DEFAULT_ROOTFS_VERSION, users: ["user"], userName: "user" };
            workspaces.push(workspace);
          } else {
            workspace.name = name;
            workspace.updatedAt = Date.now();
          }
          if (options.shareRef) workspace.shareRef = options.shareRef;
          workspace.transient = !!options.transient;
          activeWorkspaceId = id;
          if (persistRegistry) saveWorkspaceRegistry();
          await mountWorkspaceStorage(id, { load: !!existingId });
          await ensureWorkspaceLayout(id);
          await clearWorkspaceJournal(id);
          if (file) {
            await importZipIntoWorkspace(id, file);
          }
          if (!options.transient) await syncfs(false);
          prepareActiveMounts();
          renderWorkspaces();
          if (!options.switchOptions?.skipBootShell) await bootShell();
          syncShareWritebackState();
          if (!options.switchOptions?.skipRefreshFiles) refreshFiles(`/home/${activeUser()}`);
          if (!options.switchOptions?.skipAutoStartAppMode) await maybeAutoStartAppMode();
        });
        return createdId;
      }

      async function updateActiveWorkspaceRootfs() {
        const workspace = activeWorkspace();
        if (!workspace) return;
        const message =
          workspace.rootfsVersion === "custom"
            ? `Replace custom rootfs in "${workspace.name}" with the latest EdgeTerm system rootfs? User data in /home and overlay changes will be kept.`
            : `Update "${workspace.name}" to the latest EdgeTerm system rootfs? User data in /home and overlay changes will be kept.`;
        if (!(await askConfirm("Update RootFS", message, { confirmLabel: "Update" }))) return;

        await withBusy("Updating rootfs...", async () => {
          await persistActiveWorkspace();
          await seedDefaultRootfs(activeWorkspaceId, true);
          saveWorkspaceRegistry();
          await syncfs(false);
          prepareActiveMounts();
          renderWorkspaces();
          await bootShell();
          refreshFiles(`/home/${activeUser()}`);
          showNotice(`Updated rootfs to ${DEFAULT_ROOTFS_VERSION}`);
          await maybeAutoStartAppMode();
        });
      }

      async function resetEnvironment() {
        const confirmed = await askConfirm(
          "Reset Environment",
          "This permanently deletes all local EdgeTerm workspaces, files, users, installed packages, and saved editor settings.",
          { confirmLabel: "Reset", danger: true }
        );
        if (!confirmed) return;

        try {
          if (persistTimeout) {
            clearTimeout(persistTimeout);
            persistTimeout = null;
          }
          persistInFlight = null;
          edgeTermShell = null;
          await withBusy("Resetting environment...", async () => {
            clearDirectory("/workspace-store");
            clearEdgeTermStorageKeys();
            await clearAllWorkspaceJournal();
            await syncfs(false);
            location.reload();
          });
        } catch (err) {
          term?.error?.("[RESET] " + formatInitError(err));
          showNotice("Reset failed");
        }
      }

      async function deleteActiveWorkspace() {
        if (workspaces.length <= 1) {
          showNotice("Keep at least one workspace");
          return;
        }
        const workspace = activeWorkspace();
        if (!(await askConfirm("Delete Workspace", `Delete workspace "${workspace.name}"?`, { confirmLabel: "Delete", danger: true }))) return;
        await exitAppMode({ force: true, resetSurface: true, toDebugTerminal: false });
        await persistActiveWorkspace();
        removeTree(workspacePath(workspace.id));
        await clearWorkspaceJournal(workspace.id);
        await syncfs(false);
        if (mountedWorkspaceId === workspace.id) {
          try {
            pyodide.FS.unmount(workspacePath(workspace.id));
          } catch (err) {
            console.warn("[PERSIST] Workspace unmount skipped:", err);
          }
          mountedWorkspaceId = "";
        }
        workspaces = workspaces.filter((item) => item.id !== workspace.id);
        activeWorkspaceId = workspaces[0].id;
        saveWorkspaceRegistry();
        await mountWorkspaceStorage(activeWorkspaceId);
        await ensureWorkspaceLayout(activeWorkspaceId);
        await restoreWorkspaceJournal(activeWorkspaceId);
        prepareActiveMounts();
        renderWorkspaces();
        await bootShell();
        setView("terminalView");
        refreshFiles(`/home/${activeUser()}`);
        await maybeAutoStartAppMode();
      }

      async function createWorkspaceUser() {
        const workspace = activeWorkspace();
        const rawName = await askText("Create Workspace User", "Linux username", "developer", { confirmLabel: "Create" });
        if (!rawName) return;

        const user = safeName(rawName).toLowerCase();
        if (!/^[a-z_][a-z0-9_-]*$/.test(user)) {
          showNotice("Use lowercase letters, numbers, dash, or underscore");
          return;
        }

        await persistActiveWorkspace();
        if (!workspace.users.includes(user)) workspace.users.push(user);
        workspace.userName = user;
        ensureDir(workspacePath(activeWorkspaceId, `/home/${user}`));
        saveWorkspaceRegistry();
        await syncfs(false);
        prepareActiveMounts();
        renderWorkspaces();
        await bootShell();
        syncShareWritebackState();
        setView("terminalView");
        refreshFiles(`/home/${user}`);
        await maybeAutoStartAppMode();
      }

      async function switchWorkspaceUser(user) {
        const workspace = activeWorkspace();
        if (!workspace.users.includes(user) || workspace.userName === user) return;
        await persistActiveWorkspace();
        workspace.userName = user;
        saveWorkspaceRegistry();
        await syncfs(false);
        prepareActiveMounts();
        renderWorkspaces();
        await bootShell();
        setView("terminalView");
        refreshFiles(`/home/${user}`);
        await maybeAutoStartAppMode();
      }

      async function deleteWorkspaceUser(user) {
        const workspace = activeWorkspace();
        if (workspace.users.length <= 1 || workspace.userName === user) return;
        if (!(await askConfirm("Delete Workspace User", `Delete user "${user}" and /home/${user}?`, { confirmLabel: "Delete", danger: true }))) return;
        await persistActiveWorkspace();
        workspace.users = workspace.users.filter((item) => item !== user);
        removeTree(workspacePath(activeWorkspaceId, `/home/${user}`));
        saveWorkspaceRegistry();
        await syncfs(false);
        prepareActiveMounts();
        renderWorkspaces();
        renderUsers();
        refreshFiles(`/home/${activeUser()}`);
      }

      function setupEvents() {
        window.EdgeTermAppModeBridge = {
          navigate: async (url, options = {}) => navigateAppMode(url, options),
          fetch: async (request) => {
            const response = await dispatchAppModeRequest(request.url, request);
            rememberAppModeCookies(response);
            return {
              status: response.status,
              headers: response.headers || {},
              body: response.body || "",
              bodyBase64: response.bodyBase64 || "",
            };
          },
            syncSiteData: (payload = {}) => {
              applySyncedSiteData(payload);
              return true;
            },
              keydown: (payload) => {
                const synthetic = {
                  key: payload?.key || "",
                ctrlKey: !!payload?.ctrlKey,
                altKey: !!payload?.altKey,
              shiftKey: !!payload?.shiftKey,
                metaKey: !!payload?.metaKey,
              };
              if (appModeState.active && matchesHotkey(synthetic, payload?.exitHotkey || appModeState.config?.exit?.hotkey || "Escape")) {
                if (appModeState.renderTarget === "display") closeDisplayBrowserTab();
                else void exitAppMode();
                return true;
              }
            if (appModeState.active && payload?.allowDebugTerminal && matchesHotkey(synthetic, payload?.debugHotkey || appModeState.config?.ui?.debugTerminalHotkey || "Ctrl+`")) {
              void exitAppMode({ force: true, view: "terminalView" });
              showNotice("Returned to terminal from App Mode");
              return true;
            }
            return false;
          },
        };
        document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => setView(tab.dataset.view)));
        $id("toggleSidebar").addEventListener("click", () => {
          const app = $id("app");
          if (window.innerWidth <= 820) {
            setSidebarOpen(!app.classList.contains("sidebar-open"));
          } else {
            setSidebarOpen(app.classList.contains("sidebar-collapsed"));
          }
        });
        $id("sidebarBackdrop").addEventListener("click", () => setSidebarOpen(false));
        $id("sidebarResizer").addEventListener("pointerdown", (event) => {
          if (window.innerWidth <= 820) return;
          sidebarResizeState = { pointerId: event.pointerId };
          $id("sidebarResizer").classList.add("dragging");
          event.preventDefault();
          event.currentTarget.setPointerCapture?.(event.pointerId);
        });
        $id("sidebarResizer").addEventListener("pointermove", (event) => {
          if (!sidebarResizeState || window.innerWidth <= 820) return;
          applySidebarWidth(event.clientX);
        });
        $id("sidebarResizer").addEventListener("pointerup", (event) => {
          if (sidebarResizeState?.pointerId !== event.pointerId) return;
          sidebarResizeState = null;
          $id("sidebarResizer").classList.remove("dragging");
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        });
        $id("sidebarResizer").addEventListener("pointercancel", (event) => {
          if (sidebarResizeState?.pointerId !== event.pointerId) return;
          sidebarResizeState = null;
          $id("sidebarResizer").classList.remove("dragging");
        });
        $id("toggleFullscreen").addEventListener("click", () => {
          setView("terminalView");
          setFullscreen(!$id("terminalView").classList.contains("terminal-fullscreen"));
        });
        $id("toggleTheme").addEventListener("click", toggleAppTheme);
        $id("settingsToggleTheme").addEventListener("click", toggleAppTheme);
        $id("exitFullscreen").addEventListener("click", () => setFullscreen(false));
        $id("newWorkspace").addEventListener("click", async () => {
          const name = await askText("New Workspace", "Workspace name", "New Workspace", { confirmLabel: "Create" });
          if (name) await createWorkspaceFromZip(name, null);
        });
        $id("createUser").addEventListener("click", createWorkspaceUser);
        $id("importRootfs").addEventListener("click", () => $id("rootfsPicker").click());
        $id("settingsImportRootfs").addEventListener("click", () => $id("rootfsPicker").click());
        $id("rootfsPicker").addEventListener("change", async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          const fallback = file.name.replace(/\.zip$/i, "");
          const name = await askText("Import Workspace", "Workspace name", fallback, { confirmLabel: "Import" }) || fallback;
          await createWorkspaceFromZip(name, file);
          event.target.value = "";
        });
        $id("exportWorkspace").addEventListener("click", exportActiveWorkspace);
        $id("settingsExportWorkspace").addEventListener("click", exportActiveWorkspace);
        $id("settingsUpdateRootfs").addEventListener("click", updateActiveWorkspaceRootfs);
        $id("settingsResetEnvironment").addEventListener("click", resetEnvironment);
        $id("browserClearCookies")?.addEventListener("click", () => void clearCurrentBrowserSiteData("cookies"));
        $id("browserClearStorage")?.addEventListener("click", () => void clearCurrentBrowserSiteData("storage"));
        $id("browserClearCache")?.addEventListener("click", () => void clearCurrentBrowserSiteData("cache"));
        $id("browserClearCurrentSite")?.addEventListener("click", () => void clearCurrentBrowserSiteData("all"));
        $id("browserClearAllData")?.addEventListener("click", () => void clearAllBrowserData());
        $id("browserSiteStoredList")?.addEventListener("click", (event) => {
          const button = event.target.closest("[data-site-delete]");
          if (!button) return;
          const siteKey = button.getAttribute("data-site-delete") || "";
          const deletesActiveSite = appModeSiteRecordMatchesKey({ key: appModeState.siteKey, scope: appModeState.siteScope }, siteKey);
          const deleted = clearStoredAppModeSiteData(siteKey);
          if (deleted && siteKey && deletesActiveSite) {
            appModeState.cookieJar = new Map();
            appModeState.siteLocalStorage = new Map();
            appModeState.siteSessionStorage = new Map();
            const tab = appModeState.renderTarget === "display" ? activeDisplayBrowserTab() : null;
            if (tab) {
              tab.cookieJar = new Map();
              tab.siteLocalStorage = new Map();
              tab.siteSessionStorage = new Map();
            }
          }
          renderBrowserSiteSettings();
          showNotice(deleted ? "Deleted stored site data" : "Stored site data was already gone");
        });
        $id("deleteWorkspace").addEventListener("click", deleteActiveWorkspace);
        if (CLOUD_ENABLED) {
          $id("cloudLogin")?.addEventListener("click", () => loginOrRegister("login"));
          $id("cloudRegister")?.addEventListener("click", () => loginOrRegister("register"));
          $id("cloudLogout")?.addEventListener("click", logoutCloud);
          $id("syncToCloud")?.addEventListener("click", () => syncActiveWorkspaceToCloud());
          $id("shareWriteback")?.addEventListener("click", writeBackSharedWorkspace);
          $id("guestShareWriteback")?.addEventListener("click", writeBackSharedWorkspaceAsGuest);
          $id("topbarShareWriteback")?.addEventListener("click", () => {
            const shareOrigin = activeShareOrigin();
            const guestAllowed =
              !!(!cloudUser && shareOrigin?.share?.visibility === "public" && shareOrigin?.share?.mode === "read-write" && !shareOrigin?.share?.tempMode);
            return guestAllowed ? writeBackSharedWorkspaceAsGuest() : writeBackSharedWorkspace();
          });
          $id("createShare")?.addEventListener("click", createShareLink);
        }
        $id("adminUsersPageSize")?.addEventListener("change", (event) => {
          adminUsersPageSize = Math.min(500, Math.max(15, Number(event.target.value) || 15));
          adminUsersPage = 1;
          localStorage.setItem(ADMIN_USERS_PAGE_SIZE_KEY, String(adminUsersPageSize));
          renderAdminUsers(adminUsers);
        });
        $id("adminUsersPrevPage")?.addEventListener("click", () => {
          adminUsersPage = Math.max(1, adminUsersPage - 1);
          renderAdminUsers(adminUsers);
        });
        $id("adminUsersNextPage")?.addEventListener("click", () => {
          adminUsersPage += 1;
          renderAdminUsers(adminUsers);
        });
        $id("adminSnapshotsPageSize")?.addEventListener("change", (event) => {
          adminSnapshotsPageSize = Math.min(500, Math.max(15, Number(event.target.value) || 15));
          adminSnapshotsPage = 1;
          localStorage.setItem(ADMIN_SNAPSHOTS_PAGE_SIZE_KEY, String(adminSnapshotsPageSize));
          renderAdminSnapshots(adminPlatformSnapshots);
        });
        $id("adminSnapshotsPrevPage")?.addEventListener("click", () => {
          adminSnapshotsPage = Math.max(1, adminSnapshotsPage - 1);
          renderAdminSnapshots(adminPlatformSnapshots);
        });
        $id("adminSnapshotsNextPage")?.addEventListener("click", () => {
          adminSnapshotsPage += 1;
          renderAdminSnapshots(adminPlatformSnapshots);
        });
        $id("adminSharesPageSize")?.addEventListener("change", (event) => {
          adminSharesPageSize = Math.min(500, Math.max(15, Number(event.target.value) || 15));
          adminSharesPage = 1;
          localStorage.setItem(ADMIN_SHARES_PAGE_SIZE_KEY, String(adminSharesPageSize));
          renderAdminShares(adminPlatformShares);
        });
        $id("adminSharesPrevPage")?.addEventListener("click", () => {
          adminSharesPage = Math.max(1, adminSharesPage - 1);
          renderAdminShares(adminPlatformShares);
        });
        $id("adminSharesNextPage")?.addEventListener("click", () => {
          adminSharesPage += 1;
          renderAdminShares(adminPlatformShares);
        });
        $id("adminTiersPageSize")?.addEventListener("change", (event) => {
          adminTiersPageSize = Math.min(500, Math.max(15, Number(event.target.value) || 15));
          adminTiersPage = 1;
          localStorage.setItem(ADMIN_TIERS_PAGE_SIZE_KEY, String(adminTiersPageSize));
          renderAdminTiers(cloudTiers);
        });
        $id("adminTiersPrevPage")?.addEventListener("click", () => {
          adminTiersPage = Math.max(1, adminTiersPage - 1);
          renderAdminTiers(cloudTiers);
        });
        $id("adminTiersNextPage")?.addEventListener("click", () => {
          adminTiersPage += 1;
          renderAdminTiers(cloudTiers);
        });
        $id("autoSyncMode").value = localStorage.getItem(AUTO_SYNC_MODE_KEY) || localStorage.getItem(AUTO_SYNC_KEY) || "off";
        $id("autoSyncMinutes").value = localStorage.getItem(AUTO_SYNC_MINUTES_KEY) || "5";
        $id("autoSyncMode").addEventListener("change", () => syncAutoSyncFormState());
        $id("backupRetentionEnabled").checked = localStorage.getItem(BACKUP_RETENTION_KEY) !== "0";
        $id("backupRetentionCount").value = localStorage.getItem(BACKUP_RETENTION_KEY) || "";
        $id("shareReadWrite")?.addEventListener("change", syncShareFormState);
        $id("backupRetentionEnabled").addEventListener("change", (event) => {
          $id("backupRetentionCount").disabled = !event.target.checked;
          if (!event.target.checked) $id("backupRetentionCount").value = "";
        });
        $id("backupRetentionCount").addEventListener("change", (event) => {
          const next = Math.max(1, Number(event.target.value || 1));
          event.target.value = String(next);
        });
        if (CLOUD_ENABLED) $id("saveCloudBackupSettings").addEventListener("click", saveCloudBackupPreferences);
        $id("snapshotPageSize").value = String(snapshotPageSize);
        $id("snapshotPageSize").addEventListener("change", (event) => {
          snapshotPageSize = Math.min(200, Math.max(15, Number(event.target.value || 15)));
          localStorage.setItem(SNAPSHOT_PAGE_SIZE_KEY, String(snapshotPageSize));
          snapshotPage = 1;
          renderSnapshots();
        });
        $id("snapshotSelectPage").addEventListener("change", (event) => {
          const total = cloudSnapshots.length;
          const start = (snapshotPage - 1) * snapshotPageSize;
          const pageItems = cloudSnapshots.slice(start, start + snapshotPageSize);
          for (const snapshot of pageItems) {
            if (event.target.checked) selectedSnapshotIds.add(snapshot.id);
            else selectedSnapshotIds.delete(snapshot.id);
          }
          renderSnapshots();
        });
        $id("deleteSelectedSnapshots").addEventListener("click", deleteSelectedSnapshots);
        $id("deleteAllSnapshots").addEventListener("click", deleteAllSnapshots);
        $id("snapshotPrevPage").addEventListener("click", () => {
          snapshotPage = Math.max(1, snapshotPage - 1);
          renderSnapshots();
        });
        $id("snapshotNextPage").addEventListener("click", () => {
          const totalPages = Math.max(1, Math.ceil(cloudSnapshots.length / snapshotPageSize));
          snapshotPage = Math.min(totalPages, snapshotPage + 1);
          renderSnapshots();
        });
        renderBrowserSiteSettings();
        configureAutoSync();
        if (CLOUD_ENABLED) {
          $id("adminRefresh").addEventListener("click", refreshAdmin);
          $id("adminLogin").addEventListener("click", adminLogin);
          $id("adminCreateUser").addEventListener("click", adminCreateUser);
          $id("adminImportSnapshot").addEventListener("click", () => $id("adminSnapshotImportPicker").click());
          $id("adminSnapshotImportPicker").addEventListener("change", async (event) => {
            const file = event.target.files?.[0];
            await adminImportSnapshotFile(file);
            event.target.value = "";
          });
          for (const id of ["adminUserSearch", "adminShareSearch", "adminSnapshotSearch"]) {
            $id(id)?.addEventListener("input", () => void refreshAdmin());
          }
          $id("adminSnapshotUserFilter")?.addEventListener("change", () => void refreshAdmin());
          $id("adminCreateTier").addEventListener("click", () => adminEditTier("", {
            storageQuota: 100 * 1024 * 1024,
            maxSnapshots: 5,
            keepLastBackups: 5,
            minimumAutoSyncMinutes: 0,
            maxShareLinks: 2,
            defaultExpirationSeconds: 7 * 24 * 3600,
            autoSyncEnabled: false,
            appModeAllowed: true,
            isDefault: false,
            sharePermissions: ["private"],
          }));
          $id("adminSaveSettings").addEventListener("click", async () => {
            try {
              await cloudJson("/api/admin/settings", {
                method: "POST",
                body: JSON.stringify({
                  sharingEnabled: $id("adminSharingEnabled").checked,
                  appModeEnabled: $id("adminAppModeEnabled").checked,
                  cloudNoticeHtml: $id("adminCloudNoticeHtml").value,
                  tosHtml: $id("adminTosHtml")?.value || "",
                }),
              });
              showNotice("Admin settings saved");
              await refreshAdmin();
              await refreshCloudState();
            } catch (err) {
              showNotice(err.message);
            }
          });
        }
        $id("saveAppModeConfig").addEventListener("click", async () => {
          const config = collectAppModeSettings();
          await saveAppModeConfig(config);
          showNotice("Saved App Mode config");
        });
        $id("launchAppMode").addEventListener("click", async () => {
          const config = collectAppModeSettings();
          await saveAppModeConfig(config);
          if (!config.enabled) {
            showNotice("Enable App Mode first");
            return;
          }
          await enterAppMode(config, { forceReload: true });
        });
        $id("openAppModeConfigEditor").addEventListener("click", async () => {
          ensureAppModeConfigFile();
          await openEditor("/etc/appmode/config.json");
        });
        $id("appModeErrorBack").addEventListener("click", () => exitAppMode({ force: true }));
        $id("appModeErrorOpenConfig").addEventListener("click", async () => {
          await exitAppMode({ force: true });
          await openEditor("/etc/appmode/config.json");
        });

        $id("filePath").addEventListener("keydown", (event) => {
          if (event.key === "Enter") refreshFiles($id("filePath").value);
        });
        $id("fileList").addEventListener("mousedown", startMarqueeSelection);
        $id("goUp").addEventListener("click", () => refreshFiles(currentPath.split("/").slice(0, -1).join("/") || "/"));
        $id("refreshFiles").addEventListener("click", () => refreshFiles($id("filePath").value));
        $id("uploadFile").addEventListener("click", () => $id("fileUploader").click());
        $id("fileUploader").addEventListener("change", async (event) => {
          await uploadFiles(Array.from(event.target.files || []));
          event.target.value = "";
        });
        $id("downloadFile").addEventListener("click", async () => {
          const paths = getSelectedPaths();
          if (paths.length) await downloadSelectedPaths(paths);
        });
        $id("copyFile").addEventListener("click", () => {
          const paths = getSelectedPaths();
          if (!paths.length) return;
          clipboard = { mode: "copy", paths };
          showNotice(`Copied ${paths.length === 1 ? "item" : `${paths.length} items`}`);
        });
        $id("cutFile").addEventListener("click", () => {
          const paths = getSelectedPaths();
          if (!paths.length) return;
          clipboard = { mode: "cut", paths };
          showNotice(`Cut ${paths.length === 1 ? "item" : `${paths.length} items`}`);
        });
        $id("pasteFile").addEventListener("click", pasteClipboardItems);
        $id("renameFile").addEventListener("click", async () => {
          const paths = getSelectedPaths();
          if (paths.length !== 1) return showNotice("Select one item to rename");
          await renameSelectedPath(paths[0]);
        });
        $id("deleteFile").addEventListener("click", async () => {
          const paths = getSelectedPaths();
          await deleteSelectedPaths(paths);
        });
        $id("contextMenu").addEventListener("click", async (event) => {
          const button = event.target.closest("[data-action]");
          if (!button) return;
          await handleContextAction(button.dataset.action);
        });
        document.addEventListener("click", (event) => {
          if (!event.target.closest("#contextMenu")) hideContextMenu();
        });
        document.addEventListener("contextmenu", (event) => {
          if (!event.target.closest(".file-row")) hideContextMenu();
        });
        document.addEventListener("click", (event) => {
          if (!event.target.closest("#editorMenuPopover") && !event.target.closest(".menu-button")) hideEditorMenu();
          if (event.target.id === "editorCommandPalette") closeCommandPalette();
          if (event.target.id === "previewModal") closePreview();
        });
        document.addEventListener("keydown", (event) => {
          const mod = event.ctrlKey || event.metaKey;
          if (!mod || event.shiftKey || event.altKey || event.key.toLowerCase() !== "s") return;
          if (!$id("editorView").classList.contains("active")) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          saveEditorFromShortcut(focusedEditorTargetName()).catch((err) => {
            console.error("[EDITOR] Shortcut save failed:", err);
            showNotice(`Save failed: ${err.message || err}`);
          });
        }, true);
        $id("editorPath").addEventListener("keydown", (event) => {
          if (event.key === "Enter") openEditorInTarget($id("editorPath").value, { target: "main" });
        });
        $id("editorSplitPath").addEventListener("keydown", (event) => {
          if (event.key === "Enter") openEditorInTarget($id("editorSplitPath").value, { target: "split" });
        });
        $id("editorUploader").addEventListener("change", async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        const dir = normalizePath($id("editorPath").value).split("/").slice(0, -1).join("/") || `/home/${activeUser()}`;
        const target = `${dir}/${file.name}`;
        const data = new Uint8Array(await file.arrayBuffer());
        pyodide.FS.writeFile(target, data);
        if (syncRuntimePathToWorkspace(target)) {
          const mirrorTarget = workspaceMirrorPathForRuntimePath(target);
          if (mirrorTarget) await persistWorkspaceMirrorTargets([mirrorTarget], activeWorkspaceId, new Map([[mirrorTarget, data]]));
        } else {
          schedulePersistActiveWorkspace(750);
        }
        await openEditor(target);
        event.target.value = "";
      });
        $id("openSplitEditorButton").addEventListener("click", openSplitEditorPrompt);
        $id("saveSplitEditorButton").addEventListener("click", saveSplitEditor);
        $id("useSplitAsPrimaryButton").addEventListener("click", promoteSplitEditorToPrimary);
        $id("closePreview").addEventListener("click", closePreview);
        $id("previewOpenEditor").addEventListener("click", async () => {
          if (!previewPath) return;
          const target = previewPath;
          closePreview();
          await openEditor(target);
        });
        $id("previewDownload").addEventListener("click", async () => {
          if (!previewPath) return;
          await downloadPath(previewPath);
        });
        $id("commandPaletteInput").addEventListener("input", () => {
          editorPaletteSelection = 0;
          renderCommandPalette();
        });
        $id("commandPaletteInput").addEventListener("keydown", (event) => {
          const items = Array.from($id("commandPaletteList").querySelectorAll(".palette-item"));
          if (event.key === "Escape") {
            event.preventDefault();
            closeCommandPalette();
            return;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            editorPaletteSelection = Math.min(editorPaletteSelection + 1, Math.max(items.length - 1, 0));
            renderCommandPalette();
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            editorPaletteSelection = Math.max(editorPaletteSelection - 1, 0);
            renderCommandPalette();
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            items[editorPaletteSelection]?.click();
          }
        });
        $id("clearDisplay").addEventListener("click", () => {
          clearDisplaySurface();
          showNotice("Display cleared");
        });
        $id("displayBrowserBar")?.addEventListener("submit", async (event) => {
          event.preventDefault();
          if (!appModeState.active || appModeState.renderTarget !== "display") {
            showNotice("Start edgeserve first");
            return;
          }
          try {
            await navigateAppMode(normalizeDisplayBrowserUrl($id("displayUrlInput").value), { updateHistory: false });
          } catch (err) {
            showNotice(`Preview failed: ${err.message || err}`);
          }
        });
        $id("displayBackButton")?.addEventListener("click", async () => {
          if (appModeState.browserHistoryIndex <= 0) return;
          appModeState.browserHistoryIndex -= 1;
          syncDisplayBrowserButtons();
          const target = appModeState.browserHistory[appModeState.browserHistoryIndex] || "/";
          try {
            await navigateAppMode(target, { updateHistory: false, skipDisplayHistory: true });
          } catch (err) {
            showNotice(`Back failed: ${err.message || err}`);
          }
        });
        $id("displayRefreshButton")?.addEventListener("click", async () => {
          if (!appModeState.active || appModeState.renderTarget !== "display") return;
          const current = appModeState.browserHistory[appModeState.browserHistoryIndex] || normalizeDisplayBrowserUrl($id("displayUrlInput")?.value || "/");
          try {
            await navigateAppMode(current, { updateHistory: false, skipDisplayHistory: true, replaceDisplayHistory: true });
          } catch (err) {
            showNotice(`Refresh failed: ${err.message || err}`);
          }
        });
        $id("focusDisplay").addEventListener("click", () => {
          $id("displayCanvas").focus();
          showNotice("Display focused");
        });
        $id("fullscreenDisplay").addEventListener("click", () => {
          setView("displayView");
          setDisplayFullscreen(!displayState.fullscreen);
        });
        $id("focusBrowser")?.addEventListener("click", () => {
          ensureDisplayAppModeFrame()?.focus();
          showNotice("Browser focused");
        });
        $id("fullscreenBrowser")?.addEventListener("click", () => {
          setView("browserView");
          void toggleDisplayViewportFullscreen();
        });
        document.addEventListener("fullscreenchange", () => {
          setDisplayFullscreen(document.fullscreenElement === $id("displayView") || document.fullscreenElement === $id("browserView"));
        });
        document.addEventListener("keydown", (event) => {
          if (event.target.closest("#commandPaletteInput")) return;
            if (appModeState.active) {
              if (matchesHotkey(event, appModeState.config?.exit?.hotkey || "Escape")) {
                event.preventDefault();
                if (appModeState.renderTarget === "display") closeDisplayBrowserTab();
                else void exitAppMode();
                return;
              }
            if (appModeState.config?.ui?.allowDebugTerminal && matchesHotkey(event, appModeState.config?.ui?.debugTerminalHotkey || "Ctrl+`")) {
              event.preventDefault();
              void exitAppMode({ force: true, view: "terminalView" });
              showNotice("Returned to terminal from App Mode");
              return;
            }
          }
          if (event.key === "Escape" && !$id("previewModal").classList.contains("hidden")) {
            closePreview();
            return;
          }
          if (event.key === "Escape" && $id("app").classList.contains("sidebar-open")) {
            setSidebarOpen(false);
            return;
          }
          const mod = event.ctrlKey || event.metaKey;
          if (mod && event.key.toLowerCase() === "p" && event.shiftKey) {
            event.preventDefault();
            openCommandPalette("commands");
            return;
          }
          if (mod && event.key.toLowerCase() === "p") {
            event.preventDefault();
            openCommandPalette("files");
          }
        });

        const syncOnExit = () => {
          try {
            if ((localStorage.getItem(AUTO_SYNC_KEY) || "off") === "exit") {
              void syncActiveWorkspaceToCloud({ silent: true });
            }
            syncRootOverlayToWorkspace();
            syncHomeToWorkspace();
          } catch (err) {
            console.error("Workspace sync error:", err);
          }
          pyodide?.FS?.syncfs?.(false, (err) => {
            if (err) console.error("Sync error:", err);
          });
        };
        window.addEventListener("pagehide", syncOnExit);
        window.addEventListener("beforeunload", syncOnExit);
        window.addEventListener("popstate", () => {
          const shareRoute = appModeState.shareRoute;
          const localRoute = appModeState.localRoute;
          if (!appModeState.active) return;
          if (shareRoute?.shareId) {
            const route = parseSharedAppRoute();
            if (!route || route.shareId !== shareRoute.shareId) {
              void exitAppMode({ force: true });
              return;
            }
            void dispatchAppModeRoute(route.routePath || "/", route.queryString || "", { updateHistory: false });
            return;
          }
          if (localRoute?.workspaceId) {
            const route = parseLocalAppRoute();
            if (!route) {
              void exitAppMode({ force: true });
              return;
            }
            if (route.mode === "named" && String(route.workspaceSlug || "").toLowerCase() !== String(localRoute.workspaceSlug || "").toLowerCase()) {
              void exitAppMode({ force: true });
              return;
            }
            void dispatchAppModeRoute(route.routePath || "/", route.queryString || "", { updateHistory: false });
          }
        });
        window.addEventListener("resize", () => {
          if (window.innerWidth > 820) {
            setSidebarOpen(true);
          } else {
            setSidebarOpen(false);
          }
          editor?.layout();
          splitEditor?.layout();
          term?.resize();
        });
      }

      async function setupMonaco() {
        await new Promise((resolve) => {
          window.require.config({ paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs" } });
          window.require(["vs/editor/editor.main"], resolve);
        });
        editorTheme = monacoThemeForAppTheme(appTheme);
        editor = monaco.editor.create($id("editor"), {
          value: "",
          language: "python",
          theme: editorTheme,
          automaticLayout: true,
          minimap: { enabled: false },
        });
        splitEditor = monaco.editor.create($id("editorSplit"), {
          value: "",
          language: "python",
          theme: editorTheme,
          automaticLayout: true,
          readOnly: false,
          minimap: { enabled: false },
        });
        applyEditorOptions();
        registerDefaultEditorCommands();
        renderEditorChrome();
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          saveEditorFromShortcut("main").catch((err) => {
            console.error("[EDITOR] Save failed:", err);
            showNotice(`Save failed: ${err.message || err}`);
          });
        });
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF, () => editor.getAction("actions.find")?.run());
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyH, () => editor.getAction("editor.action.startFindReplaceAction")?.run());
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runCurrentFile().catch((err) => showNotice(err.message || err)));
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => openCommandPalette("files"));
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP, () => openCommandPalette("commands"));
        splitEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          saveEditorFromShortcut("split").catch((err) => {
            console.error("[EDITOR] Split save failed:", err);
            showNotice(`Split save failed: ${err.message || err}`);
          });
        });
        splitEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => openSplitEditorPrompt());
        editor.onDidChangeModelContent(() => {
          setEditorStatus("Modified");
        });
        splitEditor.onDidChangeModelContent(() => {
          setSplitEditorStatus("Modified");
        });
        window.editor = editor;
      }

      async function main() {
        applyAppTheme(appTheme);
        applyEditionMode();
        revealApp();
        applySidebarWidth();
        if (window.innerWidth > 820) setSidebarOpen(true);
        else setSidebarOpen(false);
        loadWorkspaceRegistry();
        renderWorkspaces();
        window.lucide?.createIcons();
        initializeTerminal();
        showBootStatus("Loading EdgeTerm runtime...");

        const bootWatchdog = setTimeout(() => {
          revealApp();
          showBootStatus(
            "EdgeTerm is still loading the browser Python runtime. If this message stays here, try a hard refresh so Chrome fetches the latest app files.",
            true
          );
        }, 20000);

        const { loadPyodide } = await import("https://cdn.jsdelivr.net/pyodide/v0.27.5/full/pyodide.mjs");
        showBootStatus("Starting Python runtime...");
        pyodide = await loadPyodide();
        globalThis.pyodide = pyodide;

        showBootStatus("Opening workspace storage...");
        loadWorkspaceRegistry();
        const active = activeWorkspace();
        if (active) {
          await mountWorkspaceStorage(active.id);
          showBootStatus(`Preparing ${active.name}...`);
          await ensureWorkspaceLayout(active.id);
          await restoreWorkspaceJournal(active.id);
        }
        saveWorkspaceRegistry();
        prepareActiveMounts();
        ensureAppModeConfigFile();

        setupEvents();
        configureDisplayBridge();
        configureWasmRuntime();
        if (CLOUD_ENABLED) await refreshCloudState();
        else renderCloud();
        renderWorkspaces();
        window.lucide?.createIcons();
        const initialShareLocator = currentShareLocator();
        const bootIntoDirectApp = initialShareLocator?.kind === "app-share" || initialShareLocator?.kind === "local-app";
        if (bootIntoDirectApp) document.body.classList.add("app-mode-active");
        revealApp();
        if (!bootIntoDirectApp) {
          await bootShell();
          refreshFiles(`/home/${activeUser()}`);
        }
        if (PAGE_KIND === "admin" && CLOUD_ENABLED) setView("adminView");
        await openShareFromUrl(initialShareLocator);
        if (!bootIntoDirectApp) {
          await maybeAutoStartAppMode();
        } else if (!appModeState.active && !edgeTermShell) {
          await bootShell();
          refreshFiles(`/home/${activeUser()}`);
        }
        clearTimeout(bootWatchdog);

        setupMonaco().catch((err) => {
          console.error("[MONACO] Failed:", err);
          term?.error?.("[EDITOR] Monaco failed to load: " + formatError(err));
        });
        scheduleWorkspaceFlush(5000);
      }

      main().catch((err) => {
        console.error("[BOOT] Failed:", err);
        revealApp();
        showBootStatus("[BOOT] Failed to start EdgeTerm Workspace\n" + formatError(err), true);
        const errorBox = document.createElement("pre");
        errorBox.id = "boot-error";
        errorBox.textContent = `[BOOT] Failed to start EdgeTerm Workspace\n${formatError(err)}`;
        document.body.appendChild(errorBox);
      });
}
