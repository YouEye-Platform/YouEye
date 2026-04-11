/**
 * PIN Session Management
 *
 * Manages encryption PIN setup, verification, and session lifecycle.
 * Derived keys are stored encrypted in the DB, protected by a session
 * key that lives only in the user's cookie.
 */

import { db, ensureSchema } from "@/db";
import { userEncryptionKeys, pinSessions } from "@/db/schema";
import { eq, and, gt } from "drizzle-orm";
import { cookies } from "next/headers";
import {
  deriveKey,
  hashKey,
  generateSalt,
  exportKey,
  encryptDerivedKeyForSession,
  decryptDerivedKeyFromSession,
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
  await ensureSchema();

  // Check if PIN already exists
  const existing = await hasPIN(userId);
  if (existing) {
    throw new Error("PIN already exists. Use changePIN instead.");
  }

  // Validate PIN
  if (pin.length < 4) {
    throw new Error("PIN must be at least 4 characters.");
  }

  // Generate salt and derive key
  const salt = generateSalt();
  const key = await deriveKey(pin, salt);
  const keyHashValue = await hashKey(key);

  // Store salt + key hash
  await db.insert(userEncryptionKeys).values({
    userId,
    salt: uint8ToBase64(salt),
    keyHash: keyHashValue,
    iterations: 600000,
  });

  // Create a PIN session
  return startPINSession(userId, key);
}

/** Verify PIN and start a session */
export async function verifyPIN(
  userId: string,
  pin: string
): Promise<{ sessionId: string } | null> {
  await ensureSchema();

  // Get stored key params
  const [keyRow] = await db
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

  // PIN correct — create session
  return startPINSession(userId, key);
}

/** Start a PIN session — store encrypted derived key in DB, session key in cookie */
async function startPINSession(
  userId: string,
  derivedKey: CryptoKey
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
  await db
    .delete(pinSessions)
    .where(eq(pinSessions.userId, userId));

  // Insert new session
  const [session] = await db
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
    return await decryptDerivedKeyFromSession(
      session.encryptedDerivedKey,
      session.sessionNonce,
      sessionKey
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
      await db.delete(pinSessions).where(eq(pinSessions.id, sessionId));
    }
    cookieStore.delete(PIN_SESSION_COOKIE);
  }
}

/** Change PIN — requires current PIN verification */
export async function changePIN(
  userId: string,
  currentPin: string,
  newPin: string
): Promise<boolean> {
  await ensureSchema();

  if (newPin.length < 4) {
    throw new Error("PIN must be at least 4 characters.");
  }

  // Verify current PIN
  const [keyRow] = await db
    .select()
    .from(userEncryptionKeys)
    .where(eq(userEncryptionKeys.userId, userId))
    .limit(1);

  if (!keyRow) return false;

  const currentSalt = base64ToUint8(keyRow.salt);
  const currentKey = await deriveKey(currentPin, currentSalt, keyRow.iterations);
  const currentHash = await hashKey(currentKey);

  if (currentHash !== keyRow.keyHash) return false;

  // Re-encrypt all timeline entries with new key
  const { timelineEntries } = await import("@/db/schema");
  const { decrypt, encrypt } = await import("./encryption");

  const newSalt = generateSalt();
  const newKey = await deriveKey(newPin, newSalt);
  const newKeyHash = await hashKey(newKey);

  // Get all entries
  const entries = await db
    .select()
    .from(timelineEntries)
    .where(eq(timelineEntries.userId, userId));

  // Re-encrypt each entry
  for (const entry of entries) {
    const decrypted = await decrypt(entry.encryptedBlob, entry.nonce, currentKey);
    const { ciphertext, nonce } = await encrypt(decrypted, newKey);
    await db
      .update(timelineEntries)
      .set({ encryptedBlob: ciphertext, nonce })
      .where(eq(timelineEntries.id, entry.id));
  }

  // Update key params
  await db
    .update(userEncryptionKeys)
    .set({
      salt: uint8ToBase64(newSalt),
      keyHash: newKeyHash,
      updatedAt: new Date(),
    })
    .where(eq(userEncryptionKeys.userId, userId));

  // End old sessions
  await db.delete(pinSessions).where(eq(pinSessions.userId, userId));

  return true;
}
