import { Socket } from "socket.io";
import { FaceTimeAudioBridge } from "@server/api/lib/facetime/FaceTimeAudioBridge";

type SocketLogger = {
    debug: (message: string) => void;
};

export function registerForkSocketRoutes(socket: Socket, log: SocketLogger): void {
    socket.on("ft-bridge-offer", async (params): Promise<void> => {
        try {
            await FaceTimeAudioBridge.getInstance().handleOffer(socket, params);
        } catch (ex: any) {
            log.debug(`ft-bridge-offer failed: ${ex?.message ?? ex}`);
        }
    });

    socket.on("ft-bridge-answer", async (params): Promise<void> => {
        try {
            await FaceTimeAudioBridge.getInstance().handleAnswer(socket, params);
        } catch (ex: any) {
            log.debug(`ft-bridge-answer failed: ${ex?.message ?? ex}`);
        }
    });

    socket.on("ft-bridge-ice", async (params): Promise<void> => {
        try {
            await FaceTimeAudioBridge.getInstance().handleIce(params);
        } catch (ex: any) {
            log.debug(`ft-bridge-ice failed: ${ex?.message ?? ex}`);
        }
    });

    socket.on("ft-bridge-mute", (params): void => {
        FaceTimeAudioBridge.getInstance().handleMute(params);
    });

    socket.on("ft-bridge-hangup", (params): void => {
        FaceTimeAudioBridge.getInstance().handleHangup(params);
    });
}
