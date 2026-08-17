/**
 * The GitHub half of signing in.
 *
 * Nothing here touches the database or a cookie — it turns a code into a
 * profile and stops. That keeps the routes readable and lets the tests run the
 * whole handshake against a stub `fetch` with no network and no OAuth app.
 *
 * Only `read:user` is requested. Adeia never needs to see a repository, and an
 * OAuth token that could is a token worth stealing.
 */

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";

/** Identity only. Deliberately not `repo`, `user:email`, or anything wider. */
export const OAUTH_SCOPE = "read:user";

export class GithubOauthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubOauthError";
  }
}

export interface GithubProfile {
  /** Numeric account id as a string. Stable across a login rename. */
  githubId: string;
  login: string;
  email: string | null;
  avatarUrl: string | null;
}

export interface GithubOauthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function authorizeUrl(config: GithubOauthConfig, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", OAUTH_SCOPE);
  url.searchParams.set("state", state);
  // Ask GitHub to re-prompt rather than silently reusing a session, so
  // "sign out" on our side is not undone by GitHub logging the user straight
  // back in on the next click.
  url.searchParams.set("allow_signup", "false");
  return url.toString();
}

/** Requests JSON explicitly; GitHub returns form-encoded otherwise. */
export async function exchangeCode(
  config: GithubOauthConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
    }),
  });

  if (!response.ok) {
    throw new GithubOauthError(`GitHub refused the code exchange (${response.status})`);
  }

  const payload = (await response.json()) as {
    access_token?: unknown;
    error?: unknown;
    error_description?: unknown;
  };

  // GitHub reports failure in a 200 body, so the status check above is not
  // enough on its own.
  if (typeof payload.error === "string") {
    const detail =
      typeof payload.error_description === "string" ? payload.error_description : payload.error;
    throw new GithubOauthError(`GitHub refused the code exchange: ${detail}`);
  }

  if (typeof payload.access_token !== "string" || payload.access_token === "") {
    throw new GithubOauthError("GitHub returned no access token");
  }

  return payload.access_token;
}

export async function fetchProfile(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubProfile> {
  const response = await fetchImpl(USER_URL, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/vnd.github+json",
      "user-agent": "adeia",
    },
  });

  if (!response.ok) {
    throw new GithubOauthError(`GitHub refused the profile request (${response.status})`);
  }

  const payload = (await response.json()) as {
    id?: unknown;
    login?: unknown;
    email?: unknown;
    avatar_url?: unknown;
  };

  // The id is the account. Without it there is nothing to key a user on, and
  // guessing from the login would let a renamed handle inherit someone's
  // projects.
  if (typeof payload.id !== "number" && typeof payload.id !== "string") {
    throw new GithubOauthError("GitHub returned a profile with no id");
  }
  if (typeof payload.login !== "string" || payload.login === "") {
    throw new GithubOauthError("GitHub returned a profile with no login");
  }

  return {
    githubId: String(payload.id),
    login: payload.login,
    email: typeof payload.email === "string" ? payload.email : null,
    avatarUrl: typeof payload.avatar_url === "string" ? payload.avatar_url : null,
  };
}
