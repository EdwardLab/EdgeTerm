function parseAttributes(source) {
  const attributes = new Map();
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of String(source || "").matchAll(pattern)) {
    const name = String(match[1] || "").toLowerCase();
    if (!name) continue;
    attributes.set(name, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

export function htmlModuleEntrypoint(html) {
  const pattern = /<script\b([^>]*)>[\s\S]*?<\/script>/gi;
  for (const match of String(html || "").matchAll(pattern)) {
    const attributes = parseAttributes(match[1]);
    if (String(attributes.get("type") || "").toLowerCase() !== "module") continue;
    const source = attributes.get("src");
    if (!source) continue;
    return String(source).replace(/^\/+/, "");
  }
  return "";
}

export function replaceHtmlModuleEntrypoint(html, replacement) {
  let replaced = false;
  return String(html || "").replace(
    /<script\b([^>]*)>[\s\S]*?<\/script>/gi,
    (tag, attributeSource) => {
      if (replaced) return tag;
      const attributes = parseAttributes(attributeSource);
      if (String(attributes.get("type") || "").toLowerCase() !== "module") return tag;
      if (!attributes.get("src")) return tag;
      replaced = true;
      return replacement;
    },
  );
}
