/**
 * User Database Queries
 *
 * Functions for creating and finding users in the database.
 * Users are upserted on each SSO login to keep profiles in sync with the
 * configured identity provider.
 */

import { eq } from "drizzle-orm";
import { db, ensureSchema } from "@/db";
import { users } from "@/db/schema";

/** Find a user by their identity provider subject ID */
export async function findUserByIdentityId(identityId: string) {
  await ensureSchema();
  const result = await db
    .select()
    .from(users)
    .where(eq(users.identityId, identityId))
    .limit(1);
  return result[0] ?? null;
}

/** Find a user by email address. Used for identity-provider migrations. */
export async function findUserByEmail(email: string) {
  await ensureSchema();
  const result = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return result[0] ?? null;
}

/** Find a user by username. Used by the CP -> UI settings bridge. */
export async function findUserByUsername(username: string) {
  await ensureSchema();
  const result = await db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  return result[0] ?? null;
}

type ExistingUser = NonNullable<
  Awaited<ReturnType<typeof findUserByIdentityId>>
>;

async function updateUserFromSSO(
  existing: ExistingUser,
  data: {
    identityId: string;
    username: string;
    name: string;
    email: string;
    image?: string;
    isAdmin: boolean;
    firstName?: string | null;
    lastName?: string | null;
  }
) {
  const preservedAdmin = data.isAdmin || existing.isAdmin;
  const updateFields: Record<string, unknown> = {
    identityId: data.identityId,
    username: data.username,
    name: data.name,
    email: data.email,
    isAdmin: preservedAdmin,
    updatedAt: new Date(),
  };
  // Only overwrite image if explicitly provided — prevents login from
  // clobbering avatars saved via bridge or client-side upload.
  if (data.image !== undefined) updateFields.image = data.image;
  // Sync firstName/lastName from the identity provider if provided.
  if (data.firstName !== undefined) updateFields.firstName = data.firstName;
  if (data.lastName !== undefined) updateFields.lastName = data.lastName;

  await db
    .update(users)
    .set(updateFields)
    .where(eq(users.id, existing.id));

  return { ...existing, ...data, isAdmin: preservedAdmin, id: existing.id };
}

/**
 * Upsert a user on SSO login.
 * Creates the user if they don't exist, updates their profile if they do.
 * First user to sign in automatically becomes admin.
 */
export async function upsertUser(data: {
  identityId: string;
  username: string;
  name: string;
  email: string;
  image?: string;
  isAdmin: boolean;
  firstName?: string | null;
  lastName?: string | null;
}) {
  const existing = await findUserByIdentityId(data.identityId);

  if (existing) {
    return updateUserFromSSO(existing, data);
  }

  const existingByUsername = data.username
    ? await findUserByUsername(data.username)
    : null;
  const existingByEmail = data.email ? await findUserByEmail(data.email) : null;

  if (
    existingByUsername &&
    existingByEmail &&
    existingByUsername.id !== existingByEmail.id
  ) {
    throw new Error(
      `Cannot migrate identity: username "${data.username}" and email "${data.email}" belong to different users`
    );
  }

  const migrated = existingByUsername ?? existingByEmail;
  if (migrated) {
    return updateUserFromSSO(migrated, data);
  }

  // Check if this is the first user (auto-admin)
  const userCount = await db.select().from(users).limit(1);
  const isFirstUser = userCount.length === 0;

  const [newUser] = await db
    .insert(users)
    .values({
      identityId: data.identityId,
      username: data.username,
      name: data.name,
      firstName: data.firstName ?? null,
      lastName: data.lastName ?? null,
      email: data.email,
      image: data.image,
      isAdmin: isFirstUser || data.isAdmin,
    })
    .returning();

  return newUser;
}

/** Find a user by their internal UUID */
export async function findUserById(id: string) {
  await ensureSchema();
  const result = await db
    .select()
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return result[0] ?? null;
}

/** Get all admin users */
export async function getAdminUsers() {
  await ensureSchema();
  return db
    .select({
      id: users.id,
      username: users.username,
      name: users.name,
      email: users.email,
      isAdmin: users.isAdmin,
    })
    .from(users)
    .where(eq(users.isAdmin, true));
}

/** Check if a user has completed onboarding */
export async function hasCompletedOnboarding(userId: string): Promise<boolean> {
  await ensureSchema();
  const result = await db
    .select({ onboardingCompleted: users.onboardingCompleted })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return result[0]?.onboardingCompleted ?? false;
}

/** Mark a user's onboarding as completed */
export async function completeOnboarding(userId: string) {
  await ensureSchema();
  await db
    .update(users)
    .set({ onboardingCompleted: true, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

/** Update a user's profile fields (bio, timezone, firstName, lastName, name) */
export async function updateUserProfile(
  userId: string,
  data: {
    firstName?: string | null;
    lastName?: string | null;
    bio?: string | null;
    timezone?: string | null;
    name?: string;
  }
) {
  await ensureSchema();
  const [updated] = await db
    .update(users)
    .set({
      ...data,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning();
  return updated;
}
