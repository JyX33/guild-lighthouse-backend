# Product Requirements Document: WoW Guild Manager Backend

**Version:** 1.2
**Date:** 2025-04-30
**Author:** Gemini (Merged v1.1 with user-provided text)

## 1. Introduction

This document outlines the product requirements for the backend system of a web application designed to manage World of Warcraft (WoW) guilds. The system will leverage the Blizzard Battle.net API for data retrieval and synchronization, utilizing a PostgreSQL database hosted on Supabase. Key features include user onboarding via Battle.net OAuth2, character data management, guild roster synchronization, Discord account linking, raid event and attendance tracking, guild application management, role and permission handling based on guild rank, and robust handling of external API rate limits. This document details the necessary components, data models, business logic, API integrations, and architectural considerations for building this backend system, recommending a **hybrid architecture** leveraging Supabase Edge Functions and Postgres extensions.

## 2. Authentication

User authentication will be handled exclusively through the Blizzard Battle.net OAuth 2.0 Authorization Code Flow [1]. This ensures that the application does not handle user credentials directly, relying on Battle.net for secure authentication. Each user within the application will be uniquely identified by their Battle.net account ID (`battlenet_id`).

### 2.1. OAuth 2.0 Authorization Code Flow

The application must implement the standard OAuth 2.0 Authorization Code Flow to obtain user consent and access tokens [2].

* **Authorization Request:** A Supabase Edge Function handles redirecting users to the Battle.net authorization endpoint (`https://oauth.battle.net/authorize` for US/EU/APAC regions) [1]. This request must include:
  * `client_id`: The application's unique client ID obtained from the Blizzard Developer Portal [1].
  * `response_type=code`: Specifies the authorization code flow [2].
  * `redirect_uri`: The pre-registered HTTPS callback URL where Battle.net will redirect the user after authorization. This must exactly match one of the URIs registered in the API Access tool [1].
  * `scope`: A space-separated list of permissions requested. Minimally, `openid` is required to get the user's Battle.net ID and BattleTag. To access WoW character data, the `wow.profile` scope must also be included [1].
  * `state`: A unique, securely generated value to prevent Cross-Site Request Forgery (CSRF) attacks. This value is sent back by Battle.net on the redirect [2].
* **User Authorization:** The user logs into Battle.net (if not already logged in) and grants the application permission to access the requested scopes [2].
* **Authorization Code Grant:** Battle.net redirects the user back to the application's `redirect_uri` with an authorization `code` and the original `state` value as query parameters [2]. The application (Edge Function) must validate the received `state` value.
* **Access Token Request:** The application's backend (Edge Function) makes a server-to-server POST request to the Battle.net token endpoint (`https://oauth.battle.net/token` for US/EU/APAC regions) [1]. This request requires HTTP Basic Authentication using the application's `client_id` and `client_secret` [2]. The request body must include:
  * `grant_type=authorization_code`: Specifies the grant type [2].
  * `code`: The authorization code received in the previous step [2].
  * `redirect_uri`: The same `redirect_uri` used in the initial authorization request [2].
  * `scope` (Optional but recommended): The scopes originally requested.
* **Access Token Response:** Battle.net validates the request and responds with a JSON object containing the `access_token`, `token_type` (typically 'Bearer'), and `expires_in` (duration in seconds) [2]. Access tokens are valid for 24 hours [1].

### 2.2. User Identification

Once an `access_token` is obtained using the Authorization Code Flow with the `openid` scope, the application (Edge Function) must call the `/oauth/userinfo` endpoint (`https://oauth.battle.net/userinfo`) [1].

* **Request:** A GET request with the `access_token` included in the `Authorization: Bearer <access_token>` header [2].
* **Response:** A JSON object containing the user's unique Battle.net account ID (field `id` or `sub`) and their BattleTag (`battletag`) [2].
* **Unique Identifier:** The `sub` field (subject identifier) or the `id` field should be used as the unique `battlenet_id` for the user within the application's database [5]. It's important to note that IDs might collide between global regions and the separate China region; if supporting China, the region should be stored alongside the ID to ensure global uniqueness [5].
* **Database Record:** Upon successful login/token exchange, the backend creates or updates a `users` table entry with the user’s `battlenet_id` and `battletag`.

### 2.3. Token Storage and Management

The obtained `access_token` must be securely stored (e.g., encrypted in the `users` table or managed by Supabase Auth if using its external provider features). The application must track the token's expiration time (`token_expires_at`) and implement logic to handle expired tokens, potentially requiring the user to re-authenticate. Access tokens become invalid if the user changes their password or revokes application authorization [1]. Secrets (`client_secret`, encryption keys) must be stored securely using Supabase Vault or environment variables.

