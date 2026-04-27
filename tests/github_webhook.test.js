const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  formatFork,
  formatIssue,
  formatPullRequest,
  formatRelease,
  formatStar,
} = require("../classes/github_webhook");

// Build the smallest payload shape each formatter actually reads. Real GitHub
// payloads are huge but the formatters only touch a handful of fields — these
// tests lock in the IRC-side message contract that EyeBridge / our bridge
// parser depends on.
const repo = (name = "amiantos/impostor") => ({ full_name: name });
const sender = (login = "octocat") => ({ login });

test("formatFork: '[repo] <user> forked the repo <url>'", () => {
  const message = formatFork({
    sender: sender("alice"),
    repository: repo("amiantos/impostor"),
    forkee: { html_url: "https://github.com/alice/impostor" },
  });
  assert.equal(
    message,
    "[amiantos/impostor] <alice> forked the repo <https://github.com/alice/impostor>"
  );
});

test("formatIssue: announces opened issues with number and title", () => {
  const message = formatIssue({
    action: "opened",
    sender: sender("bob"),
    repository: repo(),
    issue: {
      number: 42,
      title: "the readme is wrong",
      html_url: "https://github.com/amiantos/impostor/issues/42",
    },
  });
  assert.equal(
    message,
    "[amiantos/impostor] <bob> opened issue #42: the readme is wrong <https://github.com/amiantos/impostor/issues/42>"
  );
});

test("formatIssue: returns null for actions we deliberately ignore", () => {
  const ignored = ["assigned", "labeled", "milestoned", "edited"];
  for (const action of ignored) {
    const result = formatIssue({
      action,
      sender: sender(),
      repository: repo(),
      issue: { number: 1, title: "x", html_url: "u" },
    });
    assert.equal(result, null, `should ignore action '${action}'`);
  }
});

test("formatPullRequest: uses 'merged' verb when a closed PR was merged", () => {
  const message = formatPullRequest({
    action: "closed",
    sender: sender("carol"),
    repository: repo(),
    pull_request: {
      number: 7,
      title: "fix the thing",
      merged: true,
      html_url: "https://github.com/amiantos/impostor/pull/7",
    },
  });
  assert.match(message, /merged PR #7/);
  assert.doesNotMatch(message, /closed PR #7/);
});

test("formatPullRequest: keeps 'closed' verb for unmerged closes", () => {
  const message = formatPullRequest({
    action: "closed",
    sender: sender("dave"),
    repository: repo(),
    pull_request: {
      number: 8,
      title: "abandoned idea",
      merged: false,
      html_url: "https://github.com/amiantos/impostor/pull/8",
    },
  });
  assert.match(message, /closed PR #8/);
});

test("formatRelease: only announces 'published' actions", () => {
  const base = {
    sender: sender("erin"),
    repository: repo(),
    release: { tag_name: "v1.0", html_url: "https://example.com/r" },
  };
  assert.equal(
    formatRelease({ ...base, action: "published" }),
    "[amiantos/impostor] <erin> released v1.0 <https://example.com/r>"
  );
  assert.equal(formatRelease({ ...base, action: "edited" }), null);
  assert.equal(formatRelease({ ...base, action: "deleted" }), null);
});

test("formatStar: only announces 'started' (the GitHub event for adding a star)", () => {
  const base = { sender: sender("frank"), repository: repo() };
  assert.equal(
    formatStar({ ...base, action: "started" }),
    "[amiantos/impostor] <frank> starred the repo <https://github.com/frank>"
  );
  assert.equal(formatStar({ ...base, action: "deleted" }), null);
});

test("output starts with [tag] <name> so the bridge parser recognizes it as non-Discord", () => {
  // Regression guard: webhook output must NOT begin with "[discord] " — that
  // prefix is reserved for human Discord traffic and would cause Isaac to
  // treat a bot's announcement as a person speaking.
  const issue = formatIssue({
    action: "opened",
    sender: sender(),
    repository: repo(),
    issue: { number: 1, title: "t", html_url: "u" },
  });
  assert.match(issue, /^\[[^\]]+\] <[^>]+> /);
  assert.doesNotMatch(issue, /^\[discord\] /);
});
