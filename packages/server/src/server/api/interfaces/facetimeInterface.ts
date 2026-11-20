import { Server } from "@server";
import { FaceTimeSession, FaceTimeSessionStatus, SerializedFaceTimeSession } from "../lib/facetime/FaceTimeSession";
import { FaceTimeSessionManager } from "../lib/facetime/FacetimeSessionManager";
import { FaceTimeAudioBridge } from "../lib/facetime/FaceTimeAudioBridge";
import { isMinMonterey } from "@server/env";
import { checkPrivateApiStatus } from "@server/helpers/utils";

export type CallMetadataOptions = {
    deviceId?: string | null;
    deviceName?: string | null;
    displayName?: string | null;
    chatGuid?: string | null;
    addresses?: string[];
};

const applyMetadata = (session: FaceTimeSession, options?: CallMetadataOptions, isInitiator = false) => {
    if (!options) return;
    if (options.displayName) session.displayName = options.displayName;
    if (options.chatGuid) session.chatGuid = options.chatGuid;
    if (Array.isArray(options.addresses) && options.addresses.length > 0) {
        session.addresses = [...options.addresses];
        if (!session.address) session.address = options.addresses[0];
    }
    if (options.deviceId) {
        if (isInitiator && !session.initiatorDeviceId) session.initiatorDeviceId = options.deviceId;
        session.activeDeviceId = options.deviceId;
    }
    if (options.deviceName) {
        if (isInitiator && !session.initiatorDeviceName) session.initiatorDeviceName = options.deviceName;
        session.activeDeviceName = options.deviceName;
    }
    session.touch();
};

/**
 * An interface to interact with Facetime
 */
export class FaceTimeInterface {
    static listSessions(): SerializedFaceTimeSession[] {
        return FaceTimeSessionManager()
            .listActiveSessions()
            .map(session => session.serialize());
    }

    static async create(
        options?: CallMetadataOptions
    ): Promise<{ link: string; session: SerializedFaceTimeSession }> {
        checkPrivateApiStatus();
        if (!isMinMonterey) throw new Error("Creating FaceTime calls is only available on macOS Big Sur and newer!");
        const session = await FaceTimeSession.fromGeneratedLink(null);
        applyMetadata(session, options, true);
        session.admitAndLeave(90000, 15000, true).catch(() => {});
        FaceTimeSessionManager().broadcastUpdate(session);
        return { link: session.url, session: session.serialize() };
    }

    static async call({
        addresses,
        video = true,
        isTelephony = false,
        deviceId = null,
        deviceName = null,
        displayName = null,
        chatGuid = null
    }: {
        addresses: string[];
        video?: boolean;
        isTelephony?: boolean;
    } & CallMetadataOptions): Promise<{
        link?: { url: string };
        call: Record<string, any>;
        session: SerializedFaceTimeSession;
    }> {
        checkPrivateApiStatus();
        if (!isMinMonterey) throw new Error("FaceTime calls are only available on macOS Monterey and newer!");
        if (!Array.isArray(addresses) || addresses.length === 0) {
            throw new Error("At least one address is required to place a FaceTime call!");
        }

        const result = await Server().privateApi.facetime.startCall(addresses, video, isTelephony);
        const callUuid = result?.data?.call_uuid ?? result?.data?.callUUID;
        if (!callUuid) {
            throw new Error(result?.data?.error ?? "Failed to start FaceTime call: helper did not return call_uuid!");
        }

        const pregeneratedUrl: string | null = result?.data?.url ?? null;
        const call = {
            call_uuid: callUuid,
            callUuid,
            status: result?.data?.status ?? "outgoing",
            is_video: video,
            is_telephony: isTelephony,
            address: addresses[0],
            group_uuid: result?.data?.group_uuid ?? null
        };

        let session = FaceTimeSessionManager().findSession(callUuid);
        if (!session) {
            session = new FaceTimeSession({
                callUuid,
                status: FaceTimeSessionStatus.OUTGOING,
                url: pregeneratedUrl,
                address: addresses[0],
                addresses,
                isOutgoing: true,
                isVideo: video && !isTelephony,
                isAudio: !video || isTelephony,
                isTelephony
            });
        } else {
            if (session.status === FaceTimeSessionStatus.UNKNOWN) {
                session.status = FaceTimeSessionStatus.OUTGOING;
            }
            if (pregeneratedUrl && !session.url) {
                session.url = pregeneratedUrl;
            }
            session.isOutgoing = true;
            session.isVideo = video && !isTelephony;
            session.isAudio = !video || isTelephony;
            session.isTelephony = isTelephony;
        }
        if (result?.data?.group_uuid && !session.conversationGroupUuid) {
            session.conversationGroupUuid = result.data.group_uuid;
        }
        applyMetadata(session, { deviceId, deviceName, displayName, chatGuid, addresses }, true);

        if (!video || isTelephony) {
            FaceTimeSessionManager().broadcastUpdate(session);
            return { call, session: session.serialize() };
        }

        let url = session.url;
        if (!url) {
            try {
                url = await session.generateLink();
            } catch (err: any) {
                if (session.status === FaceTimeSessionStatus.OUTGOING) {
                    session.endedByUser = true;
                    session.endAndInvalidateTriggered = true;
                    Server()
                        ?.privateApi?.facetime?.endAndInvalidateCall?.(
                            callUuid,
                            session.url,
                            session.conversationGroupUuid
                        )
                        ?.catch?.(() => {});
                    session.invalidate("link_failed", err?.message ?? String(err));
                    FaceTimeSessionManager().broadcastUpdate(session, true);
                }
                throw err;
            }
        }
        session.admitAndLeave(90000, 15000, false).catch(() => {});
        FaceTimeSessionManager().broadcastUpdate(session);
        return { link: { url }, call, session: session.serialize() };
    }

