import { NextResponse, type NextRequest } from 'next/server';
import { readSessionToken, SESSION_COOKIE } from '@/lib/auth-edge';

/**
 * Send anonymous visitors to the sign-in page.
 *
 * This is a convenience, not the security boundary. It verifies the cookie's
 * signature -- which it can do at the edge -- but it cannot check whether the
 * session was revoked, because that is a row in PostgreSQL and there is no
 * database client in this runtime. Every page and every route therefore does its
 * own `requireUser()` / `requireUserId()` check, and would be safe even if this
 * file were deleted.
 *
 * It exists because without it, an unauthenticated visit to the dashboard would
 * render a page shell and then redirect, which looks broken.
 */

const PUBLIC_PATHS = ['/login', '/signup'];
const PUBLIC_PREFIXES = ['/api/auth/', '/api/profile/template'];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.includes(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const sessionId = token ? await readSessionToken(token) : null;
  if (sessionId) return NextResponse.next();

  // An API call gets a 401 it can display; a page gets the login screen with a
  // pointer back to where the user was going.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Sign in to continue.' }, { status: 401 });
  }

  const login = new URL('/login', request.url);
  if (pathname !== '/') login.searchParams.set('next', pathname + request.nextUrl.search);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except Next's own assets and the favicon.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|webp|txt|xml)$).*)'],
};