### 2.4. Discord Account Linking

The application supports linking a Discord account for notifications and potential future integrations.

* **Flow:**
    1. A Discord bot associated with the application provides a command (e.g., `/link_discord`).
    2. When a user invokes this command, the bot generates a unique, short-lived verification token/code.
    3. The bot instructs the user to enter this code on the web application's profile page.
    4. The user logs into the web app (via Battle.net) and enters the code.
    5. The web app frontend sends the code and the user's Discord ID (obtained from the bot interaction context, passed securely) to a dedicated Supabase Edge Function endpoint (e.g., `POST /users/link_discord`).
    6. The Edge Function verifies the code (e.g., checks against a temporary store or validates a signed token) and, if valid, associates the provided `discord_id` with the currently authenticated Supabase user (`user_id` from JWT).
    7. The `discord_id` is stored in the `users` table.
* **Security:** This flow ensures only the user who initiated the command in Discord and is logged into the corresponding Battle.net account on the web app can complete the linking.
* **Usage:** The stored `discord_id` can be used by backend processes (e.g., triggered by `pg_cron`) to send notifications (e.g., raid reminders, application status updates) via Discord APIs or webhooks.

## 3. Database Schema (PostgreSQL on Supabase)

The following PostgreSQL schema is designed to store user, character, guild, permission, raid, and application data, enforcing the specified business rules. UUIDs are used as primary keys for application-internal identification.

### 3.1. Tables

* **`users`**: Stores application user information linked to Battle.net accounts.
  * `id` (UUID, Primary Key) - Internal application user ID.
  * `battlenet_id` (BIGINT, Not Null, Unique) - The unique Battle.net account ID (sub or id from `/oauth/userinfo`) [5].
  * `battletag` (TEXT, Not Null) - User's BattleTag (e.g., "Player#1234").
  * `discord_id` (BIGINT, Nullable, Unique) - User's unique Discord ID, linked via bot flow.
  * `access_token` (TEXT, Nullable) - Encrypted storage of the latest valid OAuth token.
  * `token_expires_at` (TIMESTAMPTZ, Nullable) - Expiration timestamp of the stored `access_token`.
  * `is_admin` (BOOLEAN, Default: false) - Flag indicating if the user has global admin privileges.
  * `onboarding_status` (TEXT, Default: 'pending') - Tracks status ('pending', 'processing', 'complete', 'failed').
  * `created_at` (TIMESTAMPTZ, Default: now())
  * `updated_at` (TIMESTAMPTZ, Default: now()) - Auto-updated via trigger.
* **`characters`**: Stores detailed information about individual WoW characters.
  * `id` (UUID, Primary Key) - Internal application character ID.
  * `user_id` (UUID, Foreign Key references `users.id` ON DELETE SET NULL, Nullable) - Links to the app user. Nullable for roster-discovered chars.
  * `blizzard_id` (BIGINT, Not Null) - Unique character ID from Blizzard API [6].
  * `name` (TEXT, Not Null) - Character's name.
  * `realm_slug` (TEXT, Not Null) - Lowercase realm name slug [6].
  * `region` (TEXT, Not Null) - Character's region [6].
  * `level` (INTEGER)
  * `playable_class` (TEXT) [7].
  * `playable_race` (TEXT) [7].
  * `gender` (TEXT) [7].
  * `faction` (TEXT) [7].
  * `active_spec` (TEXT, Nullable) [8].
  * `role` (TEXT, Nullable) - Determined role ('Tank', 'Healer', 'Damage').
  * `last_login_timestamp` (TIMESTAMPTZ, Nullable) [7, 9].
  * `average_item_level` (INT, Nullable) - From equipment summary.
  * `mount_collection_hash` (TEXT, Nullable) - Hash for alt identification.
  * `toy_collection_hash` (TEXT, Nullable) - Hash for alt identification.
  * `created_at` (TIMESTAMPTZ, Default: now())
  * `updated_at` (TIMESTAMPTZ, Default: now()) - Auto-updated via trigger.
  * **Constraint:** `UNIQUE(name, realm_slug, region)`.
