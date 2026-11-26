import { Server } from "@server";
import { FaceTimeSessionManager } from "./FacetimeSessionManager";
import { NotificationCenterDB } from "@server/databases/notificationCenter/NotiicationCenterRepository";
import { convertDateToCocoaTime } from "@server/databases/imessage/helpers/dateUtil";
import { waitMs } from "@server/helpers/utils";
import { HandleResponse } from "@server/types";
import { v4 } from "uuid";
import { ScheduledService } from "../../../lib/ScheduledService";
import { Loggable } from "../../../lib/logging/Loggable";

function getFaceTimeAudioBridge(): typeof import("./FaceTimeAudioBridge").FaceTimeAudioBridge | null {
    try {
        return require("./FaceTimeAudioBridge").FaceTimeAudioBridge;
    } catch {
        return null;
    }
}

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
    is_group: boolean;
    initiator_device_id: string | null;
    initiator_device_name: string | null;
    active_device_id: string | null;
    active_device_name: string | null;
    started_at: number | null;
    answered_at: number | null;
    updated_at: number | null;
    ended_reason: string | null;
    ended_error: string | null;
    silenced_reason: "dnd" | null;
    endpoint_on_mac: boolean;
    from_iphone: boolean;
};

export type FaceTimeSessionInit = {
    callUuid?: string | null;
    uniqueProxyIdentifier?: string | null;
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
    isGroup?: boolean;
    providerIdentifier?: string | null;
    initiatorDeviceId?: string | null;
    initiatorDeviceName?: string | null;
    activeDeviceId?: string | null;
    activeDeviceName?: string | null;
    endedReason?: string | null;
    endedError?: string | null;
    silencedReason?: "dnd" | null;
    endpointOnMac?: boolean;
    fromIphone?: boolean;
};

export class FaceTimeSession extends Loggable {
    tag = "FaceTimeSession";

    uuid: string;

    conversationUuid: string;

    callUuid: string;

    uniqueProxyIdentifier: string | null = null;

    callUuidAliases: Set<string> = new Set();

    url: string;

    admittedParticipants: string[] = [];

    selfAdmissionService: ScheduledService = null;

    conversationMonitorService: ScheduledService = null;

    conversationMonitorIntervalMs = 3000;

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

    isGroup = false;

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

    silencedReason: "dnd" | null = null;

    disconnectedReason: number | null = null;

    rawEndedReason: string | null = null;

    isIncomingSilenced = false;

    conversationGroupUuid: string | null = null;

    activeRemoteParticipantsCount = 0;

    activeLightweightParticipantsCount: number | null = null;

    activeNonLightweightParticipantsCount: number | null = null;

    remoteMembersCount = 0;

    pendingMembersCount = 0;

    hasParticipantCounts = false;

    hadNonLightweightParticipant = false;

    conversationHasJoined = false;

    leftForHandoff = false;

    private outgoingAnswerPromise: Promise<boolean> | null = null;

    handoffLeaveObserved = false;

    endedByUser = false;

    endAndInvalidateTriggered = false;

    endpointOnMac = true;

    fromIphone = false;

    private hasEndpointOnMac = false;

    private expiryTimer: NodeJS.Timeout = null;

    constructor({
        callUuid = null,
        uniqueProxyIdentifier = null,
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
        isGroup = false,
        providerIdentifier = null,
        initiatorDeviceId = null,
        initiatorDeviceName = null,
        activeDeviceId = null,
        activeDeviceName = null,
        endedReason = null,
        endedError = null,
        silencedReason = null,
        endpointOnMac = true,
        fromIphone = false
    }: FaceTimeSessionInit = {}) {
        super();

        this.uuid = v4();

        this.createdAt = new Date();
        this.startedAt = this.createdAt;
        this.updatedAt = this.createdAt;
        this.callUuid = callUuid;
        this.uniqueProxyIdentifier = uniqueProxyIdentifier;
        this.registerIdentifier(this.callUuid);
        this.registerIdentifier(this.uniqueProxyIdentifier);
        this.registerIdentifier(this.uuid);
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
        this.isGroup = Boolean(isGroup || this.addresses.length > 1);
        this.providerIdentifier = providerIdentifier;
        this.initiatorDeviceId = initiatorDeviceId;
        this.initiatorDeviceName = initiatorDeviceName;
        this.activeDeviceId = activeDeviceId ?? initiatorDeviceId;
        this.activeDeviceName = activeDeviceName ?? initiatorDeviceName;
        this.endedReason = endedReason;
        this.endedError = endedError;
        this.silencedReason = silencedReason;
        this.endpointOnMac = endpointOnMac;
        this.fromIphone = fromIphone || !endpointOnMac;
        if (!this.endpointOnMac && !this.activeDeviceName) {
            this.activeDeviceName = "iPhone";
        }
        if (this.status === FaceTimeSessionStatus.ANSWERED) {
            this.answeredAt = this.createdAt;
        }

        if (addToManager) {
            FaceTimeSessionManager().addSession(this);
            this.armExpiryTimer();
        }
    }

