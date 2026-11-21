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

    private lastBroadcastSignatures: Map<string, string> = new Map();

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
            display_name: payload.display_name,
            chat_guid: payload.chat_guid,
            link: payload.link,
            is_outgoing: payload.is_outgoing,
            is_audio: payload.is_audio,
            is_video: payload.is_video,
            is_telephony: payload.is_telephony,
            is_link_only: payload.is_link_only,
            is_muted: payload.is_muted,
            active_device_id: payload.active_device_id,
            active_device_name: payload.active_device_name,
            ended_reason: payload.ended_reason,
            ended_error: payload.ended_error
        });

        const key = payload.uuid || payload.session_uuid;
        if (!force && this.lastBroadcastSignatures.get(key) === signature) {
            return payload;
        }
        this.lastBroadcastSignatures.set(key, signature);

        try {
            Server()?.emitMessage(FT_CALL_STATUS_CHANGED, payload, "high", true)?.catch?.(() => {});
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
        for (const session of this.sessions) {
            session.invalidate();
        }

        this.sessions = [];
        this.lastBroadcastSignatures.clear();
    }

    purgeOldSessions() {
        // Purge sessions older than 3 hours & invalidated
        const now = new Date().getTime();
        this.sessions = this.sessions.filter(session => {
            const keep =
                session.status !== FaceTimeSessionStatus.DISCONNECTED ||
                now - session.createdAt.getTime() < 1000 * 60 * 60 * 3;
            if (!keep) {
                this.lastBroadcastSignatures.delete(session.callUuid || session.uuid);
            }
            return keep;
        });
    }
}
