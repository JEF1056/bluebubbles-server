import { Server } from "@server";
import * as net from "net";
import { FT_CALL_STATUS_CHANGED, INCOMING_FACETIME } from "@server/events";
import { EventData, PrivateApiEventHandler } from ".";
import { slugifyAddress } from "@server/helpers/utils";
import { HandleSerializer } from "@server/api/serializers/HandleSerializer";
import { FaceTimeSessionManager } from "@server/api/lib/facetime/FacetimeSessionManager";
import { FaceTimeSession, FaceTimeSessionStatus } from "@server/api/lib/facetime/FaceTimeSession";
import { FaceTimeAudioBridge } from "@server/api/lib/facetime/FaceTimeAudioBridge";
import { setCameraHookActiveFlag } from "@server/api/lib/facetime/FaceTimeCameraHook";
import { Loggable } from "@server/lib/logging/Loggable";

export class PrivateApiFaceTimeStatusHandler extends Loggable implements PrivateApiEventHandler {
    private static readonly SILENCED_ALERT_COOLDOWN_MS = 60 * 60 * 1000;

    private static readonly SILENCED_ALERT_MESSAGE =
        "macOS silenced an incoming FaceTime call (Do Not Disturb / display sharing). Enable System Settings -> Notifications -> Allow notifications when mirroring or sharing the display.";

    tag = "PrivateApiFaceTimeStatusHandler";

    types: string[] = ["ft-call-status-changed"];

    private legacyIncomingCalls = new Set<string>();

    private completedLegacyIncomingCalls = new Set<string>();

    private lastSilencedAlertAt = 0;

    private maybeRaiseSilencedAlert(eventData: Record<string, any>, silencedReason: "dnd" | null): void {
        if (eventData?.is_incoming_silenced !== true && silencedReason !== "dnd") return;
        const now = Date.now();
        if (this.lastSilencedAlertAt > 0 && now - this.lastSilencedAlertAt < PrivateApiFaceTimeStatusHandler.SILENCED_ALERT_COOLDOWN_MS) {
            return;
        }
        this.lastSilencedAlertAt = now;
        try {
            const server = Server();
            if (typeof server?.log === "function") {
                server.log(PrivateApiFaceTimeStatusHandler.SILENCED_ALERT_MESSAGE, "warn");
                return;
            }
        } catch {
            // Fall back to handler logger when Server singleton is unavailable
        }
        this.log.warn(PrivateApiFaceTimeStatusHandler.SILENCED_ALERT_MESSAGE);
    }

    private async enrichSessionHandle(session: FaceTimeSession, rawAddress: string | null): Promise<void> {
        const targetAddress = rawAddress ?? session.addresses?.[0] ?? null;
        if (session.handle || !targetAddress) return;
        try {
            const addr = slugifyAddress(targetAddress);
            const handleRows = addr ? (await Server().iMessageRepo.getHandles({ address: addr, limit: 1 }))[0] : [];
            const serializedHandle = handleRows?.[0]
                ? await HandleSerializer.serialize({ handle: handleRows[0] })
                : null;
            if (serializedHandle && !session.handle) {
                session.handle = serializedHandle;
                session.touch();
            }
        } catch {
            // Ignore handle lookup errors when repo is unavailable
        }
    }

    async handle(data: EventData, _: net.Socket) {
        const ft_calling = Server().repo.getConfig("facetime_calling") as boolean;
        if (ft_calling) {
            await this.handleCalling(data);
        } else {
            await this.handleStandard(data);
        }
    }

