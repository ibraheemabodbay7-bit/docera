import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password"),
  name: text("name").notNull().default(""),
  senderName: text("sender_name"),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  // In-app trial / subscription (DB-backed, no Stripe required)
  trialStartedAt: timestamp("trial_started_at"),
  isSubscribed: boolean("is_subscribed").notNull().default(false),
  // Handwriting credit system — 10 credits per month, resets every 30 days
  hwCredits: integer("hw_credits").notNull().default(10),
  hwCreditsResetAt: timestamp("hw_credits_reset_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const folders = pgTable("folders", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const clients = pgTable("clients", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const documents = pgTable("documents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  folderId: varchar("folder_id").references(() => folders.id),
  clientId: varchar("client_id").references(() => clients.id),
  name: text("name").notNull(),
  type: text("type").notNull().default("pdf"),
  dataUrl: text("data_url").notNull(),
  // pages stores a JSON array of SerializablePage objects (per-page edit state).
  // Kept separate from dataUrl so the list endpoint can omit it for performance.
  pages: text("pages").notNull().default("[]"),
  size: integer("size").notNull().default(0),
  // thumbUrl: small JPEG thumbnail of the first page for document cards (max 240px wide).
  // Empty string for imported PDFs or legacy documents.
  thumbUrl: text("thumb_url").notNull().default(""),
  // status: workflow state of the document.
  // Values: "draft" | "pending" | "sent" | "approved" | "rejected"
  status: text("status").notNull().default("draft"),
  // notes: free-form user notes attached to the document (context, reminders, etc.)
  notes: text("notes"),
  // isFavorite: whether the user has starred/pinned this document for quick access.
  isFavorite: boolean("is_favorite").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// document_events: append-only audit log for each document.
export const documentEvents = pgTable("document_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  documentId: varchar("document_id").notNull().references(() => documents.id),
  userId: varchar("user_id").notNull().references(() => users.id),
  type: text("type").notNull(),
  label: text("label").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true });
export const insertFolderSchema = createInsertSchema(folders).omit({ id: true, createdAt: true });
export const insertClientSchema = createInsertSchema(clients).omit({ id: true, createdAt: true });
export const insertDocumentSchema = createInsertSchema(documents).omit({ id: true, createdAt: true });
export const insertDocumentEventSchema = createInsertSchema(documentEvents).omit({ id: true, createdAt: true });

export type InsertUser = z.infer<typeof insertUserSchema>;
export type InsertFolder = z.infer<typeof insertFolderSchema>;
export type InsertClient = z.infer<typeof insertClientSchema>;
export type InsertDocument = z.infer<typeof insertDocumentSchema>;
export type InsertDocumentEvent = z.infer<typeof insertDocumentEventSchema>;

export type User = typeof users.$inferSelect;
export type Folder = typeof folders.$inferSelect;
export type Client = typeof clients.$inferSelect;
export type Document = typeof documents.$inferSelect;
export type DocumentEvent = typeof documentEvents.$inferSelect;

// DocumentSummary is returned by the list endpoint — excludes heavy binary fields
// (dataUrl is a full PDF blob; pages contains base64 images for each page).
// Only the detail endpoint (/api/documents/:id) returns the full Document.
export type DocumentSummary = Omit<Document, "dataUrl" | "pages">;

export type PublicUser = Omit<User, "password">;

export const DOC_STATUSES = ["draft", "pending", "sent", "approved", "rejected"] as const;
export type DocStatus = typeof DOC_STATUSES[number];
