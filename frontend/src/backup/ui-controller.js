import { BackupJobStore } from "./job-store.js";
import { createBackupProvider } from "./providers/index.js";
import { BackupRepository } from "./repository.js";

const CONNECTION_KEY = "edgeterm.backups.activeConnection.v1";
const REPOSITORY_KEY_PREFIX = "edgeterm.backups.repository.v1";
const SUPPORTED_PROVIDER_TYPES = new Set(["google-drive", "dropbox", "s3", "local-folder"]);

function element(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const node = element(id);
  if (node) node.textContent = String(value ?? "");
}

function formatTimestamp(value) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Never" : date.toLocaleString();
}

function safeName(value) {
  return String(value || "workspace").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "workspace";
}

export class BackupUiController {
  constructor(options) {
    this.hooks = options;
    this.store = options.store || new BackupJobStore();
    this.connection = null;
    this.provider = null;
    this.repository = null;
    this.activeJob = null;
    this.abortController = null;
    this.initialized = false;
    this.scheduleTimer = null;
  }

  workspace() {
    return this.hooks.getWorkspace();
  }

  formatBytes(value) {
    return this.hooks.formatBytes?.(value) || `${Number(value || 0)} B`;
  }

  repositoryStorageKey(connectionId = this.connection?.id, workspaceId = this.workspace()?.id) {
    return `${REPOSITORY_KEY_PREFIX}:${connectionId || "none"}:${workspaceId || "none"}`;
  }

  passwordSecretId() {
    return `backup-password:${this.connection?.id || "none"}:${this.workspace()?.id || "none"}`;
  }

  repositoryPrefix(repositoryId) {
    if (["dropbox", "s3"].includes(this.connection?.type)) return `repositories/${repositoryId}`;
    return `EdgeTerm Backups/repositories/${repositoryId}`;
  }

  async init() {
    if (this.initialized) return;
    this.initialized = true;
    await this.store.open();
    await this.store.markInterruptedJobs();
    await this.captureOAuthReturn();
    await this.loadConnection();
    this.bindEvents();
    this.scheduleTimer = window.setInterval(() => void this.runDueSchedule(), 60_000);
    await this.render();
  }

  async captureOAuthReturn() {
    const url = new URL(window.location.href);
    const provider = url.searchParams.get("backup_provider");
    const connectionId = url.searchParams.get("backup_connection_id");
    if (!provider || !connectionId) return;
    await this.attachBrokerConnection(provider, connectionId);
    url.searchParams.delete("backup_provider");
    url.searchParams.delete("backup_connection_id");
    history.replaceState(null, "", url);
  }

  async attachBrokerConnection(provider, connectionId) {
    const connection = await this.store.saveConnection({
      id: connectionId,
      type: provider,
      label: provider === "google-drive" ? "Google Drive" : "Dropbox",
      broker_managed: true,
    });
    localStorage.setItem(CONNECTION_KEY, connection.id);
    this.connection = connection;
    this.provider = await this.createProvider(connection);
    this.repository = null;
    if (this.initialized) await this.render();
    return connection;
  }

  bindEvents() {
    document.querySelectorAll("[data-backup-provider]").forEach((button) => {
      button.addEventListener("click", () => void this.connectProvider(button.dataset.backupProvider));
    });
    element("backupDisconnect")?.addEventListener("click", () => void this.disconnect());
    element("backupUnlock")?.addEventListener("click", () => void this.unlockFromForm());
    element("backupS3Connect")?.addEventListener("click", () => void this.connectS3());
    element("backupS3Cancel")?.addEventListener("click", () => element("backupS3Panel")?.classList.add("hidden"));
    element("externalBackupNow")?.addEventListener("click", () => void this.startBackup());
    element("externalBackupCancel")?.addEventListener("click", () => this.cancel());
    element("externalBackupRefresh")?.addEventListener("click", () => void this.renderBackups());
    element("externalBackupSaveSchedule")?.addEventListener("click", () => void this.saveSchedule());
    element("externalBackupList")?.addEventListener("click", (event) => void this.handleBackupAction(event));
  }

