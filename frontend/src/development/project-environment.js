import { parse, stringify } from "smol-toml";

export const EDGETERM_PROJECT_SCHEMA = 1;
export const SUPPORTED_FRAMEWORKS = new Set([
  "static",
  "vite",
  "nextjs-static",
  "flask",
  "fastapi",
  "django",
  "php",
]);

function environmentError(code, message, details = null) {
  return Object.assign(new Error(message), { code, details, recoverable: false });
}

function stringArray(value, field, limit = 200) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw environmentError("project_config_invalid", `${field} must be an array of strings.`);
  }
  if (value.length > limit) {
    throw environmentError("project_config_limit", `${field} may contain up to ${limit} entries.`);
  }
  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))];
}

function normalizeRelativePath(value, field, fallback = ".") {
  const path = String(value || fallback).trim().replaceAll("\\", "/");
  if (!path || path.startsWith("/") || path.split("/").includes("..")) {
    throw environmentError("project_path_invalid", `${field} must stay inside the project directory.`);
  }
  return path.replace(/^\.\/+/, "") || ".";
}

function normalizeMap(value, field, { secretReferences = false } = {}) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw environmentError("project_config_invalid", `${field} must be a key-value table.`);
  }
  const output = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw environmentError("project_environment_key_invalid", `Invalid environment key: ${key}`);
    }
    const entry = String(raw ?? "");
    if (secretReferences && !/^vault:[A-Za-z0-9_.-]{1,120}$/.test(entry)) {
      throw environmentError(
        "project_secret_reference_invalid",
        `${key} must reference a local vault entry using vault:name.`,
      );
    }
    output[key] = entry;
  }
  return output;
}

function normalizeTasks(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw environmentError("project_tasks_invalid", "tasks must be an array with at most 100 entries.");
  }
  const seen = new Set();
  return value.map((task, index) => {
    if (!task || typeof task !== "object" || Array.isArray(task)) {
      throw environmentError("project_task_invalid", `Task ${index + 1} must be a table.`);
    }
    const id = String(task.id || "").trim();
    const command = String(task.command || "").trim();
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(id) || seen.has(id)) {
      throw environmentError("project_task_id_invalid", `Task ${index + 1} has an invalid or duplicate id.`);
    }
    if (!command || command.length > 8_000) {
      throw environmentError("project_task_command_invalid", `Task ${id} must have a command under 8,000 characters.`);
    }
    seen.add(id);
    return {
      id,
      label: String(task.label || id).trim().slice(0, 120) || id,
      command,
      cwd: normalizeRelativePath(task.cwd, `tasks.${id}.cwd`),
      kind: String(task.kind || "command").trim().toLowerCase(),
      background: Boolean(task.background),
      problem_matcher: String(task.problem_matcher || "").trim().slice(0, 80),
    };
  });
}

export function normalizeProjectConfiguration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw environmentError("project_config_invalid", "edgeterm.toml must contain a TOML document.");
  }
  const version = Number(value.version || 0);
  if (version !== EDGETERM_PROJECT_SCHEMA) {
    throw environmentError(
      "project_schema_unsupported",
      `Unsupported edgeterm.toml version: ${value.version ?? "missing"}.`,
    );
  }
  const project = value.project || {};
  const framework = String(project.framework || "static").trim().toLowerCase();
  if (!SUPPORTED_FRAMEWORKS.has(framework)) {
    throw environmentError("project_framework_unsupported", `Unsupported project framework: ${framework}`);
  }
  const preview = value.preview || {};
  const permissions = value.permissions || {};
  return {
    version,
    project: {
      name: String(project.name || "EdgeTerm project").trim().slice(0, 120) || "EdgeTerm project",
      root: normalizeRelativePath(project.root, "project.root"),
      framework,
    },
    packages: {
      apt: stringArray(value.packages?.apt, "packages.apt"),
      npm: stringArray(value.packages?.npm, "packages.npm"),
      pip: stringArray(value.packages?.pip, "packages.pip"),
    },
    env: normalizeMap(value.env, "env"),
    secrets: normalizeMap(value.secrets, "secrets", { secretReferences: true }),
    tasks: normalizeTasks(value.tasks),
    preview: {
      task: String(preview.task || "").trim().slice(0, 80),
      path: String(preview.path || "/").trim().startsWith("/")
        ? String(preview.path || "/").trim()
        : `/${String(preview.path || "").trim()}`,
      auto_open: preview.auto_open !== false,
    },
    permissions: {
      network: ["deny", "ask", "allow"].includes(permissions.network)
        ? permissions.network
        : "ask",
      package_install: ["deny", "ask", "allow"].includes(permissions.package_install)
        ? permissions.package_install
        : "ask",
    },
  };
}

