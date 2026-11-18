export const normalizePinnedChatGuids = (guids: unknown): string[] => {
    if (!Array.isArray(guids)) return [];

    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const entry of guids) {
        if (typeof entry !== "string") continue;
        const trimmed = entry.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        normalized.push(trimmed);
    }

    return normalized;
};

export type PinnedChatInfo = {
    isPinned: boolean;
    pinIndex: number | null;
};

export class PinnedChatsCache {
    private orderedGuids: string[] = [];

    private pinIndexByGuid: Map<string, number> = new Map();

    private initialized = false;

    isInitialized(): boolean {
        return this.initialized;
    }

    getPinnedGuids(): string[] {
        return [...this.orderedGuids];
    }

    setPinnedGuids(guids: unknown): { changed: boolean; pinnedChatGuids: string[] } {
        const nextGuids = normalizePinnedChatGuids(guids);
        const changed =
            !this.initialized ||
            nextGuids.length !== this.orderedGuids.length ||
            nextGuids.some((guid, idx) => guid !== this.orderedGuids[idx]);

        this.orderedGuids = nextGuids;
        this.pinIndexByGuid = new Map(nextGuids.map((guid, idx) => [guid, idx]));
        this.initialized = true;

        return { changed, pinnedChatGuids: [...this.orderedGuids] };
    }

    getPinInfo(guid?: string | null): PinnedChatInfo | null {
        if (!this.initialized || !guid) return null;
        const pinIndex = this.pinIndexByGuid.get(guid);
        if (pinIndex === undefined) {
            return { isPinned: false, pinIndex: null };
        }
        return { isPinned: true, pinIndex };
    }

    reset(): void {
        this.orderedGuids = [];
        this.pinIndexByGuid.clear();
        this.initialized = false;
    }
}
