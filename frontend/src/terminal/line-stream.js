export class TerminalLineStream {
  constructor() {
    this.states = new Map();
  }

  state(stream) {
    const key = String(stream || "stdout");
    if (!this.states.has(key)) {
      this.states.set(key, { text: "", carriageReturn: false });
    }
    return this.states.get(key);
  }

  push(stream, value) {
    const key = String(stream || "stdout");
    const state = this.state(key);
    const lines = [];
    for (const character of String(value ?? "")) {
      if (state.carriageReturn) {
        lines.push({ stream: key, text: state.text, carriageReturn: character !== "\n" });
        state.text = "";
        state.carriageReturn = false;
        if (character === "\n") continue;
      }
      if (character === "\r") {
        state.carriageReturn = true;
      } else if (character === "\n") {
        lines.push({ stream: key, text: state.text, carriageReturn: false });
        state.text = "";
      } else {
        state.text += character;
      }
    }
    return lines;
  }

  peek(stream) {
    const state = this.states.get(String(stream || "stdout"));
    return state?.text || "";
  }

  flush(stream = null) {
    const keys = stream === null ? [...this.states.keys()] : [String(stream)];
    const lines = [];
    for (const key of keys) {
      const state = this.states.get(key);
      if (!state) continue;
      if (state.carriageReturn || state.text) {
        lines.push({ stream: key, text: state.text, carriageReturn: state.carriageReturn });
      }
      state.text = "";
      state.carriageReturn = false;
    }
    return lines;
  }

  clear() {
    this.states.clear();
  }
}
