import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const bins = sqliteTable("bins", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  size: integer("size").notNull(),
}, table => [index("bins_expiry_idx").on(table.expiresAt)]);

export type BinRecord = typeof bins.$inferSelect;
