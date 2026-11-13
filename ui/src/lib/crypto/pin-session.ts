/**
 * PIN Session Management
 *
 * Manages encryption PIN setup, verification, and session lifecycle.
 * Derived keys are stored encrypted in the DB, protected by a session
 * key that lives only in the user's cookie.
 */

import { validTimelineSecret, TIMELINE_SECRET_HELP } from "../../../../shared/timeline-secret";
import { withTimelineUserLock, type TimelineTransaction } from "@/lib/db/timeline-lock";
import { db, ensureSchema } from "@/db";
import { userEncryptionKeys, pinSessions } from "@/db/schema";
import { eq, and, gt } from "drizzle-orm";
import { cookies } from "next/headers";
import {
  deriveKey,
  hashKey,
  generateSalt,
  encryptDerivedKeyForSession,
  decryptDerivedKeyFromSession,
  generateKeyPair,
  exportPublicKey,
  encryptPrivateKey,
  decryptPrivateKey,
  uint8ToBase64,
  base64ToUint8,
} from "./encryption";

const PIN_SESSION_COOKIE = "ye-pin-session";
const SESSION_DURATION = 60 * 60 * 4; // 4 hours in seconds

/** Check if user has set up a PIN */
export async function hasPIN(userId: string): Promise<boolean> {
  await ensureSchema();
  const [row] = await db
    .select({ id: userEncryptionKeys.id })
    .from(userEncryptionKeys)
    .where(eq(userEncryptionKeys.userId, userId))
    .limit(1);
  return !!row;
}

/** Create a new encryption PIN for the user */
export async function createPIN(
  userId: string,
  pin: string
): Promise<{ sessionId: string }> {
  if (!validTimelineSecret(pin)) throw new Error(TIMELINE_SECRET_HELP);
  return withTimelineUserLock(userId, async (tx) => {

  const [existing] = await tx.select().from(userEncryptionKeys).where(eq(userEncryptionKeys.userId, userId));
  if (existing) {
    // Same-input retries reuse the original keypair after a lost response.
    const key = await deriveKey(pin, base64ToUint8(existing.salt), existing.iterations);
    if (await hashKey(key) !== existing.keyHash) throw new Error("An encryption secret already exists. Unlock or change it instead.");
    await verifyKeyPair(existing, key);
    return startPINSession(userId, key, tx);
  }

  // Generate salt and derive key
  const salt = generateSalt();
  const key = await deriveKey(pin, salt);
  const keyHashValue = await hashKey(key);

  // Generate RSA keypair for hybrid encryption
  const { publicKey, privateKey } = await generateKeyPair();
  const publicKeyB64 = await exportPublicKey(publicKey);
  const { encryptedPrivateKey: encPrivKey, privateKeyNonce: privKeyNonce } =
    await encryptPrivateKey(privateKey, key);

  // Store salt + key hash + keypair
  await tx.insert(userEncryptionKeys).values({
    userId,
    salt: uint8ToBase64(salt),
    keyHash: keyHashValue,
    iterations: 600000,
    publicKey: publicKeyB64,
    encryptedPrivateKey: encPrivKey,
    privateKeyNonce: privKeyNonce,
  });

  // Create a PIN session
  return startPINSession(userId, key, tx);
  });
}

/** Verify PIN and start a session */
export async function verifyPIN(
  userId: string,
  pin: string
): Promise<{ sessionId: string } | null> {
  if (!validTimelineSecret(pin)) return null;
  return withTimelineUserLock(userId, async (tx) => {

  // Get stored key params
  const [keyRow] = await tx
    .select()
    .from(userEncryptionKeys)
    .where(eq(userEncryptionKeys.userId, userId))
    .limit(1);

  if (!keyRow) return null;

  // Derive key from PIN + stored salt
  const salt = base64ToUint8(keyRow.salt);
  const key = await deriveKey(pin, salt, keyRow.iterations);
  const computedHash = await hashKey(key);

  // Compare hashes
  if (computedHash !== keyRow.keyHash) return null;

  await verifyKeyPair(keyRow, key);

  // PIN correct — create session
  return startPINSession(userId, key, tx);
  });
}

