import { Server } from "@server";
import { FT_CALL_STATUS_CHANGED } from "@server/events";
import { FaceTimeSession, FaceTimeSessionStatus, SerializedFaceTimeSession } from "./FaceTimeSession";

let instance: FaceTimeSessionManagerSingleton | null = null;
export const FaceTimeSessionManager = () => {
    if (!instance) {
        instance = new FaceTimeSessionManagerSingleton();
    }

    return instance;
};

class FaceTimeSessionManagerSingleton {
    sessions: FaceTimeSession[] = [];

    createdLinkUrls: Map<string, number> = new Map();

    linkCleanupGraceMs = 60 * 1000;

    linkMaxAgeMs = 5 * 60 * 1000;

    private lastBroadcastSignatures: Map<string, string> = new Map();

    private lastBroadcastStatuses: Map<string, FaceTimeSessionStatus> = new Map();

    private pendingLinkCleanups: Map<string, NodeJS.Timeout> = new Map();

    private linkSweepInterval: NodeJS.Timeout | null = null;

    private startupLinkSweepTimer: NodeJS.Timeout | null = null;

    recordCreatedLink(url: string | null | undefined) {
        const normalized = typeof url === "string" ? url.trim() : "";
        if (!normalized) return;
        this.cancelLinkCleanup(normalized);
        this.createdLinkUrls.set(normalized, Date.now());
        this.ensureLinkSweepStarted();
    }

    cancelLinkCleanup(url: string | null | undefined) {
        const normalized = typeof url === "string" ? url.trim() : "";
        if (!normalized) return;
        const timer = this.pendingLinkCleanups.get(normalized);
        if (timer) {
            clearTimeout(timer);
            this.pendingLinkCleanups.delete(normalized);
        }
    }

    isLinkInActiveSession(url: string): boolean {
        return this.sessions.some(
            session => session.status !== FaceTimeSessionStatus.DISCONNECTED && session.url === url
        );
    }

    scheduleLinkCleanup(url: string | null | undefined, delayMs = this.linkCleanupGraceMs) {
        const normalized = typeof url === "string" ? url.trim() : "";
        if (!normalized || !this.createdLinkUrls.has(normalized)) return;
        if (this.isLinkInActiveSession(normalized)) return;
        if (this.pendingLinkCleanups.has(normalized)) return;

        const timer = setTimeout(() => {
            this.pendingLinkCleanups.delete(normalized);
            if (this.isLinkInActiveSession(normalized)) return;
            this.createdLinkUrls.delete(normalized);
            try {
                Server()?.privateApi?.facetime?.removeLink?.(normalized)?.catch?.(() => {});
            } catch {
                // Ignore when Server singleton is unavailable
            }
        }, delayMs);
        timer.unref?.();
        this.pendingLinkCleanups.set(normalized, timer);
    }

    sweepUnusedLinks(maxAgeMs = this.linkMaxAgeMs) {
        const now = Date.now();
        for (const [url, createdAt] of Array.from(this.createdLinkUrls.entries())) {
            if (now - createdAt < maxAgeMs) continue;
            if (this.isLinkInActiveSession(url)) continue;
            this.cancelLinkCleanup(url);
            this.createdLinkUrls.delete(url);
            try {
                Server()?.privateApi?.facetime?.removeLink?.(url)?.catch?.(() => {});
            } catch {
                // Ignore when Server singleton is unavailable
            }
        }
    }

    ensureLinkSweepStarted(runStartupSweep = false) {
        if (runStartupSweep && !this.startupLinkSweepTimer) {
            this.startupLinkSweepTimer = setTimeout(() => {
                this.startupLinkSweepTimer = null;
                this.sweepUnusedLinks();
            }, 30 * 1000);
            this.startupLinkSweepTimer.unref?.();
        }
        if (this.linkSweepInterval) return;
        this.linkSweepInterval = setInterval(() => {
            this.sweepUnusedLinks();
        }, 15 * 60 * 1000);
        this.linkSweepInterval.unref?.();
    }

    stopLinkSweep() {
        if (this.startupLinkSweepTimer) {
            clearTimeout(this.startupLinkSweepTimer);
            this.startupLinkSweepTimer = null;
        }
        if (this.linkSweepInterval) {
            clearInterval(this.linkSweepInterval);
            this.linkSweepInterval = null;
        }
        for (const timer of this.pendingLinkCleanups.values()) {
            clearTimeout(timer);
        }
        this.pendingLinkCleanups.clear();
    }

