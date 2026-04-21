import { db } from "./db";
import { users, folders, documents, documentEvents, clients } from "@shared/schema";
import { eq, and, isNull, desc, sql } from "drizzle-orm";
import type {
  InsertUser, InsertFolder, InsertDocument, InsertDocumentEvent, InsertClient,
  User, Folder, Document, DocumentSummary, DocumentEvent, Client,
} from "@shared/schema";
import bcrypt from "bcrypt";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserByStripeCustomerId(customerId: string): Promise<User | undefined>;
  getUserByStripeSubscriptionId(subscriptionId: string): Promise<User | undefined>;
  createUser(data: { username: string; password: string; name: string }): Promise<User>;
  updateUser(id: string, data: { name?: string; senderName?: string | null }): Promise<User | undefined>;
  updateUserStripeInfo(id: string, data: { stripeCustomerId?: string; stripeSubscriptionId?: string }): Promise<User | undefined>;
  getUserSubscriptionStatus(id: string): Promise<{ status: string; currentPeriodEnd: number | null }>;
  startTrial(id: string): Promise<void>;
  setSubscribed(id: string, value: boolean): Promise<void>;
  getHwCredits(userId: string): Promise<{ credits: number; resetAt: Date | null }>;
  consumeHwCredit(userId: string): Promise<{ ok: boolean; remaining: number }>;
  addHwCredits(userId: string, amount: number): Promise<{ credits: number }>;
  getFolders(userId: string): Promise<Folder[]>;
  getFolder(id: string): Promise<Folder | undefined>;
  createFolder(data: InsertFolder): Promise<Folder>;
  updateFolder(id: string, data: { name: string }): Promise<Folder | undefined>;
  deleteFolder(id: string): Promise<void>;
  getClients(userId: string): Promise<Client[]>;
  getClient(id: string): Promise<Client | undefined>;
  createClient(data: InsertClient): Promise<Client>;
  updateClient(id: string, data: Partial<{ name: string; email: string | null; phone: string | null; notes: string | null }>): Promise<Client | undefined>;
  deleteClient(id: string): Promise<void>;
  // List endpoint — lightweight, no heavy binary columns
  getDocuments(userId: string, folderId?: string | null): Promise<DocumentSummary[]>;
  getDocumentsByClient(clientId: string, userId: string): Promise<DocumentSummary[]>;
  // Detail endpoint — returns full document including dataUrl and pages
  getDocument(id: string): Promise<Document | undefined>;
  createDocument(data: InsertDocument): Promise<Document>;
  // Metadata-only update (name, folderId, status, clientId, notes)
  updateDocument(id: string, data: Partial<{ name: string; folderId: string | null; status: string; clientId: string | null; notes: string | null; isFavorite: boolean }>): Promise<DocumentSummary | undefined>;
  // Full content update — replaces PDF, pages edit data, and optionally name/thumb/status
  updateDocumentContent(id: string, data: { name?: string; dataUrl?: string; size?: number; pages?: string; thumbUrl?: string; status?: string }): Promise<Document | undefined>;
  deleteDocument(id: string): Promise<void>;
  duplicateDocument(id: string, newName: string): Promise<Document | undefined>;
  // Document events (append-only audit log)
  getDocumentEvents(documentId: string): Promise<DocumentEvent[]>;
  createDocumentEvent(data: InsertDocumentEvent): Promise<DocumentEvent>;
}

