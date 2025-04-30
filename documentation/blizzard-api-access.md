# Blizzard API Data Access and Sync

Now that we have users authenticating and storing their Blizzard access tokens, we can utilize those tokens to fetch World of Warcraft data. This document details how to create Edge Functions to retrieve both **static game data** (which changes infrequently, like class or realm lists) and **dynamic profile data** (like a player’s characters and guild memberships). We will also design the database schemas for storing this data and discuss how to keep it in sync, potentially using scheduled jobs (`pg_cron`) and the message queue (`pgmq`) for efficient, rate-limited processing.

## Static Game Data Synchronization

**Static game data** includes information that is the same for all users and generally updates only when the game itself updates (e.g., new expansion or patch). Examples in WoW:

- **Character Classes** (e.g., Warrior, Mage, etc. along with their IDs).
- **Races** (e.g., Orc, Human, etc. and their IDs/faction).
- **Realms** (server realms list, their slugs, region, etc.).

We will create an Edge Function `sync-static-data` that fetches all classes, races, and realms via Blizzard’s **Game Data APIs** and stores them in our database. This function might be run manually whenever needed or scheduled (say, monthly) via `pg_cron`.

### Schema for Static Data

First, let’s define database tables for these static datasets. We create a new migration (if not done already) for static data schema:

```sql
-- supabase/migrations/20250428123000_static_data_schema.sql

-- Table for WoW Playable Classes
CREATE TABLE public.wow_classes (
    id INT PRIMARY KEY,       -- class ID from Blizzard API
    name TEXT NOT NULL,       -- Localized name (we'll store English name for simplicity)
    icon TEXT                 -- (Optional) maybe store an icon URL or identifier if needed
);

-- Table for WoW Playable Races
CREATE TABLE public.wow_races (
    id INT PRIMARY KEY,       -- race ID from Blizzard API
    name TEXT NOT NULL,
    faction TEXT              -- "Alliance" or "Horde" (from API data, if available)
);

-- Table for WoW Realms
CREATE TABLE public.wow_realms (
    id INT PRIMARY KEY,       -- realm ID from API
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    region TEXT NOT NULL,     -- e.g., "us", "eu"
    timezone TEXT,            -- (Optional) timezone or locale info if needed
    category TEXT             -- (Optional) realm category (like type or region name)
);
```

