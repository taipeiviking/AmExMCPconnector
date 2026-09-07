export {
  CompositeSecretReferenceResolver,
  SecretReferenceError,
  withResolvedSecret,
  type SecretReferenceErrorCode,
  type SecretReferenceResolver,
} from "./secret-reference";
export {
  WindowsGenericCredentialResolver,
  parseWindowsCredentialReference,
  type WindowsCredentialCommandResult,
  type WindowsCredentialCommandRunner,
  type WindowsGenericCredentialResolverOptions,
} from "./windows-generic-credential-resolver";
