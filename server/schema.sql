-- RPG Realms — esquema do banco (PostgreSQL / Supabase)
-- Tudo fica no schema "rpg", que NÃO é exposto pela API pública do Supabase.
-- O servidor Node é o único que acessa estas tabelas.

create schema if not exists rpg;

create table if not exists rpg.profiles (
  user_id      uuid primary key,
  email        text,
  display_name text not null,
  created_at   timestamptz not null default now()
);

create table if not exists rpg.campaigns (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  universe     text not null,
  description  text not null default '',
  invite_code  text not null unique,
  max_players  int  not null default 6 check (max_players between 2 and 20),
  owner_id     uuid not null references rpg.profiles(user_id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists rpg.members (
  campaign_id  uuid not null references rpg.campaigns(id),
  user_id      uuid not null references rpg.profiles(user_id),
  role         text not null check (role in ('admin','player')),
  joined_at    timestamptz not null default now(),
  primary key (campaign_id, user_id)
);

-- Sementes do commit-reveal: o hash é público desde o início,
-- a semente só é revelada depois (e não pode mais ser trocada).
create table if not exists rpg.seeds (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid not null references rpg.campaigns(id),
  seed_hash    text not null,
  server_seed  text not null,
  next_nonce   int  not null default 0,
  revealed     boolean not null default false,
  created_at   timestamptz not null default now(),
  revealed_at  timestamptz
);
create index if not exists seeds_campaign_idx on rpg.seeds(campaign_id, created_at);

create table if not exists rpg.rolls (
  id           bigserial primary key,
  campaign_id  uuid not null references rpg.campaigns(id),
  user_id      uuid not null references rpg.profiles(user_id),
  request_id   text not null,
  seed_id      uuid not null references rpg.seeds(id),
  seed_hash    text not null,
  nonce        int  not null,
  client_seed  text not null,
  expression   text not null,
  label        text not null default '',
  terms        jsonb not null,
  modifier     int  not null,
  total        int  not null,
  created_at   timestamptz not null default now(),
  unique (campaign_id, user_id, request_id)
);
create index if not exists rolls_campaign_idx on rpg.rolls(campaign_id, id desc);

create table if not exists rpg.messages (
  id           bigserial primary key,
  campaign_id  uuid not null references rpg.campaigns(id),
  user_id      uuid references rpg.profiles(user_id),
  recipient_id uuid references rpg.profiles(user_id),
  kind         text not null check (kind in ('chat','private','mestre','system')),
  body         text not null,
  created_at   timestamptz not null default now()
);
create index if not exists messages_campaign_idx on rpg.messages(campaign_id, id desc);

-- Registro cronológico de eventos da campanha
create table if not exists rpg.events (
  id           bigserial primary key,
  campaign_id  uuid not null references rpg.campaigns(id),
  user_id      uuid references rpg.profiles(user_id),
  type         text not null,
  state_before jsonb,
  state_after  jsonb,
  result       jsonb,
  consequences jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists events_campaign_idx on rpg.events(campaign_id, id desc);

-- ===== Imutabilidade =====
create or replace function rpg.block_changes() returns trigger language plpgsql as $$
begin
  raise exception 'Registro imutável: % não pode ser alterado ou apagado', tg_table_name;
end $$;

drop trigger if exists rolls_immutable on rpg.rolls;
create trigger rolls_immutable before update or delete on rpg.rolls
  for each row execute function rpg.block_changes();

drop trigger if exists events_immutable on rpg.events;
create trigger events_immutable before update or delete on rpg.events
  for each row execute function rpg.block_changes();

create or replace function rpg.protect_seed() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Sementes não podem ser apagadas';
  end if;
  if new.server_seed <> old.server_seed or new.seed_hash <> old.seed_hash
     or new.campaign_id <> old.campaign_id or new.created_at <> old.created_at then
    raise exception 'Semente comprometida não pode ser alterada';
  end if;
  if old.revealed and (not new.revealed or new.next_nonce <> old.next_nonce) then
    raise exception 'Semente já revelada não pode voltar a ser usada';
  end if;
  if new.next_nonce < old.next_nonce then
    raise exception 'O contador da semente não pode voltar';
  end if;
  return new;
end $$;

drop trigger if exists seeds_protect on rpg.seeds;
create trigger seeds_protect before update or delete on rpg.seeds
  for each row execute function rpg.protect_seed();

-- Defesa extra: bloqueia acesso pela API pública (anon/authenticated)
alter table rpg.profiles  enable row level security;
alter table rpg.campaigns enable row level security;
alter table rpg.members   enable row level security;
alter table rpg.seeds     enable row level security;
alter table rpg.rolls     enable row level security;
alter table rpg.messages  enable row level security;
alter table rpg.events    enable row level security;

-- ===== Etapas 2, 3 e 5: personagens, mapas e combate =====
alter table rpg.campaigns add column if not exists rules text not null default 'paranormal';
alter table rpg.campaigns add column if not exists settings jsonb not null default '{}'::jsonb;
alter table rpg.campaigns add column if not exists combat jsonb;
alter table rpg.campaigns add column if not exists active_map_id uuid;

create table if not exists rpg.characters (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references rpg.profiles(user_id),
  data        jsonb not null,
  avatar      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists characters_owner_idx on rpg.characters(owner_id);

create table if not exists rpg.campaign_characters (
  campaign_id  uuid not null references rpg.campaigns(id),
  character_id uuid not null references rpg.characters(id) on delete cascade,
  added_at     timestamptz not null default now(),
  primary key (campaign_id, character_id)
);

create table if not exists rpg.maps (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references rpg.campaigns(id),
  name        text not null,
  image       text,
  width       int not null default 1600,
  height      int not null default 1000,
  grid        int not null default 70,
  show_grid   boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists maps_campaign_idx on rpg.maps(campaign_id);

create table if not exists rpg.tokens (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid not null references rpg.campaigns(id),
  map_id       uuid not null references rpg.maps(id) on delete cascade,
  character_id uuid references rpg.characters(id) on delete cascade,
  owner_id     uuid references rpg.profiles(user_id),
  kind         text not null check (kind in ('pc','npc','inimigo')),
  name         text not null,
  color        text not null default '#d9ad52',
  image        text,
  x            real not null default 0,
  y            real not null default 0,
  size         int not null default 1,
  hidden       boolean not null default false,
  stats        jsonb,
  conditions   jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists tokens_map_idx on rpg.tokens(map_id);

alter table rpg.characters          enable row level security;
alter table rpg.campaign_characters enable row level security;
alter table rpg.maps                enable row level security;
alter table rpg.tokens              enable row level security;