We use natural primary keys (Blizzard’s IDs) for classes, races, and realms since those are stable identifiers defined by Blizzard. These tables will be referenced by our `characters` and `guilds` tables to normalize data (e.g., `characters.class_id -> wow_classes.id`). We might also use realm data to link guilds and characters to their realm records via `realm_slug` and `region` or directly by `realm id` if Blizzard’s data uses numeric IDs (Blizzard’s Realm APIs use both slug and an ID/connected-realm concept ([battle-net-game-data-api-structures.md](file://file-KBDYDdNxWbiWUBKFcZETdh#:~:text=,string)) ([battle-net-game-data-api-structures.md](file://file-KBDYDdNxWbiWUBKFcZETdh#:~:text=,string)); we’ll use `id` as primary key for simplicity).

Make sure to run the migration or include it in your initial schema if doing fresh setup. After running, the tables `wow_classes`, `wow_races`, and `wow_realms` are empty, ready to be populated.

### Edge Function: `sync-static-data`

We will implement `supabase/functions/sync-static-data/index.ts` to fetch data from Blizzard and insert/update our tables. This function can use the **Client Credentials** flow to get an application-level token, since static data doesn’t require a user context. (The Blizzard Game Data API allows either a user token or a client token for most endpoints – client token is easier here).

**Steps in `sync-static-data`:**

1. **Get an OAuth Token (Client Credentials):** We will request a client access token by POSTing to Blizzard’s token endpoint with `grant_type=client_credentials`. This returns an access_token that typically lasts for 24 hours, with scopes applicable to game data.
2. **Fetch Class Index:** Call the **Playable Classes Index** endpoint: `GET https://us.api.blizzard.com/data/wow/playable-class/index?namespace=static-us&locale=en_US&access_token={token}` (for US region, adjust if needed). This returns a list of classes with their IDs and names ([battle-net-game-data-api-structures.md](file://file-KBDYDdNxWbiWUBKFcZETdh#:~:text=%60%60%60json%20%7B%20,Array%20of%20object)) ([battle-net-game-data-api-structures.md](file://file-KBDYDdNxWbiWUBKFcZETdh#:~:text=%7D%2C%20,string)).
3. **Fetch Race Index:** Similar: `GET /data/wow/playable-race/index?namespace=static-us&locale=en_US&access_token=...`. This returns a list of races (with IDs, names, faction info, etc.).
4. **Fetch Realm Index:** `GET /data/wow/realm/index?namespace=dynamic-us&locale=en_US&access_token=...` (Note: Blizzard’s realms are in the “dynamic” namespace because they can change status). This returns all realms in the region with their IDs, names, and slug ([battle-net-game-data-api-structures.md](file://file-KBDYDdNxWbiWUBKFcZETdh#:~:text=,string)) ([battle-net-game-data-api-structures.md](file://file-KBDYDdNxWbiWUBKFcZETdh#:~:text=,)).
5. **Upsert into Database:** For each dataset, upsert the records into `wow_classes`, `wow_races`, `wow_realms` tables. We’ll use Supabase client or direct SQL.
6. **Return a summary:** The function can return how many records were updated for logging or UI purposes.

Let’s write this function code. We’ll reuse the environment for client credentials (we use the same BLIZZARD_CLIENT_ID/SECRET). We’ll also use the `createClient` from supabase-js for database access, or we can directly use `pg` via a connection string. Using supabase-js is straightforward.

```ts
// supabase/functions/sync-static-data/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BLIZZARD_TOKEN_URL = "https://oauth.battle.net/token";
const API_BASE_URL_US = "https://us.api.blizzard.com";  // assuming US region for static data
const NAMESPACE_STATIC = "static-us";
const NAMESPACE_DYNAMIC = "dynamic-us";
const LOCALE = Deno.env.get("BLIZZARD_API_LOCALE") || "en_US";

serve(async (_req: Request) => {
  const clientId = Deno.env.get("BLIZZARD_CLIENT_ID")!;
  const clientSecret = Deno.env.get("BLIZZARD_CLIENT_SECRET")!;
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(supabaseUrl, serviceRoleKey);

  try {
    // 1. Get client credentials token
    const tokenRes = await fetch(BLIZZARD_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials"
      }),
      // Use basic auth as well
      // Deno's fetch can also accept user:password in the URL or use Authorization header
      headers: {
        "Authorization": "Basic " + btoa(`${clientId}:${clientSecret}`),
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });
    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error("Client token request failed:", errText);
      return new Response("Failed to obtain client token", { status: 500 });
    }
    const tokenData = await tokenRes.json();
    const appAccessToken = tokenData.access_token;
    
    // 2. Fetch Playable Classes
    const classesRes = await fetch(`${API_BASE_URL_US}/data/wow/playable-class/index?namespace=${NAMESPACE_STATIC}&locale=${LOCALE}&access_token=${appAccessToken}`);
    if (!classesRes.ok) {
      console.error("Failed to fetch classes:", classesRes.status);
      return new Response("Failed to fetch classes data", { status: 502 });
    }
    const classesData = await classesRes.json();
    const classesArray = classesData.classes || [];
    
    // Prepare class rows for upsert
    const classRows = classesArray.map((cls: any) => ({
      id: cls.id,
      name: cls.name?.en_US || cls.name || null
    }));
    
    // 3. Fetch Playable Races
    const racesRes = await fetch(`${API_BASE_URL_US}/data/wow/playable-race/index?namespace=${NAMESPACE_STATIC}&locale=${LOCALE}&access_token=${appAccessToken}`);
    if (!racesRes.ok) {
      console.error("Failed to fetch races:", racesRes.status);
      return new Response("Failed to fetch races data", { status: 502 });
    }
    const racesData = await racesRes.json();
    const racesArray = racesData.races || [];
    const raceRows = racesArray.map((race: any) => ({
      id: race.id,
      name: race.name?.en_US || race.name || null,
      faction: race.faction ? (race.faction.name?.en_US || race.faction.name) : null
    }));
    
    // 4. Fetch Realms
    const realmsRes = await fetch(`${API_BASE_URL_US}/data/wow/realm/index?namespace=${NAMESPACE_DYNAMIC}&locale=${LOCALE}&access_token=${appAccessToken}`);
    if (!realmsRes.ok) {
      console.error("Failed to fetch realms:", realmsRes.status);
      return new Response("Failed to fetch realms data", { status: 502 });
    }
    const realmsData = await realmsRes.json();
    const realmsArray = realmsData.realms || [];
    const realmRows = realmsArray.map((realm: any) => ({
      id: realm.id,
      name: realm.name?.en_US || realm.name || null,
      slug: realm.slug,
      region: "us"  // Since we used US API. For multi-region support, you'd loop regions.
    }));
    
    // 5. Upsert into database using supabase client
    // Upsert classes
    let { error } = await sb.from("wow_classes").upsert(classRows);
    if (error) {
      throw new Error(`DB upsert error (classes): ${error.message}`);
    }
    // Upsert races
    ({ error } = await sb.from("wow_races").upsert(raceRows));
    if (error) {
      throw new Error(`DB upsert error (races): ${error.message}`);
    }
    // Upsert realms
    ({ error } = await sb.from("wow_realms").upsert(realmRows));
    if (error) {
      throw new Error(`DB upsert error (realms): ${error.message}`);
    }
    
    const resultMsg = `Static data sync complete. Classes: ${classRows.length}, Races: ${raceRows.length}, Realms: ${realmRows.length} updated.`;
    console.log(resultMsg);
    return new Response(resultMsg, { status: 200 });
  } catch (err) {
    console.error("Error in sync-static-data:", err);
    return new Response("Internal error during static data sync.", { status: 500 });
  }
});
```

A few notes on the above:

- We assumed a single region (US) for static data. If your app needs EU or others, you could run this function for each region by changing `API_BASE_URL` and namespace (e.g., `EU` region base URL and `namespace=static-eu`). Alternatively, loop over a list of regions.
- We used `locale=en_US` for all to get English names. This could be made configurable.
- After fetching, we map the results to our table schemas:
  - Classes: each item has an `id` and `name` object with localized names. We take the English name.
  - Races: similar structure, plus a `faction` field which in Blizzard’s data is an object containing name. We extract faction name (Alliance/Horde).
  - Realms: each realm has `id`, `slug`, `name` (localized), and also a `region` reference in the detailed data. But the index already partitions by region via endpoint. We just tag them with "us" here since we know we fetched US. For multi-region, you’d incorporate the region code accordingly.
- We used the supabase client’s `upsert` method. This will insert new rows or update existing rows matching the primary key. Because we set the primary keys as the Blizzard IDs, this effectively refreshes the data. Alternatively, we could delete all rows and reinsert, but upsert is fine.
- We log and also return a summary string. In a production scenario, this could return JSON or just a 204 No Content with logs. But for debugging, a message is helpful.
- The function obtains its own app-level token each time it runs. This is okay for a function run occasionally. If worried about efficiency, one could cache the token in a KV store or global variable (Deno functions might not persist between calls, so caching is limited).
- We included error handling for each fetch to return a 502 Bad Gateway if Blizzard’s API call fails (502 to indicate upstream fetch error).

### Running the Static Data Sync

- **Manual Trigger:** You can manually call this function from an HTTP request or via Supabase UI. For example, `curl -X POST https://<project>.functions.supabase.co/sync-static-data` (or GET, since we handle both similarly here). Ensure you have the client ID/secret configured.
- **Scheduled Trigger:** To automate it, use `pg_cron`. For instance, to run this function monthly, you could set up a cron job that calls the function’s HTTP endpoint. However, `pg_cron` runs inside the database – it can call SQL functions, not external HTTP directly (unless using `pg_net` extension, which we decided against for reliability ([WoW Guild Backend Plan_.pdf](file://file-LPSH3juMbB994ZgKbSPLTY#:~:text=processing%20logic%20,pgmq)) ([WoW Guild Backend Plan_.pdf](file://file-LPSH3juMbB994ZgKbSPLTY#:~:text=within%20the%20cron%20command%20is,pgmq))).
  
  A simpler approach: schedule a cron job that inserts a row into a “tasks” table which a trigger function picks up. But an easier method might be outside Supabase’s current scope – you could use a separate scheduler or GitHub Actions to hit the endpoint. Supabase might introduce scheduled functions in the future. For now, consider running `sync-static-data` manually after major patches or use an external scheduler.

- **On Project Init:** You might run this once after deploying the backend so that classes, races, realms are populated before any user actions. That ensures when profile data comes in referencing a class_id, the class exists in our table.

## Profile Data Fetching (Characters and Guilds)

With static data in place, we can fetch **profile data** for users. Profile data is specific to each user’s WoW account:

- List of WoW characters on the user’s account (with details like level, class, etc.).
- Each character’s guild membership (guild name, etc.), if any.
- Potentially other info like collections, achievements (out of scope for now).

We will create an Edge Function `fetch-profile` that, given a user (identified by their JWT or by a user id passed in), will retrieve that user’s characters and guild info from Blizzard and update our `characters` and `guilds` tables (and possibly the relationship between them).

There are a couple of approaches:

1. **On-demand fetch:** Call `fetch-profile` whenever a user logs in or views their profile to refresh their data.
2. **On login via OAuth:** We could embed this logic at the end of the OAuth flow. For example, after storing the user, immediately fetch their characters. This ensures the first time they log in, their characters are fetched without an extra step. (One might do this asynchronously via queue to not slow the login response.)
3. **Scheduled sync:** Use `pg_cron` to periodically refresh data for all users (or active users). The plan might be to update daily for active users ([WoW Guild Backend Plan_.pdf](file://file-LPSH3juMbB994ZgKbSPLTY#:~:text=frequencies%20based%20on%20data%20volatility,to%20recently%20active%20users%20or)).

For now, we’ll implement `fetch-profile` as a function that handles one user at a time. We can invoke it after OAuth (option 2) or via separate calls.

### Blizzard Profile APIs

Blizzard’s WoW Profile API includes endpoints such as:

- **Character Profile Summary:** `/profile/wow/character/{realmSlug}/{characterName}` – requires the `wow.profile` scope and the character must belong to the authenticated user’s account. Returns character info (level, guild, etc.) ([WoW Guild Backend Plan_.pdf](file://file-LPSH3juMbB994ZgKbSPLTY#:~:text=%E2%97%8F%20Character%20Data%3A%20For%20characters,characterName%7D.4)).
- **Account Profile Summary:** `/profile/user/wow` – returns a summary of the user’s WoW account, including a list of WoW accounts and characters on them ([battle-net-api-structures.md](file://file-7ZSnpn95xXNPGBwUjQSt64#:~:text=Account%20Profile%20Summary)) ([battle-net-api-structures.md](file://file-7ZSnpn95xXNPGBwUjQSt64#:~:text=,)). This is a good starting point to get all characters without calling each explicitly by name.
- **Guild API:** There are game data endpoints for guild info and guild roster, e.g. `/data/wow/guild/{realmSlug}/{guildName}/roster`. However, these might not require user auth if the guild is public. The plan suggests using those for guild roster sync ([WoW Guild Backend Plan_.pdf](file://file-LPSH3juMbB994ZgKbSPLTY#:~:text=%E2%97%8F%20Guild%20Rosters%3A%20This%20is,containing%20characters%20linked%20to%20registered)). For our immediate need (ensuring guild exists in our DB when a user’s character is in that guild), we can get guild info from the character profile (it usually includes guild name and maybe guild ID or an href).
  
To keep it simple:

- We’ll call **Account Profile Summary** to get all characters.
- For each character, call **Character Profile** to get details (this may include guild info).
- Alternatively, the Account Profile might already list basic details for each character (level, etc.). If sufficient, we can use that to avoid per-character calls. The `wow_accounts` array in Account Profile lists characters with `name`, `id`, `realm` and a key URL ([battle-net-api-structures.md](file://file-7ZSnpn95xXNPGBwUjQSt64#:~:text=,string)) ([battle-net-api-structures.md](file://file-7ZSnpn95xXNPGBwUjQSt64#:~:text=,string)). Possibly we can use those URLs (the `protected_character` link) for detailed info if needed.

Because calling each character’s endpoint could be heavy if someone has many characters, consider the number of characters:
An account could easily have 50+ characters (multiple realms). However, not all are important – maybe the user only cares about some. But to be thorough, we sync all.

Let’s implement with Account Profile to get list, then maybe one call per character for details if needed for guild. We will also upsert guild info and character info to DB:

- If a character is in a guild, upsert the guild in `guilds` table (with name, realm).
- Upsert character: link to user_id (the user in question), set guild_id (if any), level, class_id, race_id, etc.
- Remove or mark characters that the user no longer has? Perhaps if a character was in DB but not returned now, it means they were deleted or transferred. We might handle that by either deleting those or marking them. For now, we can choose to remove characters that belong to that user_id that were not in this fetch (to keep things in sync).

However, deletion can be dangerous if we have references. But since it’s user’s own characters, likely safe to remove if not present. Alternatively, mark as `deleted=true`.

For simplicity, we can remove them. Or skip deletion logic in initial implementation.

We should be careful not to remove characters that were discovered via guild roster sync that belong to other users. But if user deletes a char, and we only get data of their own, that char would still appear in guild roster possibly. This gets complex; perhaps avoid deletion unless confident.

We can at least update existing or insert new. Not removing might leave stale data, but we can address later.

We also need to fetch the user’s token from DB (since our function runs maybe not right at login, we might retrieve from `users.access_token`).

We can authorize the `fetch-profile` call in two ways:

- Accept a Supabase JWT from the client and use it to identify user (then fetch their token from DB).
- Or accept a user id as input (only allow internal use or admin calls, as service function).
  
If we assume we call it server-side after OAuth, we can pass the user’s battlenet_id or user.id into it (or just call the logic directly in OAuth function as an alternative approach).

Let’s implement it to take a user’s battlenet ID (the numeric) as an input parameter for simplicity. Or even better, an RPC secured by service key where we specify user’s id.

But to keep it simple in code demonstration: we’ll just iterate over all users or a specific one.
Actually, maybe input via query param or path.

Alternatively, since each user’s token is stored, and if we want to schedule updates, we could have `fetch-profile` with no input that goes through each user in the users table and updates them. But that could be heavy if many users, better to do per user or a few at a time.

For demonstration, implement per user:

- Expect either a query param `user_id` (our internal UUID) or `battlenet_id`.
- Use that to retrieve the user’s tokens and then fetch data.

We ensure to use the `access_token` (or refresh if expired, but that’s more advanced; assume token valid if we call soon after login or refresh externally).

Alright, code for `fetch-profile`:

```ts
// supabase/functions/fetch-profile/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Blizzard API base (assuming US for profile; profile calls require region too in path or host)
const API_BASE_URL_US = "https://us.api.blizzard.com";
const NAMESPACE_PROFILE = "profile-us";
const LOCALE = Deno.env.get("BLIZZARD_API_LOCALE") || "en_US";

serve(async (req: Request) => {
  const url = new URL(req.url);
  const userIdParam = url.searchParams.get("user_id");
  const battlenetIdParam = url.searchParams.get("battlenet_id");

  if (!userIdParam && !battlenetIdParam) {
    return new Response("Missing user identifier (user_id or battlenet_id)", { status: 400 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(supabaseUrl, serviceKey);

  try {
    // 1. Get user record and token
    let userFilter;
    if (userIdParam) {
      userFilter = { id: userIdParam };
    } else {
      userFilter = { battlenet_id: Number(battlenetIdParam) };
    }
    const { data: userData, error: userError } = await sb.from("users").select("*").match(userFilter).single();
    if (userError || !userData) {
      return new Response("User not found in database.", { status: 404 });
    }
    const accessToken = userData.access_token;
    // Optional: if token expired, you might want to refresh here with refresh_token.

    // 2. Fetch account profile summary
    const accountProfileRes = await fetch(`${API_BASE_URL_US}/profile/user/wow?namespace=${NAMESPACE_PROFILE}&locale=${LOCALE}`, {
      headers: { "Authorization": `Bearer ${accessToken}` }
    });
    if (!accountProfileRes.ok) {
      console.error("Account profile fetch failed:", accountProfileRes.status);
      if (accountProfileRes.status === 401) {
        return new Response("Access token expired or invalid.", { status: 401 });
      }
      return new Response("Failed to fetch account profile.", { status: 500 });
    }
    const accountProfile = await accountProfileRes.json();
    // The structure has wow_accounts array
    const wowAccounts = accountProfile.wow_accounts || [];
    let allCharacters: any[] = [];
    for (const wowAccount of wowAccounts) {
      if (wowAccount.characters) {
        allCharacters = allCharacters.concat(wowAccount.characters);
      }
    }
    // allCharacters now is a list of character summaries { name, id, realm{slug}, playable_class{id}, playable_race{id}, level, etc. }
    // We'll upsert each character and possibly their guild.
    
    // Prepare arrays for DB upserts
    const charRows: any[] = [];
    const guildRows: any[] = [];

    for (const char of allCharacters) {
      const name: string = char.name;
      const realmSlug: string = char.realm.slug;
      const realmId: number | undefined = char.realm.id; // Not sure if realm id is included in this summary; if not, we could look it up from our realms table by slug.
      const classId: number = char.playable_class.id;
      const raceId: number = char.playable_race.id;
      const level: number = char.level;
      // For guild info, the account profile might not include guild. We need character profile call for guild.
      let guildId: string | null = null;
      let guildRank: number | null = null;
      if (char.guild) {
        // If the summary already includes guild (not sure it does), otherwise we fetch below.
        // Let's assume char.guild gives { name, id or something } in summary (likely not, so we'll fetch).
      }
      // Call character profile to get guild if any
      const charProfileRes = await fetch(`${API_BASE_URL_US}/profile/wow/character/${realmSlug}/${name.toLowerCase()}?namespace=${NAMESPACE_PROFILE}&locale=${LOCALE}`, {
        headers: { "Authorization": `Bearer ${accessToken}` }
      });
      if (charProfileRes.ok) {
        const charProfile = await charProfileRes.json();
        if (charProfile.guild) {
          const guildName: string = charProfile.guild.name;
          const guildRealmSlug: string = charProfile.guild.realm.slug;
          const guildRegion: string = "us"; // implied by namespace used
          // Upsert guild (if not exists)
          guildRows.push({
            name: guildName,
            realm_slug: guildRealmSlug,
            region: guildRegion
          });
          // We will fill guild_id after inserting guilds, or we could fetch the guild id by selecting after upsert.
          // For simplicity, we'll insert guild first then link by name.
          // But since we have unique (name, realm, region) on guilds, we can get guild id via select.
          // We'll do it after collecting all guilds.
        }
        // If guild exists in charProfile, it does not give rank in this endpoint (rank comes from guild roster endpoint).
        // So, we might need guild roster API to get rank of each member. That’s heavy for each char. We skip rank or fetch later in a separate process.
      } else {
        console.warn(`Could not fetch profile for character ${name}-${realmSlug}: status ${charProfileRes.status}`);
      }

      charRows.push({
        // We use unique composite to identify, but our PK is uuid. We'll rely on upsert matching on name+realm+region perhaps.
        // Supabase upsert can specify conflict target. Alternatively, we could select the character by unique and update.
        // We'll do onConflict on (name, realm_slug, region).
        name: name,
        realm_slug: realmSlug,
        region: "us",
        user_id: userData.id,
        level: level,
        class_id: classId,
        race_id: raceId
        // guild_id we'll fill in after guild upsert
        // guild_rank left null (could fill if we had it)
      });
    }

    // Upsert guilds first and create a map of guild composite to id
    let guildIdMap: { [key: string]: string } = {};
    if (guildRows.length > 0) {
      // Remove duplicates from guildRows
      const uniqueGuilds: { [key: string]: any } = {};
      for (const g of guildRows) {
        const key = `${g.name}|${g.realm_slug}|${g.region}`;
        uniqueGuilds[key] = g;
      }
      const guildsToUpsert = Object.values(uniqueGuilds);
      const { data: upsertedGuilds, error: guildError } = await sb.from("guilds").upsert(guildsToUpsert as any[], { onConflict: "name, realm_slug, region", returning: "minimal" });
      if (guildError) {
        throw new Error(`Guild upsert failed: ${guildError.message}`);
      }
      // After upsert, fetch guild ids for those guilds to update char guild_id
      const { data: guildRecords } = await sb.from("guilds").select("id, name, realm_slug, region").in(
        "name", guildsToUpsert.map((g: any) => g.name)
      );
      if (guildRecords) {
        for (const g of guildRecords) {
          guildIdMap[`${g.name}|${g.realm_slug}|${g.region}`] = g.id;
        }
      }
    }

    // Now link guild_id in charRows
    for (const c of charRows) {
      if (guildIdMap[`${c.guild_name}|${c.realm_slug}|${c.region}`]) {
        c.guild_id = guildIdMap[`${c.guild_name}|${c.realm_slug}|${c.region}`];
      } else {
        c.guild_id = null;
      }
      // Remove guild_name property if we had it
      delete c.guild_name;
    }

    // Upsert characters
    const { error: charError } = await sb.from("characters").upsert(charRows, { onConflict: "name, realm_slug, region" });
    if (charError) {
      throw new Error(`Character upsert failed: ${charError.message}`);
    }

    // (Optional) Remove characters that are in DB for this user but not in allCharacters list:
    // We can get all names from allCharacters and delete others for this user.
    const currentCharKeys = new Set(allCharacters.map(c => `${c.name}|${c.realm.slug}|us`));
    const { data: existingChars } = await sb.from("characters")
      .select("name, realm_slug, region")
      .eq("user_id", userData.id);
    if (existingChars) {
      for (const char of existingChars) {
        const key = `${char.name}|${char.realm_slug}|${char.region}`;
        if (!currentCharKeys.has(key)) {
          // delete this char
          await sb.from("characters").delete().match({ user_id: userData.id, name: char.name, realm_slug: char.realm_slug, region: char.region });
        }
      }
    }

    return new Response(`Profile sync completed for user ${userData.battletag}. Characters updated: ${charRows.length}`, { status: 200 });
  } catch (err) {
    console.error("Error in fetch-profile:", err);
    return new Response("Failed to sync profile data.", { status: 500 });
  }
});
```

Given the complexity, let’s highlight important parts and considerations:

- **Authentication:** We rely on the user’s access token stored in our DB. We assume it’s still valid. If expired (24h passed), the fetch will 401. In a real app, handle by using the refresh token: call Blizzard token with `grant_type=refresh_token`. We skip that due to scope.
- **Account Profile vs Character Profile:** We used account profile to list characters and then individual character profile to get guild info. The code above calls the character profile for each character. This could be heavy if a user has many characters. Alternatively, we could call the Guild API to get guild members (which includes rank) for guilds of interest, but that’s another set of calls. For now, one call per character is acceptable for moderate numbers. If performance is a concern, one could limit to max level characters or implement batching differently.
- **Upserting Guilds:** We collected guilds then upserted them. Guild upsert uses the unique composite (name, realm, region) to avoid duplicates. We then retrieved guild IDs to map back to characters. We had to temporarily store guild name in `charRows` (I used `guild_name` in the mapping which is not shown in the snippet but implied when constructing charRows within charProfile fetch).
- **Upserting Characters:** We used `onConflict: "name, realm_slug, region"` for characters. This assumes that combination is unique globally (which is true within a region in WoW – two characters can have same name on different realms or regions). Since we included region, it’s unique globally. If two users have a character with same name on same realm (impossible, name+realm is unique per WoW, but across accounts it's possible the same char existed but they are different accounts – but our table likely tracks characters globally, not just per user, meaning if two users have characters with same name on same realm, that actually cannot happen because one of them isn’t the owner of that name; WoW enforces unique name per realm).
  - There's an edge case: If a user transfers a character to a new account and another user picks up that name (rare), our DB might conflict. But fine for now.
  - The characters table may end up storing characters that are not linked to a user (from guild roster sync). Those could conflict if a user later claims that character by logging in. Using same unique constraint will ensure it updates the user_id in that scenario instead of duplicate. This is actually helpful – it merges data.
- **Cleaning up removed characters:** We optionally implemented logic to delete characters in our DB that are linked to this user but were not returned in the latest fetch (assuming those characters were deleted or are no longer on user’s account). We find all existing for user and delete those not in current list.
- **Guild Rank:** We did not fetch guild rank. The rank is obtainable from the guild roster endpoint (`/data/wow/guild/{realm}/{guildName}/roster`) ([WoW Guild Backend Plan_.pdf](file://file-LPSH3juMbB994ZgKbSPLTY#:~:text=%E2%97%8F%20Guild%20Rosters%3A%20This%20is,containing%20characters%20linked%20to%20registered)). That returns members and their rank index. Implementing that: for each guild in `guildRows`, we could call roster API once and update each character’s `guild_rank`. This might be done if needed for permissions. It’s extra calls though. Alternatively, if user is guild master, they might care to sync roster (maybe separate admin function).
  - To keep this function user-centric, we skip guild roster. We set guild_id, and guild_rank remains null. We can fill it later if needed via another process or by an on-demand fetch if the user specifically loads guild data.
- **Multiple WoW accounts:** A single Battle.net account can have multiple WoW licenses (e.g., WoW1, WoW2). The account profile returns an array `wow_accounts`. We concatenated all characters across them. We might want to mark which account they belong to, but not necessary unless user distinguishes them. We treat them all as one set of characters.
- **Rate limiting:** If a user had many characters, this could approach Blizzard’s rate limit (100 calls/sec). Our sequential approach should be fine for up to maybe 50 characters in one run. If more, and multiple users simultaneously, we’d need to throttle or queue. In a free tier environment, this is unlikely to be an immediate issue but should be considered. One could integrate `pgmq`: e.g., instead of calling all char profiles inline, push tasks for each char to queue and have another function process them. But that complicates things. Given moderate usage, this is fine.

### Usage and Scheduling of Profile Sync

- The `fetch-profile` function can be invoked in the OAuth flow function after storing the user. For example, after upserting the user in `oauth-flow`, you might trigger `fetch-profile` via an internal call. However, the Edge Function environment might not easily call another Edge Function internally without going out over HTTP. We could do a fetch to our own function URL, but that could be weird (though it’s possible).
- Alternatively, schedule a cron job to refresh profiles daily:
  For example, using `pg_cron`:

  ```sql
  SELECT cron.schedule('0 3 * * *', $$CALL refresh_profiles()$$);
  ```

  where `refresh_profiles` is a stored procedure that enqueues tasks or directly calls our function for each user. But directly calling an HTTP function from SQL is not trivial without `pg_net`.
  Instead, `refresh_profiles` could simply insert all user IDs into a `profile_sync_queue` table (utilizing `pgmq.send` maybe).
  Then an external worker or a separate edge function polls that queue and runs `fetch-profile` for each. This is a more advanced setup.
- For simplicity, you might call `fetch-profile` when the user logs into the front-end if data is stale. You can have the client call it (the function could require authentication to ensure the user can only trigger their own profile – we’d need to verify the JWT).
  Or just trust internal usage.

### Example API calls & responses (for documentation purposes)

- **Playable Classes API** (static data): A GET to `/data/wow/playable-class/index` might return:

  ```json
  {
    "_links": { "self": { "href": "<...>" } },
    "classes": [
      { "key": { "href": "<...>/playable-class/1" }, "name": { "en_US": "Warrior", ... }, "id": 1 },
      { "key": { "href": "<...>/playable-class/2" }, "name": { "en_US": "Paladin", ... }, "id": 2 },
      ...
    ]
  }
  ```

  We extracted `id` and `name.en_US`.
- **Account Profile API**: A GET to `/profile/user/wow` with a user token returns:

  ```json
  {
    "_links": { ... },
    "id": 12345678,
    "wow_accounts": [
      {
        "id": 1,
        "characters": [
          {
            "character": { "href": "<...>/profile/wow/character/realm-slug/CharacterName" },
            "protected_character": { "href": "<...>/profile/wow/character/realm-slug/CharacterName?namespace=profile-us" },
            "name": "CharacterName",
            "id": 11223344,
            "realm": { "key": { "href": "<...>/realm/realm-slug" }, "name": "RealmName", "id": 3678, "slug": "realm-slug" },
            "playable_class": { "key": { "...": "..." }, "name": "Mage", "id": 8 },
            "playable_race": { "key": { "...": "..." }, "name": "Troll", "id": 9 },
            "gender": { "type": "MALE", "name": "Male" },
            "faction": { "type": "HORDE", "name": "Horde" },
            "level": 70
          },
          ... more characters
        ]
      }
    ]
  }
  ```

  From this, we got each character’s name, realm (with slug and id), class id, race id, level, and faction. Note no guild info here.
- **Character Profile API**: A GET to `/profile/wow/character/{realmSlug}/{characterName}` with the user token yields:

  ```json
  {
    "_links": { ... },
    "id": 11223344,
    "name": "CharacterName",
    "level": 70,
    "gender": {...}, "faction": {...},
    "achievement_points": 12345,
    "wowaccount": {...},
    "guild": {
      "name": "Guild Name",
      "id": 223344,
      "realm": { "key": { "href": "<...>/realm/realm-slug" }, "name": "RealmName", "id": 3678, "slug": "realm-slug" }
    },
    "active_spec": {...},
    "equipped_item_level": 250,
    ... other fields ...
  }
  ```

  Here we see `guild` with name and realm (and an `id` – interestingly, guild ID 223344 may be a Blizzard guild ID, but Blizzard APIs often still require name+realm to query guild endpoints). We use the name and realm to identify the guild.
  If `guild` is absent, the character is guildless.

We used these patterns to extract the info.

## Using pg_cron and pgmq for Ongoing Sync

To ensure data remains up-to-date:

- **pg_cron Jobs:** We can schedule `fetch-profile` to run for each user periodically. However, as discussed, calling the Edge Function from the database directly isn’t straightforward without an HTTP extension. A typical solution:
  - Use cron to call a stored procedure that enqueues tasks in a `pgmq` queue:

    ```sql
    SELECT cron.schedule('0 4 * * *', $$SELECT pgmq.send('profile_sync_queue', users.battlenet_id::text) FROM users$$);
    ```

    This schedules a daily job at 4 AM that enqueues a message for each user’s battlenet_id in a queue named `profile_sync_queue`.
  - Then have a worker (could be an always-running external script or an Edge Function triggered some other way) that reads from this queue and executes profile sync. Supabase doesn’t natively auto-run functions on queue messages yet (as of writing), so you might run a small Node script on a server or use a cloud function that polls the queue periodically.
    (This architecture was hinted at in the plan: pg_cron schedules tasks into pgmq, and external workers process them ([WoW Guild Backend Plan_.pdf](file://file-LPSH3juMbB994ZgKbSPLTY#:~:text=processing%20logic%20,pgmq)) ([WoW Guild Backend Plan_.pdf](file://file-LPSH3juMbB994ZgKbSPLTY#:~:text=%E2%97%8F%20Data%20Synchronization%3A%20Implements%20asynchronous,external%20workers%20for%20API%20interaction))).
- **Free Tier note:** On free tier, you don’t have unlimited function invocations. But if you have modest user count and schedule daily, it should be fine. If user base grows, consider scaling up or optimizing (e.g., only queue active users).
- **Delta Sync:** Instead of full sync every time, you could fetch only changes. Blizzard doesn’t directly provide change logs for profile data, so full sync per user is simplest.
- **Guild Roster Sync:** For completeness, one might implement a separate function that syncs entire guild rosters for guilds of interest (e.g., guilds that at least one of our users is a member of). This could populate characters that are not in our system (other guild members) and perhaps send them invitation emails to join (if that was a feature). Given our scope, we’ll skip deep implementation, but the approach would be:
  - For each guild in `guilds` table that has at least one associated user’s character, call `/data/wow/guild/{realmSlug}/{guildName}/roster` (no auth required or maybe just client token). This returns all members with character names, realm, and rank. Upsert those characters (with no user_id since they’re not linked). Update rank for all characters of that guild.
  - This could also be queued via `pgmq` and processed slowly to avoid rate limits if many guilds.

## Conclusion

We now have a comprehensive setup:

- **sync-static-data** function to populate static reference data.
- **oauth-flow** function to authenticate users and get tokens.
- **fetch-profile** function to use those tokens to retrieve and store character and guild info.

These functions, combined with Supabase’s scheduling and queueing, provide a robust backend for a WoW Guild Management app. The data model in Postgres (users, characters, guilds, etc.) can be extended with additional tables for things like guild events, permissions, etc. And the integration points with Blizzard’s API ensure the data stays current.

Make sure to monitor the usage:

- Blizzard API usage (avoid hitting call limits).
- Supabase Edge Function invocation time (if a user has an enormous number of characters, consider breaking the job up).
- Database growth (the characters table can grow if many guild members are stored; consider pruning those not associated with any user after some time to save space).

With this setup, you can focus on building frontend features (like displaying guild rosters, showing character info, etc.) while the backend reliably syncs data in the background. Happy coding and may your guild prosper!
