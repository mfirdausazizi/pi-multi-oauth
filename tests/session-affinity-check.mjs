import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  AFFINITY_ENTRY_TYPE,
  createSessionAffinityBinding,
  pickSessionAffinityMember,
  readSessionAffinityBinding,
} from "../lib/session-affinity.ts";
import { PoolManager } from "../extensions/multi-sub.ts";

// This key hashes away from the base provider, so the first-assignment test must call setModel.
const key = {
  sessionId: "session-0",
  poolName: "codex-pool",
  modelId: "gpt-5-codex",
};

const first = createSessionAffinityBinding(key, "openai-codex");
const rebound = createSessionAffinityBinding(key, "openai-codex-2");
const entries = [
  { type: "custom", customType: AFFINITY_ENTRY_TYPE, data: first },
  { type: "custom", customType: AFFINITY_ENTRY_TYPE, data: { ...rebound, version: 99 } },
  { type: "custom", customType: AFFINITY_ENTRY_TYPE, data: rebound },
];

assert.deepEqual(readSessionAffinityBinding(entries, key), rebound);
assert.equal(
  readSessionAffinityBinding(entries, { ...key, sessionId: "forked-session" }),
  undefined,
  "forked sessions must not inherit a copied binding",
);
assert.equal(
  readSessionAffinityBinding(entries, { ...key, modelId: "gpt-5-codex-mini" }),
  undefined,
  "bindings must be model-specific",
);

const members = ["openai-codex", "openai-codex-2", "openai-codex-3"];
const selected = pickSessionAffinityMember(key, members);
assert.ok(members.includes(selected));
assert.equal(pickSessionAffinityMember(key, [...members].reverse()), selected);
assert.equal(pickSessionAffinityMember(key, members), selected);
assert.equal(pickSessionAffinityMember(key, []), undefined);

const assigned = new Set(
  Array.from({ length: 100 }, (_, index) =>
    pickSessionAffinityMember({ ...key, sessionId: `session-${index}` }, members),
  ),
);
assert.deepEqual(assigned, new Set(members), "new sessions should distribute across pool members");

const branch = [];
let selectedModel;
const models = new Map(
  members.map((provider) => [
    `${provider}:gpt-5-codex`,
    { provider, id: "gpt-5-codex", name: provider },
  ]),
);
const pi = {
  async setModel(model) {
    selectedModel = model;
    return true;
  },
  appendEntry(customType, data) {
    branch.push({ type: "custom", customType, data });
    return `entry-${branch.length}`;
  },
};
const ctx = {
  sessionManager: {
    getSessionId: () => key.sessionId,
    getBranch: () => [...branch],
  },
  modelRegistry: {
    getProviderAuthStatus: () => ({ configured: true }),
    find: (provider, modelId) => models.get(`${provider}:${modelId}`),
  },
  ui: { notify() {}, setStatus() {} },
};
const pool = {
  name: key.poolName,
  baseProvider: "openai-codex",
  members,
  enabled: true,
  sessionAffinity: true,
};
const manager = new PoolManager(pi);
manager.loadPools([pool]);
const startingModel = models.get("openai-codex:gpt-5-codex");
assert.equal(await manager.applySessionAffinity(startingModel, ctx), true);
assert.equal(selectedModel.provider, selected, "first assignment should switch to the hashed member");
assert.equal(readSessionAffinityBinding(branch, key)?.provider, selected);

const manuallySelected = selected === "openai-codex-2" ? "openai-codex-3" : "openai-codex-2";
manager.bindSessionAffinity(models.get(`${manuallySelected}:gpt-5-codex`), ctx);
selectedModel = undefined;
assert.equal(await manager.applySessionAffinity(startingModel, ctx), true);
assert.equal(selectedModel.provider, manuallySelected, "manual selection should rebind the session");

manager.markExhausted(manuallySelected);
selectedModel = undefined;
assert.equal(await manager.applySessionAffinity(models.get(`${manuallySelected}:gpt-5-codex`), ctx), true);
assert.notEqual(selectedModel.provider, manuallySelected, "an unavailable binding should be replaced");
assert.equal(
  readSessionAffinityBinding(branch, key)?.provider,
  selectedModel.provider,
  "failover should persist the replacement binding",
);

const entryCount = branch.length;
selectedModel = undefined;
assert.equal(await manager.applySessionAffinity(models.get(`${readSessionAffinityBinding(branch, key).provider}:gpt-5-codex`), ctx), true);
assert.equal(branch.length, entryCount, "reusing a binding should not append duplicate state");

manager.loadPools([{ ...pool, sessionAffinity: false }]);
selectedModel = undefined;
assert.equal(await manager.applySessionAffinity(startingModel, ctx), false);
assert.equal(selectedModel, undefined, "pools without affinity must keep existing behavior");

const scheduledPool = {
  ...pool,
  name: "scheduled-pool",
  members: ["openai-codex", "openai-codex-2"],
  strategy: "scheduled",
  memberSchedule: { "openai-codex-2": { role: "overflow" } },
};
manager.loadPools([scheduledPool]);
selectedModel = undefined;
assert.equal(
  await manager.applySessionAffinity(models.get("openai-codex-2:gpt-5-codex"), ctx),
  true,
);
assert.equal(selectedModel.provider, "openai-codex", "scheduled affinity should prefer default members");

const customPool = {
  ...pool,
  name: "custom-affinity",
  strategy: "custom",
  selectorScript: fileURLToPath(new URL("./fixtures/session-affinity-selector.mjs", import.meta.url)),
};
manager.loadPools([customPool]);
selectedModel = undefined;
assert.equal(await manager.applySessionAffinity(startingModel, ctx), true);
assert.equal(selectedModel.provider, "openai-codex-2", "custom affinity should receive the session ID");

const quotaPool = {
  ...pool,
  name: "quota-pool",
  members: ["openai-codex-2"],
  strategy: "quota-first",
};
manager.loadPools([quotaPool]);
selectedModel = undefined;
assert.equal(
  await manager.applySessionAffinity(models.get("openai-codex-2:gpt-5-codex"), ctx),
  true,
);
assert.equal(
  readSessionAffinityBinding(branch, { ...key, poolName: quotaPool.name })?.provider,
  "openai-codex-2",
  "quota-first affinity should bind its eligible member",
);

console.log("session affinity checks passed");