/** Verify the RSA identity; never replace partial/corrupt key material. */
async function verifyKeyPair(row: typeof userEncryptionKeys.$inferSelect, key: CryptoKey) {
  if (!row.publicKey || !row.encryptedPrivateKey || !row.privateKeyNonce) throw new Error("Encryption key material is incomplete; existing identity was preserved");
  const { importPublicKey, hybridEncrypt, hybridDecrypt } = await import("./encryption");
  const publicKey = await importPublicKey(row.publicKey);
  const privateKey = await decryptPrivateKey(row.encryptedPrivateKey, row.privateKeyNonce, key);
  const probe = await hybridEncrypt("keypair-check", publicKey);
  if (await hybridDecrypt(probe.ciphertext, probe.nonce, probe.wrappedKey, privateKey) !== "keypair-check") throw new Error("Encryption keypair is inconsistent");
}

/** Start a PIN session — store encrypted derived key in DB, session key in cookie */
async function startPINSession(
  userId: string,
  derivedKey: CryptoKey,
  client: typeof db | TimelineTransaction = db
): Promise<{ sessionId: string }> {
  // Generate random session key (stored in cookie only)
  const sessionKey = crypto.getRandomValues(new Uint8Array(32));

  // Encrypt the derived key with the session key
  const { encryptedKey, sessionNonce } = await encryptDerivedKeyForSession(
    derivedKey,
    sessionKey
  );

  const expiresAt = new Date(Date.now() + SESSION_DURATION * 1000);

  // Clean up old sessions for this user
  await client
    .delete(pinSessions)
    .where(eq(pinSessions.userId, userId));

  // Insert new session
  const [session] = await client
    .insert(pinSessions)
    .values({
      userId,
      encryptedDerivedKey: encryptedKey,
      sessionNonce,
      expiresAt,
    })
    .returning();

  // Store session key in HTTP-only cookie
  const cookieStore = await cookies();
  const useSecure = process.env.SECURE_COOKIES !== "false";

  cookieStore.set(PIN_SESSION_COOKIE, `${session.id}:${uint8ToBase64(sessionKey)}`, {
    httpOnly: true,
    secure: useSecure,
    sameSite: "lax",
    maxAge: SESSION_DURATION,
    path: "/",
  });

  return { sessionId: session.id };
}

/** Get the active encryption key from current PIN session */
export async function getActiveDerivedKey(
  userId: string
): Promise<CryptoKey | null> {
  await ensureSchema();

  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(PIN_SESSION_COOKIE);
  if (!sessionCookie?.value) return null;

  const [sessionId, sessionKeyB64] = sessionCookie.value.split(":");
  if (!sessionId || !sessionKeyB64) return null;

  // Get session from DB
  const [session] = await db
    .select()
    .from(pinSessions)
    .where(
      and(
        eq(pinSessions.id, sessionId),
        eq(pinSessions.userId, userId),
        gt(pinSessions.expiresAt, new Date())
      )
    )
    .limit(1);

  if (!session) {
    // Session expired or invalid — clear cookie
    cookieStore.delete(PIN_SESSION_COOKIE);
    return null;
  }

  try {
    const sessionKey = base64ToUint8(sessionKeyB64);
    const key = await decryptDerivedKeyFromSession(
      session.encryptedDerivedKey,
      session.sessionNonce,
      sessionKey
    );
    const [current] = await db.select({ keyHash: userEncryptionKeys.keyHash }).from(userEncryptionKeys).where(eq(userEncryptionKeys.userId, userId));
    return current && await hashKey(key) === current.keyHash ? key : null;
  } catch {
    return null;
  }
}

/** Get the user's RSA public key (always available after PIN setup) */
export async function getPublicKey(userId: string): Promise<CryptoKey | null> {
  await ensureSchema();

  const [keyRow] = await db
    .select({ publicKey: userEncryptionKeys.publicKey })
    .from(userEncryptionKeys)
    .where(eq(userEncryptionKeys.userId, userId))
    .limit(1);

  if (!keyRow?.publicKey) return null;

  const { importPublicKey } = await import("./encryption");
  return importPublicKey(keyRow.publicKey);
}

