-- Baseline: the schema exactly as Peewee 3.8.1 `db.create_tables([...])` built it
-- (models/__init__.py before this migration runner existed). The statements are
-- the ones Peewee itself issued, so on an existing database this is a no-op.
-- Note: FileAuditLog was never in the create_tables list, so it has no table.

CREATE TABLE IF NOT EXISTS "mimetype_types" ("id" VARCHAR(11) NOT NULL PRIMARY KEY);

CREATE TABLE IF NOT EXISTS "mimetypes" ("id" VARCHAR(100) NOT NULL PRIMARY KEY, "flags" INTEGER NOT NULL, "type_id" VARCHAR(11), FOREIGN KEY ("type_id") REFERENCES "mimetype_types" ("id"));
CREATE INDEX IF NOT EXISTS "mimetype_type_id" ON "mimetypes" ("type_id");

CREATE TABLE IF NOT EXISTS "file_hashes" ("id" BIGINT NOT NULL PRIMARY KEY, "blake2b" VARCHAR(128) NOT NULL, "sha1" VARCHAR(40) NOT NULL, "md5" VARCHAR(32) NOT NULL, "size" BIGINT NOT NULL, "height" INTEGER, "width" INTEGER, "duration" INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS "filehash_blake2b_sha1_md5" ON "file_hashes" ("blake2b", "sha1", "md5");

CREATE TABLE IF NOT EXISTS "users" ("id" BIGINT NOT NULL PRIMARY KEY, "email" VARCHAR(128) NOT NULL, "bot" BOOLEAN NOT NULL, "username" VARCHAR(32) NOT NULL, "discriminator" INTEGER NOT NULL, "password" VARCHAR(128), "flags" INTEGER NOT NULL, "verified" BOOLEAN NOT NULL, "last_email_reset" BIGINT NOT NULL, "last_password_reset" BIGINT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS "user_email" ON "users" ("email");
CREATE INDEX IF NOT EXISTS "user_username" ON "users" ("username");
CREATE UNIQUE INDEX IF NOT EXISTS "user_username_discriminator" ON "users" ("username", "discriminator");

CREATE TABLE IF NOT EXISTS "files" ("id" BIGINT NOT NULL PRIMARY KEY, "vanity" VARCHAR(128) NOT NULL, "mimetype_id" VARCHAR(100) NOT NULL, "extension" VARCHAR(12), "filename" VARCHAR(128) NOT NULL, "hash_id" BIGINT NOT NULL, "user_id" BIGINT, "fingerprint" BIGINT, "view_count" BIGINT NOT NULL, FOREIGN KEY ("mimetype_id") REFERENCES "mimetypes" ("id"), FOREIGN KEY ("hash_id") REFERENCES "file_hashes" ("id"), FOREIGN KEY ("user_id") REFERENCES "users" ("id"));
CREATE UNIQUE INDEX IF NOT EXISTS "file_vanity" ON "files" ("vanity");
CREATE INDEX IF NOT EXISTS "file_mimetype_id" ON "files" ("mimetype_id");
CREATE INDEX IF NOT EXISTS "file_hash_id" ON "files" ("hash_id");
CREATE INDEX IF NOT EXISTS "file_user_id" ON "files" ("user_id");
CREATE INDEX IF NOT EXISTS "file_fingerprint" ON "files" ("fingerprint");

CREATE TABLE IF NOT EXISTS "file_views" ("id" SERIAL NOT NULL PRIMARY KEY, "file_id" BIGINT NOT NULL, "ip" VARCHAR(255) NOT NULL, "timestamp" BIGINT NOT NULL, FOREIGN KEY ("file_id") REFERENCES "files" ("id"));
CREATE INDEX IF NOT EXISTS "fileview_file_id" ON "file_views" ("file_id");
CREATE INDEX IF NOT EXISTS "fileview_ip" ON "file_views" ("ip");
CREATE INDEX IF NOT EXISTS "fileview_file_id_ip" ON "file_views" ("file_id", "ip");

CREATE TABLE IF NOT EXISTS "mimetype_extensions" ("mimetype_id" VARCHAR(100) NOT NULL, "extension" VARCHAR(12) NOT NULL, "priority" INTEGER NOT NULL, PRIMARY KEY ("mimetype_id", "extension"), FOREIGN KEY ("mimetype_id") REFERENCES "mimetypes" ("id"));
CREATE INDEX IF NOT EXISTS "mimetypeextension_mimetype_id" ON "mimetype_extensions" ("mimetype_id");
