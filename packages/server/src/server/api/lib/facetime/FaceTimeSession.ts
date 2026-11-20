import { Server } from "@server";
import { FaceTimeSessionManager } from "./FacetimeSessionManager";
import { NotificationCenterDB } from "@server/databases/notificationCenter/NotiicationCenterRepository";
import { convertDateToCocoaTime } from "@server/databases/imessage/helpers/dateUtil";
import { waitMs } from "@server/helpers/utils";
import { HandleResponse } from "@server/types";
import { v4 } from "uuid";
import { ScheduledService } from "../../../lib/ScheduledService";
import { Loggable } from "../../../lib/logging/Loggable";

export enum FaceTimeSessionStatus {
    UNKNOWN = 0,
    ANSWERED = 1,
    CONNECTING = 2,
    OUTGOING = 3,
    INCOMING = 4,
    DISCONNECTED = 6
}

export const callStatusMap: Record<number, string> = {
    [FaceTimeSessionStatus.UNKNOWN]: "unknown",
    [FaceTimeSessionStatus.ANSWERED]: "answered",
    [FaceTimeSessionStatus.CONNECTING]: "connecting",
    [FaceTimeSessionStatus.OUTGOING]: "outgoing",
    [FaceTimeSessionStatus.INCOMING]: "incoming",
    [FaceTimeSessionStatus.DISCONNECTED]: "disconnected"
};

export type SerializedFaceTimeSession = {
    uuid: string;
    session_uuid: string;
    status: string;
    status_id: number;
    address: string | null;
    addresses: string[];
    display_name: string | null;
    chat_guid: string | null;
    handle: HandleResponse | null;
    image_url: string | null;
    link: string | null;
    is_outgoing: boolean;
    is_audio: boolean;
    is_video: boolean;
    is_telephony: boolean;
    is_link_only: boolean;
    is_muted: boolean;
    initiator_device_id: string | null;
    initiator_device_name: string | null;
    active_device_id: string | null;
    active_device_name: string | null;
    started_at: number | null;
    answered_at: number | null;
    updated_at: number | null;
    ended_reason: string | null;
    ended_error: string | null;
};

export type FaceTimeSessionInit = {
    callUuid?: string | null;
    conversationUuid?: string | null;
    addToManager?: boolean;
    status?: FaceTimeSessionStatus;
    url?: string | null;
    address?: string | null;
    addresses?: string[];
    displayName?: string | null;
    chatGuid?: string | null;
    handle?: HandleResponse | null;
    imageUrl?: string | null;
    isOutgoing?: boolean;
    isAudio?: boolean;
    isVideo?: boolean;
    isTelephony?: boolean;
    isLinkOnly?: boolean;
    isMuted?: boolean;
    providerIdentifier?: string | null;
    initiatorDeviceId?: string | null;
    initiatorDeviceName?: string | null;
    activeDeviceId?: string | null;
    activeDeviceName?: string | null;
    endedReason?: string | null;
    endedError?: string | null;
};

export class FaceTimeSession extends Loggable {
    tag = "FaceTimeSession";

    uuid: string;

    conversationUuid: string;

    callUuid: string;

    url: string;

    admittedParticipants: string[] = [];

    selfAdmissionService: ScheduledService = null;

    createdAt: Date;

    status: FaceTimeSessionStatus = FaceTimeSessionStatus.UNKNOWN;

    address: string | null = null;

    addresses: string[] = [];

    displayName: string | null = null;

    chatGuid: string | null = null;

    handle: HandleResponse | null = null;

    imageUrl: string | null = null;

    isOutgoing = false;

    isAudio = false;

    isVideo = true;

    isTelephony = false;

    isLinkOnly = false;

    isMuted = false;

    providerIdentifier: string | null = null;

    initiatorDeviceId: string | null = null;

    initiatorDeviceName: string | null = null;

    activeDeviceId: string | null = null;

    activeDeviceName: string | null = null;

    startedAt: Date;

    answeredAt: Date | null = null;

    updatedAt: Date;

    endedReason: string | null = null;

    endedError: string | null = null;

    conversationGroupUuid: string | null = null;

