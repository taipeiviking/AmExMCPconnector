export {
  CompositeSecretReferenceResolver,
  SecretReferenceError,
  withResolvedSecret,
  type SecretReferenceErrorCode,
  type SecretReferenceResolver,
  type SecretReferenceStore,
} from "./secret-reference";
export {
  WindowsGenericCredentialResolver,
  parseWindowsCredentialReference,
  type WindowsCredentialCommandResult,
  type WindowsCredentialCommandRunner,
  type WindowsGenericCredentialResolverOptions,
} from "./windows-generic-credential-resolver";
export {
  WindowsGenericCredentialStore,
  formatWindowsCredentialReference,
  type WindowsCredentialMutationCommand,
  type WindowsCredentialMutationResult,
  type WindowsCredentialMutationRunner,
  type WindowsGenericCredentialStoreOptions,
} from "./windows-generic-credential-store";