/** Get the user's decrypted RSA private key (requires active PIN session) */
export async function getPrivateKey(
  userId: string,
  derivedKey: CryptoKey
): Promise<CryptoKey | null> {
  await ensureSchema();

  const [keyRow] = await db
    .select({
      encryptedPrivateKey: userEncryptionKeys.encryptedPrivateKey,
      privateKeyNonce: userEncryptionKeys.privateKeyNonce,
    })
    .from(userEncryptionKeys)
    .where(eq(userEncryptionKeys.userId, userId))
    .limit(1);

  if (!keyRow?.encryptedPrivateKey || !keyRow?.privateKeyNonce) return null;

  try {
    return await decryptPrivateKey(
      keyRow.encryptedPrivateKey,
      keyRow.privateKeyNonce,
      derivedKey
    );
  } catch {
    return null;
  }
}

/** Check if there's an active PIN session */
export async function hasActivePINSession(userId: string): Promise<boolean> {
  const key = await getActiveDerivedKey(userId);
  return key !== null;
}

/** End the current PIN session */
export async function endPINSession(userId: string): Promise<void> {
  await ensureSchema();

  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(PIN_SESSION_COOKIE);

  if (sessionCookie?.value) {
    const [sessionId] = sessionCookie.value.split(":");
    if (sessionId) {
      await db.delete(pinSessions).where(and(eq(pinSessions.id, sessionId), eq(pinSessions.userId, userId)));
    }
    cookieStore.delete(PIN_SESSION_COOKIE);
  }
}

/** Change PIN — requires current PIN verification */
export async function changePIN(userId: string, currentPin: string, newPin: string): Promise<boolean> {
  if (!validTimelineSecret(currentPin) || !validTimelineSecret(newPin)) throw new Error(TIMELINE_SECRET_HELP);
  return withTimelineUserLock(userId, async (tx) => {
    const [keyRow] = await tx.select().from(userEncryptionKeys).where(eq(userEncryptionKeys.userId, userId));
    if (!keyRow) return false;
    const currentKey = await deriveKey(currentPin, base64ToUint8(keyRow.salt), keyRow.iterations);
    if (await hashKey(currentKey) !== keyRow.keyHash) return false;
    await verifyKeyPair(keyRow, currentKey);
    const { timelineEntries } = await import("@/db/schema");
    const { decrypt, encrypt } = await import("./encryption");
    const newSalt = generateSalt();
    const newKey = await deriveKey(newPin, newSalt);
    const newHash = await hashKey(newKey);
    const entries = await tx.select().from(timelineEntries).where(eq(timelineEntries.userId, userId));
    // Any damaged entry aborts the entire transition; the old key remains active.
    for (const entry of entries) {
      if (entry.encryptionType === "hybrid") continue;
      const plaintext = await decrypt(entry.encryptedBlob, entry.nonce, currentKey);
      const { ciphertext, nonce } = await encrypt(plaintext, newKey);
      await tx.update(timelineEntries).set({ encryptedBlob: ciphertext, nonce }).where(eq(timelineEntries.id, entry.id));
    }
    const updateSet: Partial<typeof userEncryptionKeys.$inferInsert> = {
      salt: uint8ToBase64(newSalt), keyHash: newHash, iterations: 600000, updatedAt: new Date(),
    };
    if (keyRow.encryptedPrivateKey && keyRow.privateKeyNonce) {
      const privateKey = await decryptPrivateKey(keyRow.encryptedPrivateKey, keyRow.privateKeyNonce, currentKey);
      const wrapped = await encryptPrivateKey(privateKey, newKey);
      updateSet.encryptedPrivateKey = wrapped.encryptedPrivateKey;
      updateSet.privateKeyNonce = wrapped.privateKeyNonce;
    }
    await tx.update(userEncryptionKeys).set(updateSet).where(eq(userEncryptionKeys.userId, userId));
    await tx.delete(pinSessions).where(eq(pinSessions.userId, userId));
    return true;
  });
}

export { validTimelineSecret };
