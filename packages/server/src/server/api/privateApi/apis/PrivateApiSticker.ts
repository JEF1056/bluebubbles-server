import {
    TransactionPromise,
    TransactionResult,
    TransactionType
} from "@server/managers/transactionManager/transactionPromise";
import { PrivateApiAction } from ".";

export type SendStickerParams = {
    chatGuid: string;
    filePath: string;
    selectedMessageGuid?: string | null;
    associatedMessageGuid?: string | null;
    partIndex?: number;
    associatedMessagePart?: number;
    associatedMessageType?: number;
    stickerUserInfo?: Record<string, any> | null;
};

export type RepositionStickerParams = {
    chatGuid: string;
    messageGuid: string;
    xScalar: number;
    yScalar: number;
    scale: number;
    rotation: number;
    parentPreviewWidth: number;
    currentSpv?: number;
};

export class PrivateApiSticker extends PrivateApiAction {
    tag = "PrivateApiSticker";

    async sendSticker(params: SendStickerParams): Promise<TransactionResult> {
        const action = "send-sticker";
        this.throwForNoMissingFields(action, [params.chatGuid, params.filePath]);
        const request = new TransactionPromise(TransactionType.MESSAGE);

        return this.sendApiMessage(
            action,
            {
                chatGuid: params.chatGuid,
                filePath: params.filePath,
                selectedMessageGuid: params.selectedMessageGuid ?? null,
                associatedMessageGuid: params.associatedMessageGuid ?? params.selectedMessageGuid ?? null,
                partIndex: params.partIndex ?? params.associatedMessagePart ?? 0,
                associatedMessagePart: params.associatedMessagePart ?? params.partIndex ?? 0,
                associatedMessageType: params.associatedMessageType ?? 1000,
                stickerUserInfo: params.stickerUserInfo ?? null
            },
            request
        );
    }

    async addSticker(filePath: string, name?: string | null): Promise<TransactionResult> {
        const action = "add-sticker";
        this.throwForNoMissingFields(action, [filePath]);
        const request = new TransactionPromise(TransactionType.OTHER);
        return this.sendApiMessage(action, { filePath, name: name ?? null }, request);
    }

    async deleteSticker(identifier: string): Promise<TransactionResult> {
        const action = "delete-sticker";
        this.throwForNoMissingFields(action, [identifier]);
        const request = new TransactionPromise(TransactionType.OTHER);
        return this.sendApiMessage(action, { identifier }, request);
    }

    async repositionSticker(params: RepositionStickerParams): Promise<TransactionResult> {
        const action = "reposition-sticker";
        this.throwForNoMissingFields(action, [params.chatGuid, params.messageGuid]);
        const request = new TransactionPromise(TransactionType.OTHER);
        const payload: Record<string, any> = {
            chatGuid: params.chatGuid,
            messageGuid: params.messageGuid,
            xScalar: params.xScalar,
            yScalar: params.yScalar,
            scale: params.scale,
            rotation: params.rotation,
            parentPreviewWidth: params.parentPreviewWidth
        };
        if (typeof params.currentSpv === "number" && Number.isFinite(params.currentSpv)) {
            payload.currentSpv = params.currentSpv;
        }
        return this.sendApiMessage(action, payload, request);
    }
}
