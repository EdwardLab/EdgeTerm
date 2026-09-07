export function createBridgeResult(method, result, { requestId, idempotencyKey, workspaceGeneration, startedAt }) {
  const normalized = result && typeof result === "object" && !Array.isArray(result) ? { ...result } : { value: result };
  const cancelled = normalized.cancelled === true;
  const exitCode = normalized.exit_code ?? normalized.exitCode;
  const failed = Number.isFinite(exitCode) && exitCode !== 0;
  const state = cancelled ? "cancelled" : failed ? "failed" : "completed";
  return {
    ...normalized,
    ...(typeof normalized.status === "number" ? { http_status: normalized.status } : {}),
    request_id: requestId,
    idempotency_key: idempotencyKey,
    status: state,
    error_code: failed ? normalized.error_code || "command_failed" : null,
    recoverable: failed,
    summary: String(normalized.summary || normalized.message || `${method} ${state}${failed ? ` (exit ${exitCode})` : ""}`).slice(0, 500),
    artifact_handles: Array.isArray(normalized.artifact_handles) ? normalized.artifact_handles : [],
    workspace_generation: workspaceGeneration,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };
}