    activeRemoteParticipantsCount = 0;

    activeNonLightweightParticipantsCount: number | null = null;

    remoteMembersCount = 0;

    pendingMembersCount = 0;

    hasParticipantCounts = false;

    hadNonLightweightParticipant = false;

    conversationHasJoined = false;

    leftForHandoff = false;

    handoffLeaveObserved = false;

    endedByUser = false;

    endAndInvalidateTriggered = false;

    private expiryTimer: NodeJS.Timeout = null;

    constructor({
        callUuid = null,
        conversationUuid = null,
        addToManager = true,
        status = FaceTimeSessionStatus.UNKNOWN,
        url = null,
        address = null,
        addresses = [],
        displayName = null,
        chatGuid = null,
        handle = null,
        imageUrl = null,
        isOutgoing = false,
        isAudio = false,
        isVideo = true,
        isTelephony = false,
        isLinkOnly = false,
        isMuted = false,
        providerIdentifier = null,
        initiatorDeviceId = null,
        initiatorDeviceName = null,
        activeDeviceId = null,
        activeDeviceName = null,
        endedReason = null,
        endedError = null
    }: FaceTimeSessionInit = {}) {
        super();

        this.uuid = v4();

        this.createdAt = new Date();
        this.startedAt = this.createdAt;
        this.updatedAt = this.createdAt;
        this.callUuid = callUuid;
        this.conversationUuid = conversationUuid;
        this.status = status;
        this.url = url;
        this.addresses = Array.isArray(addresses) ? [...addresses] : [];
        this.address = address ?? this.addresses[0] ?? null;
        if (this.address && this.addresses.length === 0) {
            this.addresses = [this.address];
        }
        this.displayName = displayName;
        this.chatGuid = chatGuid;
        this.handle = handle;
        this.imageUrl = imageUrl;
        this.isOutgoing = isOutgoing;
        this.isAudio = isAudio;
        this.isVideo = isVideo;
        this.isTelephony = isTelephony;
        this.isLinkOnly = isLinkOnly;
        this.isMuted = isMuted;
        this.providerIdentifier = providerIdentifier;
        this.initiatorDeviceId = initiatorDeviceId;
        this.initiatorDeviceName = initiatorDeviceName;
        this.activeDeviceId = activeDeviceId ?? initiatorDeviceId;
        this.activeDeviceName = activeDeviceName ?? initiatorDeviceName;
        this.endedReason = endedReason;
        this.endedError = endedError;
        if (this.status === FaceTimeSessionStatus.ANSWERED) {
            this.answeredAt = this.createdAt;
        }

        if (addToManager) {
            FaceTimeSessionManager().addSession(this);

            // After 3 hours, invalidate the FaceTime session and broadcast disconnected
            this.expiryTimer = setTimeout(() => {
                this.invalidate("expired");
                FaceTimeSessionManager().broadcastUpdate(this, true);
            }, 1000 * 60 * 60 * 3);
            this.expiryTimer.unref?.();
        }
    }

    touch() {
        this.updatedAt = new Date();
    }

    serialize(): SerializedFaceTimeSession {
        return {
            uuid: this.callUuid || this.uuid,
            session_uuid: this.uuid,
            status: callStatusMap[this.status] ?? "unknown",
            status_id: this.status,
            address: this.address ?? this.addresses[0] ?? null,
            addresses: this.addresses,
            display_name: this.displayName ?? null,
            chat_guid: this.chatGuid ?? null,
            handle: this.handle ?? null,
            image_url: this.imageUrl ?? null,
            link: this.url ?? null,
            is_outgoing: Boolean(this.isOutgoing),
            is_audio: Boolean(this.isAudio),
            is_video: Boolean(this.isVideo),
            is_telephony: Boolean(this.isTelephony),
            is_link_only: Boolean(this.isLinkOnly),
            is_muted: Boolean(this.isMuted),
            initiator_device_id: this.initiatorDeviceId ?? null,
            initiator_device_name: this.initiatorDeviceName ?? null,
            active_device_id: this.activeDeviceId ?? null,
            active_device_name: this.activeDeviceName ?? null,
            started_at: this.startedAt ? this.startedAt.getTime() : null,
            answered_at: this.answeredAt ? this.answeredAt.getTime() : null,
            updated_at: this.updatedAt ? this.updatedAt.getTime() : null,
            ended_reason: this.endedReason ?? null,
            ended_error: this.endedError ?? null
        };
    }

