import { Entity, PrimaryColumn, Column, Index } from "typeorm";
import { BooleanTransformer } from "@server/databases/transformers/BooleanTransformer";

@Entity({ name: "message_translation" })
export class MessageTranslation {
    @PrimaryColumn("text", { name: "message_guid" })
    messageGuid: string;

    @Index()
    @Column("text", { name: "chat_guid", nullable: true })
    chatGuid: string | null;

    @Column("text", { name: "source_text_hash", nullable: false })
    sourceTextHash: string;

    @Column("text", { name: "source_language", nullable: false })
    sourceLanguage: string;

    @Column("text", { name: "target_language", nullable: false })
    targetLanguage: string;

    @Column("text", { name: "translated_text", nullable: false })
    translatedText: string;

    @Column("text", { name: "provider", nullable: false })
    provider: string;

    @Column("integer", {
        name: "auto_translated",
        nullable: false,
        default: 0,
        transformer: BooleanTransformer
    })
    autoTranslated: boolean;

    @Column("integer", { name: "created_at", nullable: false })
    createdAt: number;

    @Index()
    @Column("integer", { name: "last_accessed_at", nullable: false })
    lastAccessedAt: number;
}
