import { setCookie } from "http/cookie.ts";
import { buildAuthorizationUrl } from "../_shared/battlenet.ts";
import { generateState } from "../_shared/config.ts"; // Assuming generateState remains in config.ts

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: Deno.env.get('ENV') === 'production',
  sameSite: "Lax",
  path: "/",
  maxAge: 60 * 10 // 10 minutes expiration
};

Deno.serve(async (req) => {
  try {
    // Validate environment variables
    const clientId = Deno.env.get("BATTLENET_CLIENT_ID");
    const redirectUri = Deno.env.get("BATTLENET_REDIRECT_URI");

    if (!clientId || !redirectUri) {
      return new Response(
        JSON.stringify({ error: "Missing Battle.net OAuth configuration" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // Generate secure state parameter
    const state = generateState();

    // Create response with redirect
    const response = new Response(null, {
      status: 302,
      headers: {
        Location: buildAuthorizationUrl({
          clientId,
          redirectUri,
          responseType: "code",
          state,
          scope: "openid"
        })
      }
    });

    // Set state cookie for verification during callback
    setCookie(response.headers, {
      name: "battlenet_auth_state",
      value: state,
      ...COOKIE_OPTIONS
    });

    return response;
  } catch (error) {
    console.error("Authorization redirect error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to initiate Battle.net authorization" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});