import { serializeSiteDataMap } from "./site-data.js";

export function buildAppModeClientScript({ currentPath, exitHotkey, debugHotkey, allowDebugTerminal, siteData, edgeServeDebug }) {
        return `
(() => {
  const currentPath = ${JSON.stringify(currentPath || "/")};
  const routePrefix = ${JSON.stringify(edgeServeDebug?.routePrefix || "/")};
  const exitHotkey = ${JSON.stringify(exitHotkey || "Escape")};
  const debugHotkey = ${JSON.stringify(debugHotkey || "Ctrl+`")};
  const allowDebugTerminal = ${allowDebugTerminal ? "true" : "false"};
  const edgeServeDebug = ${JSON.stringify(edgeServeDebug || null)};
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
  const edgeServeLog = (event, details = {}) => {
    const payload = { event, time: new Date().toISOString(), ...details };
    try {
      console.info("[EdgeServe]", payload);
    } catch {}
    try {
      parent.EdgeTermAppModeBridge.edgeServeLog(payload);
    } catch {}
    return payload;
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
    if (/^\\/\\//.test(url)) {
      try {
        const parsed = new URL("https:" + url);
        return parsed.hostname === "edgeterm.local" || parsed.hostname === window.location.hostname;
      } catch {
        return false;
      }
    }
    if (/^https?:\\/\\//i.test(url)) {
      try {
        const parsed = new URL(url);
        return parsed.hostname === "edgeterm.local" || parsed.hostname === window.location.hostname;
      } catch {
        return false;
      }
    }
    return true;
  };
  const shouldInterceptWebSocket = (url) => {
    if (!url) return false;
    if (/^(data|blob|javascript|mailto):/i.test(url)) return false;
    if (/^wss?:\\/\\/\\//i.test(url)) return true;
    if (/^wss?:\\/\\//i.test(url)) {
      try {
        const parsed = new URL(url);
        return ["edgeterm.local", "localhost", "127.0.0.1", "::1", "ws", window.location.hostname].includes(parsed.hostname);
      } catch {
        return false;
      }
    }
    if (/^https?:\\/\\//i.test(url)) return shouldIntercept(url);
    return true;
  };
  let virtualUrl = new URL(currentPath || "/", "https://edgeterm.local");
  const virtualPath = () => \`\${virtualUrl.pathname || "/"}\${virtualUrl.search || ""}\`;
  const virtualLocation = {};
  Object.defineProperties(virtualLocation, {
    href: { configurable: true, get: () => virtualUrl.href },
    protocol: { configurable: true, get: () => virtualUrl.protocol },
    host: { configurable: true, get: () => virtualUrl.host },
    hostname: { configurable: true, get: () => virtualUrl.hostname },
    port: { configurable: true, get: () => virtualUrl.port },
    pathname: { configurable: true, get: () => virtualUrl.pathname },
    search: { configurable: true, get: () => virtualUrl.search },
    hash: { configurable: true, get: () => virtualUrl.hash },
    origin: { configurable: true, get: () => virtualUrl.origin },
  });
  virtualLocation.assign = (url) => parent.EdgeTermAppModeBridge.navigate(normalizeBridgeRequestUrl(String(url || "/")));
  virtualLocation.replace = virtualLocation.assign;
  virtualLocation.reload = () => parent.EdgeTermAppModeBridge.navigate(virtualPath());
  const applicationPathname = () => {
    const pathname = virtualUrl.pathname || "/";
    if (routePrefix === "/") return pathname;
    if (pathname === routePrefix) return "/";
    if (pathname.startsWith(routePrefix + "/")) return pathname.slice(routePrefix.length) || "/";
    return pathname;
  };
  const applicationLocation = {};
  Object.defineProperties(applicationLocation, {
    href: { configurable: true, get: () => "https://edgeterm.local" + applicationPathname() + (virtualUrl.search || "") + (virtualUrl.hash || "") },
    pathname: { configurable: true, get: applicationPathname },
    search: { configurable: true, get: () => virtualUrl.search },
    hash: { configurable: true, get: () => virtualUrl.hash },
  });
  applicationLocation.assign = virtualLocation.assign;
  applicationLocation.replace = virtualLocation.replace;
  applicationLocation.reload = virtualLocation.reload;
  Object.defineProperty(window, "__EDGETERM_APP_LOCATION__", {
    configurable: true,
    value: applicationLocation,
  });
  const updateVirtualUrl = (url) => {
    if (url == null || url === "") return;
    try {
      virtualUrl = new URL(normalizeBridgeRequestUrl(String(url)), virtualUrl.href);
    } catch {}
  };
  const patchBackboneHistory = () => {
    const backbone = window.Backbone;
    if (!backbone?.history || backbone.history.__edgetermVirtualLocation) return;
    backbone.history.location = virtualLocation;
    backbone.history.history = history;
    backbone.history.__edgetermVirtualLocation = true;
    edgeServeLog("virtual-history", { url: virtualUrl.href });
  };
  let backboneHistoryPatchAttempts = 0;
  const backboneHistoryTimer = setInterval(() => {
    patchBackboneHistory();
    backboneHistoryPatchAttempts += 1;
    if (window.Backbone?.history?.__edgetermVirtualLocation || backboneHistoryPatchAttempts > 400) clearInterval(backboneHistoryTimer);
  }, 25);
  const originalFetch = window.fetch.bind(window);
  const normalizeBridgeRequestUrl = (url) => {
    const value = String(url || "");
    const lowerValue = value.toLowerCase();
    if (/^\\/\\//.test(value)) {
      try {
        const parsed = new URL("https:" + value);
        if (parsed.hostname === "edgeterm.local" || parsed.hostname === window.location.hostname) {
          return (parsed.pathname || "/") + (parsed.search || "") + (parsed.hash || "");
        }
      } catch {}
    }
    if (/^https?:\\/\\//i.test(value)) {
      try {
        const parsed = new URL(value);
        if (parsed.hostname === "edgeterm.local" || parsed.hostname === window.location.hostname) {
          return (parsed.pathname || "/") + (parsed.search || "") + (parsed.hash || "");
        }
      } catch {}
    }
    if (lowerValue.startsWith("about://undefined/") || lowerValue.startsWith("about://undefined:")) {
      try {
        const parsed = new URL(value);
        return (parsed.pathname || "/") + (parsed.search || "") + (parsed.hash || "");
      } catch {
        const marker = value.indexOf("/", "about://undefined".length);
        return marker >= 0 ? value.slice(marker) : "/";
      }
    }
    return value;
  };
  const bridgeFetch = async (url, init = {}) => {
    const requestUrl = normalizeBridgeRequestUrl(url);
    const headers = { ...(init.headers || {}) };
    const cookieKey = Object.keys(headers).find((key) => key.toLowerCase() === "cookie");
    const cookieHeader = cookieString();
    if (cookieHeader && (!cookieKey || !String(headers[cookieKey] || "").trim())) {
      if (cookieKey) headers[cookieKey] = cookieHeader;
      else headers.cookie = cookieHeader;
    }
    if (cookieStore.size && !Object.keys(headers).some((key) => key.toLowerCase() === "cookie")) {
      headers.cookie = cookieString();
    }
    headers.host ||= "edgeterm.local";
    headers.origin ||= "https://edgeterm.local";
    headers.referer ||= virtualUrl.href;
    headers["x-requested-with"] ||= "XMLHttpRequest";
    const result = await parent.EdgeTermAppModeBridge.fetch({
      url: requestUrl,
      method: (init.method || "GET").toUpperCase(),
      headers,
      body: init.body ?? null,
      currentPath: virtualPath(),
    });
    const debugKind = result?.headers?.["x-edgeterm-debug-kind"] || result?.headers?.["X-EdgeTerm-Debug-Kind"] || "";
    if (debugKind) {
      edgeServeLog("fetch", {
        method: (init.method || "GET").toUpperCase(),
        url: requestUrl,
        status: result.status,
        kind: debugKind,
        path: result.headers["x-edgeterm-request-path"] || result.headers["X-EdgeTerm-Request-Path"] || "",
        script: result.headers["x-edgeterm-php-script"] || result.headers["X-EdgeTerm-Php-Script"] || "",
        durationMs: result.headers["x-edgeterm-duration-ms"] || result.headers["X-EdgeTerm-Duration-Ms"] || result.headers["x-edgeterm-php-duration-ms"] || result.headers["X-EdgeTerm-Php-Duration-Ms"] || "",
        location: result.headers.location || result.headers.Location || "",
      });
    }
    const payload = result.bodyBase64
      ? Uint8Array.from(atob(result.bodyBase64), (char) => char.charCodeAt(0))
      : result.body;
    return new Response(payload, { status: result.status, headers: result.headers });
  };
  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);
  const safeHistoryState = (mode, state, title, url) => {
    const original = mode === "replace" ? originalReplaceState : originalPushState;
    updateVirtualUrl(url);
    patchBackboneHistory();
    try {
      original(state, title, url);
    } catch (err) {
      if (err?.name !== "SecurityError") throw err;
      edgeServeLog("history-security-suppressed", { mode, url: String(url || "") });
    }
  };
  history.pushState = (state, title, url) => safeHistoryState("push", state, title, url);
  history.replaceState = (state, title, url) => safeHistoryState("replace", state, title, url);
  window.open = (url = "", target = "", features = "") => {
    const destination = normalizeBridgeRequestUrl(String(url || "about:blank"));
    parent.EdgeTermAppModeBridge.openTab(destination, { target: String(target || ""), features: String(features || "") });
    return null;
  };
  const cssUrlBase = (url) => {
    try {
      return new URL(String(url || ""), \`https://edgeterm.local\${currentPath || "/"}\`).href;
    } catch {
      return \`https://edgeterm.local\${currentPath || "/"}\`;
    }
  };
  const rewriteCssUrls = async (cssText, stylesheetUrl) => {
    const text = String(cssText || "");
    const replacements = new Map();
    const tasks = [];
    const pattern = /url\\(\\s*(['"]?)([^'")]+)\\1\\s*\\)/gi;
    for (const match of text.matchAll(pattern)) {
      const rawUrl = String(match[2] || "").trim();
      if (!rawUrl || /^(data|blob|javascript|mailto):/i.test(rawUrl) || rawUrl.startsWith("#")) continue;
      let resolved = rawUrl;
      try {
        resolved = new URL(rawUrl, cssUrlBase(stylesheetUrl)).href;
      } catch {}
      if (!shouldIntercept(resolved)) continue;
      tasks.push(
        bridgeFetch(resolved)
          .then((response) => response.ok ? response.blob() : null)
          .then((blob) => {
            if (blob) replacements.set(match[0], \`url("\${URL.createObjectURL(blob)}")\`);
          })
          .catch(() => {})
      );
    }
    await Promise.all(tasks);
    let rewritten = text;
    for (const [source, target] of replacements) rewritten = rewritten.split(source).join(target);
    return rewritten;
  };
  const srcsetFirstUrl = (value) => {
    const first = String(value || "").split(",")[0]?.trim() || "";
    return first.split(/\\s+/)[0] || "";
  };
  const assetSelector = "[data-edgeterm-asset-url], img[src], img[srcset], script[src], link[rel~='stylesheet'][href], source[src], source[srcset], video[src], audio[src], video[poster]";
  const assetAttrForNode = (node, attrName = "") => {
    if (!(node instanceof Element)) return "";
    const attr = String(attrName || "").toLowerCase();
    const tag = node.tagName;
    if (tag === "SCRIPT" && attr === "src") return "src";
    if (tag === "IMG" && (attr === "src" || attr === "srcset")) return attr;
    if (tag === "SOURCE" && (attr === "src" || attr === "srcset")) return attr;
    if ((tag === "VIDEO" || tag === "AUDIO") && attr === "src") return "src";
    if (tag === "VIDEO" && attr === "poster") return "poster";
    if (tag === "LINK" && attr === "href" && /(?:^|\\s)stylesheet(?:\\s|$)/i.test(node.getAttribute("rel") || "")) return "href";
    return "";
  };
  const prepareBridgeAssetNode = (node, attr, rawUrl) => {
    const targetAttr = assetAttrForNode(node, attr);
    if (!targetAttr || !shouldIntercept(String(rawUrl || ""))) return false;
    node.dataset.edgetermAssetUrl = normalizeBridgeRequestUrl(String(rawUrl || ""));
    node.dataset.edgetermAssetAttr = targetAttr;
    try {
      originalRemoveAttribute.call(node, targetAttr);
      if (targetAttr !== "srcset" && node.hasAttribute("srcset")) originalRemoveAttribute.call(node, "srcset");
    } catch {}
    scheduleHydrateAssets();
    return true;
  };
  const hydrateInlineStyleUrl = (node) => {
    if (!(node instanceof Element)) return;
    const styleText = node.getAttribute("style") || "";
    if (!/url\\(/i.test(styleText) || node.dataset.edgetermStyleHydrating === "true") return;
    node.dataset.edgetermStyleHydrating = "true";
    rewriteCssUrls(styleText, currentPath)
      .then((rewritten) => {
        if (rewritten && rewritten !== styleText) node.setAttribute("style", rewritten);
      })
      .finally(() => {
        node.removeAttribute("data-edgeterm-style-hydrating");
      });
  };
  const hydrateAssetNode = (node) => {
    if (!(node instanceof Element)) return;
    hydrateInlineStyleUrl(node);
    if (!node.matches?.(assetSelector)) return;
    if (node.dataset.edgetermHydrating === "true") return;
    const attr = node.getAttribute("data-edgeterm-asset-attr")
      || (node.hasAttribute("href")
        ? "href"
        : node.hasAttribute("poster")
          ? "poster"
          : node.tagName === "SOURCE" && node.hasAttribute("srcset") && !node.hasAttribute("src")
            ? "srcset"
            : "src");
    const url = node.getAttribute("data-edgeterm-asset-url") || node.getAttribute(attr) || srcsetFirstUrl(node.getAttribute("srcset"));
    if (!shouldIntercept(url)) return;
    node.dataset.edgetermHydrating = "true";
    if (node.matches?.("link[rel~='stylesheet']")) {
      bridgeFetch(url)
        .then((response) => response.ok ? response.text() : "")
        .then((cssText) => cssText ? rewriteCssUrls(cssText, url) : "")
        .then((cssText) => {
          if (!cssText) return;
          const blobUrl = URL.createObjectURL(new Blob([cssText], { type: "text/css; charset=utf-8" }));
          node.setAttribute("href", blobUrl);
          node.removeAttribute("data-edgeterm-asset-url");
          node.removeAttribute("data-edgeterm-asset-attr");
        })
        .finally(() => {
          node.removeAttribute("data-edgeterm-hydrating");
        });
      return;
    }
    bridgeFetch(url)
      .then((response) => response.ok ? response.blob() : null)
      .then((blob) => {
        if (!blob) return;
        node.setAttribute(attr, URL.createObjectURL(blob));
        if (attr !== "srcset" && node.hasAttribute("srcset")) node.removeAttribute("srcset");
        node.removeAttribute("data-edgeterm-asset-url");
        node.removeAttribute("data-edgeterm-asset-attr");
      })
      .finally(() => {
        node.removeAttribute("data-edgeterm-hydrating");
      });
  };
  const hydrateAssets = () => {
    document.querySelectorAll(assetSelector + ", [style*='url('], [style*='URL(']").forEach(hydrateAssetNode);
  };
  let hydrateAssetsTimer = 0;
  const scheduleHydrateAssets = () => {
    clearTimeout(hydrateAssetsTimer);
    hydrateAssetsTimer = setTimeout(hydrateAssets, 25);
  };
  const originalSetAttribute = Element.prototype.setAttribute;
  const originalRemoveAttribute = Element.prototype.removeAttribute;
  const navigationSelector = "a[href], area[href], form[action]";
  const prepareBridgeNavigationNode = (node, attrName = "", rawUrl = null) => {
    if (!(node instanceof Element)) return false;
    const tag = node.tagName;
    const attr = String(attrName || "").toLowerCase();
    const isLink = (tag === "A" || tag === "AREA") && attr === "href";
    const isForm = tag === "FORM" && attr === "action";
    if (!isLink && !isForm) return false;
    const source = rawUrl == null ? node.getAttribute(attr) : rawUrl;
    const destination = normalizeBridgeRequestUrl(String(source || ""));
    if (!shouldIntercept(destination)) return false;
    originalSetAttribute.call(node, "data-edgeterm-nav-url", destination);
    originalSetAttribute.call(node, attr, isLink ? "#" : "");
    return true;
  };
  const hydrateNavigationNode = (node) => {
    if (!(node instanceof Element)) return;
    if (node.matches?.(navigationSelector)) {
      prepareBridgeNavigationNode(node, node.hasAttribute("href") ? "href" : "action");
    }
    for (const child of Array.from(node.querySelectorAll?.(navigationSelector) || [])) {
      prepareBridgeNavigationNode(child, child.hasAttribute("href") ? "href" : "action");
    }
  };
  const patchNavigationUrlProperty = (proto, property, attr) => {
    if (!proto) return;
    const descriptor = Object.getOwnPropertyDescriptor(proto, property);
    if (!descriptor?.set || !descriptor?.get) return;
    Object.defineProperty(proto, property, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(value) {
        if (prepareBridgeNavigationNode(this, attr, value)) return;
        descriptor.set.call(this, value);
      },
    });
  };
  Element.prototype.setAttribute = function(name, value) {
    const attr = String(name || "");
    if (!/^data-edgeterm-/i.test(attr) && prepareBridgeNavigationNode(this, attr, value)) return;
    if (!/^data-edgeterm-/i.test(attr) && prepareBridgeAssetNode(this, attr, value)) return;
    return originalSetAttribute.call(this, name, value);
  };
  const patchUrlProperty = (proto, property, attr) => {
    if (!proto) return;
    const descriptor = Object.getOwnPropertyDescriptor(proto, property);
    if (!descriptor?.set || !descriptor?.get) return;
    Object.defineProperty(proto, property, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(value) {
        if (prepareBridgeAssetNode(this, attr, value)) return;
        descriptor.set.call(this, value);
      },
    });
  };
  patchUrlProperty(window.HTMLScriptElement?.prototype, "src", "src");
  patchUrlProperty(window.HTMLImageElement?.prototype, "src", "src");
  patchUrlProperty(window.HTMLImageElement?.prototype, "srcset", "srcset");
  patchUrlProperty(window.HTMLSourceElement?.prototype, "src", "src");
  patchUrlProperty(window.HTMLSourceElement?.prototype, "srcset", "srcset");
  patchUrlProperty(window.HTMLLinkElement?.prototype, "href", "href");
  patchUrlProperty(window.HTMLVideoElement?.prototype, "src", "src");
  patchUrlProperty(window.HTMLVideoElement?.prototype, "poster", "poster");
  patchUrlProperty(window.HTMLAudioElement?.prototype, "src", "src");
  patchNavigationUrlProperty(window.HTMLAnchorElement?.prototype, "href", "href");
  patchNavigationUrlProperty(window.HTMLAreaElement?.prototype, "href", "href");
  patchNavigationUrlProperty(window.HTMLFormElement?.prototype, "action", "action");
  window.fetch = async (input, init = {}) => {
    const url = normalizeBridgeRequestUrl(typeof input === "string" ? input : input?.url || "");
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
  const OriginalXMLHttpRequest = window.XMLHttpRequest;
  class EdgeTermUploadTarget extends EventTarget {
    constructor() {
      super();
      this.onloadstart = null;
      this.onprogress = null;
      this.onload = null;
      this.onerror = null;
      this.onloadend = null;
      this.onabort = null;
    }
    emit(type, init = {}) {
      const loaded = Number(init.loaded || 0);
      const total = Number(init.total || 0);
      const event = new ProgressEvent(type, {
        lengthComputable: !!init.lengthComputable,
        loaded,
        total,
      });
      this.dispatchEvent(event);
      const handler = this["on" + type];
      if (typeof handler === "function") handler.call(this, event);
    }
  }
  class EdgeTermXMLHttpRequest extends EventTarget {
    static UNSENT = 0;
    static OPENED = 1;
    static HEADERS_RECEIVED = 2;
    static LOADING = 3;
    static DONE = 4;
    constructor() {
      super();
      this.readyState = EdgeTermXMLHttpRequest.UNSENT;
      this.response = "";
      this.responseText = "";
      this.responseType = "";
      this.responseURL = "";
      this.responseXML = null;
      this.status = 0;
      this.statusText = "";
      this.timeout = 0;
      this.withCredentials = false;
      this.onreadystatechange = null;
      this.onload = null;
      this.onerror = null;
      this.onloadend = null;
      this.onloadstart = null;
      this.onabort = null;
      this.ontimeout = null;
      this.onprogress = null;
      this.upload = new EdgeTermUploadTarget();
      this._method = "GET";
      this._url = "";
      this._async = true;
      this._headers = {};
      this._responseHeaders = {};
      this._responseHeaderLines = "";
      this._aborted = false;
      this._native = null;
    }
    open(method, url, async = true) {
      this._method = String(method || "GET").toUpperCase();
      this._url = normalizeBridgeRequestUrl(url);
      this._async = async !== false;
      this._headers = {};
      this._setReadyState(EdgeTermXMLHttpRequest.OPENED);
    }
    setRequestHeader(name, value) {
      this._headers[String(name)] = String(value);
    }
    overrideMimeType() {}
    abort() {
      this._aborted = true;
      try {
        this._native?.abort?.();
      } catch {}
      this.status = 0;
      this.statusText = "";
      this._setReadyState(EdgeTermXMLHttpRequest.DONE);
      this.upload.emit("abort");
      this.upload.emit("loadend");
      this._emit("abort");
      this._emit("loadend");
    }
    getAllResponseHeaders() {
      return this.readyState < EdgeTermXMLHttpRequest.HEADERS_RECEIVED ? "" : this._responseHeaderLines;
    }
    getResponseHeader(name) {
      if (this.readyState < EdgeTermXMLHttpRequest.HEADERS_RECEIVED) return null;
      return this._responseHeaders[String(name || "").toLowerCase()] || null;
    }
    async send(body = null) {
      if (!this._async) throw new DOMException("Synchronous XMLHttpRequest is not supported in EdgeServe preview.", "NotSupportedError");
      if (!shouldIntercept(this._url) && OriginalXMLHttpRequest) {
        const native = new OriginalXMLHttpRequest();
        this._native = native;
        native.open(this._method, this._url, true);
        native.responseType = this.responseType || "";
        native.withCredentials = this.withCredentials;
        native.timeout = this.timeout;
        for (const [name, value] of Object.entries(this._headers)) native.setRequestHeader(name, value);
        for (const type of ["loadstart", "progress", "load", "error", "abort", "timeout", "loadend"]) {
          native.upload?.addEventListener?.(type, (event) => this.upload.emit(type, event));
        }
        native.onreadystatechange = () => {
          this.readyState = native.readyState;
          this._emit("readystatechange");
        };
        native.onload = () => {
          this.status = native.status;
          this.statusText = native.statusText;
          this.response = native.response;
          try {
            this.responseText = native.responseText;
          } catch {
            this.responseText = "";
          }
          this.responseURL = native.responseURL;
          this._responseHeaderLines = native.getAllResponseHeaders();
          this._setReadyState(EdgeTermXMLHttpRequest.DONE);
          this._emit("load");
          this._emit("loadend");
        };
        native.onerror = () => {
          this.status = native.status || 0;
          this._setReadyState(EdgeTermXMLHttpRequest.DONE);
          this._emit("error");
          this._emit("loadend");
        };
        native.send(body);
        return;
      }
      this._aborted = false;
      this._emit("loadstart");
      let uploadTotal = 0;
      try {
        if (body instanceof Blob) uploadTotal = Number(body.size || 0);
        else if (body instanceof ArrayBuffer) uploadTotal = body.byteLength;
        else if (ArrayBuffer.isView(body)) uploadTotal = body.byteLength;
        else uploadTotal = String(body || "").length;
      } catch {}
      this.upload.emit("loadstart", { loaded: 0, total: uploadTotal, lengthComputable: uploadTotal > 0 });
      try {
        const response = await bridgeFetch(this._url, { method: this._method, headers: this._headers, body });
        if (this._aborted) return;
        this.upload.emit("progress", { loaded: uploadTotal, total: uploadTotal, lengthComputable: uploadTotal > 0 });
        this.upload.emit("load", { loaded: uploadTotal, total: uploadTotal, lengthComputable: uploadTotal > 0 });
        this.upload.emit("loadend", { loaded: uploadTotal, total: uploadTotal, lengthComputable: uploadTotal > 0 });
        this.status = response.status;
        this.statusText = response.statusText || "";
        this.responseURL = new URL(this._url, virtualUrl.href).href;
        this._responseHeaders = {};
        this._responseHeaderLines = "";
        response.headers.forEach((value, name) => {
          this._responseHeaders[String(name).toLowerCase()] = value;
          this._responseHeaderLines += \`\${name}: \${value}\\r\\n\`;
        });
        this._setReadyState(EdgeTermXMLHttpRequest.HEADERS_RECEIVED);
        this._setReadyState(EdgeTermXMLHttpRequest.LOADING);
        if (this.responseType === "blob") {
          this.response = await response.blob();
          this.responseText = "";
        } else if (this.responseType === "arraybuffer") {
          this.response = await response.arrayBuffer();
          this.responseText = "";
        } else if (this.responseType === "json") {
          this.responseText = await response.text();
          try {
            this.response = this.responseText ? JSON.parse(this.responseText) : null;
          } catch {
            this.response = null;
          }
        } else {
          this.responseText = await response.text();
          this.response = this.responseText;
        }
        this._setReadyState(EdgeTermXMLHttpRequest.DONE);
        this._emit("load");
        this._emit("loadend");
      } catch (err) {
        if (this._aborted) return;
        this.upload.emit("error", { loaded: 0, total: uploadTotal, lengthComputable: uploadTotal > 0 });
        this.upload.emit("loadend", { loaded: 0, total: uploadTotal, lengthComputable: uploadTotal > 0 });
        this.status = 0;
        this.statusText = "";
        this._setReadyState(EdgeTermXMLHttpRequest.DONE);
        this._emit("error");
        this._emit("loadend");
      }
    }
    _setReadyState(state) {
      this.readyState = state;
      this._emit("readystatechange");
    }
    _emit(type) {
      const event = new Event(type);
      this.dispatchEvent(event);
      const handler = this["on" + type];
      if (typeof handler === "function") {
        try {
          handler.call(this, event);
        } catch (err) {
          setTimeout(() => { throw err; }, 0);
        }
      }
    }
  }
  EdgeTermXMLHttpRequest.prototype.UNSENT = EdgeTermXMLHttpRequest.UNSENT;
  EdgeTermXMLHttpRequest.prototype.OPENED = EdgeTermXMLHttpRequest.OPENED;
  EdgeTermXMLHttpRequest.prototype.HEADERS_RECEIVED = EdgeTermXMLHttpRequest.HEADERS_RECEIVED;
  EdgeTermXMLHttpRequest.prototype.LOADING = EdgeTermXMLHttpRequest.LOADING;
  EdgeTermXMLHttpRequest.prototype.DONE = EdgeTermXMLHttpRequest.DONE;
  window.XMLHttpRequest = EdgeTermXMLHttpRequest;
  const OriginalWebSocket = window.WebSocket;
  const toBase64 = async (value) => {
    let bytes;
    if (value instanceof Blob) {
      bytes = new Uint8Array(await value.arrayBuffer());
    } else if (value instanceof ArrayBuffer) {
      bytes = new Uint8Array(value);
    } else if (ArrayBuffer.isView(value)) {
      bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    } else {
      return { kind: "text", data: String(value ?? "") };
    }
    let text = "";
    for (let index = 0; index < bytes.length; index += 32768) {
      text += String.fromCharCode(...bytes.subarray(index, index + 32768));
    }
    return { kind: "bytes", dataBase64: btoa(text) };
  };
  const fromBase64 = (value, binaryType) => {
    const bytes = Uint8Array.from(atob(value || ""), (char) => char.charCodeAt(0));
    if (binaryType === "arraybuffer") return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return new Blob([bytes]);
  };
  const bridgedWebSockets = new Set();
  class EdgeTermWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url, protocols = []) {
      super();
      if (!shouldInterceptWebSocket(String(url || "")) && OriginalWebSocket) {
        return new OriginalWebSocket(url, protocols);
      }
      this.url = String(url || "");
      this.protocol = "";
      this.extensions = "";
      this.binaryType = "blob";
      this.bufferedAmount = 0;
      this.readyState = EdgeTermWebSocket.CONNECTING;
      this._id = \`ws-\${Date.now().toString(36)}-\${Math.random().toString(36).slice(2)}\`;
      this._closed = false;
      this._pollTimer = 0;
      this._protocols = Array.isArray(protocols) ? protocols : protocols ? [protocols] : [];
      bridgedWebSockets.add(this);
      this._open();
    }
    async _open() {
      try {
        const result = await parent.EdgeTermAppModeBridge.websocketOpen({
          id: this._id,
          url: this.url,
          protocols: this._protocols,
          currentPath: virtualPath(),
        });
        if (!result?.ok) {
          this._finishClose(result?.status || 1006, result?.reason || "WebSocket connection failed");
          return;
        }
        this.protocol = result.subprotocol || "";
        this.readyState = EdgeTermWebSocket.OPEN;
        this.dispatchEvent(new Event("open"));
        this._poll();
      } catch (err) {
        this.dispatchEvent(new Event("error"));
        this._finishClose(1006, err?.message || "WebSocket connection failed");
      }
    }
    async _poll() {
      if (this._closed || this.readyState === EdgeTermWebSocket.CLOSED) return;
      try {
        const result = await parent.EdgeTermAppModeBridge.websocketPoll({ id: this._id });
        for (const event of result?.events || []) {
          if (event.type === "message") {
            const data = event.kind === "bytes" ? fromBase64(event.dataBase64 || "", this.binaryType) : String(event.data || "");
            this.dispatchEvent(new MessageEvent("message", { data, origin: "edgeterm.local" }));
          } else if (event.type === "close") {
            this._finishClose(event.code || 1000, event.reason || "");
            return;
          }
        }
      } catch (err) {
        this.dispatchEvent(new Event("error"));
        this._finishClose(1006, err?.message || "WebSocket polling failed");
        return;
      }
      this._pollTimer = setTimeout(() => this._poll(), 0);
    }
    async send(data) {
      if (this.readyState !== EdgeTermWebSocket.OPEN) throw new DOMException("WebSocket is not open", "InvalidStateError");
      const payload = await toBase64(data);
      await parent.EdgeTermAppModeBridge.websocketSend({ id: this._id, ...payload });
    }
    close(code = 1000, reason = "") {
      if (this.readyState === EdgeTermWebSocket.CLOSING || this.readyState === EdgeTermWebSocket.CLOSED) return;
      this.readyState = EdgeTermWebSocket.CLOSING;
      parent.EdgeTermAppModeBridge.websocketClose({ id: this._id, code, reason }).catch(() => {});
      this._finishClose(code, reason);
    }
    _finishClose(code = 1000, reason = "") {
      if (this._closed) return;
      this._closed = true;
      bridgedWebSockets.delete(this);
      clearTimeout(this._pollTimer);
      this.readyState = EdgeTermWebSocket.CLOSED;
      this.dispatchEvent(new CloseEvent("close", { code: Number(code) || 1000, reason: String(reason || ""), wasClean: Number(code) === 1000 }));
    }
    set onopen(handler) { this._setHandler("open", handler); }
    get onopen() { return this._onopen || null; }
    set onmessage(handler) { this._setHandler("message", handler); }
    get onmessage() { return this._onmessage || null; }
    set onerror(handler) { this._setHandler("error", handler); }
    get onerror() { return this._onerror || null; }
    set onclose(handler) { this._setHandler("close", handler); }
    get onclose() { return this._onclose || null; }
    _setHandler(type, handler) {
      const key = \`_on\${type}\`;
      if (this[key]) this.removeEventListener(type, this[key]);
      this[key] = typeof handler === "function" ? handler : null;
      if (this[key]) this.addEventListener(type, this[key]);
    }
  }
  EdgeTermWebSocket.prototype.CONNECTING = EdgeTermWebSocket.CONNECTING;
  EdgeTermWebSocket.prototype.OPEN = EdgeTermWebSocket.OPEN;
  EdgeTermWebSocket.prototype.CLOSING = EdgeTermWebSocket.CLOSING;
  EdgeTermWebSocket.prototype.CLOSED = EdgeTermWebSocket.CLOSED;
  window.WebSocket = EdgeTermWebSocket;
  if (edgeServeDebug?.enabled) {
    edgeServeLog("document", edgeServeDebug);
  }
  const hydrateBridgeDocument = () => {
    hydrateAssets();
    hydrateNavigationNode(document.documentElement);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hydrateBridgeDocument, { once: true });
  else hydrateBridgeDocument();
  try {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes") {
          hydrateNavigationNode(mutation.target);
          hydrateAssetNode(mutation.target);
          continue;
        }
        for (const node of mutation.addedNodes || []) {
          if (!(node instanceof Element)) continue;
          hydrateNavigationNode(node);
          hydrateAssetNode(node);
          if (node.querySelector?.(assetSelector + ", [style*='url('], [style*='URL(']")) {
            scheduleHydrateAssets();
          }
        }
      }
    });
    const observeDocument = () => {
      if (!document.documentElement) return;
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "srcset", "href", "action", "poster", "style", "data-edgeterm-asset-url"],
      });
    };
    if (document.documentElement) observeDocument();
    else document.addEventListener("DOMContentLoaded", observeDocument, { once: true });
  } catch {}
  const handleInternalLinkClick = (event) => {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const link = target?.closest?.("a[href], area[href]");
    if (!link) return;
    const href = link.getAttribute("data-edgeterm-nav-url") || link.getAttribute("href");
    if (event.defaultPrevented) return;
    if (!shouldIntercept(href)) return;
    const destination = normalizeBridgeRequestUrl(href);
    if (link.target === "_blank" || event.button === 1 || event.metaKey || event.ctrlKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      parent.EdgeTermAppModeBridge.openTab(destination);
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    parent.EdgeTermAppModeBridge.navigate(destination);
  };
  document.addEventListener("click", handleInternalLinkClick, true);
  document.addEventListener("auxclick", handleInternalLinkClick, true);
  document.addEventListener("submit", async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    const action = normalizeBridgeRequestUrl(form.getAttribute("data-edgeterm-nav-url") || form.getAttribute("action") || virtualPath());
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
  window.addEventListener("beforeunload", () => {
    syncSiteData();
    for (const socket of bridgedWebSockets) {
      parent.EdgeTermAppModeBridge.websocketClose({ id: socket._id, code: 1001, reason: "Frame unloaded" }).catch(() => {});
    }
  });
})();
`;
      }
