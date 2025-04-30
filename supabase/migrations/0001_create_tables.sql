-- Create a dedicated schema
CREATE SCHEMA IF NOT EXISTS game_data;

-- Set search path to the new schema
SET search_path TO game_data, public;

-- Create tables
CREATE TABLE users (
    id uuid PRIMARY KEY REFERENCES auth.users(id),
    username text UNIQUE NOT NULL,
    email text NOT NULL, -- Consider using Supabase auth email directly or keeping this for redundancy/specific use cases
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE characters (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    class text NOT NULL,
    level integer NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE guilds (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text UNIQUE NOT NULL,
    description text,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE guild_members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id uuid REFERENCES guilds(id) ON DELETE CASCADE,
    character_id uuid REFERENCES characters(id) ON DELETE CASCADE,
    is_main boolean DEFAULT FALSE NOT NULL,
    joined_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    UNIQUE (guild_id, character_id) -- Ensure a character can only be in a guild once
);

CREATE TABLE ranks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id uuid REFERENCES guilds(id) ON DELETE CASCADE,
    name text NOT NULL,
    position integer NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    UNIQUE (guild_id, name) -- Ensure unique rank names per guild
);

CREATE TABLE permissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    rank_id uuid REFERENCES ranks(id) ON DELETE CASCADE,
    permission_name text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    UNIQUE (rank_id, permission_name) -- Ensure unique permissions per rank
);

CREATE TABLE raid_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id uuid REFERENCES guilds(id) ON DELETE CASCADE,
    name text NOT NULL,
    description text,
    event_time timestamptz NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE raid_roster (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    raid_event_id uuid REFERENCES raid_events(id) ON DELETE CASCADE,
    character_id uuid REFERENCES characters(id) ON DELETE CASCADE,
    role text, -- e.g., 'tank', 'healer', 'dps'
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    UNIQUE (raid_event_id, character_id) -- Ensure a character is only on a roster once per event
);

CREATE TABLE raid_attendance (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    raid_event_id uuid REFERENCES raid_events(id) ON DELETE CASCADE,
    character_id uuid REFERENCES characters(id) ON DELETE CASCADE,
    status text NOT NULL CHECK (status IN ('confirmed', 'tentative', 'declined', 'absent')),
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    UNIQUE (raid_event_id, character_id) -- Ensure attendance is recorded once per character per event
);

CREATE TABLE applications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id uuid REFERENCES guilds(id) ON DELETE CASCADE,
    character_id uuid REFERENCES characters(id) ON DELETE CASCADE,
    status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
    message text,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL
);

-- Trigger function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to tables
CREATE TRIGGER update_users_timestamp
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER update_characters_timestamp
BEFORE UPDATE ON characters
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER update_guilds_timestamp
BEFORE UPDATE ON guilds
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER update_guild_members_timestamp
BEFORE UPDATE ON guild_members
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER update_ranks_timestamp
BEFORE UPDATE ON ranks
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER update_permissions_timestamp
BEFORE UPDATE ON permissions
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER update_raid_events_timestamp
BEFORE UPDATE ON raid_events
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER update_raid_roster_timestamp
BEFORE UPDATE ON raid_roster
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER update_raid_attendance_timestamp
BEFORE UPDATE ON raid_attendance
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER update_applications_timestamp
BEFORE UPDATE ON applications
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

-- Trigger function to enforce one main character per user per guild
CREATE OR REPLACE FUNCTION enforce_one_main_per_user_per_guild()
RETURNS TRIGGER AS $$
DECLARE user_id_val uuid; -- Changed INT to uuid based on users.id type
BEGIN
  -- If setting a character as main
  IF NEW.is_main = TRUE THEN
    -- Get the user_id for this character
    SELECT user_id INTO user_id_val FROM game_data.characters WHERE id = NEW.character_id; -- Added schema prefix

    -- Set all other characters of this user in this guild to non-main
    UPDATE game_data.guild_members -- Added schema name
    SET is_main = FALSE
    WHERE guild_id = NEW.guild_id
      AND character_id IN (SELECT id FROM game_data.characters WHERE user_id = user_id_val) -- Added schema name
      AND id != NEW.id;
  END IF; RETURN NEW; -- Corrected line 179
END;
$$ LANGUAGE plpgsql;

-- Apply the trigger to the guild_members table
CREATE TRIGGER enforce_one_main_trigger
BEFORE INSERT OR UPDATE OF is_main ON guild_members
FOR EACH ROW
WHEN (NEW.is_main = TRUE)
EXECUTE FUNCTION enforce_one_main_per_user_per_guild();
-- Indexes for Performance Optimization
CREATE INDEX idx_users_email ON users (email);
CREATE INDEX idx_characters_user_id ON characters (user_id);
CREATE INDEX idx_guild_members_guild_id_character_id ON game_data.guild_members (guild_id, character_id);
CREATE INDEX idx_guild_members_character_id ON game_data.guild_members (character_id);
CREATE INDEX idx_guild_members_guild_id_is_main ON game_data.guild_members (guild_id, is_main) WHERE is_main = TRUE;
CREATE INDEX idx_raid_events_guild_id_event_time ON raid_events (guild_id, event_time);
CREATE INDEX idx_raid_roster_raid_event_id ON raid_roster (raid_event_id);
CREATE INDEX idx_raid_attendance_raid_event_id_status ON raid_attendance (raid_event_id, status);
CREATE INDEX idx_applications_guild_id_status ON applications (guild_id, status) WHERE status = 'pending';
-- Additional Constraints and Validation Rules
ALTER TABLE ranks
  ADD CONSTRAINT chk_ranks_position_nonnegative CHECK (position >= 0);

CREATE UNIQUE INDEX uniq_applications_guild_character_pending
  ON applications (guild_id, character_id)
  WHERE status = 'pending';