  async loadConnection() {
    const id = localStorage.getItem(CONNECTION_KEY);
    this.connection = id ? await this.store.getConnection(id) : null;
    if (this.connection && !SUPPORTED_PROVIDER_TYPES.has(this.connection.type)) {
      await this.store.deleteConnection(this.connection.id);
      localStorage.removeItem(CONNECTION_KEY);
      this.connection = null;
    }
    this.provider = this.connection ? await this.createProvider(this.connection) : null;
    this.repository = null;
  }

  async createProvider(connection) {
    if (connection.type === "local-folder") {
      return createBackupProvider(connection, { directoryHandle: connection.directoryHandle });
    }
    if (connection.type === "s3") {
      return createBackupProvider(connection, {
        credentialsProvider: async () => await this.store.getSecret(`s3:${connection.id}`),
      });
    }
    return createBackupProvider(connection, {
      tokenProvider: async () => await this.fetchProviderToken(connection.id),
    });
  }

  async fetchProviderToken(connectionId) {
    if (typeof this.hooks.requestHost === "function") {
      const payload = await this.hooks.requestHost("backup.oauth.token", {
        connection_id: String(connectionId),
      });
      if (!payload?.access_token) throw new Error("Storage authorization expired");
      return payload.access_token;
    }
    const broker = String(this.hooks.oauthBroker || window.EDGETERM_BACKUP_OAUTH_BROKER || "").replace(/\/+$/, "");
    if (!broker) throw new Error("The storage OAuth broker is not configured");
    const apiPath = String(window.EDGETERM_BACKUP_OAUTH_API_PATH || "/_panel_api/api/edgeterm/backup").replace(/\/+$/, "");
    const response = await fetch(`${broker}${apiPath}/connections/${encodeURIComponent(connectionId)}/token`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Storage authorization expired");
    return payload.access_token;
  }

  brokerBaseUrl() {
    return String(this.hooks.oauthBroker || window.EDGETERM_BACKUP_OAUTH_BROKER || "").replace(/\/+$/, "");
  }

  brokerApiPath() {
    return String(window.EDGETERM_BACKUP_OAUTH_API_PATH || "/_panel_api/api/edgeterm/backup").replace(/\/+$/, "");
  }

  async revokeBrokerConnection(connectionId) {
    if (typeof this.hooks.requestHost === "function") {
      await this.hooks.requestHost("backup.oauth.revoke", {
        connection_id: String(connectionId),
      });
      return;
    }
    const broker = this.brokerBaseUrl();
    if (!broker) throw new Error("The storage OAuth broker is not configured");
    const csrfResponse = await fetch(`${broker}/_panel_api/api/security/csrf`, {
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    const csrfPayload = await csrfResponse.json().catch(() => ({}));
    if (!csrfResponse.ok || !csrfPayload.csrf_token) {
      throw new Error("The storage connection could not be revoked safely");
    }
    const response = await fetch(`${broker}${this.brokerApiPath()}/connections/${encodeURIComponent(connectionId)}`, {
      method: "DELETE",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "X-CSRF-Token": csrfPayload.csrf_token,
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "The storage connection could not be revoked");
  }

  async connectProvider(type) {
    if (!SUPPORTED_PROVIDER_TYPES.has(type)) {
      throw new Error("The storage provider is not supported");
    }
    if (type === "local-folder") return await this.connectLocalFolder();
    if (type === "s3") {
      element("backupS3Panel")?.classList.remove("hidden");
      element("backupS3Endpoint")?.focus();
      return;
    }
    if (typeof this.hooks.requestHost === "function") {
      await this.hooks.requestHost("backup.oauth.connect", {
        provider: String(type),
        workspace_id: this.workspace()?.id || "",
      });
      return;
    }
    const broker = String(this.hooks.oauthBroker || window.EDGETERM_BACKUP_OAUTH_BROKER || "").replace(/\/+$/, "");
    if (!broker) return this.hooks.notice("Storage sign-in is not configured for this EdgeTerm build");
    const apiPath = String(window.EDGETERM_BACKUP_OAUTH_API_PATH || "/_panel_api/api/edgeterm/backup").replace(/\/+$/, "");
    const returnTo = new URL(window.location.href);
    returnTo.searchParams.delete("backup_provider");
    returnTo.searchParams.delete("backup_connection_id");
    const url = new URL(`${broker}${apiPath}/oauth/${encodeURIComponent(type)}/start`);
    url.searchParams.set("return_to", returnTo.toString());
    url.searchParams.set("workspace_id", this.workspace()?.id || "");
    window.top.location.assign(url.toString());
  }

  async connectLocalFolder() {
    if (typeof window.showDirectoryPicker !== "function") {
      return this.hooks.notice("Local folder backup needs a browser with File System Access support");
    }
    try {
      const directoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
      const id = `local-${crypto.randomUUID()}`;
      this.connection = await this.store.saveConnection({
        id,
        type: "local-folder",
        label: directoryHandle.name || "Local folder",
        directoryHandle,
      });
      localStorage.setItem(CONNECTION_KEY, id);
      this.provider = await this.createProvider(this.connection);
      this.repository = null;
      await this.render();
    } catch (error) {
      if (error?.name !== "AbortError") this.hooks.notice(error?.message || String(error));
    }
  }

  async connectS3() {
    try {
      const id = `s3-${crypto.randomUUID()}`;
      const connection = {
        id,
        type: "s3",
        label: element("backupS3Bucket")?.value.trim() || "S3-compatible storage",
        endpoint: element("backupS3Endpoint")?.value.trim(),
        region: element("backupS3Region")?.value.trim() || "us-east-1",
        bucket: element("backupS3Bucket")?.value.trim(),
        rootPrefix: element("backupS3Prefix")?.value.trim() || "EdgeTerm Backups",
        forcePathStyle: element("backupS3PathStyle")?.checked !== false,
      };
      const secret = {
        accessKeyId: element("backupS3AccessKey")?.value.trim(),
        secretAccessKey: element("backupS3SecretKey")?.value,
      };
      const provider = createBackupProvider(connection, { credentialsProvider: secret });
      await provider.listObjects("connection-test");
      await this.store.setSecret(`s3:${id}`, secret);
      this.connection = await this.store.saveConnection(connection);
      localStorage.setItem(CONNECTION_KEY, id);
      this.provider = await this.createProvider(this.connection);
      this.repository = null;
      element("backupS3Panel")?.classList.add("hidden");
      element("backupS3SecretKey").value = "";
      await this.render();
    } catch (error) {
      this.hooks.notice(error?.message || String(error));
    }
  }

  async disconnect() {
    if (!this.connection) return;
    if (!(await this.hooks.confirm("Disconnect backup storage? Existing backups will remain in your storage."))) return;
    const id = this.connection.id;
    if (this.connection.broker_managed) {
      try {
        await this.revokeBrokerConnection(id);
      } catch (error) {
        return this.hooks.notice(error?.message || String(error));
      }
    }
    if (this.connection.type === "s3") await this.store.deleteSecret(`s3:${id}`);
    await this.store.deleteSecret(this.passwordSecretId());
    await this.store.deleteConnection(id);
    localStorage.removeItem(CONNECTION_KEY);
    this.connection = null;
    this.provider = null;
    this.repository = null;
    await this.render();
  }

  async unlockFromForm() {
    if (!this.connection || !this.provider) return this.hooks.notice("Connect storage first");
    const password = element("backupPassword")?.value || "";
    const confirmation = element("backupPasswordConfirm")?.value || "";
    if (password.length < 12) return this.hooks.notice("Use a recovery password with at least 12 characters");
    try {
      await this.unlock(password, { confirmation, remember: element("backupRememberPassword")?.checked === true });
      element("backupPassword").value = "";
      element("backupPasswordConfirm").value = "";
      await this.render();
    } catch (error) {
      this.hooks.notice(error?.message || String(error));
    }
  }

  async unlock(password, options = {}) {
    const workspace = this.workspace();
    if (!workspace) throw new Error("No active workspace");
    let repositoryId = localStorage.getItem(this.repositoryStorageKey());
    if (!repositoryId) {
      if (password !== options.confirmation) throw new Error("Recovery passwords do not match");
      repositoryId = `repo-${safeName(workspace.id).slice(0, 40)}-${crypto.randomUUID().slice(0, 8)}`;
      this.repository = await BackupRepository.create(this.provider, {
        repositoryId,
        prefix: this.repositoryPrefix(repositoryId),
        password,
      });
      localStorage.setItem(this.repositoryStorageKey(), repositoryId);
    } else {
      this.repository = await BackupRepository.open(this.provider, {
        repositoryId,
        prefix: this.repositoryPrefix(repositoryId),
        password,
      });
    }
    if (options.remember) await this.store.setSecret(this.passwordSecretId(), { password });
    else await this.store.deleteSecret(this.passwordSecretId());
    await this.renderBackups();
    return this.repository;
  }

  async tryRememberedPassword() {
    if (!this.connection) return false;
    const secret = await this.store.getSecret(this.passwordSecretId()).catch(() => null);
    if (!secret?.password) return false;
    try {
      await this.unlock(secret.password, { confirmation: secret.password, remember: true });
      return true;
    } catch {
      return false;
    }
  }

  async startBackup(options = {}) {
    if (this.activeJob) throw new Error("A backup job is already running");
    if (!this.repository && !(await this.tryRememberedPassword())) throw new Error("Unlock backups before starting");
    const workspace = this.workspace();
    const job = await this.store.createJob({
      type: "backup",
      workspace_id: workspace.id,
      repository_id: this.repository.repositoryId,
      provider_connection_id: this.connection.id,
      snapshot_id: options.snapshotId,
    });
    this.activeJob = job;
    this.abortController = new AbortController();
    await this.store.updateJob(job.id, { status: "running", phase: "flush" });
    await this.render();
    try {
      const source = await this.hooks.createSource();
      const result = await this.repository.createBackup(source, {
        snapshotId: job.snapshot_id,
        signal: this.abortController.signal,
        onProgress: (progress) => void this.updateJobProgress(job.id, progress),
        onCheckpoint: (checkpoint) => this.store.updateJob(job.id, { status: "uploading", phase: checkpoint.phase, progress: checkpoint }),
      });
      await this.store.updateJob(job.id, { status: "completed", phase: "complete", progress: result.manifest.stats, error: null });
      this.hooks.notice("Backup complete");
      await this.renderBackups();
      return result;
    } catch (error) {
      const cancelled = error?.name === "AbortError" || this.abortController.signal.aborted;
      await this.store.updateJob(job.id, {
        status: cancelled ? "cancelled" : "paused",
        phase: cancelled ? "cancelled" : "awaiting_resume",
        error: { code: error?.code || (cancelled ? "backup_cancelled" : "backup_failed"), message: error?.message || String(error), recoverable: !cancelled && error?.recoverable !== false },
      });
      if (!cancelled) this.hooks.notice(error?.message || String(error));
      throw error;
    } finally {
      this.activeJob = null;
      this.abortController = null;
      await this.render();
    }
  }

  async updateJobProgress(jobId, progress) {
    const status = progress.phase === "upload" ? "uploading" : progress.phase === "complete" ? "completed" : "running";
    await this.store.updateJob(jobId, { status, phase: progress.phase, progress });
    this.renderProgress(progress);
  }

  cancel() {
    this.abortController?.abort(new DOMException("Backup cancelled", "AbortError"));
  }

  renderProgress(progress) {
    const wrapper = element("externalBackupProgress");
    if (!wrapper) return;
    wrapper.classList.remove("hidden");
    setText("externalBackupProgressTitle", progress.message || "Working");
    const completed = Number(progress.completed_files || progress.pack || 0);
    const total = Number(progress.total_files || progress.total_packs || 0);
    setText("externalBackupProgressDetail", total ? `${completed} / ${total}` : "");
    const bar = element("externalBackupProgressBar");
    if (bar) bar.value = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  }

  async render() {
    const workspace = this.workspace();
    setText("backupWorkspaceLabel", workspace ? `${workspace.name} · ${workspace.id}` : "No workspace selected");
    setText("externalBackupStatus", this.repository ? "Ready" : this.connection ? "Locked" : "Not connected");
    setText("backupConnectionSummary", this.connection ? `${this.connection.label || this.connection.type} connected` : "Choose where to store this workspace.");
    element("backupDisconnect")?.toggleAttribute("disabled", !this.connection);
    element("externalBackupNow")?.toggleAttribute("disabled", !this.connection || !this.repository || !!this.activeJob);
    element("externalBackupCancel")?.classList.toggle("hidden", !this.activeJob);
    setText("externalBackupJob", this.activeJob ? this.activeJob.phase : "None");
    document.querySelectorAll("[data-backup-provider]").forEach((button) => button.classList.toggle("active", button.dataset.backupProvider === this.connection?.type));
    const schedule = workspace ? await this.store.getSchedule(workspace.id) : null;
    if (element("externalBackupScheduleEnabled")) element("externalBackupScheduleEnabled").checked = schedule?.enabled === true;
    if (element("externalBackupScheduleInterval")) element("externalBackupScheduleInterval").value = String(schedule?.interval_minutes || 1440);
    if (this.repository) await this.renderBackups();
    else if (element("externalBackupList")) element("externalBackupList").innerHTML = '<div class="file-muted">Connect and unlock storage to list backups.</div>';
    window.lucide?.createIcons();
  }

  async renderBackups() {
    if (!this.repository) return;
    const backups = await this.repository.listBackups();
    setText("externalBackupCount", backups.length);
    setText("externalBackupLastRun", backups[0]?.created_at ? formatTimestamp(backups[0].created_at) : "Never");
    const latestStats = backups[0]?.stats || {};
    setText("externalBackupReused", this.formatBytes(latestStats.reused_bytes || 0));
    setText("externalBackupSourceBytes", this.formatBytes(latestStats.source_bytes || 0));
    setText("externalBackupUploadedBytes", this.formatBytes(latestStats.uploaded_bytes || 0));
    setText("externalBackupReusedBytes", this.formatBytes(latestStats.reused_bytes || 0));
    const list = element("externalBackupList");
    if (!list) return;
    list.textContent = "";
    if (!backups.length) {
      list.innerHTML = '<div class="file-muted">No backups yet.</div>';
      return;
    }
    for (const backup of backups) {
      const card = document.createElement("div");
      card.className = "backup-card external-backup-card";
      card.dataset.snapshotId = backup.snapshot_id;
      card.innerHTML = `
        <div class="external-backup-card-main">
          <strong></strong>
          <span></span>
        </div>
        <div class="setting-actions">
          <button class="icon-button button-ghost" type="button" data-backup-action="verify"><i data-lucide="shield-check"></i>Verify</button>
          <button class="icon-button" type="button" data-backup-action="restore"><i data-lucide="rotate-ccw"></i>Restore</button>
          <button class="icon-only" type="button" data-backup-action="delete" title="Delete backup"><i data-lucide="trash-2"></i></button>
        </div>`;
      card.querySelector("strong").textContent = backup.workspace_name || "EdgeTerm workspace";
      card.querySelector("span").textContent = `${formatTimestamp(backup.created_at)} · ${backup.stats?.files || 0} files · ${this.formatBytes(backup.stats?.source_bytes || 0)}`;
      list.appendChild(card);
    }
    window.lucide?.createIcons({ root: list });
  }

  async handleBackupAction(event) {
    const button = event.target.closest("[data-backup-action]");
    const card = button?.closest("[data-snapshot-id]");
    if (!button || !card || !this.repository) return;
    const snapshotId = card.dataset.snapshotId;
    try {
      if (button.dataset.backupAction === "verify") {
        button.disabled = true;
        const result = await this.repository.verifyBackup(snapshotId, { onProgress: (progress) => this.renderProgress(progress) });
        this.hooks.notice(`Verified ${result.checked_files} files`);
      } else if (button.dataset.backupAction === "restore") {
        if (!(await this.hooks.confirm("Restore this backup into a new workspace?"))) return;
        const { manifest } = await this.repository.loadManifest(snapshotId);
        const target = await this.hooks.createRestoreTarget(manifest);
        await this.repository.restoreBackup(snapshotId, target, { onProgress: (progress) => this.renderProgress(progress) });
        this.hooks.notice("Backup restored into a new workspace");
      } else if (button.dataset.backupAction === "delete") {
        if (!(await this.hooks.confirm("Delete this restore point? Unused data is cleaned after the repository grace period."))) return;
        await this.repository.deleteBackup(snapshotId);
        await this.renderBackups();
      }
    } catch (error) {
      this.hooks.notice(error?.message || String(error));
    } finally {
      button.disabled = false;
      element("externalBackupProgress")?.classList.add("hidden");
    }
  }

  async saveSchedule() {
    const workspace = this.workspace();
    if (!workspace) return;
    const enabled = element("externalBackupScheduleEnabled")?.checked === true;
    if (enabled && !this.connection) return this.hooks.notice("Connect storage before enabling a schedule");
    const interval = Math.max(60, Number(element("externalBackupScheduleInterval")?.value || 1440));
    await this.store.saveSchedule({
      workspace_id: workspace.id,
      enabled,
      interval_minutes: interval,
      next_run_at: enabled ? new Date(Date.now() + interval * 60_000).toISOString() : null,
    });
    this.hooks.notice(enabled ? "Backup schedule saved" : "Automatic backups disabled");
  }

  async runDueSchedule() {
    if (this.activeJob || !this.connection) return;
    const workspace = this.workspace();
    if (!workspace) return;
    const schedule = await this.store.getSchedule(workspace.id);
    if (!schedule?.enabled || !schedule.next_run_at || new Date(schedule.next_run_at).getTime() > Date.now()) return;
    try {
      await this.startBackup();
    } catch {}
    const interval = Math.max(60, Number(schedule.interval_minutes || 1440));
    await this.store.saveSchedule({ ...schedule, next_run_at: new Date(Date.now() + interval * 60_000).toISOString() });
  }

  async handleBridge(method, params = {}) {
    if (method === "backup.attach_connection") {
      const provider = String(params.provider || "");
      const connectionId = String(params.connection_id || "");
      if (!["google-drive", "dropbox"].includes(provider) || !/^\d+$/.test(connectionId)) {
        throw new Error("The managed backup connection is invalid");
      }
      const connection = await this.attachBrokerConnection(provider, connectionId);
      return {
        connected: true,
        provider: connection.type,
        connection_id: connection.id,
      };
    }
    if (method === "backup.status") {
      return {
        connected: !!this.connection,
        unlocked: !!this.repository,
        provider: this.connection?.type || null,
        connection_id: this.connection?.id || null,
        repository_id: this.repository?.repositoryId || null,
        active_job: this.activeJob,
      };
    }
    if (method === "backup.list") {
      if (!this.repository) throw new Error("Unlock backups first");
      return { backups: await this.repository.listBackups() };
    }
    if (method === "backup.create") return await this.startBackup({ snapshotId: params.snapshot_id });
    if (method === "backup.cancel") {
      this.cancel();
      return { cancelled: true };
    }
    if (method === "backup.verify") {
      if (!this.repository) throw new Error("Unlock backups first");
      return await this.repository.verifyBackup(params.snapshot_id, { full: params.full === true });
    }
    if (method === "backup.restore_preview") {
      if (!this.repository) throw new Error("Unlock backups first");
      return await this.repository.previewRestore(params.snapshot_id, await this.hooks.currentEntries());
    }
    if (method === "backup.restore") {
      if (!this.repository) throw new Error("Unlock backups first");
      if (!(await this.hooks.confirm("Restore this backup into a new workspace?"))) throw new Error("Restore was not approved");
      const { manifest } = await this.repository.loadManifest(params.snapshot_id);
      return await this.repository.restoreBackup(params.snapshot_id, await this.hooks.createRestoreTarget(manifest));
    }
    throw new Error(`Unsupported backup method: ${method}`);
  }
}