    static async answer(
        callUuid: string,
        audioOnly = false,
        options?: CallMetadataOptions
    ): Promise<{ audioOnly: boolean; callUuid: string; link: string | null; session: SerializedFaceTimeSession }> {
        checkPrivateApiStatus();
        if (!isMinMonterey) throw new Error("Answering FaceTime calls is only available on macOS Big Sur and newer!");

        let session = FaceTimeSessionManager().findSession(callUuid);
        if (!session) {
            session = new FaceTimeSession({ callUuid, status: FaceTimeSessionStatus.INCOMING });
        }
        applyMetadata(session, options, false);

        if (audioOnly) {
            session.isAudio = true;
            session.isVideo = false;
            session.touch();
            await Server().privateApi.facetime.answerCall(callUuid);
            session.status = FaceTimeSessionStatus.ANSWERED;
            if (!session.answeredAt) session.answeredAt = new Date();
            session.touch();
            FaceTimeSessionManager().broadcastUpdate(session);
            return { audioOnly: true, callUuid, link: null, session: session.serialize() };
        }

        session.isVideo = true;
        session.isAudio = false;
        session.touch();
        const link = await FaceTimeInterface.answerAndWaitForLink(callUuid);
        Server().privateApi.facetime.setMuted(callUuid, true).catch(() => {});
        session.status = FaceTimeSessionStatus.ANSWERED;
        if (!session.answeredAt) session.answeredAt = new Date();
        session.touch();
        FaceTimeSessionManager().broadcastUpdate(session);
        return { audioOnly: false, callUuid, link, session: session.serialize() };
    }

    static async handoff(
        callUuid: string,
        {
            deviceId = null,
            deviceName = null,
            mode
        }: { deviceId?: string | null; deviceName?: string | null; mode?: "video" | "audio" } = {}
    ): Promise<{ link: string | null; session: SerializedFaceTimeSession }> {
        checkPrivateApiStatus();
        if (!isMinMonterey) throw new Error("Handing off FaceTime calls is only available on macOS Monterey and newer!");

        const session = FaceTimeSessionManager().findSession(callUuid);
        if (!session || session.status === FaceTimeSessionStatus.DISCONNECTED) {
            throw new Error("FaceTime session not found or already ended!");
        }

        if (deviceId) session.activeDeviceId = deviceId;
        if (deviceName) session.activeDeviceName = deviceName;

        const targetMode: "video" | "audio" = mode ?? (session.isTelephony ? "audio" : "video");
        if (targetMode === "video" && !session.isTelephony) {
            FaceTimeAudioBridge.getInstance().cleanupSession(session.callUuid || session.uuid);
            session.isVideo = true;
            session.isAudio = false;
            if (!session.url) {
                await session.generateLink();
            }
            if (session.callUuid) {
                Server()?.privateApi?.facetime?.setMuted(session.callUuid, true)?.catch?.(() => {});
            }
            session.admitSelf(false).catch(() => {});
        } else {
            session.isAudio = true;
            session.isVideo = false;
            if (session.callUuid && !session.isLinkOnly) {
                Server()?.privateApi?.facetime?.setMuted(session.callUuid, session.isMuted)?.catch?.(() => {});
            }
        }

        session.touch();
        const serialized = FaceTimeSessionManager().broadcastUpdate(session, true);
        return { link: session.url ?? null, session: serialized };
    }

