import { createClient } from "@supabase/supabase-js";
import { getCookies, setCookie } from "http/cookie.ts";
import { exchangeCodeForTokens, fetchUserInfo, validateState } from "../_shared/config.ts"; // Import new functions
import { storeTokens } from "../_shared/tokenManagement.ts"; // Import storeTokens

Deno.serve(async (req: Request) => {
  const headers = new Headers();
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    if (!code || !state) {
      return new Response(
        JSON.stringify({ error: 'Missing authorization code or state parameter.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Verify the state parameter against the stored cookie value
    const cookies = getCookies(req.headers);
    const storedState = cookies['battlenet_auth_state'];

    // Clear the state cookie immediately after retrieving it
    setCookie(headers, {
      name: 'battlenet_auth_state',
      value: '',
      path: '/',
      maxAge: 0, // Expire the cookie immediately
    });

    if (!validateState(state, storedState)) {
      return new Response(
        JSON.stringify({ error: 'Invalid state parameter.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Exchange the authorization code for tokens using the utility function
    const tokenData = await exchangeCodeForTokens(code);
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;
    const expiresIn = tokenData.expires_in;

    // Use the access token to fetch user information using the utility function
    const userInfo = await fetchUserInfo(accessToken);
    console.log('Battle.net User Info:', userInfo);

    // Parse and validate the user information response
    const battleNetId = userInfo.id;
    const battleTag = userInfo.battletag; // Assuming battletag is available
    const email = userInfo.email; // Assuming email is available

    if (!battleNetId) {
        return new Response(
            JSON.stringify({ error: 'Battle.net user ID not found in user info.' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }

    const supabase = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    let userId: string;

    // 3. Implement Auth User Linking
    // Check if a user with this Battle.net ID exists in game_data.users
    const { data: existingUsers, error: fetchError } = await supabase
        .from('users', { schema: 'game_data' }) // Explicitly use game_data schema
        .select('id, username')
        .eq('battlenet_id', battleNetId);

    if (fetchError) {
        console.error('Database error while checking user existence:', fetchError);
        return new Response(
            JSON.stringify({ error: `Database error during user lookup: ${fetchError.message}` }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }

    if (existingUsers && existingUsers.length > 0) {
      // User exists, use their existing Supabase user ID
      userId = existingUsers[0].id;
      console.log('Existing user found:', userId);

      // Optionally update user information in game_data.users
      const { error: updateError } = await supabase
        .from('users', { schema: 'game_data' }) // Explicitly use game_data schema
        .update({ username: battleTag, updated_at: new Date() })
        .eq('id', userId);

      if (updateError) {
        console.error('Error updating user in database:', updateError);
        // Log the error but don't necessarily fail the auth flow
      }

    } else {
      // User does not exist, create a new Supabase auth user and link it
      console.log('New Battle.net user. Creating Supabase auth user.');

      // Create a new user in Supabase auth.users
      // Note: Using service role key to bypass RLS and create user directly
      const { data: authUserData, error: authError } = await supabase.auth.admin.createUser({
        email: email || `${battleNetId}@battlenet.example.com`, // Use Battle.net email or a placeholder
        email_confirm: true, // Optional: confirm email automatically
        user_metadata: {
            battlenet_id: battleNetId,
            battletag: battleTag,
        }
      });

      if (authError) {
        console.error('Error creating Supabase auth user:', authError);
        return new Response(
            JSON.stringify({ error: `Failed to create Supabase auth user: ${authError.message}` }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }

      userId = authUserData.user.id;
      console.log('New Supabase auth user created:', userId);

      // Create a corresponding record in game_data.users
      const { error: insertUserError } = await supabase
        .from('users', { schema: 'game_data' }) // Explicitly use game_data schema
        .insert([
          {
            id: userId, // Link to the Supabase auth user ID
            battlenet_id: battleNetId,
            username: battleTag,
            email: email || `${battleNetId}@battlenet.example.com`, // Use Battle.net email or a placeholder
          }
        ]);

      if (insertUserError) {
        console.error('Error inserting new user into game_data.users:', insertUserError);
        // TODO: Handle potential conflicts if user was created in auth but not game_data.users
        return new Response(
            JSON.stringify({ error: `Database error while creating user record: ${insertUserError.message}` }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
      console.log('New user record created in game_data.users:', userId);
    }

    // Store the Battle.net tokens securely linked to the user ID
    await storeTokens(userId, {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: expiresIn,
        timestamp: Date.now(),
    });
    console.log('Battle.net tokens stored for user:', userId);

    // Redirect to a success page or return a success response
    // For now, returning a JSON response with user info and status
    return new Response(
      JSON.stringify({ message: 'OAuth successful. User processed.', userId: userId, userInfo: userInfo }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error handling Battle.net OAuth callback:', error);
    // Refined error handling
    let errorMessage = 'Internal Server Error';
    let statusCode = 500;

    if (error instanceof Error) {
        errorMessage = `OAuth callback error: ${error.message}`;
        // You could add more specific error type checking here if needed
    } else if (typeof error === 'object' && error !== null && 'message' in error) {
         errorMessage = `OAuth callback error: ${error.message}`;
    }


    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: statusCode, headers: { 'Content-Type': 'application/json' } }
    );
  }
});