    armExpiryTimer() {
        if (this.expiryTimer || this.status === FaceTimeSessionStatus.DISCONNECTED) return;
        // After 3 hours, invalidate the FaceTime session and broadcast disconnected
        this.expiryTimer = setTimeout(() => {
            this.invalidate("expired");
            FaceTimeSessionManager().broadcastUpdate(this, true);
        }, 1000 * 60 * 60 * 3);
        this.expiryTimer.unref?.();
    }

    touch() {
        this.updatedAt = new Date();
    }

    setStatus(status: FaceTimeSessionStatus): void {
        const prevStatus = this.status;
        this.status = status;
        if (status === FaceTimeSessionStatus.ANSWERED && !this.answeredAt) {
            this.answeredAt = new Date();
        }
        if (prevStatus !== FaceTimeSessionStatus.ANSWERED && status === FaceTimeSessionStatus.ANSWERED) {
            const bridge = getFaceTimeAudioBridge();
            if (bridge) {
                const ids = new Set<string>();
                if (this.callUuid) ids.add(this.callUuid);
                if (this.uniqueProxyIdentifier) ids.add(this.uniqueProxyIdentifier);
                for (const alias of this.callUuidAliases) {
                    if (alias) ids.add(alias);
                }
                for (const id of ids) {
                    bridge.getInstance()?.onCallAnswered?.(id);
                }
            }
        }
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
            is_group: Boolean(this.isGroup),
            initiator_device_id: this.initiatorDeviceId ?? null,
            initiator_device_name: this.initiatorDeviceName ?? null,
            active_device_id: this.activeDeviceId ?? null,
            active_device_name: this.activeDeviceName ?? null,
            started_at: this.startedAt ? this.startedAt.getTime() : null,
            answered_at: this.answeredAt ? this.answeredAt.getTime() : null,
            updated_at: this.updatedAt ? this.updatedAt.getTime() : null,
            ended_reason: this.endedReason ?? null,
            ended_error: this.endedError ?? null,
            silenced_reason: this.silencedReason ?? null,
            endpoint_on_mac: Boolean(this.endpointOnMac),
            from_iphone: Boolean(this.fromIphone)
        };
    }

    invalidate(endedReason: string | null = null, endedError: string | null = null) {
        const prevUrl = this.url;
        const prevGroupUuid = this.conversationGroupUuid;
        this.setStatus(FaceTimeSessionStatus.DISCONNECTED);
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

        if (this.conversationMonitorService) {
            this.conversationMonitorService.stop();
            this.conversationMonitorService = null;
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

        this.outgoingAnswerPromise = null;

        // Preserve callUuid and uuid until after disconnected listeners/serializers match it.
        this.emit("disconnected");

        if (prevUrl) {
            FaceTimeSessionManager().scheduleLinkCleanup(prevUrl);
        }
    }

    static isFailureEndedReason(reason: string | null | undefined): boolean {
        return Boolean(
            reason &&
                ["call_failed", "declined", "no_answer", "busy", "unreachable", "link_failed", "admit_failed"].includes(
                    reason
                )
        );
    }

    static resolveMediaFlags(event: any): { isTelephony: boolean; isVideo: boolean; isAudio: boolean } {
        const isTelephony = Boolean(event?.is_telephony ?? false);
        const isVideo = isTelephony
            ? false
            : event?.is_video !== undefined
              ? Boolean(event.is_video)
              : event?.is_sending_video !== undefined
                ? Boolean(event.is_sending_video)
                : true;
        const isAudio = isTelephony ? true : event?.is_audio !== undefined ? Boolean(event.is_audio) : !isVideo;
        return { isTelephony, isVideo, isAudio };
    }

    static mapEndedReason(
        disconnectedReason: number | null | undefined,
        rawEndedReason: string | null | undefined,
        endedError: string | null | undefined,
        isOutgoing = true,
        wasAnswered = true,
        isSilenced = false
    ): string | null {
        if (rawEndedReason && rawEndedReason !== "unknown") {
            if (rawEndedReason === "link_generation_failed") return "link_failed";
            if (rawEndedReason === "left") return "user_ended";
            return rawEndedReason;
        }
        const hasErr = Boolean(endedError && String(endedError).trim().length > 0);
        if (disconnectedReason === 17) return "answered_elsewhere";
        if (disconnectedReason === 18) return "declined_elsewhere";
        if (isSilenced && !hasErr) return "missed";
        if (disconnectedReason === 2) return "declined";
        if (disconnectedReason === 3) return "busy";
        if (disconnectedReason === 4) return "no_answer";
        if (disconnectedReason === 6) return "unreachable";
        if (disconnectedReason === 11 || disconnectedReason === 14 || disconnectedReason === 15) return "call_failed";
        if (hasErr) return "call_failed";
        if (disconnectedReason === 21) return !isOutgoing && !wasAnswered ? "missed" : "remote_ended";
        if (disconnectedReason === 1 || disconnectedReason === 0) {
            return !isOutgoing && !wasAnswered ? "missed" : "remote_ended";
        }
        return !isOutgoing && !wasAnswered && disconnectedReason !== null && disconnectedReason !== undefined
            ? "missed"
            : null;
    }

    registerIdentifier(identifier: string | null | undefined) {
        const normalized = typeof identifier === "string" ? identifier.trim().toLowerCase() : "";
        if (normalized) {
            this.callUuidAliases.add(normalized);
        }
    }

    matchesIdentifier(identifier: string | null | undefined): boolean {
        const normalized = typeof identifier === "string" ? identifier.trim().toLowerCase() : "";
        if (!normalized) return false;
        return (
            (this.callUuid ?? "").toLowerCase() === normalized ||
            (this.uuid ?? "").toLowerCase() === normalized ||
            (this.uniqueProxyIdentifier ?? "").toLowerCase() === normalized ||
            (this.conversationGroupUuid ?? "").toLowerCase() === normalized ||
            this.callUuidAliases.has(normalized)
        );
    }

    update(session: FaceTimeSession) {
        let changed = false;

        // macOS 26.4+ TUProxyCall may emit uniqueProxyIdentifier first and populate a distinct
        // callUUID later on answer; keep this.callUuid stable for clients while aliasing both IDs.
        if (session.callUuid && !this.callUuid) {
            this.callUuid = session.callUuid;
            changed = true;
        }
        if (session.uniqueProxyIdentifier && !this.uniqueProxyIdentifier) {
            this.uniqueProxyIdentifier = session.uniqueProxyIdentifier;
            changed = true;
        }
        this.registerIdentifier(session.callUuid);
        this.registerIdentifier(session.uniqueProxyIdentifier);
        for (const alias of session.callUuidAliases ?? []) {
            this.registerIdentifier(alias);
        }

        if (session.address && !this.address) {
            this.address = session.address;
            changed = true;
        }
        if (session.addresses?.length && session.addresses.length > this.addresses.length) {
            this.addresses = [...session.addresses];
            changed = true;
        }
        if (session.isGroup && !this.isGroup) {
            this.isGroup = true;
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
            this.registerIdentifier(session.conversationGroupUuid);
            changed = true;
        }
        if (session.hasEndpointOnMac && session.endpointOnMac !== this.endpointOnMac) {
            this.endpointOnMac = session.endpointOnMac;
            if (this.endpointOnMac && this.activeDeviceName === "iPhone") {
                this.activeDeviceName = null;
            }
            changed = true;
        }
        if (session.fromIphone && !this.fromIphone) {
            this.fromIphone = true;
            changed = true;
        }
        if (!this.endpointOnMac && !this.activeDeviceName) {
            this.activeDeviceName = "iPhone";
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
            if (session.activeLightweightParticipantsCount !== null) {
                this.activeLightweightParticipantsCount = session.activeLightweightParticipantsCount;
            }
            if (session.activeNonLightweightParticipantsCount !== null) {
                this.activeNonLightweightParticipantsCount = session.activeNonLightweightParticipantsCount;
                if (session.activeNonLightweightParticipantsCount > 0) {
                    this.hadNonLightweightParticipant = true;
                }
            }
            changed = true;
        }
        if (session.silencedReason && !this.silencedReason) {
            this.silencedReason = session.silencedReason;
            changed = true;
        }
        if (session.isIncomingSilenced && !this.isIncomingSilenced) {
            this.isIncomingSilenced = true;
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
            const nonLightweightCount = session.activeNonLightweightParticipantsCount;
            const calleeStillActive =
                nonLightweightCount !== null
                    ? nonLightweightCount > 0 || (this.addresses.length === 0 && session.activeRemoteParticipantsCount > 0)
                    : session.activeRemoteParticipantsCount > 0 || session.pendingMembersCount > 0;
            const initialHandoffLeave = this.leftForHandoff && !this.handoffLeaveObserved;
            if (initialHandoffLeave) {
                this.handoffLeaveObserved = true;
            }
            // Once the Mac has left for handoff, ignore duplicate TUCall DISCONNECTED notifications
            // (both CallStatusChanged and VideoCallStatusChanged fire); the conversation monitor owns hangup.
            const isHandoffLeave =
                (this.leftForHandoff ||
                    (Boolean(this.url) &&
                        this.admittedParticipants.length > 0 &&
                        session.hasParticipantCounts &&
                        calleeStillActive)) &&
                !this.endedByUser &&
                !session.endedError &&
                !FaceTimeSession.isFailureEndedReason(session.endedReason);
            if (isHandoffLeave) {
                if (this.status !== FaceTimeSessionStatus.ANSWERED) {
                    this.setStatus(FaceTimeSessionStatus.ANSWERED);
                    this.emit("answered", true);
                }
                this.touch();
                this.emit("updated");
                return;
            }
            if (this.endedByUser && this.endedReason) {
                this.invalidate(this.endedReason, session.endedError ?? this.endedError ?? null);
                return;
            }
            const wasAnswered = Boolean(this.answeredAt || this.status === FaceTimeSessionStatus.ANSWERED);
            const effectiveIsOutgoing = this.isOutgoing || session.isOutgoing;
            const isSilenced = Boolean(this.silencedReason || session.silencedReason || session.isIncomingSilenced);
            const mappedEndedReason = FaceTimeSession.mapEndedReason(
                session.disconnectedReason,
                session.rawEndedReason,
                session.endedError,
                effectiveIsOutgoing,
                wasAnswered,
                isSilenced
            );
            const fallbackEndedReason =
                mappedEndedReason ??
                (!effectiveIsOutgoing && !wasAnswered
                    ? "missed"
                    : nonLightweightCount === 0 && this.addresses.length > 0 && !this.endedByUser
                      ? "remote_ended"
                      : session.endedReason);
            this.invalidate(fallbackEndedReason, session.endedError ?? null);
            return;
        }

        if (session.status === FaceTimeSessionStatus.ANSWERED && this.status !== FaceTimeSessionStatus.ANSWERED) {
            this.setStatus(FaceTimeSessionStatus.ANSWERED);
            this.touch();
            this.emit("answered", true);
            this.emit("updated");
            return;
        }

        if (
            session.status === FaceTimeSessionStatus.CONNECTING &&
            [FaceTimeSessionStatus.UNKNOWN, FaceTimeSessionStatus.INCOMING, FaceTimeSessionStatus.OUTGOING].includes(
                this.status
            )
        ) {
            this.setStatus(FaceTimeSessionStatus.CONNECTING);
            this.touch();
            this.emit("updated");
            return;
        }

        if (this.status === FaceTimeSessionStatus.UNKNOWN && session.status !== FaceTimeSessionStatus.UNKNOWN) {
            this.setStatus(session.status);
            this.touch();
            this.emit("updated");
            return;
        }

        if (changed) {
            this.touch();
            this.emit("updated");
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
                    : Array.isArray(result?.data?.admittedMembers)
                      ? result.data.admittedMembers
                      : [];
                for (const participant of admitted) {
                    if (participant && !this.admittedParticipants.includes(participant)) {
                        this.admittedParticipants.push(participant);
                    }
                }
                this.selfAdmissionService?.stop();
                this.selfAdmissionService = null;
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

                if (!d.req?.body?.includes("join")) {
                    this.log.debug(`Notification body does not contain a join request: ${String(d.req?.body)}`);
                    continue;
                }

                // Extract the user data
                const userData = d.req?.usda?.["$objects"] ?? [];

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
            let inFlight = false;
            const startDate = new Date(new Date().getTime() - 5000);

            const cleanup = () => {
                this.removeListener("disconnected", onDisconnected);
                this.selfAdmissionService?.stop();
                this.selfAdmissionService = null;
            };

            const onDisconnected = () => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve();
            };

            this.once("disconnected", onDisconnected);

            this.selfAdmissionService = new ScheduledService(async () => {
                if (settled || inFlight) return;
                if (this.status === FaceTimeSessionStatus.DISCONNECTED) {
                    onDisconnected();
                    return;
                }

                inFlight = true;
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
                } finally {
                    inFlight = false;
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
        FaceTimeSessionManager().recordCreatedLink(this.url);

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

        // Wait for conversation join/link readiness (Sonoma crash workaround), capped at 4s.
        await this.waitForConditionOrCap(
            () =>
                this.conversationHasJoined ||
                Boolean(this.url) ||
                this.isTelephony ||
                this.status === FaceTimeSessionStatus.DISCONNECTED,
            4000,
            signal
        );
    }

    private async waitForConditionOrCap(
        predicate: () => boolean,
        capMs: number,
        signal?: AbortSignal
    ): Promise<void> {
        if (predicate() || signal?.aborted || capMs <= 0) return;
        await new Promise<void>(resolve => {
            let settled = false;
            let timer: NodeJS.Timeout | null = null;
            const cleanup = () => {
                if (timer) clearTimeout(timer);
                this.removeListener("updated", onCheck);
                this.removeListener("disconnected", finish);
                signal?.removeEventListener("abort", finish);
            };
            const finish = () => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve();
            };
            const onCheck = () => {
                if (predicate() || signal?.aborted) {
                    finish();
                }
            };
            this.on("updated", onCheck);
            this.once("disconnected", finish);
            signal?.addEventListener("abort", finish, { once: true });
            timer = setTimeout(finish, capMs);
            timer.unref?.();
        });
    }

    async leaveCall(): Promise<void> {
        if (!this.callUuid || this.isLinkOnly) return;
        this.log.info(`Leaving Call: ${this.callUuid}`);
        this.leftForHandoff = true;
        this.handoffLeaveObserved = false;
        await Server().privateApi.facetime.leaveCall(this.callUuid);
        await this.waitForConditionOrCap(
            () => this.handoffLeaveObserved || this.status === FaceTimeSessionStatus.DISCONNECTED,
            2000
        );
    }

    private findMatchingConversation(conversations: any[]): any {
        const groupTarget = (this.conversationGroupUuid ?? "").toLowerCase();
        const convTarget = (this.conversationUuid ?? "").toLowerCase();
        const urlTarget = this.url ?? "";

        return conversations.find((c: any) => {
            if (!c || typeof c !== "object") return false;
            const cGroup = typeof c.groupUUID === "string" ? c.groupUUID.toLowerCase() : "";
            const cUuid = typeof c.uuid === "string" ? c.uuid.toLowerCase() : "";
            const cLink = typeof c.link === "string" ? c.link : "";
            return (
                (groupTarget.length > 0 && cGroup === groupTarget) ||
                (convTarget.length > 0 && cUuid === convTarget) ||
                (urlTarget.length > 0 && cLink === urlTarget)
            );
        });
    }

    private applyConversationMatch(match: any): {
        activeRemote: number;
        activeLightweight: number;
        pending: number;
    } {
        if (!this.conversationGroupUuid && typeof match.groupUUID === "string" && match.groupUUID) {
            this.conversationGroupUuid = match.groupUUID;
        }
        if (!this.conversationUuid && typeof match.uuid === "string" && match.uuid) {
            this.conversationUuid = match.uuid;
        }

        const activeRemote = Number(match.activeRemoteParticipantCount ?? 0);
        const activeLightweight = Number(match.activeLightweightParticipantCount ?? 0);
        const pending = Number(match.pendingMemberCount ?? 0);
        this.hasParticipantCounts = true;
        this.activeRemoteParticipantsCount = activeRemote;
        this.activeLightweightParticipantsCount = activeLightweight;
        this.pendingMembersCount = pending;
        if (
            match.activeNonLightweightParticipantCount !== undefined &&
            match.activeNonLightweightParticipantCount !== null
        ) {
            this.activeNonLightweightParticipantsCount = Number(match.activeNonLightweightParticipantCount);
        }
        return { activeRemote, activeLightweight, pending };
    }

    startConversationMonitor(intervalMs = this.conversationMonitorIntervalMs): void {
        if (this.status === FaceTimeSessionStatus.DISCONNECTED) return;

        if (this.conversationMonitorService) {
            this.conversationMonitorService.stop();
            this.conversationMonitorService = null;
        }

        const EMPTY_THRESHOLD = 3;
        const MISSING_BEFORE_OBSERVED_LIMIT = 5;
        let observedConversation = false;
        let observedOccupied = false;
        let emptyPolls = 0;
        let missingBeforeObservedPolls = 0;
        let pollInFlight = false;

        const finishEmptyRoom = () => {
            if (this.status === FaceTimeSessionStatus.DISCONNECTED) return;
            this.conversationMonitorService?.stop();
            this.conversationMonitorService = null;
            this.log.info(
                `All participants left FaceTime room (${this.callUuid || this.uuid}); hanging up and invalidating link.`
            );
            const prevUrl = this.url;
            const prevGroupUuid = this.conversationGroupUuid;
            if (!this.endAndInvalidateTriggered) {
                this.endAndInvalidateTriggered = true;
                try {
                    Server()
                        ?.privateApi?.facetime?.endAndInvalidateCall?.(
                            this.callUuid || this.uuid,
                            prevUrl,
                            prevGroupUuid
                        )
                        ?.catch?.(() => {});
                } catch {
                    // Ignore when Server singleton is not initialized
                }
            }
            this.invalidate("remote_ended");
            FaceTimeSessionManager().broadcastUpdate(this, true);
        };

        // shortcut: polls get-conversation-state every 3s; upgrade to TUConversationManagerDelegate push events if lower latency is needed
        this.conversationMonitorService = new ScheduledService(async () => {
            if (pollInFlight) return;
            if (this.status === FaceTimeSessionStatus.DISCONNECTED) {
                this.conversationMonitorService?.stop();
                this.conversationMonitorService = null;
                return;
            }

            pollInFlight = true;
            let res: any;
            try {
                const getter = Server()?.privateApi?.facetime?.getConversationState;
                if (typeof getter !== "function") return;
                res = await getter.call(Server().privateApi.facetime);
            } catch (err: any) {
                this.log.debug(`Conversation monitor poll failed: ${err?.message ?? err}`);
                return;
            } finally {
                pollInFlight = false;
            }

            if ((this.status as FaceTimeSessionStatus) === FaceTimeSessionStatus.DISCONNECTED) {
                this.conversationMonitorService?.stop();
                this.conversationMonitorService = null;
                return;
            }

            const conversations = res?.data?.conversations;
            if (!Array.isArray(conversations)) return;

            const match = this.findMatchingConversation(conversations);

            if (match) {
                observedConversation = true;
                missingBeforeObservedPolls = 0;
                const { activeRemote, activeLightweight, pending } = this.applyConversationMatch(match);

                if (activeRemote > 0 || activeLightweight > 0 || pending > 0) {
                    observedOccupied = true;
                    emptyPolls = 0;
                    return;
                }

                emptyPolls += 1;
            } else if (observedConversation || observedOccupied) {
                emptyPolls += 1;
            } else {
                missingBeforeObservedPolls += 1;
                if (missingBeforeObservedPolls >= MISSING_BEFORE_OBSERVED_LIMIT) {
                    if (
                        this.hasParticipantCounts &&
                        this.activeRemoteParticipantsCount === 0 &&
                        this.pendingMembersCount === 0
                    ) {
                        finishEmptyRoom();
                        return;
                    }
                    // Never blindly kick/invalidate if macOS didn't report the unjoined conversation.
                    this.log.debug(
                        `FaceTime conversation not visible in TUConversationManager after Mac left (${this.callUuid || this.uuid}); stopping monitor.`
                    );
                    this.conversationMonitorService?.stop();
                    this.conversationMonitorService = null;
                }
                return;
            }

            if (emptyPolls >= EMPTY_THRESHOLD) {
                finishEmptyRoom();
            }
        }, intervalMs);
    }

    ensureOutgoingAnswerPolling(ringTimeoutMs = 60000): Promise<boolean> {
        if (this.status === FaceTimeSessionStatus.ANSWERED) return Promise.resolve(true);
        if (this.status !== FaceTimeSessionStatus.OUTGOING) return Promise.resolve(false);
        if (this.isLinkOnly) return Promise.resolve(false);
        if (this.outgoingAnswerPromise) return this.outgoingAnswerPromise;

        this.outgoingAnswerPromise = new Promise<boolean>(resolve => {
            let settled = false;
            let timer: NodeJS.Timeout | null = null;
            let pollTimer: NodeJS.Timeout | null = null;
            let pollInFlight = false;
            const cleanup = () => {
                if (timer) clearTimeout(timer);
                if (pollTimer) clearInterval(pollTimer);
                this.removeListener("answered", onAnswered);
                this.removeListener("disconnected", onDisconnected);
            };
            const finish = (answered: boolean) => {
                if (settled) return;
                settled = true;
                this.outgoingAnswerPromise = null;
                cleanup();
                resolve(answered);
            };
            const onAnswered = () => finish(true);
            const onDisconnected = () => finish(false);
            this.once("answered", onAnswered);
            this.once("disconnected", onDisconnected);

            try {
                const getter = Server()?.privateApi?.facetime?.getConversationState;
                if (typeof getter === "function") {
                    pollTimer = setInterval(async () => {
                        if (settled || pollInFlight) return;
                        pollInFlight = true;
                        try {
                            const res = await getter.call(Server().privateApi.facetime);
                            const conversations = res?.data?.conversations;
                            if (!Array.isArray(conversations)) return;
                            const match = this.findMatchingConversation(conversations);
                            if (!match) return;
                            this.applyConversationMatch(match);
                            if (
                                (this.activeNonLightweightParticipantsCount ?? 0) > 0 &&
                                this.status === FaceTimeSessionStatus.OUTGOING
                            ) {
                                this.setStatus(FaceTimeSessionStatus.ANSWERED);
                                this.hadNonLightweightParticipant = true;
                                this.touch();
                                this.emit("answered", true);
                                this.emit("updated");
                                FaceTimeSessionManager().broadcastUpdate(this);
                            }
                        } catch {
                            // Ignore transient poll errors while waiting for outgoing answer
                        } finally {
                            pollInFlight = false;
                        }
                    }, 1000);
                    pollTimer.unref?.();
                }
            } catch {
                // Ignore when Server singleton is not initialized
            }

            const onTimeout = () => {
                if (settled) return;
                // Guard against racing with a late answer or user hangup
                const shouldAutoEndNoAnswer =
                    this.status === FaceTimeSessionStatus.OUTGOING &&
                    !this.isLinkOnly &&
                    !this.endedByUser;
                finish(false);
                if (!shouldAutoEndNoAnswer) return;

                this.log.info(
                    `Outgoing FaceTime call timed out after ${ringTimeoutMs}ms with no answer (${this.callUuid || this.uuid})`
                );
                if (this.callUuid) {
                    try {
                        Server()?.privateApi?.facetime?.leaveCall?.(this.callUuid)?.catch?.(() => {});
                    } catch {
                        // Ignore when Server singleton is not initialized
                    }
                }
                this.invalidate("no_answer");
                getFaceTimeAudioBridge()
                    ?.getInstance()
                    ?.cleanupSessions?.([
                        this.callUuid,
                        ...this.callUuidAliases,
                        this.uniqueProxyIdentifier,
                        this.conversationGroupUuid,
                        this.uuid
                    ]);
                FaceTimeSessionManager().broadcastUpdate(this, true);
            };

            timer = setTimeout(onTimeout, ringTimeoutMs);
            timer.unref?.();
        });

        return this.outgoingAnswerPromise;
    }

    private waitForOutgoingAnswer(ringTimeoutMs = 60000): Promise<boolean> {
        return this.ensureOutgoingAnswerPolling(ringTimeoutMs);
    }

    async admitAndLeave(ringTimeoutMs = 60000, handoffDelayMs = 15000, leaveAfterAdmit = true): Promise<void> {
        this.log.debug("Waiting to admit self...");

        if (this.status === FaceTimeSessionStatus.OUTGOING && !this.isLinkOnly) {
            void this.ensureOutgoingAnswerPolling(ringTimeoutMs);
        }

        // Wait for the user, and admit them into the call
        await this.admitSelf(leaveAfterAdmit);

        if ((this.status as FaceTimeSessionStatus) === FaceTimeSessionStatus.DISCONNECTED) {
            this.log.debug("FaceTime session disconnected before handoff; skipping leaveCall.");
            return;
        }

        // Keep the Mac in an active outbound call while ringing so leaveCall never drops an unanswered ring.
        if (this.status === FaceTimeSessionStatus.OUTGOING && !this.isLinkOnly) {
            this.log.debug("Outbound FaceTime call still ringing; waiting for answer before handoff...");
            const answered = await this.ensureOutgoingAnswerPolling(ringTimeoutMs);
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

        if (this.isLinkOnly || !this.callUuid) {
            this.startConversationMonitor();
            return;
        }

        // Mute the Mac immediately during the handoff window so there is no audio echo before leaving.
        try {
            Server()?.privateApi?.facetime?.setMuted(this.callUuid, true)?.catch?.(() => {});
        } catch {
            // Ignore when Server singleton is not initialized
        }

        // Wait for the admitted device to finish connecting (wake on participant state or disconnect, capped at handoffDelayMs)
        const isRemoteAdmittedConnected = () =>
            (this.status as FaceTimeSessionStatus) === FaceTimeSessionStatus.DISCONNECTED ||
            (this.hasParticipantCounts &&
                this.pendingMembersCount === 0 &&
                ((this.activeLightweightParticipantsCount ?? 0) > 0 ||
                    this.activeRemoteParticipantsCount > (this.activeNonLightweightParticipantsCount ?? 0)));

        if (!isRemoteAdmittedConnected() && handoffDelayMs > 0) {
            this.log.debug(`Waiting up to ${handoffDelayMs}ms for you to connect before Mac leaves...`);
            await new Promise<void>(resolve => {
                let settled = false;
                let timer: NodeJS.Timeout | null = null;
                let pollTimer: NodeJS.Timeout | null = null;
                let pollInFlight = false;
                const cleanup = () => {
                    if (timer) clearTimeout(timer);
                    if (pollTimer) clearInterval(pollTimer);
                    this.removeListener("updated", onUpdate);
                    this.removeListener("disconnected", finish);
                };
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    resolve();
                };
                const onUpdate = () => {
                    if (isRemoteAdmittedConnected()) {
                        finish();
                    }
                };
                this.on("updated", onUpdate);
                this.once("disconnected", finish);
                if (handoffDelayMs >= 500) {
                    try {
                        const getter = Server()?.privateApi?.facetime?.getConversationState;
                        if (typeof getter === "function") {
                            pollTimer = setInterval(async () => {
                                if (settled || pollInFlight) return;
                                pollInFlight = true;
                                try {
                                    const res = await getter.call(Server().privateApi.facetime);
                                    const conversations = res?.data?.conversations;
                                    if (!Array.isArray(conversations)) return;
                                    const match = this.findMatchingConversation(conversations);
                                    if (match) {
                                        this.applyConversationMatch(match);
                                        if (isRemoteAdmittedConnected()) {
                                            finish();
                                        }
                                    }
                                } catch {
                                    // Ignore transient poll errors during handoff settle window
                                } finally {
                                    pollInFlight = false;
                                }
                            }, 1000);
                            pollTimer.unref?.();
                        }
                    } catch {
                        // Ignore when Server singleton is not initialized
                    }
                }
                timer = setTimeout(finish, handoffDelayMs);
                timer.unref?.();
            });
        }

        if ((this.status as FaceTimeSessionStatus) === FaceTimeSessionStatus.DISCONNECTED) {
            this.log.debug("FaceTime session disconnected during handoff; skipping leaveCall.");
            return;
        }

        // Once the user has connected, leave the room on the Mac and monitor the conversation for auto-hangup.
        this.log.debug("Leaving the call on Mac and starting conversation monitor...");
        await this.leaveCall();
        if ((this.status as FaceTimeSessionStatus) !== FaceTimeSessionStatus.DISCONNECTED) {
            this.startConversationMonitor();
        }
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
        await session.admitAndLeave(60000, 15000, true);
        return session;
    }

    static async fromGeneratedLink(callUuid: string = null, isVideo = true): Promise<FaceTimeSession> {
        const session = new FaceTimeSession({
            callUuid,
            isLinkOnly: !callUuid,
            isOutgoing: !callUuid,
            isVideo,
            isAudio: !isVideo
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
        const isHandoffEligible = Boolean(event?.is_handoff_eligible);
        let status =
            event?.call_status ??
            event?.status_id ??
            (isHandoffEligible ? FaceTimeSessionStatus.ANSWERED : FaceTimeSessionStatus.UNKNOWN);
        const addresses = Array.isArray(event?.addresses)
            ? event.addresses.filter((a: any) => typeof a === "string" && a.trim().length > 0)
            : [];
        const rawAddress = event?.handle?.value ?? event?.address ?? addresses[0] ?? null;
        const isGroup = Boolean(
            event?.is_group ?? ((event?.remote_members_count ?? 0) > 1 || addresses.length > 1)
        );
        const { isTelephony, isVideo, isAudio } = FaceTimeSession.resolveMediaFlags(event);
        // Outgoing GFT calls join their own conversation (callStatus=1) before the callee answers.
        if (
            status === FaceTimeSessionStatus.ANSWERED &&
            event?.is_outgoing &&
            event?.is_conversation &&
            !isTelephony &&
            Boolean(event?.conversation_uuid || event?.conversation_group_uuid) &&
            Number(event?.active_non_lightweight_participants_count ?? 1) === 0
        ) {
            status = FaceTimeSessionStatus.OUTGOING;
        }
        const isOutgoing = Boolean(event?.is_outgoing ?? status === FaceTimeSessionStatus.OUTGOING);
        const endedError = event?.ended_error ?? null;
        const disconnectedReason =
            event?.disconnected_reason !== undefined && event?.disconnected_reason !== null
                ? Number(event.disconnected_reason)
                : null;
        const rawEndedReason = event?.ended_reason ?? null;
        const filteredOutReason = Number(event?.filtered_out_reason ?? 0);
        const silencedReason: "dnd" | null =
            Number.isFinite(filteredOutReason) && filteredOutReason !== 0 ? "dnd" : null;
        const isIncomingSilenced = Boolean(event?.is_incoming_silenced ?? false);
        const endedReason = FaceTimeSession.mapEndedReason(
            disconnectedReason,
            rawEndedReason,
            endedError,
            isOutgoing,
            false,
            Boolean(silencedReason || isIncomingSilenced)
        );
        const hasEndpointOnMac = event?.is_endpoint_on_current_device !== undefined || isHandoffEligible;
        const endpointOnMac = isHandoffEligible
            ? false
            : event?.is_endpoint_on_current_device !== undefined
              ? Boolean(event.is_endpoint_on_current_device)
              : true;
        const fromIphone = !endpointOnMac || isHandoffEligible;
        const conversationGroupUuid = event?.conversation_group_uuid ?? null;
        const uniqueProxyIdentifier = event?.unique_proxy_identifier ?? event?.uniqueProxyIdentifier ?? null;
        const resolvedCallUuid =
            event?.call_uuid ??
            event?.callUUID ??
            uniqueProxyIdentifier ??
            (isHandoffEligible ? conversationGroupUuid : null);
        const session = new FaceTimeSession({
            callUuid: resolvedCallUuid,
            uniqueProxyIdentifier,
            conversationUuid: event?.conversation_uuid ?? null,
            url: event?.conversation_link ?? event?.url ?? null,
            addToManager,
            status,
            address: rawAddress,
            addresses: addresses.length > 0 ? addresses : rawAddress ? [rawAddress] : [],
            imageUrl: event?.image_url ?? null,
            isOutgoing,
            isAudio,
            isVideo,
            isTelephony,
            isGroup,
            providerIdentifier: event?.provider_identifier ?? null,
            endedReason,
            endedError,
            silencedReason,
            endpointOnMac,
            fromIphone
        });
        session.hasEndpointOnMac = hasEndpointOnMac;
        session.disconnectedReason = disconnectedReason;
        session.rawEndedReason = rawEndedReason;
        session.isIncomingSilenced = isIncomingSilenced;
        session.conversationGroupUuid = conversationGroupUuid;
        session.registerIdentifier(conversationGroupUuid);
        session.hasParticipantCounts =
            event?.active_remote_participants_count !== undefined ||
            event?.active_lightweight_participants_count !== undefined ||
            event?.active_non_lightweight_participants_count !== undefined ||
            event?.remote_members_count !== undefined ||
            event?.pending_members_count !== undefined;
        session.activeRemoteParticipantsCount = Number(event?.active_remote_participants_count ?? 0);
        session.activeLightweightParticipantsCount =
            event?.active_lightweight_participants_count !== undefined &&
            event?.active_lightweight_participants_count !== null
                ? Number(event.active_lightweight_participants_count)
                : null;
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