    async handleStandard(data: EventData) {
        const eventData = data?.data ?? {};
        const statusId = eventData.call_status ?? eventData.status_id;
        const uniqueProxyIdentifier = eventData.unique_proxy_identifier ?? eventData.uniqueProxyIdentifier ?? null;
        const conversationGroupUuid = eventData.conversation_group_uuid ?? null;
        const callUuid = eventData.call_uuid ?? eventData.callUUID ?? uniqueProxyIdentifier ?? conversationGroupUuid ?? null;
        const rawAddress = eventData.handle?.value ?? eventData.address ?? null;

        // Keep tracked sessions (e.g. outbound calls) synced even when facetime_calling is disabled.
        const existingSession = FaceTimeSessionManager().findSession(
            callUuid,
            uniqueProxyIdentifier,
            conversationGroupUuid
        );
        if (existingSession) {
            existingSession.update(FaceTimeSession.fromEvent(eventData));
            if (existingSession.status === FaceTimeSessionStatus.DISCONNECTED) {
                FaceTimeAudioBridge.getInstance().cleanupSessions([
                    existingSession.callUuid,
                    ...existingSession.callUuidAliases,
                    existingSession.uniqueProxyIdentifier,
                    existingSession.conversationGroupUuid,
                    callUuid
                ]);
                if (!FaceTimeSessionManager().listActiveSessions().some(s => s.isVideo)) {
                    setCameraHookActiveFlag(false);
                }
            }
            FaceTimeSessionManager().broadcastUpdate(existingSession);
            return;
        }

        if (
            callUuid &&
            this.legacyIncomingCalls.has(callUuid) &&
            (statusId === FaceTimeSessionStatus.ANSWERED || statusId === FaceTimeSessionStatus.DISCONNECTED)
        ) {
            if (statusId === FaceTimeSessionStatus.DISCONNECTED) {
                this.legacyIncomingCalls.delete(callUuid);
                if (this.completedLegacyIncomingCalls.size >= 512) {
                    this.completedLegacyIncomingCalls.clear();
                }
                this.completedLegacyIncomingCalls.add(callUuid);
            }
            Server().emitMessage(FT_CALL_STATUS_CHANGED, { uuid: callUuid, status_id: statusId }, "high", true, true);
            return;
        }

        if (callUuid && this.completedLegacyIncomingCalls.has(callUuid) && statusId === FaceTimeSessionStatus.DISCONNECTED) {
            return;
        }

        // First-seen non-outgoing status 6 (e.g. silenced by macOS DND/display-sharing):
        // surface missed session + alert unless it was answered/declined on another device.
        if (
            statusId === FaceTimeSessionStatus.DISCONNECTED &&
            !eventData.is_outgoing &&
            (eventData.is_incoming_silenced === true || Number(eventData.filtered_out_reason ?? 0) !== 0)
        ) {
            const endedReason = FaceTimeSession.mapEndedReason(
                eventData.disconnected_reason ?? null,
                eventData.ended_reason ?? null,
                eventData.ended_error ?? null,
                false,
                false,
                true
            );
            if (endedReason === "answered_elsewhere" || endedReason === "declined_elsewhere") {
                return;
            }
            const session = FaceTimeSession.fromEvent(eventData, false);
            if (!session.endedReason) {
                session.endedReason = "missed";
            }
            FaceTimeSessionManager().addSession(session);
            FaceTimeSessionManager().broadcastUpdate(session);
            this.maybeRaiseSilencedAlert(eventData, session.silencedReason);
            await this.enrichSessionHandle(session, rawAddress);
            return;
        }

        // Adopt active iPhone-hosted or handoff-eligible calls so the transfer pill shows even when facetime_calling is off.
        const isIphoneHosted =
            eventData.is_endpoint_on_current_device === false || eventData.is_handoff_eligible === true;
        if (
            isIphoneHosted &&
            (statusId === FaceTimeSessionStatus.ANSWERED || eventData.is_handoff_eligible === true)
        ) {
            const session = FaceTimeSession.fromEvent(eventData, false);
            if (!session.answeredAt && session.status === FaceTimeSessionStatus.ANSWERED) {
                session.answeredAt = new Date();
            }
            FaceTimeSessionManager().addSession(session);
            FaceTimeSessionManager().broadcastUpdate(session);
            await this.enrichSessionHandle(session, rawAddress);
            return;
        }

        // Ignore calls that are not incoming (or marked outgoing)
        if (statusId !== FaceTimeSessionStatus.INCOMING || eventData.is_outgoing) return;

        if (callUuid) {
            if (this.legacyIncomingCalls.size >= 512) {
                const oldest = this.legacyIncomingCalls.values().next().value;
                if (oldest !== undefined) this.legacyIncomingCalls.delete(oldest);
            }
            this.legacyIncomingCalls.add(callUuid);
        }

        const { isVideo, isAudio, isTelephony } = FaceTimeSession.resolveMediaFlags(eventData);

        this.log.info(`Incoming FaceTime call from ${rawAddress ?? "unknown"}`);

        // stringify to maintain backwards compat
        const output = JSON.stringify({
            caller: rawAddress,
            address: rawAddress,
            timestamp: new Date().getTime(),
            uuid: callUuid,
            is_video: isVideo,
            is_audio: isAudio,
            is_telephony: isTelephony
        });

        Server().emitMessage(INCOMING_FACETIME, output, "high", true, true);
    }

