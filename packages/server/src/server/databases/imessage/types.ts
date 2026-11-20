export type DBMessageParams = {
    chatGuid?: string;
    offset?: number;
    limit?: number | null;
    after?: Date | number;
    before?: Date | number;
    withChats?: boolean;
    withChatParticipants?: boolean;
    withAttachments?: boolean;
    withCount?: boolean;
    includeCreated?: boolean;
    sort?: "ASC" | "DESC";
    orderBy?: string;
    where?: DBWhereItem[];
};

export type DBWhereItem = {
    statement: string;
    args: { [key: string]: string | number | string[] | number[] };
};

export type ChatParams = {
    chatGuid?: string;
    globGuid?: boolean;
    withParticipants?: boolean;
    withLastMessage?: boolean;
    withArchived?: boolean;
    offset?: number;
    limit?: number;
    where?: DBWhereItem[];
    orderBy?: string;
};

export type HandleParams = {
    address?: string;
    offset?: number;
    limit?: number;
};