    findSession(callUuid: string, ...aliases: Array<string | null | undefined>): FaceTimeSession {
        const candidates = [callUuid, ...aliases].filter(
            (id): id is string => typeof id === "string" && id.trim().length > 0
        );
        if (candidates.length === 0) return null;
        return (
            this.sessions.find(session => candidates.some(id => session.matchesIdentifier(id))) ?? null
        );
    }

    addSession(session: FaceTimeSession): boolean {
        const existingSession = this.findSession(session?.callUuid, session?.uniqueProxyIdentifier, session?.uuid);
        const isNew = !existingSession;

        if (existingSession) {
            existingSession.update(session);
        } else {
            this.sessions.push(session);
            session.armExpiryTimer();
        }
        if (session?.url && session.status !== FaceTimeSessionStatus.DISCONNECTED) {
            this.cancelLinkCleanup(session.url);
        }

        this.purgeOldSessions();
        return isNew;
    }

    listActiveSessions(): FaceTimeSession[] {
        this.purgeOldSessions();
        return this.sessions.filter(session => session.status !== FaceTimeSessionStatus.DISCONNECTED);
    }

    broadcastUpdate(session: FaceTimeSession, force = false): SerializedFaceTimeSession {
        const payload = session.serialize();
        const signature = JSON.stringify({
            uuid: payload.uuid,
            status_id: payload.status_id,
            address: payload.address,
            addresses: payload.addresses,
            display_name: payload.display_name,
            chat_guid: payload.chat_guid,
            link: payload.link,
            is_outgoing: payload.is_outgoing,
            is_audio: payload.is_audio,
            is_video: payload.is_video,
            is_telephony: payload.is_telephony,
            is_link_only: payload.is_link_only,
            is_muted: payload.is_muted,
            is_group: payload.is_group,
            endpoint_on_mac: payload.endpoint_on_mac,
            from_iphone: payload.from_iphone,
            active_device_id: payload.active_device_id,
            active_device_name: payload.active_device_name,
            ended_reason: payload.ended_reason,
            ended_error: payload.ended_error,
            silenced_reason: payload.silenced_reason
        });

        const key = payload.uuid || payload.session_uuid;
        if (!force && this.lastBroadcastSignatures.get(key) === signature) {
            return payload;
        }
        this.lastBroadcastSignatures.set(key, signature);

        const prevStatus = this.lastBroadcastStatuses.get(key);
        const useFcm =
            prevStatus !== session.status &&
            (session.status === FaceTimeSessionStatus.INCOMING ||
                session.status === FaceTimeSessionStatus.ANSWERED ||
                session.status === FaceTimeSessionStatus.DISCONNECTED);
        this.lastBroadcastStatuses.set(key, session.status);

        try {
            Server()?.emitMessage(FT_CALL_STATUS_CHANGED, payload, useFcm ? "high" : "normal", useFcm)?.catch?.(() => {});
        } catch {
            // Ignore when Server singleton is not initialized (e.g. unit tests)
        }

        return payload;
    }

    invalidateSession(callUuid: string, endedReason: string | null = null, endedError: string | null = null) {
        const session = this.findSession(callUuid);
        if (session) {
            session.invalidate(endedReason, endedError);
        }
    }

    clearSessions() {
        this.stopLinkSweep();
        this.createdLinkUrls.clear();
        for (const session of this.sessions) {
            session.invalidate();
        }

        this.sessions = [];
        this.lastBroadcastSignatures.clear();
        this.lastBroadcastStatuses.clear();
    }

    purgeOldSessions() {
        // Purge sessions older than 3 hours & invalidated
        const now = new Date().getTime();
        this.sessions = this.sessions.filter(session => {
            const keep =
                session.status !== FaceTimeSessionStatus.DISCONNECTED ||
                now - session.createdAt.getTime() < 1000 * 60 * 60 * 3;
            if (!keep) {
                const key = session.callUuid || session.uuid;
                this.lastBroadcastSignatures.delete(key);
                this.lastBroadcastStatuses.delete(key);
            }
            return keep;
        });
    }
}
