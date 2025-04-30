# Blizzard OAuth2 Authorization Code Flow Implementation

One of the first steps in our backend is enabling users to authenticate via Blizzard’s Battle.net OAuth2. This section details how to implement the **Authorization Code Flow** for Blizzard in a Supabase Edge Function. We will create an Edge Function called `oauth-flow` that handles the entire process: redirecting the user to Blizzard’s login/consent page, receiving the authorization code, exchanging it for an access token (and refresh token if provided), and securely storing the tokens along with the user’s Battle.net identity.

By the end of this guide, you will have:

- A working `oauth-flow` Edge Function in `supabase/functions/oauth-flow/index.ts`.
- Supabase secrets configured for your Blizzard OAuth **client_id** and **client_secret**.
- Secure handling of the OAuth flow, including state parameter verification (CSRF protection) and error handling for various failure scenarios.
- Logic to store the Blizzard user’s ID and BattleTag in the database (linking the Blizzard account to an internal user record).

## Overview of the OAuth2 Flow

Blizzard’s OAuth2 follows the standard Authorization Code grant type when you want to access user-specific data (like WoW profile information) ([WoW Guild Backend Plan_.pdf](file://file-LPSH3juMbB994ZgKbSPLTY#:~:text=Accessing%20user,delegated%20resources.2)). Here’s a high-level recap of how the flow works, tailored to our application:

1. **User Initiates Login:** On the frontend, the user clicks “Log in with Battle.net”. This will ultimately trigger our backend to start the OAuth flow.
2. **Redirect to Blizzard Authorization Endpoint:** The `oauth-flow` function will respond with a redirect to Blizzard’s OAuth2 authorization URL (`https://oauth.battle.net/authorize` for US, or region-specific base URL). We include query parameters:
   - `client_id` – Your application’s Client ID.
   - `redirect_uri` – The URL of our `oauth-flow` function (this must match a redirect URI registered in the Blizzard developer portal).
   - `response_type=code` – Asking for an authorization code.
   - `scope` – The permissions we want (for WoW profile data we need `wow.profile`; we can also request `openid` for basic user info).
   - `state` – A random string we generate to prevent CSRF. We’ll store it temporarily (e.g., in a cookie or in memory) to validate later.
3. **User Logs In and Grants Access:** Blizzard will prompt the user to log in (if not already) and show the consent screen with the scopes requested (e.g., permission to access their WoW profile). The user can authorize or cancel.
4. **Blizzard Redirects back with Code:** If authorized, Blizzard redirects the user’s browser to our `redirect_uri` (our function) with a `code` (authorization code) and the original `state` value in the query string.
5. **Our Function Exchanges Code for Token:** The `oauth-flow` function now handles the incoming request from Blizzard. It will:
   - Read the `code` and `state` from the query params.
   - Validate the `state` against what we previously stored to ensure it matches (protect against CSRF and unsolicited requests).
   - If state is valid, make a **POST** request to Blizzard’s token endpoint (`https://oauth.battle.net/token`). This request includes:
     - Authentication: HTTP Basic auth with our client_id and client_secret.
     - `grant_type=authorization_code`
     - `code` – the code from the query.
     - `redirect_uri` – same redirect URI (Blizzard requires it again for verification).
   - Blizzard responds with a JSON containing an `access_token`, `token_type`, `expires_in` (typically 86400 seconds = 24 hours) ([WoW Guild Backend Plan_.pdf](file://file-LPSH3juMbB994ZgKbSPLTY#:~:text=%E2%97%8B%20expires_in%3A%20The%20lifetime%20of,3)), and if configured, a `refresh_token` (Blizzard’s docs suggest refresh tokens may be provided, which can be used to get new access tokens without user login) ([WoW Guild Backend Plan_.pdf](file://file-LPSH3juMbB994ZgKbSPLTY#:~:text=%E2%97%8B%20,Verification%20during%20implementation%20is%20needed)).
6. **Store Tokens & User Info:** After obtaining the tokens, we call Blizzard’s **User Info endpoint** (`/oauth/userinfo`) with the access token ([WoW Guild Backend Plan_.pdf](file://file-LPSH3juMbB994ZgKbSPLTY#:~:text=3,the%20application%20calls%20%2Foauth%2Fuserinfo%20using)). This returns the user’s Battle.net account ID and BattleTag. We then store/update the user in our database:
   - If a user with that Battle.net ID already exists in our `users` table, update their `battletag` (in case it changed) and new token info.
   - If not, create a new `users` record with a new UUID, store the Battle.net ID, BattleTag, and tokens.
   - In both cases, we securely store the `access_token` and `refresh_token` (if any). **Important:** In a production scenario, encrypt these tokens before saving to the DB (for example, using a secret key with pgcrypto). We also save the token expiration time (current time + expires_in).
7. **Finalize Login:** At this point, the backend has linked the Blizzard account to an internal user record. The function can set a cookie or redirect the user to a frontend page indicating success. If using Supabase Auth for session management, alternatively, you might create a Supabase Auth user or issue a JWT. For simplicity, we might just redirect to a static “success” page or send a small HTML response asking the user to close the window and return to the app (since the actual session handling might be out of scope for this backend guide).

Throughout this flow, we must handle errors at each step (user denies access, state mismatch, network errors, invalid code, etc.) and respond appropriately.

## Implementing the `oauth-flow` Edge Function

Now, let’s write the code for the `supabase/functions/oauth-flow/index.ts`. We will use Deno/TypeScript. Supabase provides a Deno runtime; you write your function as an HTTP handler. We will use the native `fetch` API (available in Deno) to call Blizzard’s endpoints and some utility from Deno or simple functions to generate random state strings.

### **Step 1: Setting up the OAuth redirect**

When our function is invoked **without** a `code` (initial login attempt), we interpret that as a request to start the OAuth flow. We’ll generate a `state` value and redirect the user. We can store the `state` in a secure, HTTP-only cookie so that it returns to us on the redirect callback for verification.

```ts
// supabase/functions/oauth-flow/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const BLIZZARD_AUTH_URL = "https://oauth.battle.net/authorize";
const BLIZZARD_TOKEN_URL = "https://oauth.battle.net/token";

// Scopes for WoW profile access (openid gives BattleTag & ID, wow.profile gives game profile)
const OAUTH_SCOPES = "openid wow.profile";

// Helper to generate a random string for state (16 characters alphanumeric)
function generateState(length = 16) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

serve(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  // Load our config from environment
  const clientId = Deno.env.get("BLIZZARD_CLIENT_ID")!;
  const clientSecret = Deno.env.get("BLIZZARD_CLIENT_SECRET")!;
  const redirectUri = Deno.env.get("BLIZZARD_OAUTH_REDIRECT_URI")!;
  
  try {
    if (!code) {
      // Step 1: No code present, initiate auth request by redirecting to Blizzard
      const stateVal = generateState();
      // Set cookie for state (HTTP-only, short-lived)
      const headers = new Headers();
      headers.set("Set-Cookie", `oauth_state=${stateVal}; HttpOnly; Path=/; Max-Age=300`); // expires in 5 minutes
      const authUrl = `${BLIZZARD_AUTH_URL}?client_id=${encodeURIComponent(clientId)}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(OAUTH_SCOPES)}&state=${stateVal}`;
      headers.set("Location", authUrl);
      return new Response("Redirecting to Blizzard for authentication...", {
        status: 302,
        headers: headers
      });
    }

    // Step 2: We have been redirected back with a code (and possibly state)
    // Check state for CSRF protection
    const cookies = Object.fromEntries(
      req.headers.get("Cookie")?.split(";").map(c => {
        const [name, ...rest] = c.trim().split("=");
        return [name, rest.join("=")];
      }) || []
    );
    const storedState = cookies["oauth_state"];
    if (!state || !storedState || state !== storedState) {
      console.error("State mismatch or missing. Potential CSRF attack.");
      return new Response("Invalid state parameter. Authentication aborted.", { status: 400 });
    }

    // Exchange the authorization code for tokens
    const basicAuth = btoa(`${clientId}:${clientSecret}`);
    const tokenResponse = await fetch(BLIZZARD_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Basic ${basicAuth}`
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        redirect_uri: redirectUri
      })
    });

    if (!tokenResponse.ok) {
      const errorBody = await tokenResponse.text();
      console.error("Token exchange failed:", tokenResponse.status, errorBody);
      return new Response("Failed to exchange authorization code for token.", { status: 500 });
    }

    const tokenData = await tokenResponse.json();
    const accessToken: string = tokenData.access_token;
    const refreshToken: string | undefined = tokenData.refresh_token;
    const expiresIn: number = tokenData.expires_in;
    // token_type is usually "bearer"

    // Step 3: Fetch user info (BattleTag and ID)
    const userInfoResp = await fetch("https://oauth.battle.net/oauth/userinfo", {
      headers: {
        "Authorization": `Bearer ${accessToken}`
      }
    });
    if (!userInfoResp.ok) {
      console.error("Failed to fetch user info:", userInfoResp.status);
      return new Response("Failed to retrieve user information.", { status: 500 });
    }
    const userInfo = await userInfoResp.json();
    const battleTag: string = userInfo.battletag;
    const battleNetId: number = userInfo.id;  // numeric ID

    // Step 4: Store/Update user in the database
    // We'll use Supabase client to upsert the user. The service role key must be available.
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, serviceRoleKey);  // using supabase-js client
    // Upsert the user (if battlenet_id exists, update; otherwise insert)
    const { error } = await adminClient.from("users").upsert({
      battlenet_id: battleNetId,
      battletag: battleTag,
      access_token: accessToken,       // In production, encrypt this before storing
      refresh_token: refreshToken || null,
      token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString()
    }, { onConflict: "battlenet_id" });
    if (error) {
      console.error("DB upsert error:", error.message);
      return new Response("Database error while saving user data.", { status: 500 });
    }

    // Step 5: Finish - respond to the client
    // At this point, the user is authenticated. We might want to create a session.
    // For simplicity, we'll just return a message or HTML that the login succeeded.
    const responseHtml = `<html><body><script>
      // Notify parent window or application of success
      window.close();
      </script>
      <p>Login successful! You can close this window.</p></body></html>`;
    return new Response(responseHtml, {
      headers: { "Content-Type": "text/html" }
    });
  } catch (err) {
    console.error("Unexpected error in OAuth flow:", err);
    return new Response("Internal Server Error during OAuth process.", { status: 500 });
  }
});
```

Let’s break down key parts of the above code:

- We import `serve` from Deno’s standard library to create our HTTP server function. The function runs for every request to the `oauth-flow` endpoint.
- **Environment Variables:** We retrieve `BLIZZARD_CLIENT_ID`, `BLIZZARD_CLIENT_SECRET`, and `BLIZZARD_OAUTH_REDIRECT_URI` from `Deno.env`. These should be configured in Supabase (we set them in our `.env` for local and via `supabase secrets` in production).
- **State Generation:** We use a simple helper `generateState()` to create a random string for the OAuth `state`. This helps mitigate CSRF.
- **Initial Request Handling:** If `code` is not present, we assume this is the start of auth. We generate a state, set it in a cookie (`Set-Cookie: oauth_state=<state>` with HttpOnly so client JS can’t read it). We then construct the Blizzard auth URL with required params and respond with HTTP 302 redirect to that URL.
  - We encode the redirect URI and scopes properly. We limit the cookie lifespan (Max-Age=300 seconds, i.e., 5 minutes) to mitigate reuse.
- **Callback Handling:** If `code` is present, we:
  - Parse cookies from the request to retrieve our stored `oauth_state`.
  - Compare the state query param with our stored state. If they don’t match or missing, we abort with 400 (Bad Request) ([WoW Guild Backend Plan_.pdf](file://file-LPSH3juMbB994ZgKbSPLTY#:~:text=%E2%97%8F%20Token%20Validation%20and%20Expiration%3A,must%20handle%20token%20expiration%20and)).
  - Then proceed to exchange the code for a token by calling Blizzard’s token endpoint. We use `fetch` with method POST. Note the use of Basic auth header: Blizzard requires HTTP Basic authentication with client_id and secret. We encode that with `btoa` (binary-to-ASCII, to get Base64).
  - We send `grant_type=authorization_code` and the code & redirect in the body as URL-encoded form. If Blizzard responds with not OK, we log and return 500.
  - On success, we parse JSON to get the tokens and expiry.
- **User Info:** Using the access token, we call Blizzard’s `/oauth/userinfo`. This requires the `openid` scope. It returns the user’s `id` (their unique account ID) and `battletag`. We check for success, and parse JSON.
- **Database Upsert:** We then use the Supabase JS client (`createClient`) to upsert into our `users` table. This requires the service role key (supplied via env var) for authorization. We upsert by `battlenet_id` – if the user exists, it will update their battletag and token; if not, it will insert a new record. We set `token_expires_at` to current time + expiresIn. (Note: we directly store the token here for clarity. In a real app, **encrypt** this value.)
  - Ensure you have imported or have access to `createClient` from `@supabase/supabase-js` in this file. Since Deno can import from URLs, you might add `import { createClient } from "https://esm.sh/@supabase/supabase-js@2";` at the top. (This uses ESM.sh to provide a Deno-compatible build of the supabase-js library).
- **Completion:** After saving to DB, we respond to the user. In a real single-page app, you might redirect back to your front-end with a session token or simply close the popup. In our example, we returned a small HTML/JS snippet that just closes the window. Adjust this to fit your application’s flow (for instance, you could redirect to a deep link in your app or set a cookie with a session JWT if you implemented that).

**Error Handling:**

- If the user denies the OAuth request, Blizzard will redirect back with an `error` parameter instead of `code`. Our function above doesn’t explicitly check for `error` param – we should handle that. For completeness, we could add:

  ```ts
  const errorParam = url.searchParams.get("error");
  if (errorParam) {
    return new Response(`Authentication error: ${errorParam}`, { status: 400 });
  }
  ```

  right after obtaining the URL in the serve handler. This would catch scenarios like the user canceling login.
- Network errors or exceptions are caught by the try/catch, returning a 500.
- We logged to `console.error` for debugging; in production, consider routing these to an observability tool or at least ensuring they are not exposed to the client.

**CSRF Protection (State):** We used the classic state approach with an HttpOnly cookie. Another approach could be to store the state server-side (e.g., in a temporary table or in-memory cache). Using a short-lived cookie is simpler in a serverless environment where we might not have a persistent session store. The HttpOnly flag means JavaScript on the client cannot read it, reducing risk if your frontend is compromised. The comparison ensures the request is legit.

## Configuring Supabase Secrets

As mentioned, for the above code to work, we need `BLIZZARD_CLIENT_ID` and `BLIZZARD_CLIENT_SECRET` in the environment:

- In development, ensure your `supabase/.env` has these and that you run `supabase functions serve` with `--env-file` or have them exported in your shell.
- In production (Supabase cloud), run `supabase secrets set BLIZZARD_CLIENT_ID="..."`
  and similarly for the secret. Also set `BLIZZARD_OAUTH_REDIRECT_URI` if it’s not something you can derive (you might derive it from `req.headers.host` in code, but having it fixed is safer to avoid mismatches).

Additionally, the function needs the `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_URL` for database access. Supabase automatically provides those to the function environment:

- `SUPABASE_URL` is your project’s URL (e.g., `https://xyzcompany.supabase.co`).
- `SUPABASE_SERVICE_ROLE_KEY` is a secret API key with full database access. In Supabase Cloud it’s pre-set. Locally, the CLI sets a placeholder. We included these in `.env.example` for completeness.

