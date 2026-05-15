/**
 * Authenticated API Client
 * 
 * Provides a fetch wrapper that automatically includes CSRF tokens
 * for all state-changing requests (POST, PUT, DELETE, PATCH).
 */

/**
 * Read CSRF token from cookie
 */
function getCSRFToken(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(/ye-csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Methods that require CSRF tokens
 */
const CSRF_REQUIRED_METHODS = ['POST', 'PUT', 'DELETE', 'PATCH'];

/**
 * Authenticated fetch wrapper that automatically includes CSRF tokens
 * 
 * @param url - The URL to fetch
 * @param options - Standard fetch options
 * @returns Promise<Response>
 */
export async function authenticatedFetch(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const method = (options.method || 'GET').toUpperCase();
  
  // Build headers
  const headers = new Headers(options.headers);
  
  // Add CSRF token for state-changing methods
  if (CSRF_REQUIRED_METHODS.includes(method)) {
    const csrfToken = getCSRFToken();
    if (csrfToken) {
      headers.set('X-CSRF-Token', csrfToken);
    }
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  return response;
}

/**
 * Authenticated fetch that returns parsed JSON
 * Throws on HTTP errors with the error message from response
 * 
 * @param url - The URL to fetch
 * @param options - Standard fetch options
 * @returns Promise<T> - Parsed JSON response
 */
export async function authenticatedJson<T = unknown>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await authenticatedFetch(url, options);
  
  const data = await response.json();
  
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  
  return data as T;
}
