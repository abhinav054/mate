import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export class TerminalUI {
  static BLACK = "\x1b[30m";
  static BLUE = "\x1b[34m";
  static CYAN = "\x1b[36m";
  static GREEN = "\x1b[32m";
  static MAGENTA = "\x1b[35m";
  static RED = "\x1b[31m";
  static WHITE = "\x1b[37m";
  static YELLOW = "\x1b[33m";
  static BOLD = "\x1b[1m";
  static DIM = "\x1b[2m";
  static RESET = "\x1b[0m";
  static BG_BLUE = "\x1b[44m";

  static enabled() {
    return process.env.NO_COLOR === undefined;
  }

  static style(value, ...codes) {
    return this.enabled() ? `${codes.join("")}${value}${this.RESET}` : value;
  }

  static rule(title = "") {
    const width = Math.min(output.columns || 88, 100);
    if (title) {
      const label = ` ${title} `;
      console.log(this.style("- " + label + "-".repeat(Math.max(2, width - label.length - 2)), this.DIM));
    } else {
      console.log(this.style("-".repeat(width), this.DIM));
    }
  }

  static banner(title, body = "") {
    const width = Math.min(output.columns || 88, 100);
    const text = ` ${title} `;
    console.log(this.enabled() ? this.style(text.padEnd(width), this.BOLD, this.WHITE, this.BG_BLUE) : text.trim());
    if (body) this.body(body);
    console.log();
  }

  static panel(title, body, color = this.CYAN) {
    this.rule(this.style(title, this.BOLD, color));
    this.body(body);
    this.rule();
    console.log();
  }

  static answer(body, elapsedSeconds = null) {
    const title = elapsedSeconds === null ? "Result" : `Worked for ${this.formatDuration(elapsedSeconds)}`;
    this.rule(this.style(title, this.BOLD, this.GREEN));
    this.body(body);
    this.rule();
    console.log();
  }

  static activity(action, detail = "", color = this.CYAN) {
    const marker = this.style("*", color, this.BOLD);
    const suffix = detail ? ` ${this.highlight(detail)}` : "";
    console.log(`${marker} ${this.style(action, this.BOLD, color)}${suffix}`);
  }

  static success(body) {
    console.log(`${this.style("OK", this.GREEN, this.BOLD)} ${this.highlight(body)}`);
  }

  static warning(body) {
    console.log(`${this.style("!", this.YELLOW, this.BOLD)} ${this.highlight(body)}`);
  }

  static diff(body) {
    this.rule(this.style("File Diff", this.BOLD, this.MAGENTA));
    for (const line of body.split(/\r?\n/)) {
      if (line.startsWith("+") && !line.startsWith("+++")) console.log(this.style(line, this.GREEN));
      else if (line.startsWith("-") && !line.startsWith("---")) console.log(this.style(line, this.RED));
      else if (line.startsWith("@@")) console.log(this.style(line, this.CYAN, this.BOLD));
      else if (line.startsWith("---") || line.startsWith("+++")) console.log(this.style(line, this.YELLOW));
      else console.log(line);
    }
    this.rule();
    console.log();
  }

  static async prompt(label, secret = false) {
    if (secret) return this.askHidden(label);
    const rl = readline.createInterface({ input, output });
    try {
      return await rl.question(this.style(label, this.BOLD, this.YELLOW));
    } catch (error) {
      if (error && error.code === "ABORT_ERR") {
        output.write("\n");
        return null;
      }
      throw error;
    } finally {
      rl.close();
    }
  }

  static async transientPrompt(label) {
    const answer = await this.prompt(label);
    return answer;
  }

  static promptLabel() {
    return this.style("mate", this.BOLD, this.CYAN) + this.style(" > ", this.BOLD, this.GREEN);
  }

  static body(body) {
    if (!String(body || "").trim()) {
      console.log(this.style("(no output)", this.DIM));
      return;
    }
    for (const line of String(body).replace(/\s+$/, "").split(/\r?\n/)) console.log(this.highlight(line));
  }

  static highlight(value) {
    if (!this.enabled()) return value;
    return String(value).replace(/`[^`]+`/g, (match) => this.style(match, this.GREEN, this.BOLD));
  }

  static formatDuration(seconds) {
    let total = Math.max(0, Math.round(seconds));
    const hours = Math.floor(total / 3600);
    total %= 3600;
    const minutes = Math.floor(total / 60);
    const remaining = total % 60;
    return [hours && `${hours}h`, minutes && `${minutes}m`, `${remaining}s`].filter(Boolean).join(" ");
  }

  static working(label = "Mate is working") {
    this.activity(label, "started", this.CYAN);
    return { stop() {} };
  }

  static async askHidden(label) {
    const wasRaw = input.isRaw;
    if (input.isTTY) input.setRawMode(true);
    output.write(this.style(label, this.BOLD, this.YELLOW));
    let value = "";
    return await new Promise((resolve) => {
      const onData = (chunk) => {
        const text = chunk.toString("utf8");
        for (const char of text) {
          if (char === "\n" || char === "\r") {
            input.off("data", onData);
            if (input.isTTY) input.setRawMode(Boolean(wasRaw));
            output.write("\n");
            resolve(value);
          } else if (char === "\u0003") {
            input.off("data", onData);
            if (input.isTTY) input.setRawMode(Boolean(wasRaw));
            output.write("\n");
            resolve(null);
          } else if (char === "\u007f") {
            value = value.slice(0, -1);
          } else {
            value += char;
          }
        }
      };
      input.on("data", onData);
    });
  }
}