Double-check that in your Supabase project settings, the `users` table is set to allow the service role to insert (service role bypasses Row Level Security by default). If you have RLS enabled on the users table, our approach with service key will still work (service key ignores RLS), but if you ever use anon key, you’d need RLS policies.

## Testing the OAuth Flow

1. **Deploy the Function:** If you haven’t already, deploy the `oauth-flow` function:

   ```powershell
   PS> supabase functions deploy oauth-flow --env-file supabase/.env
   ```

   This builds and deploys it to your local dev stack (or to the cloud if you’ve linked to a cloud project). The CLI will output the URL for the function.

2. **Initiate Login:** Open a browser (or use curl for testing) to call the function’s URL. For example, `http://localhost:54321/functions/v1/oauth-flow`. You should be redirected to `oauth.battle.net/authorize` with your client_id and scopes. Log in to Blizzard and authorize the app.

3. **Callback Handling:** After authorizing, Blizzard will redirect back to your function. If running locally via `supabase start`, the redirect will go to the deployed URL (which might not be accessible publicly). For local testing, a trick is to use `supabase functions serve` on a public network or use an HTTPS tunneling service:
   - Alternatively, temporarily set your Blizzard OAuth redirect to something like `https://example.com` just to get the code, and then manually call your local function URL with that code and state. (This is cumbersome – using a deployed function or tunneling is easier.)

   Ideally, test this flow on a deployed Supabase instance: once deployed, update the Blizzard redirect URI to the Supabase function URL (which is HTTPS and public) and perform the flow.

