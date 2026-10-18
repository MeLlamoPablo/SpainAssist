/**
 * @sa/sidecar — sa-sidecar, the native TLS helper of the agent's browser (Go, `go/`), and its
 * Node client. It presents client certificates for government logins: a .p12 key in memory, or
 * the DNIe in the paired phone. See README.md and docs/research/dnie.md §2.
 */
export { sidecarBinaryPath } from './layout';
export {
  type RemoteKey,
  Sidecar,
  SidecarError,
  type SidecarEvent,
  type SidecarHash,
  type SidecarIdentity,
  type SidecarLanguage,
  type SidecarLogger,
  type SidecarOptions,
} from './sidecar';
