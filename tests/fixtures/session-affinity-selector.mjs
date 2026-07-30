export default function select(ctx) {
  return ctx.sessionId === "session-0" ? "openai-codex-2" : undefined;
}
