import { Server } from "@server";
import { FaceTimeSession, FaceTimeSessionStatus } from "../lib/facetime/FaceTimeSession";
import { FaceTimeAudioBridge } from "../lib/facetime/FaceTimeAudioBridge";
import { isMinMonterey } from "@server/env";
import { checkPrivateApiStatus } from "@server/helpers/utils";

/**
 * An interface to interact with Facetime
 */
export class FaceTimeInterface {
    static async create(): Promise<string> {
        checkPrivateApiStatus();
        if (!isMinMonterey) throw new Error("Creating FaceTime calls is only available on macOS Big Sur and newer!");
        const session = await FaceTimeSession.fromGeneratedLink(null);
        session.admitAndLeave();
        return session.url;
    }

    static async call({
        addresses,
        video = true,
        isTelephony = false
    }: {
        addresses: string[];
        video?: boolean;
        isTelephony?: boolean;
    }): Promise<{ link?: { url: string }; call: Record<string, any> }> {
        checkPrivateApiStatus();
        if (!isMinMonterey) throw new Error("FaceTime calls are only available on macOS Monterey and newer!");
        if (!Array.isArray(addresses) || addresses.length === 0) {
            throw new Error("At least one address is required to place a FaceTime call!");
        }

        const result = await Server().privateApi.facetime.startCall(addresses, video, isTelephony);
        const callUuid = result?.data?.call_uuid ?? result?.data?.callUUID;
        if (!callUuid) {
            throw new Error("Failed to start FaceTime call: helper did not return call_uuid!");
        }

        const call = {
            call_uuid: callUuid,
            callUuid,
            status: result?.data?.status ?? "outgoing",
            is_video: video,
            is_telephony: isTelephony,
            address: addresses[0],
            group_uuid: result?.data?.group_uuid ?? null
        };

        if (!video) {
            return { call };
        }

        const session = new FaceTimeSession({ callUuid });
        session.status = FaceTimeSessionStatus.OUTGOING;
        let url: string;
        try {
            url = await session.generateLink();
        } catch (err) {
            // Only leave if the call is still outgoing/ringing; never drop an already answered call.
            if (session.status === FaceTimeSessionStatus.OUTGOING) {
                session.leaveCall().catch(() => {});
            }
            throw err;
        }
        session.admitAndLeave().catch(() => {});
        return { link: { url }, call };
    }

    static async answer(callUuid: string, audioOnly = false): Promise<string | null> {
        checkPrivateApiStatus();
        if (!isMinMonterey) throw new Error("Answering FaceTime calls is only available on macOS Big Sur and newer!");
        if (audioOnly) {
            await Server().privateApi.facetime.answerCall(callUuid);
            return null;
        }
        return await FaceTimeInterface.answerAndWaitForLink(callUuid);
    }

    static async leave(callUuid: string): Promise<void> {
        checkPrivateApiStatus();
        if (!isMinMonterey) throw new Error("Leaving FaceTime calls is only available on macOS Big Sur and newer!");
        await Server().privateApi.facetime.leaveCall(callUuid);
        FaceTimeAudioBridge.getInstance().cleanupSession(callUuid);
    }

    static async decline(callUuid: string): Promise<void> {
        checkPrivateApiStatus();
        if (!isMinMonterey) throw new Error("Declining FaceTime calls is only available on macOS Big Sur and newer!");
        await Server().privateApi.facetime.declineCall(callUuid);
        FaceTimeAudioBridge.getInstance().cleanupSession(callUuid);
    }

    static async setMuted(callUuid: string, muted: boolean): Promise<void> {
        checkPrivateApiStatus();
        if (!isMinMonterey) throw new Error("Muting FaceTime calls is only available on macOS Big Sur and newer!");
        await Server().privateApi.facetime.setMuted(callUuid, muted);
    }

    private static async answerAndWaitForLink(callUuid: string): Promise<string> {
        return await new Promise((resolve, reject) => {
            try {
                FaceTimeSession.answerIncomingCall(callUuid, (link: string) => {
                    resolve(link);
                });
            } catch (ex) {
                reject(ex);
            }
        });
    }
}