    async handleCalling(data: EventData) {
        const eventData = data?.data ?? {};
        const statusId = eventData.call_status ?? eventData.status_id;
        const uniqueProxyIdentifier = eventData.unique_proxy_identifier ?? eventData.uniqueProxyIdentifier ?? null;
        const conversationGroupUuid = eventData.conversation_group_uuid ?? null;
        const callUuid = eventData.call_uuid ?? eventData.callUUID ?? uniqueProxyIdentifier ?? conversationGroupUuid ?? null;
        const rawAddress = eventData.handle?.value ?? eventData.address ?? null;

        const incomingSession = FaceTimeSession.fromEvent(eventData, false);

        let session = FaceTimeSessionManager().findSession(callUuid, uniqueProxyIdentifier, conversationGroupUuid);
        let isNew = false;
        if (session) {
            session.update(incomingSession);
        } else {
            session = incomingSession;
            isNew = FaceTimeSessionManager().addSession(session);
        }

        if (incomingSession.status === FaceTimeSessionStatus.ANSWERED) {
            if (!session.answeredAt) {
                session.answeredAt = new Date();
                session.touch();
            }
            this.log.info(`FaceTime call answered (Call UUID: ${session.callUuid ?? callUuid})`);
        } else if (incomingSession.status === FaceTimeSessionStatus.OUTGOING) {
            if (
                session.status === FaceTimeSessionStatus.OUTGOING &&
                session.isOutgoing &&
                !session.isTelephony &&
                !session.isLinkOnly &&
                session.activeNonLightweightParticipantsCount === 0
            ) {
                void session.ensureOutgoingAnswerPolling();
            }
            this.log.info(`Outgoing FaceTime call to ${rawAddress ?? "unknown"} (Call UUID: ${session.callUuid ?? callUuid})`);
        } else if (incomingSession.status === FaceTimeSessionStatus.INCOMING) {
            if (!isNew || eventData.is_outgoing) {
                return;
            }
            this.log.info(`Incoming FaceTime call from ${rawAddress ?? "unknown"} (Call UUID: ${session.callUuid ?? callUuid})`);
        } else if (session.status === FaceTimeSessionStatus.DISCONNECTED) {
            FaceTimeAudioBridge.getInstance().cleanupSessions([
                session.callUuid,
                ...session.callUuidAliases,
                session.uniqueProxyIdentifier,
                session.conversationGroupUuid,
                callUuid
            ]);
            if (!FaceTimeSessionManager().listActiveSessions().some(s => s.isVideo)) {
                setCameraHookActiveFlag(false);
            }

            if (!session.isOutgoing && session.endedReason === "missed") {
                const normalizeAddr = (raw: string | null | undefined) => {
                    const slug = slugifyAddress(raw ?? "");
                    if (!slug) return "";
                    if (slug.includes("@")) return slug;
                    const digits = slug.replace(/\D/g, "");
                    return digits.length > 10 ? digits.slice(-10) : digits;
                };
                const callerNorm = normalizeAddr(rawAddress ?? session.address);
                if (callerNorm) {
                    const answeredElsewhere = FaceTimeSessionManager()
                        .listActiveSessions()
                        .some(
                            s =>
                                s !== session &&
                                s.status === FaceTimeSessionStatus.ANSWERED &&
                                normalizeAddr(s.address) === callerNorm
                        );
                    if (answeredElsewhere) {
                        session.endedReason = "answered_elsewhere";
                    }
                }
            }

            if (isNew && !session.isOutgoing) {
                if (!session.endedReason) {
                    session.endedReason = "missed";
                }
                if (session.endedReason !== "answered_elsewhere" && session.endedReason !== "declined_elsewhere") {
                    this.maybeRaiseSilencedAlert(eventData, session.silencedReason);
                }
            }

            if (rawAddress) {
                this.log.info(
                    `FaceTime call disconnected with ${rawAddress}` +
                        (session.endedReason ? ` (${session.endedReason})` : "") +
                        (session.silencedReason ? ` [${session.silencedReason}]` : "")
                );
            }
        }

        FaceTimeSessionManager().broadcastUpdate(session);
        await this.enrichSessionHandle(session, rawAddress);
    }
}