    invalidate(endedReason: string | null = null, endedError: string | null = null) {
        const prevUrl = this.url;
        const prevGroupUuid = this.conversationGroupUuid;
        this.status = FaceTimeSessionStatus.DISCONNECTED;
        if (endedReason !== null && endedReason !== undefined) {
            this.endedReason = endedReason;
        }
        if (endedError !== null && endedError !== undefined) {
            this.endedError = endedError;
        }
        this.touch();
        this.conversationUuid = null;
        this.url = null;
        this.admittedParticipants = [];

        if (this.expiryTimer) {
            clearTimeout(this.expiryTimer);
            this.expiryTimer = null;
        }

        if (this.selfAdmissionService) {
            this.selfAdmissionService.stop();
            this.selfAdmissionService = null;
        }

        if (
            !this.endAndInvalidateTriggered &&
            this.callUuid &&
            (FaceTimeSession.isFailureEndedReason(this.endedReason) ||
                (this.endedReason === "remote_ended" && this.activeRemoteParticipantsCount > 0))
        ) {
            this.endAndInvalidateTriggered = true;
            try {
                Server()
                    ?.privateApi?.facetime?.endAndInvalidateCall?.(this.callUuid, prevUrl, prevGroupUuid)
                    ?.catch?.(() => {});
            } catch {
                // Ignore when Server singleton is not initialized
            }
        }

        // Preserve callUuid and uuid until after disconnected listeners/serializers match it.
        this.emit("disconnected");
    }

    static isFailureEndedReason(reason: string | null | undefined): boolean {
        return Boolean(
            reason &&
                ["call_failed", "declined", "no_answer", "busy", "unreachable", "link_failed", "admit_failed"].includes(
                    reason
                )
        );
    }

    static mapEndedReason(
        disconnectedReason: number | null | undefined,
        rawEndedReason: string | null | undefined,
        endedError: string | null | undefined
    ): string | null {
        if (rawEndedReason && rawEndedReason !== "unknown") {
            if (rawEndedReason === "link_generation_failed") return "link_failed";
            if (rawEndedReason === "left") return "user_ended";
            return rawEndedReason;
        }
        const hasErr = Boolean(endedError && String(endedError).trim().length > 0);
        if (disconnectedReason === 2) return "declined";
        if (disconnectedReason === 3) return "busy";
        if (disconnectedReason === 4) return "no_answer";
        if (disconnectedReason === 6) return "unreachable";
        if (disconnectedReason === 11 || disconnectedReason === 14 || disconnectedReason === 15) return "call_failed";
        if (hasErr) return "call_failed";
        if (disconnectedReason === 1 || disconnectedReason === 0) return "remote_ended";
        return null;
    }

