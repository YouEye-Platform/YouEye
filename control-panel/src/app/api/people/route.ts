/**
 * People API
 *
 * GET  /api/people - List Authentik users
 * POST /api/people - Create a new user
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { listUsers, createUser, listGroups, type AuthentikGroup } from '@/lib/authentik/client';

/** Usernames / types hidden by default */
const HIDDEN_USERNAMES = ['akadmin'];
const HIDDEN_TYPES = ['service_account', 'internal_service_account'];

let adminGroupCache: AuthentikGroup | null = null;

/** Resolve the "authentik Admins" group PK (cached) */
async function getAdminGroup(): Promise<AuthentikGroup | null> {
  if (adminGroupCache) return adminGroupCache;
  const groups = await listGroups({ search: 'authentik Admins', page_size: 5 });
  adminGroupCache = groups.results.find(g => g.name === 'authentik Admins') ?? null;
  return adminGroupCache;
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const showHidden = request.nextUrl.searchParams.get('showHidden') === 'true';
    const search = request.nextUrl.searchParams.get('search') || undefined;

    const data = await listUsers({ search, page_size: 200 });
    const adminGroup = await getAdminGroup();

    let users = data.results.map(u => ({
      pk: u.pk,
      username: u.username,
      name: u.name,
      email: u.email,
      isActive: u.is_active,
      isAdmin: adminGroup
        ? u.groups_obj?.some(g => g.name === 'authentik Admins') ?? false
        : u.is_superuser,
      type: u.type,
      lastLogin: u.last_login || null,
      hidden: HIDDEN_USERNAMES.includes(u.username) || HIDDEN_TYPES.includes(u.type),
    }));

    if (!showHidden) {
      users = users.filter(u => !u.hidden);
    }

    return NextResponse.json({ users, adminGroupPk: adminGroup?.pk ?? null });
  } catch (error) {
    console.error('Error listing users:', error);
    return NextResponse.json(
      { error: 'Failed to list users', details: error instanceof Error ? error.message : 'Unknown' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const csrf = request.headers.get('X-CSRF-Token');
    if (!csrf || !(await verifyCSRFToken(csrf))) {
      return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
    }

    const body = await request.json();
    const { username, name, email, password, isAdmin: makeAdmin } = body as {
      username: string;
      name: string;
      email?: string;
      password?: string;
      isAdmin?: boolean;
    };

    if (!username || !name) {
      return NextResponse.json({ error: 'Username and name are required' }, { status: 400 });
    }

    // Resolve admin group if making admin
    const groups: string[] = [];
    if (makeAdmin) {
      const adminGroup = await getAdminGroup();
      if (adminGroup) groups.push(adminGroup.pk);
    }

    const user = await createUser({ username, name, email, groups });

    // Set password if provided (don't fail the whole request if password-set fails)
    let passwordWarning: string | undefined;
    if (password) {
      try {
        const { setUserPassword } = await import('@/lib/authentik/client');
        await setUserPassword(user.pk, password);
      } catch (pwError) {
        console.error('Failed to set password for new user:', pwError);
        passwordWarning = pwError instanceof Error ? pwError.message : 'Failed to set password';
      }
    }

    return NextResponse.json({ user, success: true, passwordWarning });
  } catch (error) {
    console.error('Error creating user:', error);
    return NextResponse.json(
      { error: 'Failed to create user', details: error instanceof Error ? error.message : 'Unknown' },
      { status: 500 },
    );
  }
}