* **`guilds`**: Stores information about WoW guilds.
  * `id` (UUID, Primary Key) - Internal application guild ID.
  * `blizzard_id` (BIGINT, Nullable) - Unique guild ID from Blizzard API (confirm availability/stability).
  * `name` (TEXT, Not Null) - Guild's name.
  * `realm_slug` (TEXT, Not Null) [6].
  * `region` (TEXT, Not Null) [6].
  * `faction` (TEXT, Nullable).
  * `guild_master_char_id` (UUID, Nullable, Foreign Key references `characters.id` ON DELETE SET NULL) - Quick reference to the GM character.
  * `created_at` (TIMESTAMPTZ, Default: now())
  * `updated_at` (TIMESTAMPTZ, Default: now()) - Auto-updated via trigger.
  * **Constraint:** `UNIQUE(name, realm_slug, region)`.
* **`guild_members`**: Association table linking characters to guilds.
  * `id` (UUID, Primary Key) - Internal association ID.
  * `character_id` (UUID, Foreign Key references `characters.id` ON DELETE CASCADE, Not Null, Unique) - Links to character. `UNIQUE` enforces 1 guild per char.
  * `guild_id` (UUID, Foreign Key references `guilds.id` ON DELETE CASCADE, Not Null) - Links to guild.
  * `rank` (INTEGER, Not Null) - Rank level (0 = GM).
  * `is_main` (BOOLEAN, Default: false) - Is this the user's main char in this guild?
  * `created_at` (TIMESTAMPTZ, Default: now())
  * `updated_at` (TIMESTAMPTZ, Default: now()) - Auto-updated via trigger.
  * **Constraint:** Trigger/logic needed to enforce one `is_main = true` per `user_id` per `guild_id`.
* **`ranks`**: Stores custom rank names per guild.
  * `id` (UUID, Primary Key) - Internal rank definition ID.
  * `guild_id` (UUID, Foreign Key references `guilds.id` ON DELETE CASCADE, Not Null).
  * `rank_level` (INTEGER, Not Null).
  * `rank_name` (TEXT, Not Null).
  * `created_at` (TIMESTAMPTZ, Default: now())
  * `updated_at` (TIMESTAMPTZ, Default: now()) - Auto-updated via trigger.
  * **Constraint:** `UNIQUE(guild_id, rank_level)`.
* **`permissions`**: Defines CRUD permissions granted to ranks.
  * `id` (UUID, Primary Key) - Internal permission ID.
  * `rank_id` (UUID, Foreign Key references `ranks.id` ON DELETE CASCADE, Not Null).
  * `permission_key` (TEXT, Not Null) - Scope (e.g., 'MANAGE_ROSTER', 'EDIT_GUILD_INFO', 'CREATE_EVENT', 'MANAGE_RAID_ROSTER', 'MARK_ATTENDANCE', 'REVIEW_APPLICATIONS').
  * `can_create` (BOOLEAN, Default: false)
  * `can_read` (BOOLEAN, Default: true)
  * `can_update` (BOOLEAN, Default: false)
  * `can_delete` (BOOLEAN, Default: false)
  * `created_at` (TIMESTAMPTZ, Default: now())
  * `updated_at` (TIMESTAMPTZ, Default: now()) - Auto-updated via trigger.
  * **Constraint:** `UNIQUE(rank_id, permission_key)`.
* **`raid_events`**: Stores scheduled raid events.
  * `id` (UUID, Primary Key)
  * `guild_id` (UUID, Foreign Key references `guilds.id` ON DELETE CASCADE, Not Null)
  * `event_datetime` (TIMESTAMPTZ, Not Null) - Date and time of the event.
  * `raid_name` (TEXT, Nullable) - e.g., "Vault of the Incarnates".
  * `description` (TEXT, Nullable) - e.g., "Mythic Progression Night".
  * `created_by_user_id` (UUID, Foreign Key references `users.id` ON DELETE SET NULL, Nullable)
  * `created_at` (TIMESTAMPTZ, Default: now())
  * `updated_at` (TIMESTAMPTZ, Default: now()) - Auto-updated via trigger.
* **`raid_roster`**: Links characters signed up/assigned to a raid event.
  * `id` (UUID, Primary Key)
  * `raid_event_id` (UUID, Foreign Key references `raid_events.id` ON DELETE CASCADE, Not Null)
  * `character_id` (UUID, Foreign Key references `characters.id` ON DELETE CASCADE, Not Null)
  * `status` (TEXT, Default: 'tentative') - e.g., 'signed_up', 'accepted', 'declined', 'tentative', 'backup'.
  * `role_assigned` (TEXT, Nullable) - Specific role for this event (Tank, Healer, DPS), if pre-assigned.
  * `created_at` (TIMESTAMPTZ, Default: now())
  * `updated_at` (TIMESTAMPTZ, Default: now()) - Auto-updated via trigger.
  * **Constraint:** `UNIQUE(raid_event_id, character_id)`.