    update(session: FaceTimeSession) {
        let changed = false;

        if (session.address && !this.address) {
            this.address = session.address;
            changed = true;
        }
        if (session.addresses?.length && this.addresses.length === 0) {
            this.addresses = [...session.addresses];
            changed = true;
        }
        if (session.displayName && !this.displayName) {
            this.displayName = session.displayName;
            changed = true;
        }
        if (session.chatGuid && !this.chatGuid) {
            this.chatGuid = session.chatGuid;
            changed = true;
        }
        if (session.handle && !this.handle) {
            this.handle = session.handle;
            changed = true;
        }
        if (session.imageUrl && !this.imageUrl) {
            this.imageUrl = session.imageUrl;
            changed = true;
        }
        if (session.url && !this.url) {
            this.url = session.url;
            changed = true;
        }
        if (session.providerIdentifier && !this.providerIdentifier) {
            this.providerIdentifier = session.providerIdentifier;
            changed = true;
        }
        if (session.isOutgoing && !this.isOutgoing) {
            this.isOutgoing = true;
            changed = true;
        }
        if (session.isTelephony && !this.isTelephony) {
            this.isTelephony = true;
            changed = true;
        }
        if (session.isAudio && !this.isAudio) {
            this.isAudio = true;
            changed = true;
        }
        if (session.conversationGroupUuid && !this.conversationGroupUuid) {
            this.conversationGroupUuid = session.conversationGroupUuid;
            changed = true;
        }
        if (session.conversationUuid && !this.conversationUuid) {
            this.conversationUuid = session.conversationUuid;
            changed = true;
        }
        if (session.hasParticipantCounts) {
            this.hasParticipantCounts = true;
            this.activeRemoteParticipantsCount = session.activeRemoteParticipantsCount;
            this.remoteMembersCount = session.remoteMembersCount;
            this.pendingMembersCount = session.pendingMembersCount;
            if (session.activeNonLightweightParticipantsCount !== null) {
                this.activeNonLightweightParticipantsCount = session.activeNonLightweightParticipantsCount;
                if (session.activeNonLightweightParticipantsCount > 0) {
                    this.hadNonLightweightParticipant = true;
                }
            }
            changed = true;
        }
        if (session.conversationHasJoined && !this.conversationHasJoined) {
            this.conversationHasJoined = true;
            changed = true;
        }
        if (session.initiatorDeviceId && !this.initiatorDeviceId) {
            this.initiatorDeviceId = session.initiatorDeviceId;
            changed = true;
        }
        if (session.initiatorDeviceName && !this.initiatorDeviceName) {
            this.initiatorDeviceName = session.initiatorDeviceName;
            changed = true;
        }

        if (session.status === FaceTimeSessionStatus.DISCONNECTED) {
            const nonLightweightCount =
                session.activeNonLightweightParticipantsCount ?? this.activeNonLightweightParticipantsCount;
            const calleeStillActive =
                nonLightweightCount !== null
                    ? nonLightweightCount > 0 || (this.addresses.length === 0 && this.activeRemoteParticipantsCount > 0)
                    : this.activeRemoteParticipantsCount > 0 ||
                      this.pendingMembersCount > 0 ||
                      session.activeRemoteParticipantsCount > 0 ||
                      session.pendingMembersCount > 0;
            const initialHandoffLeave = this.leftForHandoff && !this.handoffLeaveObserved;
            if (initialHandoffLeave) {
                this.handoffLeaveObserved = true;
            }
            const isHandoffLeave =
                (initialHandoffLeave || (calleeStillActive && this.status === FaceTimeSessionStatus.ANSWERED)) &&
                !this.endedByUser &&
                !session.endedError &&
                !FaceTimeSession.isFailureEndedReason(session.endedReason);
            if (isHandoffLeave) {
                if (this.status !== FaceTimeSessionStatus.ANSWERED) {
                    this.status = FaceTimeSessionStatus.ANSWERED;
                    if (!this.answeredAt) this.answeredAt = new Date();
                    this.emit("answered", true);
                }
                this.touch();
                return;
            }
            const fallbackEndedReason =
                session.endedReason ??
                (nonLightweightCount === 0 && this.addresses.length > 0 && !this.endedByUser ? "remote_ended" : null);
            this.invalidate(fallbackEndedReason, session.endedError ?? null);
            return;
        }

        if (session.status === FaceTimeSessionStatus.ANSWERED && this.status !== FaceTimeSessionStatus.ANSWERED) {
            this.status = FaceTimeSessionStatus.ANSWERED;
            if (!this.answeredAt) {
                this.answeredAt = new Date();
            }
            this.touch();
            this.emit("answered", true);
            return;
        }

        if (
            session.status === FaceTimeSessionStatus.CONNECTING &&
            [FaceTimeSessionStatus.UNKNOWN, FaceTimeSessionStatus.INCOMING, FaceTimeSessionStatus.OUTGOING].includes(
                this.status
            )
        ) {
            this.status = FaceTimeSessionStatus.CONNECTING;
            this.touch();
            return;
        }

        if (this.status === FaceTimeSessionStatus.UNKNOWN && session.status !== FaceTimeSessionStatus.UNKNOWN) {
            this.status = session.status;
            this.touch();
            return;
        }

        if (changed) {
            this.touch();
        }
    }

