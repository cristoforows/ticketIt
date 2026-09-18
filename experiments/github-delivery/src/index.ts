export { FakeGitHubApi } from "./fake-github-api.js";
export type {
  FakeGitHubApiConfig,
  OAuthAccountConfig,
  PatAccountConfig,
  RequestLogEntry,
  TokenKind,
} from "./fake-github-api.js";

export { FakeGitRemote } from "./fake-git-remote.js";
export type { SshInvocation } from "./fake-git-remote.js";

export { GalleySubstitute } from "./galley-substitute.js";
export type { SignInResult, SignInSession } from "./galley-substitute.js";

export {
  GitHubConnection,
  GitHubConnectionActions,
  AdmissionRefusedError,
  IdentityMismatchError,
  RepositoryAccessError,
  PullRequestPermissionError,
  repoResource,
  pullsResource,
  pushResource,
} from "./github-connection.js";
export type { GitAuthor, GitHubConnectionConfig, LedgerContext } from "./github-connection.js";
