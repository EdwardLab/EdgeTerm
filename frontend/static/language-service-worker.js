const documents = new Map();

function respond(id, result) {
  self.postMessage({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  self.postMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

function notify(method, params) {
  self.postMessage({ jsonrpc: "2.0", method, params });
}

function positionAt(text, offset) {
  const before = text.slice(0, Math.max(0, offset));
  const lines = before.split("\n");
  return { line: lines.length - 1, character: lines.at(-1).length };
}

function offsetAt(text, position = {}) {
  const lines = text.split("\n");
  const line = Math.max(0, Math.min(lines.length - 1, Number(position.line || 0)));
  let offset = 0;
  for (let index = 0; index < line; index += 1) offset += lines[index].length + 1;
  return offset + Math.max(0, Math.min(lines[line].length, Number(position.character || 0)));
}

function wordAt(text, position) {
  const offset = offsetAt(text, position);
  const left = text.slice(0, offset).match(/[A-Za-z_$][A-Za-z0-9_$]*$/)?.[0] || "";
  const right = text.slice(offset).match(/^[A-Za-z0-9_$]*/)?.[0] || "";
  const word = `${left}${right}`;
  return { word, start: offset - left.length, end: offset + right.length };
}

function diagnostic(message, text, start, end = start + 1, severity = 1, code = "syntax") {
  return {
    range: { start: positionAt(text, start), end: positionAt(text, Math.max(start + 1, end)) },
    severity,
    code,
    source: "EdgeTerm Language Services",
    message,
  };
}

function delimiterDiagnostics(text, pairs = { "(": ")", "[": "]", "{": "}" }) {
  const stack = [];
  const closing = new Map(Object.entries(pairs).map(([open, close]) => [close, open]));
  let quote = "";
  let escaped = false;
  const output = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (["\"", "'", "`"].includes(char)) {
      quote = char;
      continue;
    }
    if (pairs[char]) stack.push({ char, index });
    else if (closing.has(char)) {
      const expected = closing.get(char);
      const open = stack.pop();
      if (!open || open.char !== expected) output.push(diagnostic(`Unexpected ${char}.`, text, index));
    }
  }
  for (const open of stack) output.push(diagnostic(`Missing ${pairs[open.char]}.`, text, open.index));
  return output;
}

function jsonDiagnostics(text) {
  try {
    JSON.parse(text);
    return [];
  } catch (error) {
    const offset = Number(String(error?.message || "").match(/position\s+(\d+)/i)?.[1] || 0);
    return [diagnostic(String(error?.message || "Invalid JSON."), text, offset)];
  }
}

function htmlDiagnostics(text) {
  const stack = [];
  const output = [];
  const voidElements = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const expression = /<\/?([A-Za-z][A-Za-z0-9:-]*)(?:\s[^<>]*?)?\s*\/?>/g;
  for (const match of text.matchAll(expression)) {
    const tag = match[1].toLowerCase();
    if (voidElements.has(tag) || match[0].endsWith("/>")) continue;
    if (match[0].startsWith("</")) {
      const open = stack.pop();
      if (!open || open.tag !== tag) output.push(diagnostic(`Unexpected closing tag </${tag}>.`, text, match.index, match.index + match[0].length));
    } else stack.push({ tag, index: match.index, length: match[0].length });
  }
  for (const open of stack) output.push(diagnostic(`Missing closing tag for <${open.tag}>.`, text, open.index, open.index + open.length));
  return output;
}

function pythonDiagnostics(text) {
  const output = delimiterDiagnostics(text);
  const lines = text.split("\n");
  lines.forEach((line, lineNumber) => {
    const indentation = line.match(/^[\t ]*/)?.[0] || "";
    if (indentation.includes("\t") && indentation.includes(" ")) {
      const start = lines.slice(0, lineNumber).reduce((total, entry) => total + entry.length + 1, 0);
      output.push(diagnostic("Mixed tabs and spaces in indentation.", text, start, start + indentation.length, 2, "mixed-indentation"));
    }
  });
  return output;
}

function diagnostics(document) {
  const language = String(document.languageId || "").toLowerCase();
  if (language === "json") return jsonDiagnostics(document.text);
  if (["html", "handlebars"].includes(language)) return htmlDiagnostics(document.text);
  if (["css", "scss", "less", "javascript", "javascriptreact", "typescript", "typescriptreact"].includes(language)) return delimiterDiagnostics(document.text);
  if (["python", "py"].includes(language)) return pythonDiagnostics(document.text);
  return [];
}

function publish(document) {
  const items = diagnostics(document);
  notify("textDocument/publishDiagnostics", { uri: document.uri, version: document.version, diagnostics: items });
  return items;
}

function definitionPatterns(language, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (["javascript", "javascriptreact", "typescript", "typescriptreact"].includes(language)) {
    return new RegExp(`(?:class|function|const|let|var|interface|type|enum)\\s+(${escaped})\\b`, "g");
  }
  if (language === "python") return new RegExp(`(?:def|class)\\s+(${escaped})\\b|^\\s*(${escaped})\\s*=`, "gm");
  if (language === "php") return new RegExp(`(?:class|function)\\s+(${escaped})\\b|\\$(${escaped})\\s*=`, "g");
  if (language === "sql") return new RegExp(`(?:CREATE\\s+(?:TABLE|VIEW)|WITH)\\s+(${escaped})\\b`, "gi");
  return new RegExp(`\\b(${escaped})\\b`, "g");
}

function locationsForWord(word, { definitionsOnly = false } = {}) {
  if (!word) return [];
  const output = [];
  for (const document of documents.values()) {
    const expression = definitionsOnly
      ? definitionPatterns(document.languageId, word)
      : new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
    for (const match of document.text.matchAll(expression)) {
      const relative = match[0].lastIndexOf(word);
      const start = match.index + Math.max(0, relative);
      output.push({
        uri: document.uri,
        range: { start: positionAt(document.text, start), end: positionAt(document.text, start + word.length) },
      });
    }
  }
  return output;
}

function formatDocument(document) {
  if (document.languageId === "json") {
    try {
      return `${JSON.stringify(JSON.parse(document.text), null, 2)}\n`;
    } catch {
      return document.text;
    }
  }
  if (document.languageId === "sql") {
    const keywords = /\b(select|from|where|join|left|right|inner|outer|on|group by|order by|having|limit|insert into|values|update|set|delete from|create table|alter table|drop table|with|as|and|or)\b/gi;
    return document.text.replace(keywords, (value) => value.toUpperCase()).replace(/[ \t]+$/gm, "");
  }
  return document.text.replace(/[ \t]+$/gm, "");
}

async function handle(message) {
  const { id, method, params = {} } = message;
  if (method === "initialize") {
    respond(id, {
      capabilities: {
        textDocumentSync: 1,
        diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false },
        completionProvider: { triggerCharacters: [".", "\"", "'"] },
        hoverProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        renameProvider: { prepareProvider: false },
        documentFormattingProvider: true,
        codeActionProvider: true,
      },
      serverInfo: { name: "EdgeTerm Language Services", version: "1.0.0" },
    });
    return;
  }
  if (method === "initialized") return;
  if (method === "shutdown") {
    respond(id, null);
    return;
  }
  if (method === "textDocument/didOpen") {
    const document = { ...params.textDocument };
    documents.set(document.uri, document);
    publish(document);
    return;
  }
  if (method === "textDocument/didChange") {
    const current = documents.get(params.textDocument?.uri);
    if (!current) return;
    current.text = String(params.contentChanges?.at(-1)?.text ?? current.text);
    current.version = Number(params.textDocument?.version || current.version + 1);
    publish(current);
    return;
  }
  const uri = params.textDocument?.uri;
  const document = documents.get(uri);
  if (!document) {
    fail(id, "document_not_open", "The document is not open in the language worker.");
    return;
  }
  if (method === "textDocument/diagnostic") {
    respond(id, { kind: "full", items: diagnostics(document) });
    return;
  }
  const selected = wordAt(document.text, params.position || {});
  if (method === "textDocument/completion") {
    const languageKeywords = {
      javascript: ["const", "let", "function", "async", "await", "import", "export", "class", "return"],
      typescript: ["const", "let", "function", "async", "await", "import", "export", "interface", "type", "class", "return"],
      python: ["def", "class", "async", "await", "import", "from", "return", "yield", "with", "try", "except"],
      html: ["html", "head", "body", "main", "section", "article", "button", "input", "script", "link"],
      css: ["display", "position", "color", "background", "margin", "padding", "grid-template-columns", "font-family"],
      json: ["true", "false", "null"],
      sql: ["SELECT", "FROM", "WHERE", "JOIN", "INSERT", "UPDATE", "DELETE", "CREATE TABLE", "ORDER BY", "GROUP BY"],
    };
    const words = new Set(languageKeywords[String(document.languageId || "").toLowerCase()] || []);
    for (const source of documents.values()) {
      for (const word of source.text.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) || []) words.add(word);
    }
    respond(id, {
      isIncomplete: false,
      items: [...words].sort().slice(0, 500).map((label) => ({ label, kind: 6, insertText: label })),
    });
    return;
  }
  if (method === "textDocument/hover") {
    respond(id, selected.word ? { contents: { kind: "markdown", value: `\`${selected.word}\` in ${document.languageId}` }, range: { start: positionAt(document.text, selected.start), end: positionAt(document.text, selected.end) } } : null);
    return;
  }
  if (method === "textDocument/definition") {
    respond(id, locationsForWord(selected.word, { definitionsOnly: true }).at(0) || null);
    return;
  }
  if (method === "textDocument/references") {
    respond(id, locationsForWord(selected.word));
    return;
  }
  if (method === "textDocument/rename") {
    const changes = {};
    for (const location of locationsForWord(selected.word)) {
      (changes[location.uri] ||= []).push({ range: location.range, newText: String(params.newName || "") });
    }
    respond(id, { changes });
    return;
  }
  if (method === "textDocument/formatting") {
    const formatted = formatDocument(document);
    respond(id, formatted === document.text ? [] : [{
      range: { start: { line: 0, character: 0 }, end: positionAt(document.text, document.text.length) },
      newText: formatted,
    }]);
    return;
  }
  if (method === "textDocument/codeAction") {
    respond(id, []);
    return;
  }
  fail(id, "method_not_found", `Unsupported language method: ${method}`);
}

self.addEventListener("message", (event) => {
  Promise.resolve(handle(event.data || {})).catch((error) => {
    if (event.data?.id !== undefined) fail(event.data.id, "language_internal_error", String(error?.message || error));
  });
});