    private async admitSelfHandler(since: Date): Promise<boolean> {
        if (this.status === FaceTimeSessionStatus.DISCONNECTED) {
            this.selfAdmissionService?.stop();
            return false;
        }

        // Prefer helper's direct pending-member admission when available; fall back to NotificationCenterDB.
        try {
            const result = await Server().privateApi.facetime.admitAnyPendingMember();
            const admittedCount = Number(result?.data?.admittedCount ?? 0);
            if (admittedCount > 0) {
                const admitted = Array.isArray(result?.data?.admittedParticipants)
                    ? result.data.admittedParticipants
                    : [];
                for (const participant of admitted) {
                    if (participant && !this.admittedParticipants.includes(participant)) {
                        this.admittedParticipants.push(participant);
                    }
                }
                this.selfAdmissionService?.stop();
                return true;
            }
        } catch (err: any) {
            this.log.debug(`admitAnyPendingMember failed, falling back to NotificationCenterDB: ${err?.message ?? err}`);
        }

        if ((this.status as FaceTimeSessionStatus) === FaceTimeSessionStatus.DISCONNECTED) {
            this.selfAdmissionService?.stop();
            return false;
        }

        // Check the notification center database for a waiting room notification
        this.log.debug(`Checking for FaceTime admission notifications since: ${since}`);
        const [notifications, _] = await NotificationCenterDB().getRecords({
            sort: "ASC", // ascending so we can process the oldest first
            where: [
                {
                    statement: `app.identifier = :identifier`,
                    args: {
                        identifier: "com.apple.facetime"
                    }
                },
                {
                    statement: `record.delivered_date >= :deliveredDate`,
                    args: {
                        deliveredDate: convertDateToCocoaTime(since)
                    }
                }
            ]
        });

        this.log.debug(`Found ${notifications.length} notification(s)...`);
        for (const notification of notifications) {
            // If the notification is for this conversation, admit the participant
            for (const d of notification.data) {
                if ((this.status as FaceTimeSessionStatus) === FaceTimeSessionStatus.DISCONNECTED) {
                    this.selfAdmissionService?.stop();
                    return false;
                }

                if (!d.req?.body.includes("join")) {
                    this.log.debug(`Notification body does not contain a join request: ${String(d.req?.body)}`);
                    continue;
                }

                // Extract the user data
                const userData = d.req?.usda["$objects"] ?? [];

                // If our data is incomplete, skip
                if (userData.length < 10) {
                    this.log.debug("User data did not contain enough parts!");
                    continue;
                }

                const userId = userData[6];
                const conversationId = userData[9];

                // If we'ave already admitted the user, skip
                if (this.admittedParticipants.includes(userId)) {
                    this.log.debug(`User already admitted! (ID: ${userId})`);
                    continue;
                }

                this.log.debug(`Admitting ${userId}, into Call: ${conversationId}`);
                await Server().privateApi.facetime.admitParticipant(conversationId, userId);
                this.admittedParticipants.push(userId);
                this.log.debug(`Admitted ${userId}!`);

                // Exit if we have admitted a user
                this.selfAdmissionService?.stop();
                return true;
            }
        }

        return false;
    }