export function parseProjectConfiguration(source) {
  try {
    return normalizeProjectConfiguration(parse(String(source || "")));
  } catch (error) {
    if (error?.code) throw error;
    throw environmentError("project_toml_invalid", String(error?.message || "Invalid TOML configuration."));
  }
}

export function serializeProjectConfiguration(configuration) {
  const config = normalizeProjectConfiguration(configuration);
  return stringify({
    version: config.version,
    project: config.project,
    packages: config.packages,
    env: config.env,
    secrets: config.secrets,
    tasks: config.tasks,
    preview: config.preview,
    permissions: config.permissions,
  });
}

function packageJson(files) {
  try {
    return JSON.parse(String(files.get("package.json") || "{}"));
  } catch {
    return {};
  }
}

function requirementNames(source) {
  return String(source || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("-"))
    .map((line) => line.match(/^[A-Za-z0-9_.-]+/)?.[0] || "")
    .filter(Boolean);
}

export function detectProjectConfiguration(filesInput, { name = "EdgeTerm project" } = {}) {
  const files = filesInput instanceof Map ? filesInput : new Map(Object.entries(filesInput || {}));
  const paths = new Set(files.keys());
  const pkg = packageJson(files);
  let framework = "static";
  if (paths.has("manage.py")) framework = "django";
  else if ([...paths].some((path) => /(^|\/)main\.py$/.test(path)) && /fastapi/i.test(String(files.get("main.py") || ""))) framework = "fastapi";
  else if ([...paths].some((path) => /(^|\/)app\.py$/.test(path)) && /flask/i.test(String(files.get("app.py") || ""))) framework = "flask";
  else if (paths.has("index.php") || [...paths].some((path) => path.endsWith(".php"))) framework = "php";
  else if (pkg.dependencies?.next || pkg.devDependencies?.next) framework = "nextjs-static";
  else if (pkg.dependencies?.vite || pkg.devDependencies?.vite) framework = "vite";

  const tasks = [];
  for (const [id, command] of Object.entries(pkg.scripts || {})) {
    if (typeof command !== "string") continue;
    tasks.push({ id: `npm.${id}`, label: `npm ${id}`, command: `npm run ${id}`, kind: id === "test" ? "test" : "command" });
  }
  const defaultTask = {
    static: { id: "preview", label: "Preview", command: "python -m http.server 8000", background: true },
    flask: { id: "dev", label: "Run Flask", command: "flask run", background: true },
    fastapi: { id: "dev", label: "Run FastAPI", command: "uvicorn main:app", background: true },
    django: { id: "dev", label: "Run Django", command: "python manage.py runserver", background: true },
    php: { id: "dev", label: "Run PHP", command: "php -S 127.0.0.1:8000", background: true },
  }[framework];
  if (defaultTask && !tasks.some((task) => task.id === defaultTask.id)) tasks.unshift(defaultTask);

  return normalizeProjectConfiguration({
    version: EDGETERM_PROJECT_SCHEMA,
    project: { name, root: ".", framework },
    packages: {
      apt: [],
      npm: Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }),
      pip: requirementNames(files.get("requirements.txt")),
    },
    env: {},
    secrets: {},
    tasks,
    preview: { task: defaultTask?.id || (tasks.some((task) => task.id === "npm.dev") ? "npm.dev" : ""), path: "/", auto_open: true },
    permissions: { network: "ask", package_install: "ask" },
  });
}

export function inspectProjectEnvironment(configInput, state = {}) {
  const config = normalizeProjectConfiguration(configInput);
  const dependencyName = (manager, value) => {
    const source = String(value || "").trim();
    if (manager === "npm") return source.startsWith("@") ? source.split("@").slice(0, 2).join("@") : source.split("@")[0];
    if (manager === "pip") return (source.match(/^[A-Za-z0-9_.-]+/)?.[0] || source).toLowerCase().replaceAll("_", "-");
    return source.split(":")[0];
  };
  const installed = {
    apt: new Set((state.apt || []).map((value) => dependencyName("apt", value))),
    npm: new Set((state.npm || []).map((value) => dependencyName("npm", value))),
    pip: new Set((state.pip || []).map((value) => dependencyName("pip", value))),
  };
  const missing = {
    apt: config.packages.apt.filter((name) => !installed.apt.has(dependencyName("apt", name))),
    npm: config.packages.npm.filter((name) => !installed.npm.has(dependencyName("npm", name))),
    pip: config.packages.pip.filter((name) => !installed.pip.has(dependencyName("pip", name))),
  };
  return {
    configuration: config,
    missing,
    ready: !missing.apt.length && !missing.npm.length && !missing.pip.length,
    estimated_install_count: missing.apt.length + missing.npm.length + missing.pip.length,
    secret_references: Object.entries(config.secrets).map(([key, reference]) => ({ key, reference })),
  };
}