* **`raid_attendance`**: Tracks actual attendance.
  * `id` (UUID, Primary Key)
  * `raid_event_id` (UUID, Foreign Key references `raid_events.id` ON DELETE CASCADE, Not Null)
  * `character_id` (UUID, Foreign Key references `characters.id` ON DELETE CASCADE, Not Null)
  * `attended` (BOOLEAN, Default: false) - Marked true if the character attended.
  * `attended_at` (TIMESTAMPTZ, Nullable) - Optional timestamp when marked attended.
  * `created_at` (TIMESTAMPTZ, Default: now())
  * `updated_at` (TIMESTAMPTZ, Default: now()) - Auto-updated via trigger.
  * **Constraint:** `UNIQUE(raid_event_id, character_id)`.
* **`applications`**: Stores guild application submissions.
  * `id` (UUID, Primary Key)
  * `guild_id` (UUID, Foreign Key references `guilds.id` ON DELETE CASCADE, Not Null)
  * `user_id` (UUID, Foreign Key references `users.id` ON DELETE CASCADE, Not Null) - The applicant user.
  * `applying_char_id` (UUID, Foreign Key references `characters.id` ON DELETE CASCADE, Not Null) - Character applying.
  * `message` (TEXT, Nullable) - Applicant's message.
  * `status` (TEXT, Default: 'pending') - Enum: 'pending', 'approved', 'rejected'.
  * `reviewed_by_user_id` (UUID, Foreign Key references `users.id` ON DELETE SET NULL, Nullable) - User who reviewed.
  * `reviewed_at` (TIMESTAMPTZ, Nullable)
  * `created_at` (TIMESTAMPTZ, Default: now())
  * `updated_at` (TIMESTAMPTZ, Default: now()) - Auto-updated via trigger.
  * **Constraint:** `UNIQUE(guild_id, user_id)` - Allow only one active application per user per guild (enforce via logic/trigger on status='pending').

### 3.2. Relationships & Constraints Summary

* **Users <-> Characters:** One-to-Many.
* **Characters <-> Guilds:** One-to-One via `guild_members` (`UNIQUE` on `character_id`).
* **Guilds <-> Ranks:** One-to-Many.
* **Ranks <-> Permissions:** One-to-Many.
* **Guilds <-> Raid Events:** One-to-Many.
* **Raid Events <-> Raid Roster:** One-to-Many.
* **Characters <-> Raid Roster:** One-to-Many.
* **Raid Events <-> Raid Attendance:** One-to-Many.
* **Characters <-> Raid Attendance:** One-to-Many.
* **Guilds <-> Applications:** One-to-Many.
* **Users <-> Applications:** One-to-Many.
* **Characters <-> Applications:** One-to-Many (for `applying_char_id`).
* **Character Uniqueness:** `UNIQUE(name, realm_slug, region)` on `characters`.
* **Character Existence Rule:** Enforced by Pruning Cron Job (Section 4.2).
* **Single Main Character Rule:** Requires trigger/logic on `guild_members`.
* **Single Pending Application Rule:** Requires trigger/logic on `applications`.

### 3.3. Indexing Strategy

(Includes indexes from v1.1 plus new tables)

* All Foreign Key columns.
* `users.battlenet_id`, `users.discord_id`.
* `characters(name, realm_slug, region)`, `characters.blizzard_id`.
* `guilds(name, realm_slug, region)`, `guilds.blizzard_id`.
* `guild_members(guild_id, rank)`.
* `ranks(guild_id, rank_level)`.
* `permissions(rank_id, permission_key)`.
* `raid_events(guild_id, event_datetime)`.
* `raid_roster(raid_event_id, character_id)`.
* `raid_attendance(raid_event_id, character_id)`.
* `applications(guild_id, user_id)`, `applications(guild_id, status)`.

## 4. Core Features & Business Logic

This section details the primary backend processes, including user onboarding, data synchronization, raid/application management, and the enforcement of specific business rules.

### 4.1. User Onboarding Job