// Summary column selection — omits dataUrl and pages for list performance
const SUMMARY_COLS = {
  id: documents.id,
  userId: documents.userId,
  folderId: documents.folderId,
  clientId: documents.clientId,
  name: documents.name,
  type: documents.type,
  size: documents.size,
  thumbUrl: documents.thumbUrl,
  status: documents.status,
  notes: documents.notes,
  isFavorite: documents.isFavorite,
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
} as const;

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, email));
    return user;
  }

  async getUserByStripeCustomerId(customerId: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.stripeCustomerId, customerId));
    return user;
  }

  async getUserByStripeSubscriptionId(subscriptionId: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.stripeSubscriptionId, subscriptionId));
    return user;
  }

  async createUser(data: { username: string; password: string; name: string }): Promise<User> {
    const hashed = await bcrypt.hash(data.password, 10);
    const [user] = await db.insert(users).values({
      username: data.username,
      password: hashed,
      name: data.name,
    }).returning();
    return user;
  }

  async updateUser(id: string, data: { name?: string; senderName?: string | null }): Promise<User | undefined> {
    const [user] = await db.update(users).set(data).where(eq(users.id, id)).returning();
    return user;
  }

  async updateUserStripeInfo(id: string, data: { stripeCustomerId?: string; stripeSubscriptionId?: string }): Promise<User | undefined> {
    const [user] = await db.update(users).set(data).where(eq(users.id, id)).returning();
    return user;
  }

  async getUserSubscriptionStatus(id: string): Promise<{ status: string; currentPeriodEnd: number | null }> {
    const user = await this.getUser(id);
    if (!user) return { status: "none", currentPeriodEnd: null };

    // 1. Real Stripe subscription — highest priority, always wins
    //    This means cancellations/failures in Stripe are immediately reflected.
    if (user.stripeSubscriptionId) {
      try {
        const result = await db.execute(
          sql`SELECT status, current_period_end FROM stripe.subscriptions WHERE id = ${user.stripeSubscriptionId} LIMIT 1`
        );
        const row = result.rows[0] as { status?: string; current_period_end?: string | number } | undefined;
        if (row) {
          const periodEnd = row.current_period_end
            ? typeof row.current_period_end === "number"
              ? row.current_period_end
              : Math.floor(new Date(row.current_period_end).getTime() / 1000)
            : null;
          const stripeStatus = String(row.status ?? "none");
          // Return the real Stripe status unconditionally — frontend decides what to show/block
          return { status: stripeStatus, currentPeriodEnd: periodEnd };
        }
      } catch {
        // DB error — fall through to other checks
      }
    }

    // 2. Simulated in-app subscription (only when no real Stripe subscription exists)
    if (user.isSubscribed) {
      return { status: "active", currentPeriodEnd: null };
    }

    // 3. In-app 3-day free trial
    if (user.trialStartedAt) {
      const trialEndMs = new Date(user.trialStartedAt).getTime() + 3 * 24 * 60 * 60 * 1000;
      const trialEndSec = Math.floor(trialEndMs / 1000);
      if (Date.now() < trialEndMs) {
        return { status: "trialing", currentPeriodEnd: trialEndSec };
      }
      return { status: "expired", currentPeriodEnd: trialEndSec };
    }

    return { status: "none", currentPeriodEnd: null };
  }

  async startTrial(id: string): Promise<void> {
    await db.update(users)
      .set({ trialStartedAt: new Date() })
      .where(eq(users.id, id));
  }

  async setSubscribed(id: string, value: boolean): Promise<void> {
    await db.update(users)
      .set({ isSubscribed: value })
      .where(eq(users.id, id));
  }

  // ── Handwriting credit helpers ─────────────────────────────────────────────

  /** Resets hwCredits to 10 if the last reset was > 30 days ago (or never). */
  private async resetHwCreditsIfDue(userId: string): Promise<void> {
    const [row] = await db
      .select({ hwCreditsResetAt: users.hwCreditsResetAt })
      .from(users)
      .where(eq(users.id, userId));
    if (!row) return;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    if (!row.hwCreditsResetAt || row.hwCreditsResetAt < thirtyDaysAgo) {
      await db.update(users)
        .set({ hwCredits: 10, hwCreditsResetAt: new Date() })
        .where(eq(users.id, userId));
    }
  }

  async getHwCredits(userId: string): Promise<{ credits: number; resetAt: Date | null }> {
    await this.resetHwCreditsIfDue(userId);
    const [row] = await db
      .select({ hwCredits: users.hwCredits, hwCreditsResetAt: users.hwCreditsResetAt })
      .from(users)
      .where(eq(users.id, userId));
    return { credits: row?.hwCredits ?? 10, resetAt: row?.hwCreditsResetAt ?? null };
  }

  async consumeHwCredit(userId: string): Promise<{ ok: boolean; remaining: number }> {
    await this.resetHwCreditsIfDue(userId);
    const [row] = await db
      .select({ hwCredits: users.hwCredits })
      .from(users)
      .where(eq(users.id, userId));
    const current = row?.hwCredits ?? 0;
    if (current <= 0) return { ok: false, remaining: 0 };
    const next = current - 1;
    await db.update(users).set({ hwCredits: next }).where(eq(users.id, userId));
    return { ok: true, remaining: next };
  }

  async addHwCredits(userId: string, amount: number): Promise<{ credits: number }> {
    const [row] = await db
      .select({ hwCredits: users.hwCredits })
      .from(users)
      .where(eq(users.id, userId));
    const next = (row?.hwCredits ?? 0) + amount;
    await db.update(users).set({ hwCredits: next }).where(eq(users.id, userId));
    return { credits: next };
  }

  async getFolders(userId: string): Promise<Folder[]> {
    return db.select().from(folders).where(eq(folders.userId, userId));
  }

  async getFolder(id: string): Promise<Folder | undefined> {
    const [folder] = await db.select().from(folders).where(eq(folders.id, id));
    return folder;
  }

  async createFolder(data: InsertFolder): Promise<Folder> {
    const [folder] = await db.insert(folders).values(data).returning();
    return folder;
  }

  async updateFolder(id: string, data: { name: string }): Promise<Folder | undefined> {
    const [folder] = await db.update(folders).set(data).where(eq(folders.id, id)).returning();
    return folder;
  }

  async deleteFolder(id: string): Promise<void> {
    await db.update(documents).set({ folderId: null }).where(eq(documents.folderId, id));
    await db.delete(folders).where(eq(folders.id, id));
  }

  async getClients(userId: string): Promise<Client[]> {
    return db.select().from(clients).where(eq(clients.userId, userId)).orderBy(clients.name);
  }

  async getClient(id: string): Promise<Client | undefined> {
    const [client] = await db.select().from(clients).where(eq(clients.id, id));
    return client;
  }

  async createClient(data: InsertClient): Promise<Client> {
    const [client] = await db.insert(clients).values(data).returning();
    return client;
  }

  async updateClient(id: string, data: Partial<{ name: string; email: string | null; phone: string | null; notes: string | null }>): Promise<Client | undefined> {
    const [client] = await db.update(clients).set(data).where(eq(clients.id, id)).returning();
    return client;
  }

  async deleteClient(id: string): Promise<void> {
    await db.update(documents).set({ clientId: null }).where(eq(documents.clientId, id));
    await db.delete(clients).where(eq(clients.id, id));
  }

  async getDocuments(userId: string, folderId?: string | null): Promise<DocumentSummary[]> {
    if (folderId === undefined) {
      return db.select(SUMMARY_COLS).from(documents).where(eq(documents.userId, userId));
    }
    if (folderId === null) {
      return db.select(SUMMARY_COLS).from(documents).where(
        and(eq(documents.userId, userId), isNull(documents.folderId))
      );
    }
    return db.select(SUMMARY_COLS).from(documents).where(
      and(eq(documents.userId, userId), eq(documents.folderId, folderId))
    );
  }

  async getDocumentsByClient(clientId: string, userId: string): Promise<DocumentSummary[]> {
    return db.select(SUMMARY_COLS).from(documents).where(
      and(eq(documents.clientId, clientId), eq(documents.userId, userId))
    ).orderBy(desc(documents.createdAt));
  }

  async getDocument(id: string): Promise<Document | undefined> {
    const [doc] = await db.select().from(documents).where(eq(documents.id, id));
    return doc;
  }

  async createDocument(data: InsertDocument): Promise<Document> {
    const [doc] = await db.insert(documents).values(data).returning();
    return doc;
  }

  async updateDocument(id: string, data: Partial<{ name: string; folderId: string | null; status: string; clientId: string | null; notes: string | null; isFavorite: boolean }>): Promise<DocumentSummary | undefined> {
    const [doc] = await db.update(documents)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(documents.id, id))
      .returning(SUMMARY_COLS);
    return doc;
  }

  async updateDocumentContent(id: string, data: { name?: string; dataUrl?: string; size?: number; pages?: string; thumbUrl?: string; status?: string }): Promise<Document | undefined> {
    const [doc] = await db.update(documents)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(documents.id, id))
      .returning();
    return doc;
  }

  async deleteDocument(id: string): Promise<void> {
    await db.delete(documents).where(eq(documents.id, id));
  }

  async duplicateDocument(id: string, newName: string): Promise<Document | undefined> {
    const [src] = await db.select().from(documents).where(eq(documents.id, id));
    if (!src) return undefined;
    const [copy] = await db.insert(documents).values({
      userId: src.userId,
      folderId: src.folderId,
      clientId: src.clientId,
      name: newName,
      type: src.type,
      dataUrl: src.dataUrl,
      pages: src.pages,
      size: src.size,
      thumbUrl: src.thumbUrl,
      status: src.status,      // preserve original status
      notes: src.notes,        // preserve notes
      isFavorite: false,       // new copy is never pre-starred
    }).returning();
    return copy;
  }

  async getDocumentEvents(documentId: string): Promise<DocumentEvent[]> {
    return db.select()
      .from(documentEvents)
      .where(eq(documentEvents.documentId, documentId))
      .orderBy(desc(documentEvents.createdAt));
  }

  async createDocumentEvent(data: InsertDocumentEvent): Promise<DocumentEvent> {
    const [event] = await db.insert(documentEvents).values(data).returning();
    return event;
  }
}

export const storage = new DatabaseStorage();
