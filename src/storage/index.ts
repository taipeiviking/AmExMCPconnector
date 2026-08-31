export {
  EncryptedSqlJsDatabase,
  type CreateEncryptedSqlJsDatabaseOptions,
  type EncryptedSqlJsDatabaseOptions,
  type SqlParameters,
  type SqlResult,
  type SqlRow,
} from "./encrypted-sqljs-database";
export {
  ElectronSafeStorageKeyProtector,
  createElectronSafeStorageKeyProtector,
  type ElectronSafeStorageLike,
} from "./electron-safe-storage-key-protector";
export { type KeyProtector } from "./key-protector";
export {
  SqlJsSecretVault,
  type SecretVaultEntryMetadata,
  type SecretVaultOptions,
} from "./sqljs-secret-vault";
export {
  StorageError,
  isStorageError,
  type StorageErrorCode,
} from "./storage-error";