4. **Verify DB Entry:** After successful login, check the `users` table in your database. There should be a new row with the user’s battlenet_id, battletag, and tokens. The tokens should be valid (you can use them to call Blizzard APIs for ~24h). Ensure that sensitive fields like `access_token` are not exposed to any client directly.

5. **Error Tests:** Try triggering some error scenarios:
   - Go to the Blizzard auth screen and click “Deny” instead of allow – the function should handle the `error=access_denied`.
   - Tamper with the `state` (if you intercept the redirect URL, change the state value) to ensure the function detects the mismatch and rejects the request.

If all is working, you have a fully functioning OAuth login integration with Blizzard! The next step is to use that access token to retrieve the actual WoW data (characters, guilds) for the user, which we’ll cover in the data access section.

## Security Considerations

- **Token Security:** As emphasized, never leak the `access_token` or `refresh_token` to the client-side. All Blizzard API calls should be made server-side using these tokens. If you need to perform actions on behalf of the user from a client (like a frontend), your backend should provide an interface (like additional functions or RPC endpoints) that internally use the tokens.
- **Token Refresh:** Blizzard’s access tokens expire after 24 hours ([WoW Guild Backend Plan_.pdf](file://file-LPSH3juMbB994ZgKbSPLTY#:~:text=%E2%97%8F%20Token%20Validation%20and%20Expiration%3A,must%20handle%20token%20expiration%20and)). The code above stores `refresh_token` if provided. Implement a strategy (perhaps via a cron job or on-demand) to use the refresh token to get a new access token before expiry, updating the DB. Blizzard’s token endpoint can also accept `grant_type=refresh_token`. Ensure to handle the case where the refresh token itself expires or is revoked (user revokes app access).
- **State Storage:** We used cookies for simplicity. If this were a more complex environment with multiple instances of the function, a more robust state storage (like storing in the database keyed by a temporary session ID) might be used. However, because our redirect URI is an Edge Function (stateless by nature), the cookie approach is acceptable for this scenario.
- **Scopes:** We requested `openid wow.profile`. If you need additional scopes (say, for other Blizzard games or detailed info), include them in the scope string. The user will see each scope in the consent screen. Only request what you need.
- **Blizzard Account Requirements:** Blizzard may require that your Developer Account has Two-Factor Authentication (2FA) enabled to create API clients. Ensure you’ve done that, or the token request might fail.

With OAuth in place, proceed to fetching game data using the access tokens. The next document, **Blizzard API Data Access**, will outline how to use Blizzard’s Game Data and Profile APIs to populate our database with relevant information.
