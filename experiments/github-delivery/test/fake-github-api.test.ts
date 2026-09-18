import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeGitHubApi } from "../src/fake-github-api.js";

const OAUTH_TOKEN = "oauth-fixture-owner-token";
const PAT_TOKEN = "pat-fixture-michelin-token";
const UNCONFIGURED_TOKEN = "unconfigured-token-should-never-be-accepted";

function makeApi(): FakeGitHubApi {
  return new FakeGitHubApi({
    oauthAccounts: [{ token: OAUTH_TOKEN, login: "cristoforows" }],
    patAccounts: [
      {
        token: PAT_TOKEN,
        login: "michelin-bot",
        repositories: ["acme/allowed-repo"],
        permissions: ["contents"],
      },
    ],
  });
}

test("GET /user with a configured OAuth token returns that account's login", async () => {
  const api = makeApi();
  const { baseUrl } = await api.listen();
  try {
    const res = await fetch(new URL("/user", baseUrl), { headers: { Authorization: `Bearer ${OAUTH_TOKEN}` } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { login: "cristoforows" });
  } finally {
    await api.close();
  }
});

test("GET /user with a configured PAT token returns that account's login", async () => {
  const api = makeApi();
  const { baseUrl } = await api.listen();
  try {
    const res = await fetch(new URL("/user", baseUrl), { headers: { Authorization: `Bearer ${PAT_TOKEN}` } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { login: "michelin-bot" });
  } finally {
    await api.close();
  }
});

test("GET /user with an unconfigured token is rejected with 401, never accepted", async () => {
  const api = makeApi();
  const { baseUrl } = await api.listen();
  try {
    const res = await fetch(new URL("/user", baseUrl), { headers: { Authorization: `Bearer ${UNCONFIGURED_TOKEN}` } });
    assert.equal(res.status, 401);
    const log = api.requestLog();
    assert.equal(log.length, 1);
    assert.equal(log[0]?.tokenKind, "unknown");
    assert.equal(log[0]?.login, null);
  } finally {
    await api.close();
  }
});

test("GET /repos/{owner}/{repo} returns 200 only for a repository inside the PAT's resource set", async () => {
  const api = makeApi();
  const { baseUrl } = await api.listen();
  try {
    const res = await fetch(new URL("/repos/acme/allowed-repo", baseUrl), { headers: { Authorization: `Bearer ${PAT_TOKEN}` } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { full_name: string };
    assert.equal(body.full_name, "acme/allowed-repo");
  } finally {
    await api.close();
  }
});

test("GET /repos/{owner}/{repo} returns 404 for a repository outside the PAT's resource set", async () => {
  const api = makeApi();
  const { baseUrl } = await api.listen();
  try {
    const res = await fetch(new URL("/repos/acme/other-repo", baseUrl), { headers: { Authorization: `Bearer ${PAT_TOKEN}` } });
    assert.equal(res.status, 404);
  } finally {
    await api.close();
  }
});

test("GET /repos/{owner}/{repo}/pulls returns 403 when the token lacks pull-request permission", async () => {
  const api = makeApi();
  const { baseUrl } = await api.listen();
  try {
    const res = await fetch(new URL("/repos/acme/allowed-repo/pulls", baseUrl), { headers: { Authorization: `Bearer ${PAT_TOKEN}` } });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { message: string };
    assert.equal(body.message, "Resource not accessible by personal access token");
  } finally {
    await api.close();
  }
});

test("GET /repos/{owner}/{repo}/pulls returns 200 when the token has pull-request permission", async () => {
  const api = new FakeGitHubApi({
    patAccounts: [
      {
        token: PAT_TOKEN,
        login: "michelin-bot",
        repositories: ["acme/allowed-repo"],
        permissions: ["contents", "pull_requests"],
      },
    ],
  });
  const { baseUrl } = await api.listen();
  try {
    const res = await fetch(new URL("/repos/acme/allowed-repo/pulls", baseUrl), { headers: { Authorization: `Bearer ${PAT_TOKEN}` } });
    assert.equal(res.status, 200);
  } finally {
    await api.close();
  }
});

test("requestLog records method, path, token kind, and status for every request", async () => {
  const api = makeApi();
  const { baseUrl } = await api.listen();
  try {
    await fetch(new URL("/user", baseUrl), { headers: { Authorization: `Bearer ${PAT_TOKEN}` } });
    await fetch(new URL("/repos/acme/other-repo", baseUrl), { headers: { Authorization: `Bearer ${PAT_TOKEN}` } });
    const log = api.requestLog();
    assert.equal(log.length, 2);
    assert.deepEqual(
      log.map((entry) => ({ method: entry.method, path: entry.path, tokenKind: entry.tokenKind, status: entry.status })),
      [
        { method: "GET", path: "/user", tokenKind: "pat", status: 200 },
        { method: "GET", path: "/repos/acme/other-repo", tokenKind: "pat", status: 404 },
      ],
    );
  } finally {
    await api.close();
  }
});
