import { createClient } from "@supabase/supabase-js";
import { oauthConfig } from "./config.ts";

// Initialize Supabase client
const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
);

export interface BattleNetTokens {
  access_token: string;
  refresh_token?: string; // Refresh token might not always be provided
  expires_in: number; // Time in seconds until access token expires
  timestamp: number; // Timestamp when tokens were received (for calculating expiration)
}

// Function to securely store tokens for a user in the database
export async function storeTokens(userId: string, tokens: BattleNetTokens): Promise<void> {
  const { data, error } = await supabase
    .from('user_tokens', { schema: 'game_data' }) // Explicitly use game_data schema
    .upsert({
      user_id: userId,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in,
      timestamp: new Date(tokens.timestamp).toISOString(), // Store timestamp as ISO string
    }, { onConflict: 'user_id' }); // Upsert based on user_id

  if (error) {
    console.error('Error storing tokens:', error);
    // TODO: Implement more robust error handling/logging
  } else {
    console.log(`Tokens stored for user ${userId}`);
  }
}

// Function to retrieve tokens for a user from the database
export async function getTokens(userId: string): Promise<BattleNetTokens | undefined> {
  const { data, error } = await supabase
    .from('user_tokens', { schema: 'game_data' }) // Explicitly use game_data schema
    .select('access_token, refresh_token, expires_in, timestamp')
    .eq('user_id', userId)
    .single();

  if (error && error.code !== 'PGRST116') { // PGRST116 is 'No rows found'
    console.error('Error retrieving tokens:', error);
    return undefined;
  }

  if (data) {
    console.log(`Tokens retrieved for user ${userId}`);
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || undefined,
      expires_in: data.expires_in,
      timestamp: new Date(data.timestamp).getTime(), // Convert ISO string back to timestamp
    };
  }

  console.warn(`No tokens found for user ${userId}`);
  return undefined;
}

// Function to check if an access token is expired or about to expire
export function isAccessTokenExpired(tokens: BattleNetTokens): boolean {
  const expirationTime = tokens.timestamp + tokens.expires_in * 1000; // expires_in is in seconds
  const currentTime = Date.now();
  // Consider refreshing if it expires within the next 5 minutes (300 seconds)
  const isExpired = currentTime >= expirationTime - 300 * 1000;
  if (isExpired) {
    console.log('Access token is expired or about to expire.');
  }
  return isExpired;
}

// Function to refresh an access token
export async function refreshAccessToken(userId: string, refreshToken: string): Promise<BattleNetTokens | undefined> {
  console.log(`Attempting to refresh token for user ${userId}`);
  try {
    const refreshResponse = await fetch(oauthConfig.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: oauthConfig.clientId || '',
        client_secret: oauthConfig.clientSecret || '',
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });

    if (!refreshResponse.ok) {
      const errorData = await refreshResponse.json();
      console.error('Error refreshing token:', errorData);
      // Graceful handling of refresh failures: clear tokens and indicate re-auth needed
      await logoutUser(userId); // Clear tokens on refresh failure
      return undefined;
    }

    const refreshedTokenData = await refreshResponse.json();
    const newTokens: BattleNetTokens = {
        access_token: refreshedTokenData.access_token,
        refresh_token: refreshedTokenData.refresh_token || refreshToken, // Use new refresh token if provided, otherwise keep old
        expires_in: refreshedTokenData.expires_in,
        timestamp: Date.now() // Update timestamp
    };

    // Update the stored tokens and expiration times
    await storeTokens(userId, newTokens);
    console.log(`Token refreshed successfully for user ${userId}`);
    return newTokens;

  } catch (error) {
    console.error('Exception during token refresh:', error);
    // Graceful handling of refresh failures: clear tokens and indicate re-auth needed
    await logoutUser(userId); // Clear tokens on refresh failure
    return undefined;
  }
}

// Function to get a valid access token, refreshing if necessary
export async function getValidAccessToken(userId: string): Promise<string | undefined> {
    const tokens = await getTokens(userId);

    if (!tokens) {
        console.warn(`No tokens found for user ${userId}. Cannot get valid access token.`);
        return undefined; // No tokens stored
    }

    if (isAccessTokenExpired(tokens)) {
        if (tokens.refresh_token) {
            console.log(`Access token expired for user ${userId}. Attempting refresh.`);
            const refreshedTokens = await refreshAccessToken(userId, tokens.refresh_token);
            if (refreshedTokens) {
                return refreshedTokens.access_token;
            } else {
                console.error(`Failed to refresh token for user ${userId}. Re-authentication required.`);
                // refreshAccessToken already handles clearing tokens on failure
                return undefined;
            }
        } else {
            console.error(`Access token expired for user ${userId}, no refresh token available. Re-authentication required.`);
            // No refresh token, clear existing tokens and indicate re-auth needed
            await logoutUser(userId);
            return undefined;
        }
    } else {
        console.log(`Access token is valid for user ${userId}.`);
        return tokens.access_token; // Access token is still valid
    }
}

// Function to log out a user by clearing their stored tokens
export async function logoutUser(userId: string): Promise<void> {
    const { error } = await supabase
        .from('user_tokens', { schema: 'game_data' }) // Explicitly use game_data schema
        .delete()
        .eq('user_id', userId);

    if (error) {
        console.error('Error logging out user (clearing tokens):', error);
        // TODO: Implement more robust error handling/logging
    } else {
        console.log(`User ${userId} logged out (tokens cleared from database).`);
    }
    // In a real app, you'd also handle Supabase session invalidation and potentially Battle.net token revocation
}