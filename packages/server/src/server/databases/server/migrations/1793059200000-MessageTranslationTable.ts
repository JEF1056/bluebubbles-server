import { Server } from "@server";
import { MigrationInterface, QueryRunner } from "typeorm";

export class MessageTranslationTable1793059200000 implements MigrationInterface {
    name = "MessageTranslationTable1793059200000";

    async up(queryRunner: QueryRunner): Promise<void> {
        Server().log(`Migration[${this.name}] Creating message_translation table...`, "debug");
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "message_translation" (
                "message_guid" varchar PRIMARY KEY NOT NULL,
                "chat_guid" varchar,
                "source_text_hash" varchar NOT NULL,
                "source_language" varchar NOT NULL,
                "target_language" varchar NOT NULL,
                "translated_text" text NOT NULL,
                "provider" varchar NOT NULL,
                "auto_translated" integer NOT NULL DEFAULT (0),
                "created_at" integer NOT NULL,
                "last_accessed_at" integer NOT NULL
            )
        `);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_message_translation_chat_guid" ON "message_translation" ("chat_guid")`
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_message_translation_last_accessed_at" ` +
                `ON "message_translation" ("last_accessed_at")`
        );
        Server().log(`Migration[${this.name}] Success!`, "debug");
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        // Don't do anything
    }
}