    async admitSelf(leaveOnTimeout = false): Promise<void> {
        if (this.status === FaceTimeSessionStatus.DISCONNECTED) {
            return;
        }

        if (this.selfAdmissionService) {
            this.selfAdmissionService.stop();
            this.selfAdmissionService = null;
        }

        return await new Promise<void>((resolve, reject) => {
            let settled = false;
            const startDate = new Date(new Date().getTime() - 5000);

            const cleanup = () => {
                this.removeListener("disconnected", onDisconnected);
                this.selfAdmissionService?.stop();
            };

            const onDisconnected = () => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve();
            };

            this.once("disconnected", onDisconnected);

            this.selfAdmissionService = new ScheduledService(async () => {
                if (settled) return;
                if (this.status === FaceTimeSessionStatus.DISCONNECTED) {
                    onDisconnected();
                    return;
                }

                try {
                    const admitted = await this.admitSelfHandler(startDate);
                    if (admitted) {
                        if (!settled) {
                            settled = true;
                            cleanup();
                            resolve();
                        }
                        return;
                    }
                } catch (err) {
                    this.log.debug(`admitSelfHandler error: ${err}`);
                }

                if (settled || (this.status as FaceTimeSessionStatus) === FaceTimeSessionStatus.DISCONNECTED) {
                    onDisconnected();
                    return;
                }

                // If the current time is more than 2 minutes, stop admission; only leave if not answered and leaveOnTimeout is true.
                const now = new Date().getTime();
                if (now - startDate.getTime() > 1000 * 60 * 2) {
                    settled = true;
                    cleanup();
                    if (
                        leaveOnTimeout &&
                        this.status !== FaceTimeSessionStatus.ANSWERED &&
                        (this.status as FaceTimeSessionStatus) !== FaceTimeSessionStatus.DISCONNECTED
                    ) {
                        try {
                            await this.leaveCall();
                        } catch (err) {
                            this.log.debug(`admitSelf timeout leaveCall error: ${err}`);
                        }
                        this.invalidate("admission_timeout");
                        FaceTimeSessionManager().broadcastUpdate(this, true);
                        reject("Failed to admit self into FaceTime call!. No join requests detected in 2 minutes.");
                    } else {
                        resolve();
                    }
                }
            }, 1000);
        });
    }

    async generateLink(): Promise<string> {
        if (this.callUuid) {
            this.log.info(`Generating FaceTime Link for Call: ${this.callUuid}`);
        } else {
            this.log.info(`Generating FaceTime Link For New Call`);
        }

        // Invoke the private API
        const result = await Server().privateApi.facetime.generateLink(this.callUuid);
        if (!result?.data?.url) {
            throw new Error("Failed to generate FaceTime link!");
        }

        // Set the url
        this.url = result.data.url;

        // Emit URL to listeners
        this.emit("link", this.url);
        this.log.info(`New FaceTime Link Generated: ${this.url}`);
        return this.url;
    }

    async admitParticipant(handleUuid: string): Promise<string[]> {
        // Invoke the private API
        const result = await Server().privateApi.facetime.admitParticipant(this.conversationUuid, handleUuid);
        if (!result?.data?.admittedParticipants) {
            throw new Error("Failed to admit participant!");
        }

        // Set the admitted participants
        this.admittedParticipants = result.data.admittedParticipants;
        return this.admittedParticipants;
    }

    async answerWithServer(): Promise<void> {
        this.log.info(`Answering Call: ${this.callUuid}`);

        // Initialize the listener before answering so fast events aren't missed
        const abortController = new AbortController();
        const waiter = this.waitForAnswer(abortController.signal);
        // Prevent an unobserved rejection if answerCall() throws before waiter is awaited
        waiter.catch(() => {});

        // Answer the call
        try {
            await Server().privateApi.facetime.answerCall(this.callUuid);
        } catch (err) {
            abortController.abort(err);
            throw err;
        }

        // Wait for the listener to receive the answered event
        await waiter;
    }

    private async waitForAnswer(signal?: AbortSignal): Promise<void> {
        if (this.status === FaceTimeSessionStatus.DISCONNECTED) {
            throw new Error("FaceTime call disconnected before answering!");
        }

        if (this.status !== FaceTimeSessionStatus.ANSWERED) {
            await new Promise<void>((resolve, reject) => {
                let settled = false;
                const cleanup = () => {
                    clearTimeout(timer);
                    this.removeListener("answered", onAnswered);
                    this.removeListener("disconnected", onDisconnected);
                    signal?.removeEventListener("abort", onAbort);
                };
                const onAnswered = () => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    resolve();
                };
                const onDisconnected = () => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    reject(new Error("FaceTime call disconnected while waiting for answer!"));
                };
                const onAbort = () => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    reject(signal?.reason instanceof Error ? signal.reason : new Error("FaceTime answer cancelled!"));
                };
                const timer = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    reject(new Error("Timed out waiting for FaceTime call to connect!"));
                }, 1000 * 30);

                if (signal?.aborted) {
                    onAbort();
                    return;
                }
                signal?.addEventListener("abort", onAbort, { once: true });
                this.once("answered", onAnswered);
                this.once("disconnected", onDisconnected);
            });
        }

        // Wait 4 seconds to prevent crashing on Sonoma (and potentially other environments).
        // 1 second is too short. 3 seconds will work 75% of the time. 4 seconds for good measure.
        // Unfortunately, there isn't a good wait to detect when the call is ready to be used.
        await waitMs(4000);
    }

    async leaveCall(): Promise<void> {
        this.log.info(`Leaving Call: ${this.callUuid}`);
        this.leftForHandoff = true;
        await Server().privateApi.facetime.leaveCall(this.callUuid);
        await waitMs(2000);
    }

    private waitForOutgoingAnswer(ringTimeoutMs = 90000): Promise<boolean> {
        if (this.status === FaceTimeSessionStatus.ANSWERED) return Promise.resolve(true);
        if (this.status !== FaceTimeSessionStatus.OUTGOING) return Promise.resolve(false);

        return new Promise<boolean>(resolve => {
            let timer: NodeJS.Timeout;
            const cleanup = () => {
                clearTimeout(timer);
                this.removeListener("answered", onAnswered);
                this.removeListener("disconnected", onDisconnected);
            };
            const onAnswered = () => {
                cleanup();
                resolve(true);
            };
            const onDisconnected = () => {
                cleanup();
                resolve(false);
            };
            this.once("answered", onAnswered);
            this.once("disconnected", onDisconnected);
            timer = setTimeout(() => {
                cleanup();
                resolve(false);
            }, ringTimeoutMs);
        });
    }

    async admitAndLeave(ringTimeoutMs = 90000, handoffDelayMs = 15000, leaveAfterAdmit = false): Promise<void> {
        this.log.debug("Waiting to admit self...");

        // Wait for the user, and admit them into the call
        await this.admitSelf(leaveAfterAdmit);

        if ((this.status as FaceTimeSessionStatus) === FaceTimeSessionStatus.DISCONNECTED) {
            this.log.debug("FaceTime session disconnected before handoff; skipping leaveCall.");
            return;
        }

        // Keep the Mac in an active outbound call while ringing so leaveCall never drops an unanswered ring.
        if (this.status === FaceTimeSessionStatus.OUTGOING) {
            this.log.debug("Outbound FaceTime call still ringing; waiting for answer before handoff...");
            const answered = await this.waitForOutgoingAnswer(ringTimeoutMs);
            if (!answered || (this.status as FaceTimeSessionStatus) === FaceTimeSessionStatus.DISCONNECTED) {
                this.log.debug("Outbound FaceTime call did not reach answered state; skipping leaveCall.");
                return;
            }
        }

        if (!leaveAfterAdmit) {
            // Keep Mac in call muted so callUuid remains controllable for hangup and transfer re-admission.
            if (this.callUuid) {
                try {
                    Server()?.privateApi?.facetime?.setMuted(this.callUuid, true)?.catch?.(() => {});
                } catch {
                    // Ignore when Server singleton is not initialized
                }
            }
            return;
        }

        // Wait 15 seconds for the person to join (wake early if call disconnects)
        this.log.debug("Waiting 15 seconds for you to connect...");
        await new Promise<void>(resolve => {
            const onDisconnected = () => {
                clearTimeout(timer);
                resolve();
            };
            const timer = setTimeout(() => {
                this.removeListener("disconnected", onDisconnected);
                resolve();
            }, handoffDelayMs);
            this.once("disconnected", onDisconnected);
        });

        if ((this.status as FaceTimeSessionStatus) === FaceTimeSessionStatus.DISCONNECTED) {
            this.log.debug("FaceTime session disconnected during handoff; skipping leaveCall.");
            return;
        }

        // Once the user has been admitted, we can leave the call.
        this.log.debug("Leaving the call...");
        await this.leaveCall();
    }

    static async answerIncomingCall(
        callUuid: string,
        onLinkGenerated?: (link: string) => void
    ): Promise<FaceTimeSession> {
        let session = FaceTimeSessionManager().findSession(callUuid);
        session ??= new FaceTimeSession({ callUuid });

        if (session.status === FaceTimeSessionStatus.DISCONNECTED) {
            throw new Error("Unable to answer call! The call has already ended.");
        }

        if (session.status !== FaceTimeSessionStatus.ANSWERED) {
            session.status = FaceTimeSessionStatus.INCOMING;
        }
        session.isVideo = true;
        session.isAudio = false;
        session.touch();

        session.once("link", (link: string) => {
            if (onLinkGenerated) {
                onLinkGenerated(link);
            }
        });

        // Answer the call and generate a link for it.
        await session.answerWithServer();
        await session.generateLink();
        await session.admitAndLeave(90000, 15000, false);
        return session;
    }

    static async fromGeneratedLink(callUuid: string = null): Promise<FaceTimeSession> {
        const session = new FaceTimeSession({
            callUuid,
            isLinkOnly: !callUuid,
            isOutgoing: !callUuid,
            isVideo: true,
            isAudio: false
        });

        if (callUuid) {
            if (session.status === FaceTimeSessionStatus.DISCONNECTED) {
                throw new Error("Unable to generate link for call! The call has already ended.");
            }

            session.status = FaceTimeSessionStatus.INCOMING;
            await session.answerWithServer();
        } else {
            session.status = FaceTimeSessionStatus.OUTGOING;
        }

        await session.generateLink();
        return session;
    }

    static fromEvent(event: any, addToManager = false): FaceTimeSession {
        const status = event?.call_status ?? event?.status_id ?? FaceTimeSessionStatus.UNKNOWN;
        const rawAddress = event?.handle?.value ?? event?.address ?? null;
        const isTelephony = Boolean(event?.is_telephony ?? false);
        const isVideo = isTelephony
            ? false
            : event?.is_video !== undefined
              ? Boolean(event.is_video)
              : event?.is_sending_video !== undefined
                ? Boolean(event.is_sending_video)
                : true;
        const isAudio = Boolean(event?.is_sending_audio ?? event?.is_audio ?? !isVideo);
        const endedError = event?.ended_error ?? null;
        const disconnectedReason =
            event?.disconnected_reason !== undefined && event?.disconnected_reason !== null
                ? Number(event.disconnected_reason)
                : null;
        const endedReason = FaceTimeSession.mapEndedReason(
            disconnectedReason,
            event?.ended_reason ?? null,
            endedError
        );
        const session = new FaceTimeSession({
            callUuid: event?.call_uuid ?? null,
            conversationUuid: event?.conversation_uuid ?? null,
            url: event?.conversation_link ?? event?.url ?? null,
            addToManager,
            status,
            address: rawAddress,
            addresses: Array.isArray(event?.addresses) ? event.addresses : rawAddress ? [rawAddress] : [],
            imageUrl: event?.image_url ?? null,
            isOutgoing: Boolean(event?.is_outgoing ?? status === FaceTimeSessionStatus.OUTGOING),
            isAudio,
            isVideo,
            isTelephony,
            providerIdentifier: event?.provider_identifier ?? null,
            endedReason,
            endedError
        });
        session.conversationGroupUuid = event?.conversation_group_uuid ?? null;
        session.hasParticipantCounts =
            event?.active_remote_participants_count !== undefined ||
            event?.active_non_lightweight_participants_count !== undefined ||
            event?.remote_members_count !== undefined ||
            event?.pending_members_count !== undefined;
        session.activeRemoteParticipantsCount = Number(event?.active_remote_participants_count ?? 0);
        session.activeNonLightweightParticipantsCount =
            event?.active_non_lightweight_participants_count !== undefined &&
            event?.active_non_lightweight_participants_count !== null
                ? Number(event.active_non_lightweight_participants_count)
                : null;
        if ((session.activeNonLightweightParticipantsCount ?? 0) > 0) {
            session.hadNonLightweightParticipant = true;
        }
        session.remoteMembersCount = Number(event?.remote_members_count ?? 0);
        session.pendingMembersCount = Number(event?.pending_members_count ?? 0);
        session.conversationHasJoined = Boolean(event?.conversation_has_joined ?? false);
        return session;
    }
}
