const PYTHON_APP_DEFAULTS = {
  flask: "app:app",
  fastapi: "main:app",
  django: "siteapp.wsgi:application",
};

function relativeTarget(target, root) {
  const value = String(target || "").trim().replace(/\\/g, "/");
  const normalizedRoot = String(root || "").trim().replace(/\/+$/, "");
  if (normalizedRoot && value.startsWith(`${normalizedRoot}/`)) {
    return value.slice(normalizedRoot.length + 1);
  }
  return value.replace(/^\.\/+/, "");
}

function pythonModuleFromFile(target) {
  return target
    .replace(/\.py$/i, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, ".");
}

export function normalizeAppTarget(framework, target, root = "") {
  const normalizedFramework = String(framework || "").trim().toLowerCase();
  const fallback = PYTHON_APP_DEFAULTS[normalizedFramework];
  if (!fallback) return String(target || "").trim();

  const value = relativeTarget(target, root);
  if (!value) return fallback;
  if (value.includes(":")) return value;

  if (normalizedFramework === "django") {
    if (value === "manage.py") return fallback;
    const moduleName = pythonModuleFromFile(value);
    return moduleName ? `${moduleName}:application` : fallback;
  }

  const moduleName = value.toLowerCase().endsWith(".py")
    ? pythonModuleFromFile(value)
    : value.replace(/^\/+|\/+$/g, "").replace(/\/+/g, ".");
  return moduleName ? `${moduleName}:app` : fallback;
}
