import * as esbuild from "esbuild-wasm";
import {
  htmlModuleEntrypoint,
  replaceHtmlModuleEntrypoint,
} from "./html-entrypoint.js";

let initialized = false;
const textDecoder = new TextDecoder();

function post(type, payload = {}) {
  self.postMessage({ type, ...payload });
}

function normalizePath(value) {
  const parts = [];
  for (const part of String(value || "").replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function dirname(path) {
  const parts = normalizePath(path).split("/");
  parts.pop();
  return parts.join("/");
}

function joinPath(...values) {
  return normalizePath(values.filter(Boolean).join("/"));
}

function decodeFile(file) {
  if (file.encoding === "base64") {
    const binary = atob(String(file.data || ""));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  return String(file.text ?? file.data ?? "");
}

function textFile(file) {
  const value = decodeFile(file);
  return typeof value === "string" ? value : textDecoder.decode(value);
}

function loaderFor(path) {
  const extension = path.split(".").pop()?.toLowerCase() || "";
  return {
    js: "jsx",
    mjs: "jsx",
    cjs: "jsx",
    jsx: "jsx",
    ts: "ts",
    tsx: "tsx",
    json: "json",
    css: "css",
    txt: "text",
    svg: "dataurl",
    png: "dataurl",
    jpg: "dataurl",
    jpeg: "dataurl",
    gif: "dataurl",
    webp: "dataurl",
    avif: "dataurl",
    woff: "dataurl",
    woff2: "dataurl",
  }[extension] || "text";
}

function packageNameFor(specifier) {
  const parts = String(specifier || "").split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function packageSubpath(specifier) {
  const packageName = packageNameFor(specifier);
  return specifier.slice(packageName.length).replace(/^\/+/, "");
}

function exportTarget(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  for (const condition of ["browser", "import", "module", "default", "development"]) {
    const target = exportTarget(value[condition]);
    if (target) return target;
  }
  return "";
}

function createResolver(files) {
  const extensions = ["", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".json", ".css"];
  const readPackage = (root) => {
    const entry = files.get(joinPath(root, "package.json"));
    if (!entry) return {};
    try {
      return JSON.parse(textFile(entry));
    } catch {
      return {};
    }
  };
  const resolveFile = (candidate) => {
    const normalized = normalizePath(candidate);
    for (const extension of extensions) {
      const path = `${normalized}${extension}`;
      if (files.has(path)) return path;
    }
    const packageJsonPath = joinPath(normalized, "package.json");
    if (files.has(packageJsonPath)) {
      const metadata = readPackage(normalized);
      const target =
        (typeof metadata.browser === "string" && metadata.browser) ||
        metadata.module ||
        metadata.main ||
        "index.js";
      const resolved = resolveFile(joinPath(normalized, target));
      if (resolved) return resolved;
    }
    for (const extension of extensions.slice(1)) {
      const path = joinPath(normalized, `index${extension}`);
      if (files.has(path)) return path;
    }
    return "";
  };
  const resolveBare = (specifier, importer) => {
    const packageName = packageNameFor(specifier);
    const subpath = packageSubpath(specifier);
    let current = dirname(importer);
    while (true) {
      const packageRoot = joinPath(current, "node_modules", packageName);
      if (files.has(joinPath(packageRoot, "package.json"))) {
        const metadata = readPackage(packageRoot);
        if (subpath) {
          const exportsValue = metadata.exports?.[`./${subpath}`];
          const target = exportTarget(exportsValue) || subpath;
          return resolveFile(joinPath(packageRoot, target));
        }
        const target =
          exportTarget(metadata.exports?.["."] ?? metadata.exports) ||
          (typeof metadata.browser === "string" && metadata.browser) ||
          metadata.module ||
          metadata.main ||
          "index.js";
        return resolveFile(joinPath(packageRoot, target));
      }
      if (!current) break;
      current = dirname(current);
    }
    return "";
  };
  return {
    resolve(specifier, importer = "") {
      if (/^(?:node:|fs$|path$|http$|https$|net$|tls$|child_process$)/.test(specifier)) {
        throw new Error(`Node built-in module is not available in browser builds: ${specifier}`);
      }
      if (specifier.startsWith("/") || specifier.startsWith(".")) {
        const base = specifier.startsWith("/")
          ? specifier.slice(1)
          : joinPath(dirname(importer), specifier);
        return resolveFile(base);
      }
      return resolveBare(specifier, importer);
    },
  };
}

function findHtmlEntrypoint(files) {
  if (files.has("index.html")) return "index.html";
  const candidates = ["src/main.tsx", "src/main.jsx", "src/main.ts", "src/main.js", "main.js"];
  return candidates.find((path) => files.has(path)) || "";
}

function readJsonFile(files, path) {
  const file = files.get(path);
  if (!file) return {};
  try {
    return JSON.parse(textFile(file));
  } catch {
    return {};
  }
}

function detectNextProject(files) {
  const metadata = readJsonFile(files, "package.json");
  const dependencies = {
    ...(metadata.dependencies || {}),
    ...(metadata.devDependencies || {}),
  };
  const scripts = Object.values(metadata.scripts || {}).join(" ");
  const nextDetected = Boolean(dependencies.next) || /(?:^|\s)next(?:\s|$)/.test(scripts);
  if (!nextDetected) return null;

  const rootCandidates = [
    "app/page.tsx",
    "app/page.jsx",
    "app/page.ts",
    "app/page.js",
    "src/app/page.tsx",
    "src/app/page.jsx",
    "src/app/page.ts",
    "src/app/page.js",
    "pages/index.tsx",
    "pages/index.jsx",
    "pages/index.ts",
    "pages/index.js",
    "src/pages/index.tsx",
    "src/pages/index.jsx",
    "src/pages/index.ts",
    "src/pages/index.js",
  ];
  const page = rootCandidates.find((path) => files.has(path));
  if (!page) {
    throw Object.assign(
      new Error("Next.js static preview requires app/page or pages/index."),
      { code: "next_static_entrypoint_missing" },
    );
  }

  const appDirectory = /(?:^|\/)app\/page\.[cm]?[jt]sx?$/.test(page);
  const root = page.replace(/(?:app\/page|pages\/index)\.[cm]?[jt]sx?$/, "");
  const routePrefix = appDirectory ? joinPath(root, "app") : joinPath(root, "pages");
  const routePattern = appDirectory
    ? /(?:^|\/)app\/(.*\/)?page\.[cm]?[jt]sx?$/
    : /(?:^|\/)pages\/(.+)\.[cm]?[jt]sx?$/;
  const routes = [];
  for (const path of files.keys()) {
    if (!path.startsWith(`${routePrefix}/`) && path !== `${routePrefix}/page.js`) continue;
    const match = path.match(routePattern);
    if (!match) continue;
    const routeSource = textFile(files.get(path));
    const unsupported = [
      ["next/headers", "next/headers"],
      ["next/server", "next/server"],
      ["server-only", "server-only"],
      ["getServerSideProps", "getServerSideProps"],
      ["getInitialProps", "getInitialProps"],
    ].find(([pattern]) => routeSource.includes(pattern));
    if (unsupported) {
      throw Object.assign(
        new Error(
          `Next.js server feature ${unsupported[1]} cannot run in the browser-local static adapter.`,
        ),
        { code: "next_ssr_unsupported" },
      );
    }
    const rawRoute = appDirectory
      ? String(match[1] || "").replace(/\/$/, "")
      : String(match[1] || "").replace(/(?:^|\/)index$/, "");
    if (rawRoute.split("/").some((part) => /^\[.*\]$/.test(part))) {
      throw Object.assign(
        new Error(`Dynamic Next.js route ${rawRoute} requires a server or static parameters.`),
        { code: "next_dynamic_route_unsupported" },
      );
    }
    if (!appDirectory && /(?:^|\/)(?:_app|_document|_error|api)(?:\/|$)/.test(rawRoute)) continue;
    routes.push({ route: rawRoute ? `/${rawRoute}` : "/", page: path });
  }
  routes.sort((left, right) => left.route.localeCompare(right.route));
  const globalCssCandidates = appDirectory
    ? [joinPath(root, "app/globals.css"), joinPath(root, "app/global.css")]
    : [joinPath(root, "styles/globals.css"), joinPath(root, "styles/global.css")];
  const globalCss = globalCssCandidates.find((path) => files.has(path)) || "";
  const customAppCandidates = [
    joinPath(root, "pages/_app.tsx"),
    joinPath(root, "pages/_app.jsx"),
    joinPath(root, "pages/_app.ts"),
    joinPath(root, "pages/_app.js"),
  ];
  const customApp = appDirectory
    ? ""
    : customAppCandidates.find((path) => files.has(path)) || "";

  return {
    page,
    routes,
    globalCss,
    customApp,
    appDirectory,
  };
}

function createNextEntrypoint(nextProject) {
  const imports = [
    'import React from "react";',
    'import { createRoot } from "react-dom/client";',
  ];
  const routes = nextProject.routes?.length
    ? nextProject.routes
    : [{ route: "/", page: nextProject.page }];
  routes.forEach((route, index) => imports.push(`import Page${index} from "./${route.page}";`));
  if (nextProject.globalCss) imports.push(`import "./${nextProject.globalCss}";`);
  if (nextProject.customApp) imports.push(`import App from "./${nextProject.customApp}";`);
  const routeMap = routes
    .map((route, index) => `${JSON.stringify(route.route)}: Page${index}`)
    .join(",\n  ");
  const component = nextProject.customApp
    ? '<App Component={Page} pageProps={{}} router={{ pathname, route: pathname, query: {}, asPath: pathname }} />'
    : "<Page />";
  return `${imports.join("\n")}

const routes = {
  ${routeMap}
};

function normalizeRoute(pathname) {
  const value = String(pathname || "/").replace(/\\/+$/, "");
  return value || "/";
}

function RouterView() {
  const currentLocation = () => window.__EDGETERM_APP_LOCATION__ || window.location;
  const [pathname, setPathname] = React.useState(() => normalizeRoute(currentLocation().pathname));
  React.useEffect(() => {
    const update = () => setPathname(normalizeRoute(currentLocation().pathname));
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  const Page = routes[pathname];
  if (!Page) return <main><h1>Page not found</h1></main>;
  return ${component};
}

const root = createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <RouterView />
  </React.StrictMode>,
);
`;
}

function nextShimSource(specifier) {
  if (specifier === "next/link") {
    return `
import React from "react";
function hrefValue(href) {
  if (typeof href === "string") return href;
  if (!href || typeof href !== "object") return "#";
  const query = href.query ? new URLSearchParams(href.query).toString() : "";
  return String(href.pathname || "/") + (query ? "?" + query : "");
}
export default React.forwardRef(function Link({ href, replace, scroll, prefetch, locale, children, ...props }, ref) {
  return React.createElement("a", { ...props, ref, href: hrefValue(href) }, children);
});
`;
  }
  if (specifier === "next/image") {
    return `
import React from "react";
export default React.forwardRef(function Image({ src, alt = "", width, height, fill, priority, quality, loader, unoptimized, ...props }, ref) {
  const value = typeof src === "string" ? src : src?.src || "";
  const style = fill ? { ...(props.style || {}), position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: props.style?.objectFit || "cover" } : props.style;
  return React.createElement("img", { ...props, ref, src: value, alt, width: fill ? undefined : width, height: fill ? undefined : height, style });
});
`;
  }
  if (specifier === "next/navigation" || specifier === "next/router") {
    return `
import React from "react";
const currentLocation = () => window.__EDGETERM_APP_LOCATION__ || window.location;
const navigate = (url, replace = false) => {
  const target = typeof url === "string" ? url : String(url?.pathname || "/");
  window.history[replace ? "replaceState" : "pushState"]({}, "", target);
  window.dispatchEvent(new PopStateEvent("popstate"));
};
export function useRouter() {
  return {
    push: (url) => navigate(url),
    replace: (url) => navigate(url, true),
    back: () => window.history.back(),
    forward: () => window.history.forward(),
    refresh: () => currentLocation().reload(),
    prefetch: async () => {},
    pathname: currentLocation().pathname,
    route: currentLocation().pathname,
    asPath: currentLocation().pathname,
    query: Object.fromEntries(new URLSearchParams(currentLocation().search)),
    isReady: true,
  };
}
export function usePathname() { return currentLocation().pathname; }
export function useSearchParams() { return new URLSearchParams(currentLocation().search); }
export function useParams() { return {}; }
export function useSelectedLayoutSegment() { return null; }
export function useSelectedLayoutSegments() { return []; }
export function redirect(url) { currentLocation().assign(url); }
export function permanentRedirect(url) { currentLocation().replace(url); }
export function notFound() { throw new Error("Next.js notFound() was called."); }
export const RouterContext = React.createContext(null);
export default { useRouter };
`;
  }
  if (specifier === "next/head") {
    return `
import React from "react";
export default function Head({ children }) {
  React.useEffect(() => {
    const title = React.Children.toArray(children).find((child) => child?.type === "title");
    if (title?.props?.children) document.title = String(title.props.children);
  }, [children]);
  return null;
}
`;
  }
  if (specifier === "next/script") {
    return `
import React from "react";
export default function Script(props) {
  const { strategy, onReady, ...scriptProps } = props;
  return React.createElement("script", scriptProps);
}
`;
  }
  if (specifier === "next/dynamic") {
    return `
import React from "react";
export default function dynamic(loader, options = {}) {
  const Lazy = React.lazy(async () => {
    const loaded = await loader();
    return loaded?.default ? loaded : { default: loaded };
  });
  return function DynamicComponent(props) {
    return React.createElement(React.Suspense, { fallback: options.loading ? React.createElement(options.loading) : null }, React.createElement(Lazy, props));
  };
}
`;
  }
  if (specifier === "next/config") {
    return "export default function getConfig() { return { publicRuntimeConfig: {}, serverRuntimeConfig: {} }; }";
  }
  if (specifier === "next/font/google" || specifier === "next/font/local") {
    return `
const font = () => ({ className: "", style: {}, variable: "" });
export const Inter = font;
export const Roboto = font;
export const Geist = font;
export const Geist_Mono = font;
export const Open_Sans = font;
export const Lato = font;
export const Montserrat = font;
export const Poppins = font;
export default font;
`;
  }
  throw Object.assign(
    new Error(`Next.js module ${specifier} is not available in the static adapter.`),
    { code: "next_module_unsupported" },
  );
}

function replaceHtmlEntrypoint(html, cssOutput) {
  let output = String(html || "");
  const replacement = '<script type="module" src="./assets/app.js"></script>';
  const replaced = replaceHtmlModuleEntrypoint(output, replacement);
  if (replaced === output) {
    output = output.replace(/<\/body>/i, `${replacement}</body>`);
  } else {
    output = replaced;
  }
  if (cssOutput && !/href=["'][^"']*assets\/app\.css["']/.test(output)) {
    const link = '<link rel="stylesheet" href="./assets/app.css">';
    output = /<\/head>/i.test(output)
      ? output.replace(/<\/head>/i, `${link}</head>`)
      : `${link}${output}`;
  }
  return output;
}

async function initialize() {
  if (initialized) return;
  await esbuild.initialize({
    wasmURL: new URL("./esbuild.wasm", self.location.href).toString(),
    worker: false,
  });
  initialized = true;
}

async function buildProject(payload = {}) {
  await initialize();
  const files = new Map();
  for (const file of Array.isArray(payload.files) ? payload.files : []) {
    const path = normalizePath(file?.path);
    if (path) files.set(path, file);
  }
  const nextProject = detectNextProject(files);
  const generatedNextEntrypoint = "__edgeterm_next_entry.tsx";
  if (nextProject) {
    files.set(generatedNextEntrypoint, {
      path: generatedNextEntrypoint,
      encoding: "text",
      data: createNextEntrypoint(nextProject),
    });
  }
  const detected = nextProject ? generatedNextEntrypoint : findHtmlEntrypoint(files);
  if (!detected) {
    throw Object.assign(new Error("No index.html or frontend entry file was found."), {
      code: "frontend_entrypoint_missing",
    });
  }
  const htmlPath = detected.endsWith(".html") ? detected : "";
  const html = htmlPath ? textFile(files.get(htmlPath)) : "";
  const entrypoint = htmlPath ? htmlModuleEntrypoint(html) : detected;
  if (!entrypoint || !files.has(entrypoint)) {
    throw Object.assign(
      new Error(`The frontend entry file was not found: ${entrypoint || "(missing)"}`),
      { code: "frontend_entrypoint_missing" },
    );
  }
  const resolver = createResolver(files);
  const plugin = {
    name: "edgeterm-virtual-workspace",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") {
          return { path: normalizePath(args.path), namespace: "edgeterm" };
        }
        if (args.path.startsWith("next/")) {
          return { path: args.path, namespace: "edgeterm-next-shim" };
        }
        const path = resolver.resolve(args.path, args.importer);
        if (!path) {
          return {
            errors: [
              {
                text: `Unable to resolve "${args.path}" from ${args.importer || "the project entrypoint"}`,
              },
            ],
          };
        }
        return { path, namespace: "edgeterm" };
      });
      build.onLoad({ filter: /.*/, namespace: "edgeterm" }, (args) => {
        const file = files.get(args.path);
        if (!file) return { errors: [{ text: `File not found: ${args.path}` }] };
        return {
          contents: decodeFile(file),
          loader: loaderFor(args.path),
          resolveDir: dirname(args.path),
        };
      });
      build.onLoad({ filter: /.*/, namespace: "edgeterm-next-shim" }, (args) => {
        try {
          return {
            contents: nextShimSource(args.path),
            loader: "js",
          };
        } catch (error) {
          return {
            errors: [{ text: error.message || String(error) }],
          };
        }
      });
    },
  };
  const result = await esbuild.build({
    entryPoints: [entrypoint],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: ["es2020"],
    jsx: "automatic",
    sourcemap: false,
    minify: Boolean(payload.production),
    outdir: "dist/assets",
    entryNames: "app",
    assetNames: "[name]-[hash]",
    define: {
      "process.env.NODE_ENV": JSON.stringify(payload.production ? "production" : "development"),
      global: "globalThis",
    },
    plugins: [plugin],
    logLevel: "silent",
  });
  const outputFiles = [];
  let hasCss = false;
  for (const file of result.outputFiles || []) {
    const name = normalizePath(file.path).split("/dist/").pop() || normalizePath(file.path);
    const relative = name.startsWith("assets/") ? `dist/${name}` : `dist/assets/${name.split("/").pop()}`;
    hasCss ||= relative.endsWith(".css");
    outputFiles.push({
      path: relative,
      encoding: "base64",
      data: btoa(
        Array.from(file.contents, (byte) => String.fromCharCode(byte)).join(""),
      ),
    });
  }
  const finalHtml = htmlPath
    ? replaceHtmlEntrypoint(html, hasCss)
    : `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${hasCss ? '<link rel="stylesheet" href="./assets/app.css">' : ""}</head><body><div id="root"></div><script type="module" src="./assets/app.js"></script></body></html>`;
  outputFiles.push({ path: "dist/index.html", encoding: "text", data: finalHtml });
  if (nextProject) {
    for (const route of nextProject.routes || []) {
      if (route.route === "/") continue;
      const segments = route.route.split("/").filter(Boolean);
      const assetPrefix = "../".repeat(segments.length);
      outputFiles.push({
        path: `dist/${segments.join("/")}/index.html`,
        encoding: "text",
        data: finalHtml.replaceAll("./assets/", `${assetPrefix}assets/`),
      });
    }
  }

  for (const [path, file] of files) {
    if (!path.startsWith("public/") || path.endsWith("/")) continue;
    outputFiles.push({
      path: `dist/${path.slice("public/".length)}`,
      encoding: file.encoding || "text",
      data: file.data ?? file.text ?? "",
    });
  }
  return {
    files: outputFiles,
    entrypoint,
    framework: nextProject ? "nextjs-static" : "frontend",
    outputDirectory: "dist",
    warnings: (result.warnings || []).map((warning) => warning.text),
  };
}

self.onmessage = (event) => {
  const message = event.data || {};
  const requestId = String(message.requestId || "");
  if (message.type !== "build") return;
  buildProject(message.payload || {})
    .then((result) => post("result", { requestId, result }))
    .catch((error) =>
      post("error", {
        requestId,
        error: {
          code: String(error?.code || "frontend_build_failed"),
          message: String(error?.message || error || "Frontend build failed"),
          stack: String(error?.stack || ""),
        },
      }),
    );
};
