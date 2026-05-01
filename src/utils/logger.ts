type Level = "info" | "warn" | "error";

function emit(level: Level, msg: string, meta?: unknown): void {
  const stamp = new Date().toISOString();
  const tag = level.toUpperCase().padEnd(5);
  const line = `[${stamp}] ${tag} ${msg}`;
  const stream = level === "error" ? process.stderr : process.stdout;
  if (meta !== undefined) {
    stream.write(`${line} ${JSON.stringify(meta)}\n`);
  } else {
    stream.write(`${line}\n`);
  }
}

export const log = {
  info: (msg: string, meta?: unknown) => emit("info", msg, meta),
  warn: (msg: string, meta?: unknown) => emit("warn", msg, meta),
  error: (msg: string, meta?: unknown) => emit("error", msg, meta),
};