(As described in v1.1 - fetches user's characters, enqueues processing via `pgmq`, worker fetches details/spec/collections, determines role, calculates hashes, updates DB, determines main/alt post-processing).

### 4.2. Data Synchronization Cron Jobs

(As described in v1.1 - uses `pg_cron` to trigger jobs, `pgmq` to queue tasks, Edge Function workers for API calls)

* **Job 1: Update Known User Characters** (Daily)
* **Job 2: Update Guild Rosters (Indirectly via Character Updates)** (Every 1-4 hours) - *Preferred method*.
* **Job 3: Prune Stale/Orphaned Data** (Weekly)

### 4.3. Business Rule Enforcement

(As described in v1.1 - Character Uniqueness, Role Calculation, Guild/User Association, Character Existence, Main/Alt Logic including inferred linking via hashes, GM Rank, Initial Permissions).

### 4.4. Raid Event Management

* **FR-RAID-01:** Allow authorized users (GM/Officers or specific rank with `CREATE_EVENT` permission) to create `raid_events` associated with their guild, specifying date/time, name, and description.
* **FR-RAID-02:** Allow authorized users (`MANAGE_RAID_ROSTER` permission) to add/remove characters from the `raid_roster` for an event, potentially assigning a role (`role_assigned`).
* **FR-RAID-03:** Allow guild members to sign up for raid events (creating a `raid_roster` entry with status 'signed_up' or 'tentative').
* **FR-RAID-04:** Allow authorized users (`MARK_ATTENDANCE` permission) to mark characters in the `raid_attendance` table as `attended = true` for a completed event.
* **FR-RAID-05:** Provide API endpoints to list upcoming/past events, view event details including roster and attendance.

### 4.5. Guild Application Management

* **FR-APP-01:** Allow authenticated users (not already members of the target guild) to submit an application via an API endpoint, creating an entry in the `applications` table with status 'pending'.
* **FR-APP-02:** Enforce only one pending application per user per guild.
* **FR-APP-03:** Allow authorized users (GM/Officers or specific rank with `REVIEW_APPLICATIONS` permission) to view pending applications for their guild.
* **FR-APP-04:** Allow authorized users to update the status of an application to 'approved' or 'rejected'.
* **FR-APP-05:** (Optional) Trigger a notification (e.g., via Discord if linked) to the applicant when their application status changes.
* **Note:** Application approval does *not* automatically add the character to the guild in-game or in the `guild_members` table. Membership is confirmed via the next roster sync (Job 2) after the user is invited in-game.

## 5. Permissions System

(As described in v1.1, using roles Admin, GM, Rank-Based Members. Permissions defined per guild, rank level, and action scope via `permissions` table. Default permissions apply, GMs/Admins can customize via API. Enforcement via API layer checks).

* **Updated Permission Keys:** The `permission_key` vocabulary in the `permissions` table should include scopes for new features:
  * `CREATE_EVENT`
  * `MANAGE_RAID_ROSTER`
  * `MARK_ATTENDANCE`
  * `REVIEW_APPLICATIONS`
  * (Existing keys like `EDIT_GUILD_INFO`, `MANAGE_ROSTER` remain relevant).

## 6. External API Integration (Blizzard Battle.net)

(As described in v1.1 - Required API endpoints table, Data Structures handling, and the **mandatory Rate Limit Handling Strategy** using centralized queuing (`pgmq`) and dedicated Edge Function workers implementing Token Bucket).

## 7. Architecture Investigation: PostgreSQL-Centric Backend

(As described in v1.1 - Feasibility analysis of `pg_cron`, `pgmq`, `pg_net`, PL/pgSQL. Comparison table. **Strong recommendation for Hybrid Architecture** remains the conclusion, leveraging Edge Functions for OAuth, Frontend API, and critical external API interaction/rate limiting).

## 8. API Endpoints (Edge Functions)

All external API endpoints are implemented as Supabase Edge Functions (TypeScript/Deno), grouped logically (e.g., using Hono/Express router). Key endpoints include:

* **Authentication:**
  * `POST /auth/bnet_callback` – Handles OAuth callback, exchanges code, fetches user info, creates/updates user, establishes Supabase session (JWT).
* **User Management:**
  * `GET /users/me` – Returns logged-in user’s profile, linked Discord ID, associated characters, and guild memberships.
  * `POST /users/link_discord` – Secure endpoint for linking Discord ID (requires verification token/code).
* **Guild Management:**
  * `GET /guilds` – Lists guilds relevant to the user (e.g., guilds their characters are in).
  * `GET /guilds/{guildId}` – Fetches detailed guild info and full roster (joins `guilds`, `guild_members`, `characters`).
  * `POST /guilds` – (Admin/GM potentially) Triggers onboarding sync for a new guild.
  * `PUT /guilds/{guildId}` – Update guild settings (requires GM/Admin or `EDIT_GUILD_INFO` permission).
  * `GET /guilds/{guildId}/ranks` – List ranks and their names for the guild.
  * `PUT /guilds/{guildId}/ranks` – Update rank names (requires GM/Admin).
  * `GET /guilds/{guildId}/permissions` – Get permissions configuration for ranks.
  * `PUT /guilds/{guildId}/permissions` – Update permissions for ranks (requires GM/Admin).
* **Guild Applications:**
  * `GET /guilds/{guildId}/applications` – List pending applications (requires `REVIEW_APPLICATIONS` permission).
  * `POST /guilds/{guildId}/applications` – Submit a new application (requires auth, not member). Body: `{ "character_id": "...", "message": "..." }`.
  * `PUT /applications/{appId}` – Approve/reject application (requires `REVIEW_APPLICATIONS` permission). Body: `{ "status": "approved" | "rejected" }`.
* **Raid Management:**
  * `GET /guilds/{guildId}/raids` – List upcoming/past raid events for the guild.
  * `POST /guilds/{guildId}/raids` – Create a new raid event (requires `CREATE_EVENT` permission). Body: `{ "event_datetime": "...", "raid_name": "...", "description": "..." }`.
  * `GET /raids/{raidId}` – Get details of a specific raid event, including roster and attendance.
  * `PUT /raids/{raidId}` – Update raid event details (requires permission).
  * `DELETE /raids/{raidId}` – Delete a raid event (requires permission).
  * `POST /raids/{raidId}/roster` – Sign up current user's character or assign a character (requires `MANAGE_RAID_ROSTER` if assigning others). Body: `{ "character_id": "...", "status": "signed_up" | ... }`.
  * `DELETE /raids/{raidId}/roster/{characterId}` – Remove character from roster (requires permission).
  * `POST /raids/{raidId}/attendance` – Mark character(s) as attended (requires `MARK_ATTENDANCE` permission). Body: `{ "character_id": "...", "attended": true }` or array.
* **Character Management:**
  * `GET /characters/{characterId}` – Fetch detailed character info from DB.
  * `PUT /characters/{characterId}/designate_main` – (Potentially) Allow user to manually set `is_main` flag for a character within a specific guild (complex permission check needed).

## 9. Non-Functional Requirements

(As described in v1.1 - Scalability, Reliability, Performance, Logging & Monitoring, Maintainability, emphasizing the hybrid architecture benefits).

## 10. Future Considerations

* More detailed character data display (achievements, Mythic+, PvP).
* Historical data tracking (guild membership history, past raid logs).
* Support for multiple WoW accounts per Battle.net ID if distinguishable via API.
* Admin dashboard for global management.
* More sophisticated raid planning tools (composition analysis).
* Direct integration with WoW Addons (if feasible/allowed).

## 11. Conclusion

This document specifies the requirements for a robust and scalable backend system for managing World of Warcraft guilds, incorporating features like Discord linking, raid management, and applications. The **recommended hybrid architecture** leverages the strengths of PostgreSQL on Supabase (`pg_cron`, `pgmq`) while utilizing Supabase Edge Functions for OAuth, the frontend API, and critical, rate-limited interactions with the Blizzard Battle.net API. Careful implementation of the expanded data model, business logic, permission system, and rate-limiting strategy outlined herein will be crucial for success.

## Appendix A: Referenced API Structures

* `battle-net-api-structures.md` (Profile API Endpoints)
* `battle-net-game-data-api-structures.md` (Game Data API Endpoints)

## Appendix B: Database Schema (SQL)

```sql
-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), -- Internal application user ID
    battlenet_id BIGINT NOT NULL UNIQUE, -- The unique Battle.net account ID (sub or id from /oauth/userinfo)
    battletag TEXT NOT NULL, -- User's BattleTag (e.g., "Player#1234")
    discord_id BIGINT NULL UNIQUE, -- User's unique Discord ID
    access_token TEXT NULL, -- Encrypted storage of the latest valid OAuth token
    token_expires_at TIMESTAMPTZ NULL, -- Expiration timestamp of the stored access_token
    is_admin BOOLEAN NOT NULL DEFAULT false, -- Flag indicating if the user has global admin privileges
    onboarding_status TEXT NOT NULL DEFAULT 'pending', -- Tracks status ('pending', 'processing', 'complete', 'failed')
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now() -- Should be updated automatically on row modification (e.g., via a trigger)
);

-- Characters table
CREATE TABLE characters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), -- Internal application character ID
    user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL, -- Link to the app user (Nullable for roster-discovered chars)
    blizzard_id BIGINT NOT NULL, -- Unique character ID from Blizzard API
    name TEXT NOT NULL, -- Character's name
    realm_slug TEXT NOT NULL, -- Lowercase realm name slug (e.g., 'tichondrius')
    region TEXT NOT NULL, -- Character's region (e.g., 'us', 'eu')
    level INTEGER NULL,
    playable_class TEXT NULL, -- Character's class (e.g., 'Warrior')
    playable_race TEXT NULL, -- Character's race (e.g., 'Human')
    gender TEXT NULL, -- Character's gender
    faction TEXT NULL, -- Character's faction ('Alliance', 'Horde')
    active_spec TEXT NULL, -- Name of the currently active specialization
    role TEXT NULL, -- Determined role ('Tank', 'Healer', 'Damage')
    average_item_level INT NULL, -- From equipment summary
    last_login_timestamp TIMESTAMPTZ NULL, -- Timestamp from Blizzard API (often last logout)
    mount_collection_hash TEXT NULL, -- Hash for alt identification
    toy_collection_hash TEXT NULL, -- Hash for alt identification
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- Should be updated automatically
    CONSTRAINT characters_unique_name_realm_region UNIQUE (name, realm_slug, region)
);

-- Guilds table
CREATE TABLE guilds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), -- Internal application guild ID
    blizzard_id BIGINT NULL, -- Unique guild ID from Blizzard API (confirm availability)
    name TEXT NOT NULL, -- Guild's name
    realm_slug TEXT NOT NULL, -- Lowercase realm name slug
    region TEXT NOT NULL, -- Guild's region
    faction TEXT NULL, -- Guild's faction ('Alliance', 'Horde', 'Neutral')
    guild_master_char_id UUID NULL REFERENCES characters(id) ON DELETE SET NULL, -- Quick ref to GM char
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- Should be updated automatically
    CONSTRAINT guilds_unique_name_realm_region UNIQUE (name, realm_slug, region)
);

-- Guild Members junction table
CREATE TABLE guild_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), -- Internal association ID
    character_id UUID NOT NULL UNIQUE REFERENCES characters(id) ON DELETE CASCADE, -- Link to character, UNIQUE enforces 1 guild per char
    guild_id UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE, -- Link to guild
    rank INTEGER NOT NULL, -- Rank level within the guild (0 = GM)
    is_main BOOLEAN NOT NULL DEFAULT false, -- Is this the user's main char in this guild?
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now() -- Should be updated automatically
    -- Constraint for one main per user per guild needs a trigger or complex check
);

-- Ranks table (Custom rank names per guild)
CREATE TABLE ranks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), -- Internal rank definition ID
    guild_id UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE, -- Link to the guild
    rank_level INTEGER NOT NULL, -- The numeric rank level (e.g., 0, 1, 2...)
    rank_name TEXT NOT NULL, -- Custom name (e.g., "Officer", "Raider")
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- Should be updated automatically
    CONSTRAINT ranks_unique_guild_level UNIQUE (guild_id, rank_level)
);

-- Permissions table (CRUD permissions per rank per scope)
CREATE TABLE permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), -- Internal permission ID
    rank_id UUID NOT NULL REFERENCES ranks(id) ON DELETE CASCADE, -- Link to the specific rank definition
    permission_key TEXT NOT NULL, -- Permission scope (e.g., 'MANAGE_ROSTER', 'CREATE_EVENT', 'REVIEW_APPLICATIONS')
    can_create BOOLEAN NOT NULL DEFAULT false,
    can_read BOOLEAN NOT NULL DEFAULT true, -- Default to read access
    can_update BOOLEAN NOT NULL DEFAULT false,
    can_delete BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- Should be updated automatically
    CONSTRAINT permissions_unique_rank_key UNIQUE (rank_id, permission_key)
);

-- Raid Events table
CREATE TABLE raid_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    event_datetime TIMESTAMPTZ NOT NULL, -- Date and time of the event
    raid_name TEXT NULL, -- e.g., "Vault of the Incarnates"
    description TEXT NULL, -- e.g., "Mythic Progression Night"
    created_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now() -- Auto-updated via trigger
);

-- Raid Roster table (Signups/Assignments)
CREATE TABLE raid_roster (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    raid_event_id UUID NOT NULL REFERENCES raid_events(id) ON DELETE CASCADE,
    character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'tentative', -- e.g., 'signed_up', 'accepted', 'declined', 'tentative', 'backup'
    role_assigned TEXT NULL, -- Specific role for this event (Tank, Healer, DPS)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- Auto-updated via trigger
    CONSTRAINT raid_roster_unique_event_char UNIQUE (raid_event_id, character_id)
);

-- Raid Attendance table
CREATE TABLE raid_attendance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    raid_event_id UUID NOT NULL REFERENCES raid_events(id) ON DELETE CASCADE,
    character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    attended BOOLEAN NOT NULL DEFAULT false, -- Marked true if the character attended
    attended_at TIMESTAMPTZ NULL, -- Optional timestamp when marked attended
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- Auto-updated via trigger
    CONSTRAINT raid_attendance_unique_event_char UNIQUE (raid_event_id, character_id)
);

-- Applications table
CREATE TABLE applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- The applicant user
    applying_char_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE, -- Character applying
    message TEXT NULL, -- Applicant's message
    status TEXT NOT NULL DEFAULT 'pending', -- Enum: 'pending', 'approved', 'rejected'
    reviewed_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL, -- User who reviewed
    reviewed_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- Auto-updated via trigger
    CONSTRAINT applications_unique_pending_user_guild UNIQUE (guild_id, user_id) WHERE (status = 'pending') -- Allow only one pending app per user per guild
);


-- Indexes (Including previous + new tables)
CREATE INDEX idx_users_battlenet_id ON users(battlenet_id);
CREATE INDEX idx_users_discord_id ON users(discord_id);
CREATE INDEX idx_characters_user_id ON characters(user_id);
CREATE INDEX idx_characters_blizzard_id ON characters(blizzard_id);
CREATE INDEX idx_characters_name_realm_region ON characters(name, realm_slug, region); -- Supports unique constraint
CREATE INDEX idx_guilds_name_realm_region ON guilds(name, realm_slug, region); -- Supports unique constraint
CREATE INDEX idx_guild_members_guild_id_rank ON guild_members(guild_id, rank);
CREATE INDEX idx_ranks_guild_id_level ON ranks(guild_id, rank_level); -- Supports unique constraint
CREATE INDEX idx_permissions_rank_id_key ON permissions(rank_id, permission_key); -- Supports unique constraint
CREATE INDEX idx_raid_events_guild_id_datetime ON raid_events(guild_id, event_datetime);
CREATE INDEX idx_raid_roster_event_id ON raid_roster(raid_event_id);
CREATE INDEX idx_raid_roster_char_id ON raid_roster(character_id);
CREATE INDEX idx_raid_attendance_event_id ON raid_attendance(raid_event_id);
CREATE INDEX idx_raid_attendance_char_id ON raid_attendance(character_id);
CREATE INDEX idx_applications_guild_id_status ON applications(guild_id, status);
CREATE INDEX idx_applications_user_id ON applications(user_id);


-- Trigger function to automatically update 'updated_at' columns
CREATE OR REPLACE FUNCTION trigger_set_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to tables that need it
CREATE TRIGGER set_timestamp_users BEFORE UPDATE ON users FOR EACH ROW EXECUTE PROCEDURE trigger_set_timestamp();
CREATE TRIGGER set_timestamp_characters BEFORE UPDATE ON characters FOR EACH ROW EXECUTE PROCEDURE trigger_set_timestamp();
CREATE TRIGGER set_timestamp_guilds BEFORE UPDATE ON guilds FOR EACH ROW EXECUTE PROCEDURE trigger_set_timestamp();
CREATE TRIGGER set_timestamp_guild_members BEFORE UPDATE ON guild_members FOR EACH ROW EXECUTE PROCEDURE trigger_set_timestamp();
CREATE TRIGGER set_timestamp_ranks BEFORE UPDATE ON ranks FOR EACH ROW EXECUTE PROCEDURE trigger_set_timestamp();
CREATE TRIGGER set_timestamp_permissions BEFORE UPDATE ON permissions FOR EACH ROW EXECUTE PROCEDURE trigger_set_timestamp();
CREATE TRIGGER set_timestamp_raid_events BEFORE UPDATE ON raid_events FOR EACH ROW EXECUTE PROCEDURE trigger_set_timestamp();
CREATE TRIGGER set_timestamp_raid_roster BEFORE UPDATE ON raid_roster FOR EACH ROW EXECUTE PROCEDURE trigger_set_timestamp();
CREATE TRIGGER set_timestamp_raid_attendance BEFORE UPDATE ON raid_attendance FOR EACH ROW EXECUTE PROCEDURE trigger_set_timestamp();
CREATE TRIGGER set_timestamp_applications BEFORE UPDATE ON applications FOR EACH ROW EXECUTE PROCEDURE trigger_set_timestamp();

-- NOTE: A trigger/function is still needed to enforce the 'one main per user per guild' rule on guild_members.is_main updates.
