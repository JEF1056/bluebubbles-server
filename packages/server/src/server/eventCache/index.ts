import { isEmpty } from "@server/helpers/utils";

/**
 * A Map-backed helper class for caching items with O(1) lookup
 */
export class EventCache {
    items: Map<string, number> = new Map();

    purge() {
        if (this.items.size === 0) return;
        console.info(`Purging ${this.size()} items from cache...`);
        this.items.clear();
    }

    trim(msOld: number) {
        const now = new Date().getTime();
        for (const [item, date] of this.items) {
            if (now - date >= msOld) this.items.delete(item);
        }
    }

    size() {
        return this.items.size;
    }

    add(item: string): boolean {
        if (isEmpty(item) || this.items.has(item)) return false;
        this.items.set(item, new Date().getTime());
        return true;
    }

    find(item: string): string | null {
        return this.items.has(item) ? item : null;
    }

    remove(item: string) {
        if (!item) return;
        this.items.delete(item);
    }
}
