import { Server } from "@server";
import * as net from "net";
import { INCOMING_FACETIME } from "@server/events";
import { EventData, PrivateApiEventHandler } from ".";
import { slugifyAddress } from "@server/helpers/utils";
import { HandleSerializer } from "@server/api/serializers/HandleSerializer";
import { FaceTimeSessionManager } from "@server/api/lib/facetime/FacetimeSessionManager";
import { FaceTimeSession, FaceTimeSessionStatus } from "@server/api/lib/facetime/FaceTimeSession";
import { FaceTimeAudioBridge } from "@server/api/lib/facetime/FaceTimeAudioBridge";
import { Loggable } from "@server/lib/logging/Loggable";

export class PrivateApiFaceTimeStatusHandler extends Loggable implements PrivateApiEventHandler {
    tag = "PrivateApiFaceTimeStatusHandler";

    types: string[] = ["ft-call-status-changed"];

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
        const callUuid = eventData.call_uuid ?? eventData.callUUID ?? uniqueProxyIdentifier ?? null;
        const rawAddress = eventData.handle?.value ?? null;

        // Keep tracked sessions (e.g. outbound calls) synced even when facetime_calling is disabled.
        const existingSession = FaceTimeSessionManager().findSession(callUuid, uniqueProxyIdentifier);
        if (existingSession) {
            existingSession.update(FaceTimeSession.fromEvent(eventData));
            if (existingSession.status === FaceTimeSessionStatus.DISCONNECTED) {
                const bridge = FaceTimeAudioBridge.getInstance();
                if (existingSession.callUuid) bridge.cleanupSession(existingSession.callUuid);
                if (callUuid && callUuid !== existingSession.callUuid) bridge.cleanupSession(callUuid);
            }
            FaceTimeSessionManager().broadcastUpdate(existingSession);
            return;
        }

        // Ignore calls that are not incoming (or marked outgoing)
        if (statusId !== FaceTimeSessionStatus.INCOMING || eventData.is_outgoing) return;

        this.log.info(`Incoming FaceTime call from ${rawAddress ?? "unknown"}`);

        // stringify to maintain backwards compat
        const output = JSON.stringify({
            caller: rawAddress,
            timestamp: new Date().getTime()
        });

        Server().emitMessage(INCOMING_FACETIME, output, "high", true, true);
    }

    async handleCalling(data: EventData) {
        const eventData = data?.data ?? {};
        const statusId = eventData.call_status ?? eventData.status_id;
        const uniqueProxyIdentifier = eventData.unique_proxy_identifier ?? eventData.uniqueProxyIdentifier ?? null;
        const callUuid = eventData.call_uuid ?? eventData.callUUID ?? uniqueProxyIdentifier ?? null;
        const rawAddress = eventData.handle?.value ?? null;

        let serializedHandle = null;
        if (rawAddress) {
            try {
                const addr = slugifyAddress(rawAddress);
                const handleRows = addr ? (await Server().iMessageRepo.getHandles({ address: addr, limit: 1 }))[0] : [];
                serializedHandle = handleRows?.[0] ? await HandleSerializer.serialize({ handle: handleRows[0] }) : null;
            } catch {
                // Ignore handle lookup errors when repo is unavailable
            }
        }

        const incomingSession = FaceTimeSession.fromEvent(eventData, false);
        incomingSession.handle = serializedHandle;

        let session = FaceTimeSessionManager().findSession(callUuid, uniqueProxyIdentifier);
        let isNew = false;
        if (session) {
            session.update(incomingSession);
        } else {
            session = incomingSession;
            isNew = FaceTimeSessionManager().addSession(session);
        }

        if (statusId === FaceTimeSessionStatus.ANSWERED) {
            if (!session.answeredAt) {
                session.answeredAt = new Date();
                session.touch();
            }
            this.log.info(`FaceTime call answered (Call UUID: ${session.callUuid ?? callUuid})`);
        } else if (statusId === FaceTimeSessionStatus.OUTGOING) {
            this.log.info(`Outgoing FaceTime call to ${rawAddress ?? "unknown"} (Call UUID: ${session.callUuid ?? callUuid})`);
        } else if (statusId === FaceTimeSessionStatus.INCOMING) {
            if (!isNew || eventData.is_outgoing) {
                return;
            }
            this.log.info(`Incoming FaceTime call from ${rawAddress ?? "unknown"} (Call UUID: ${session.callUuid ?? callUuid})`);
        } else if (session.status === FaceTimeSessionStatus.DISCONNECTED) {
            const bridge = FaceTimeAudioBridge.getInstance();
            if (session.callUuid) bridge.cleanupSession(session.callUuid);
            if (callUuid && callUuid !== session.callUuid) bridge.cleanupSession(callUuid);
            if (rawAddress) {
                this.log.info(
                    `FaceTime call disconnected with ${rawAddress}` +
                        (session.endedReason ? ` (${session.endedReason})` : "")
                );
            }
        }

        FaceTimeSessionManager().broadcastUpdate(session);
    }
}