    static async end(callUuid: string): Promise<void> {
        checkPrivateApiStatus();
        if (!isMinMonterey) throw new Error("Ending FaceTime calls is only available on macOS Big Sur and newer!");
        await FaceTimeInterface.endSessionIdempotently(callUuid, "end");
    }

    static async leave(callUuid: string): Promise<void> {
        checkPrivateApiStatus();
        if (!isMinMonterey) throw new Error("Leaving FaceTime calls is only available on macOS Big Sur and newer!");
        await FaceTimeInterface.endSessionIdempotently(callUuid, "leave");
    }

    static async decline(callUuid: string): Promise<void> {
        checkPrivateApiStatus();
        if (!isMinMonterey) throw new Error("Declining FaceTime calls is only available on macOS Big Sur and newer!");
        await FaceTimeInterface.endSessionIdempotently(callUuid, "decline");
    }

    private static async endSessionIdempotently(callUuid: string, action: "leave" | "decline" | "end"): Promise<void> {
        const session = FaceTimeSessionManager().findSession(callUuid);
        const targetCallUuid = session?.callUuid || callUuid;
        const sessionUrl = session?.url ?? null;
        const groupUuid = session?.conversationGroupUuid ?? null;

        if (session) {
            session.endedByUser = true;
            session.endAndInvalidateTriggered = true;
        }

        if (targetCallUuid && !session?.isLinkOnly) {
            try {
                const ftApi = Server().privateApi.facetime;
                if (typeof ftApi.endAndInvalidateCall === "function") {
                    await ftApi.endAndInvalidateCall(targetCallUuid, sessionUrl, groupUuid);
                } else if (action === "decline") {
                    await ftApi.declineCall(targetCallUuid);
                } else {
                    await ftApi.leaveCall(targetCallUuid);
                }
            } catch {
                // Idempotent: TUCall may already be disconnected on macOS
            }
        } else if (sessionUrl && typeof Server()?.privateApi?.facetime?.endAndInvalidateCall === "function") {
            try {
                await Server().privateApi.facetime.endAndInvalidateCall(targetCallUuid, sessionUrl, groupUuid);
            } catch {
                // Ignore
            }
        }

        if (targetCallUuid) {
            FaceTimeAudioBridge.getInstance().cleanupSession(targetCallUuid);
        }

        const endedReason = action === "decline" ? "declined" : "user_ended";
        if (session) {
            if (session.status !== FaceTimeSessionStatus.DISCONNECTED) {
                session.invalidate(endedReason);
            }
            FaceTimeSessionManager().broadcastUpdate(session, true);
        } else {
            const transient = new FaceTimeSession({ callUuid, addToManager: false });
            transient.invalidate(endedReason);
            FaceTimeSessionManager().broadcastUpdate(transient, true);
        }
    }

    static async setMuted(callUuid: string, muted: boolean): Promise<SerializedFaceTimeSession | null> {
        checkPrivateApiStatus();
        if (!isMinMonterey) throw new Error("Muting FaceTime calls is only available on macOS Big Sur and newer!");
        const session = FaceTimeSessionManager().findSession(callUuid);
        const targetCallUuid = session?.callUuid || callUuid;
        if (targetCallUuid && !session?.isLinkOnly) {
            await Server().privateApi.facetime.setMuted(targetCallUuid, muted);
        }
        if (session) {
            session.isMuted = muted;
            session.touch();
            return FaceTimeSessionManager().broadcastUpdate(session, true);
        }
        return null;
    }

    static async dtmf(callUuid: string, digit: string): Promise<{ played: boolean; via: "helper" | "bridge" | "none" }> {
        checkPrivateApiStatus();
        if (!isMinMonterey) throw new Error("Sending DTMF tones is only available on macOS Monterey and newer!");
        const normalized = String(digit ?? "").trim().toUpperCase();
        if (!/^[0-9*#ABCD]$/.test(normalized)) {
            throw new Error("Invalid DTMF digit: must be one of 0-9, *, #, A-D");
        }
        const res = await Server().privateApi.facetime.playDtmf(callUuid, normalized);
        if (res?.data?.played) {
            return { played: true, via: "helper" };
        }
        if (FaceTimeAudioBridge.getInstance().sendDtmf(callUuid, normalized)) {
            return { played: true, via: "bridge" };
        }
        return { played: false, via: "none" };
    }

    private static async answerAndWaitForLink(callUuid: string): Promise<string> {
        return await new Promise((resolve, reject) => {
            let settled = false;
            FaceTimeSession.answerIncomingCall(callUuid, (link: string) => {
                if (!settled) {
                    settled = true;
                    resolve(link);
                }
            }).catch(ex => {
                if (!settled) {
                    settled = true;
                    reject(ex);
                }
            });
        });
    }
}
