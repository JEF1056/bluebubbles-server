import { Socket } from "socket.io";
import { FaceTimeAudioBridge } from "@server/api/lib/facetime/FaceTimeAudioBridge";

type SocketLogger = {
    debug: (message: string) => void;
};

export function registerForkSocketRoutes(socket: Socket, log: SocketLogger): void {
    const withCallUuid = <T extends { callUuid?: unknown }>(
        params: T,
        rebind: boolean,
        fn: (p: T & { callUuid: string }) => void | Promise<void>
    ): void | Promise<void> => {
        if (typeof params?.callUuid !== "string" || !params.callUuid.trim()) return;
        const typed = params as T & { callUuid: string };
        if (rebind) {
            FaceTimeAudioBridge.getInstance().rebindSocket(typed.callUuid, socket);
        }
        return fn(typed);
    };

    socket.on("ft-bridge-offer", async (params): Promise<void> => {
        try {
            await withCallUuid(params, false, p => FaceTimeAudioBridge.getInstance().handleOffer(socket, p));
        } catch (ex: any) {
            log.debug(`ft-bridge-offer failed: ${ex?.message ?? ex}`);
        }
    });

    socket.on("ft-bridge-answer", async (params): Promise<void> => {
        try {
            await withCallUuid(params, true, p => FaceTimeAudioBridge.getInstance().handleAnswer(socket, p));
        } catch (ex: any) {
            log.debug(`ft-bridge-answer failed: ${ex?.message ?? ex}`);
        }
    });

    socket.on("ft-bridge-ice", async (params): Promise<void> => {
        try {
            await withCallUuid(params, true, p => FaceTimeAudioBridge.getInstance().handleIce(p));
        } catch (ex: any) {
            log.debug(`ft-bridge-ice failed: ${ex?.message ?? ex}`);
        }
    });

    socket.on("ft-bridge-mute", (params): void => {
        void withCallUuid(params, true, p => FaceTimeAudioBridge.getInstance().handleMute(p));
    });

    socket.on("ft-bridge-camera", (params): void => {
        void withCallUuid(params, true, p => FaceTimeAudioBridge.getInstance().handleCamera(p));
    });

    socket.on("ft-bridge-hangup", (params): void => {
        void withCallUuid(params, false, p => FaceTimeAudioBridge.getInstance().handleHangup(p));
    });

    socket.on("ft-bridge-keyframe", (params): void => {
        void withCallUuid(params, true, p => FaceTimeAudioBridge.getInstance().handleKeyframe(p));
    });

    socket.on("ft-bridge-config", (params, cb): void => {
        const ack = typeof params === "function" ? params : cb;
        if (typeof ack === "function") {
            ack({
                iceServers: FaceTimeAudioBridge.getIceServers(),
                videoSupported: FaceTimeAudioBridge.isVideoSupported(),
                videoUplinkSupported: FaceTimeAudioBridge.isVideoUplinkSupported()
            });
        }
    });
}
