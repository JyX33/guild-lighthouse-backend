// Securely access environment variables
const BATTLENET_CLIENT_ID = Deno.env.get('BATTLENET_CLIENT_ID');
const BATTLENET_CLIENT_SECRET = Deno.env.get('BATTLENET_CLIENT_SECRET');
const REDIRECT_URI = Deno.env.get('REDIRECT_URI');

if (!BATTLENET_CLIENT_ID || !BATTLENET_CLIENT_SECRET || !REDIRECT_URI) {
  console.error('Missing Battle.net OAuth environment variables.');
  // Depending on the function's purpose, you might want to throw an error or handle this differently
}

export const oauthConfig = {
  clientId: BATTLENET_CLIENT_ID,
  clientSecret: BATTLENET_CLIENT_SECRET,
  redirectUri: REDIRECT_URI,
  authorizationEndpoint: 'https://oauth.battle.net/authorize',
  tokenEndpoint: 'https://oauth.battle.net/token',
  userInfoEndpoint: 'https://oauth.battle.net/userinfo',
  scope: 'openid' // Basic scope for user info
};

// Utility function to generate a secure state parameter for CSRF protection
export function generateState(): string {
  // Generates a secure random state parameter for CSRF protection.
  // The calling function is responsible for storing this state (e.g., in a cookie).
  return crypto.randomUUID();
}

// Utility function to validate the state parameter
export function validateState(state: string, storedState: string): boolean {
  // Validates the state parameter received in the callback against the stored value.
  // This is a basic comparison; more robust validation might involve checking expiration or single-use.
  return state === storedState;
}

// Helper function for constructing OAuth URLs
export function buildAuthorizationUrl(state: string): URL {
  const url = new URL(oauthConfig.authorizationEndpoint);
  url.searchParams.set('client_id', oauthConfig.clientId || '');
  url.searchParams.set('redirect_uri', oauthConfig.redirectUri || '');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', oauthConfig.scope);
  url.searchParams.set('state', state);
  return url;
}

// Function to exchange the authorization code for tokens
export async function exchangeCodeForTokens(code: string): Promise<any> {
  const tokenResponse = await fetch(oauthConfig.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: oauthConfig.clientId || '',
      client_secret: oauthConfig.clientSecret || '',
      code: code,
      redirect_uri: oauthConfig.redirectUri || '',
      grant_type: 'authorization_code',
    }).toString(),
  });

  if (!tokenResponse.ok) {
    const errorData = await tokenResponse.json();
    console.error('Error exchanging code for tokens:', errorData);
    throw new Error(`Failed to exchange code: ${tokenResponse.status}`);
  }

  return tokenResponse.json();
}

// Function for fetching user info
export async function fetchUserInfo(accessToken: string): Promise<any> {
  const userInfoResponse = await fetch(oauthConfig.userInfoEndpoint, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
    },
  });

  if (!userInfoResponse.ok) {
    const errorData = await userInfoResponse.json();
    console.error('Error fetching user info:', errorData);
    throw new Error(`Failed to fetch user info: ${userInfoResponse.status}`);
  }

  return userInfoResponse.json();
}