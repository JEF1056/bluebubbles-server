import {
    TransactionPromise,
    TransactionResult,
    TransactionType
} from "@server/managers/transactionManager/transactionPromise";
import { PrivateApiAction } from ".";

export class PrivateApiFaceTime extends PrivateApiAction {
    tag = "PrivateApiFaceTime";

    async answerCall(uuid: string): Promise<TransactionResult> {
        const action = "answer-call";
        const request = new TransactionPromise(TransactionType.OTHER);
        return this.sendApiMessage(action, { callUUID: uuid }, request);
    }

    async leaveCall(uuid: string): Promise<TransactionResult> {
        const action = "leave-call";
        return this.sendApiMessage(action, { callUUID: uuid });
    }

    async endAndInvalidateCall(
        uuid: string,
        url: string | null = null,
        groupUUID: string | null = null
    ): Promise<TransactionResult> {
        const action = "end-and-invalidate-call";
        const request = new TransactionPromise(TransactionType.OTHER);
        const args: Record<string, any> = { callUUID: uuid };
        if (url) args.url = url;
        if (groupUUID) args.groupUUID = groupUUID;
        return this.sendApiMessage(action, args, request);
    }

    async declineCall(uuid: string): Promise<TransactionResult> {
        const action = "decline-call";
        const request = new TransactionPromise(TransactionType.OTHER);
        return this.sendApiMessage(action, { callUUID: uuid }, request);
    }

    async startCall(addresses: string[], video = true, isTelephony = false): Promise<TransactionResult> {
        const action = "start-call";
        const request = new TransactionPromise(TransactionType.OTHER);
        return this.sendApiMessage(action, { addresses, video, isTelephony }, request);
    }

    async setMuted(uuid: string, muted: boolean): Promise<TransactionResult> {
        const action = "set-muted";
        return this.sendApiMessage(action, { callUUID: uuid, muted });
    }

    async playDtmf(uuid: string, digit: string): Promise<TransactionResult> {
        const action = "play-dtmf";
        const request = new TransactionPromise(TransactionType.OTHER);
        return this.sendApiMessage(action, { callUUID: uuid, digit }, request);
    }

    async generateLink(uuid: string = null): Promise<TransactionResult> {
        const action = "generate-link";
        const request = new TransactionPromise(TransactionType.OTHER);

        const args: Record<string, any> = {};
        args["callUUID"] = uuid ?? null;

        return this.sendApiMessage(action, args, request);
    }

    async removeLink(url?: string): Promise<TransactionResult> {
        const normalized = typeof url === "string" ? url.trim() : "";
        if (!normalized) {
            throw new Error("url is required to remove a FaceTime link");
        }
        const action = "remove-facetime-link";
        const request = new TransactionPromise(TransactionType.OTHER);
        return this.sendApiMessage(action, { url: normalized }, request);
    }

    async admitParticipant(conversationUuid: string, handleUuid: string): Promise<TransactionResult> {
        const action = "admit-pending-member";
        const request = new TransactionPromise(TransactionType.OTHER);
        return this.sendApiMessage(
            action,
            {
                conversationUUID: conversationUuid,
                handleUUID: handleUuid
            },
            request
        );
    }

    async admitAnyPendingMember(): Promise<TransactionResult> {
        const action = "admit-any-pending-member";
        const request = new TransactionPromise(TransactionType.OTHER);
        return this.sendApiMessage(action, {}, request);
    }

    async getConversationState(): Promise<TransactionResult> {
        const action = "get-conversation-state";
        const request = new TransactionPromise(TransactionType.OTHER);
        return this.sendApiMessage(action, {}, request);
    }

    async pullCall(callUuid?: string | null, conversationGroupUuid?: string | null): Promise<TransactionResult> {
        const action = "pull-call";
        const request = new TransactionPromise(TransactionType.OTHER);
        const args: Record<string, any> = {};
        if (callUuid) {
            args.callUUID = callUuid;
            args.call_uuid = callUuid;
        }
        if (conversationGroupUuid) {
            args.groupUUID = conversationGroupUuid;
            args.conversation_group_uuid = conversationGroupUuid;
        }
        return this.sendApiMessage(action, args, request);
    }

    async pushCall(callUuid?: string | null): Promise<TransactionResult> {
        const action = "push-call";
        const request = new TransactionPromise(TransactionType.OTHER);
        const args: Record<string, any> = {};
        if (callUuid) {
            args.callUUID = callUuid;
            args.call_uuid = callUuid;
        }
        return this.sendApiMessage(action, args, request);
    }
}
