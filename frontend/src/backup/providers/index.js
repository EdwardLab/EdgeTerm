export { BackupProvider, BackupProviderError } from "./base.js";
export { DropboxBackupProvider } from "./dropbox.js";
export { GoogleDriveBackupProvider } from "./google-drive.js";
export { LocalFolderBackupProvider } from "./local-folder.js";
export { MemoryBackupProvider } from "./memory.js";
export { S3BackupProvider } from "./s3.js";

import { DropboxBackupProvider } from "./dropbox.js";
import { GoogleDriveBackupProvider } from "./google-drive.js";
import { LocalFolderBackupProvider } from "./local-folder.js";
import { S3BackupProvider } from "./s3.js";

export function createBackupProvider(config, runtime = {}) {
  const type = String(config?.type || "");
  if (type === "local-folder") return new LocalFolderBackupProvider(runtime.directoryHandle || config.directoryHandle, config);
  if (type === "google-drive") return new GoogleDriveBackupProvider({ ...config, tokenProvider: runtime.tokenProvider });
  if (type === "dropbox") return new DropboxBackupProvider({ ...config, tokenProvider: runtime.tokenProvider });
  if (type === "s3") return new S3BackupProvider({ ...config, credentialsProvider: runtime.credentialsProvider });
  throw new TypeError(`Unsupported backup provider: ${type}`);
}
