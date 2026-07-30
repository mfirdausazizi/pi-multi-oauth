import { createHash } from "node:crypto";

export const AFFINITY_ENTRY_TYPE = "pi-multi-oauth:pool-affinity";

export interface SessionAffinityKey {
	sessionId: string;
	poolName: string;
	modelId: string;
}

export interface SessionAffinityBinding extends SessionAffinityKey {
	version: 1;
	provider: string;
}

export function createSessionAffinityBinding(
	key: SessionAffinityKey,
	provider: string,
): SessionAffinityBinding {
	return { version: 1, ...key, provider };
}

export function readSessionAffinityBinding(
	entries: readonly unknown[],
	key: SessionAffinityKey,
): SessionAffinityBinding | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		if (record.type !== "custom" || record.customType !== AFFINITY_ENTRY_TYPE) continue;
		const data = record.data;
		if (!data || typeof data !== "object") continue;
		const binding = data as Record<string, unknown>;
		if (
			binding.version === 1 &&
			binding.sessionId === key.sessionId &&
			binding.poolName === key.poolName &&
			binding.modelId === key.modelId &&
			typeof binding.provider === "string" &&
			binding.provider.length > 0
		) {
			return binding as unknown as SessionAffinityBinding;
		}
	}
	return undefined;
}

export function pickSessionAffinityMember(
	key: SessionAffinityKey,
	members: readonly string[],
): string | undefined {
	let selected: string | undefined;
	let selectedScore = "";
	for (const member of new Set(members)) {
		const score = createHash("sha256")
			.update(JSON.stringify([key.sessionId, key.poolName, key.modelId, member]))
			.digest("hex");
		if (score > selectedScore || (score === selectedScore && member < (selected ?? member))) {
			selected = member;
			selectedScore = score;
		}
	}
	return selected;
}
