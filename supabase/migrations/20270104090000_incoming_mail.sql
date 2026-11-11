-- Spec 0607: Jira's incoming mail. Mail servers (IMAP, a Microsoft 365 mailbox through Graph, or a folder of message files)
-- are read every few minutes by mail handlers, which create work items and add comments from what arrives.
create table mail_servers (
  id           uuid primary key default uuid_v7(),
  workspace_id uuid not null references workspaces on delete cascade,
  name         text not null,
  kind         text not null check (kind in ('imap', 'graph', 'files')),
  config       jsonb not null,   -- imap: host, port, secure, username, folder; graph: tenantId, clientId, mailbox, folder; files: folder
  secret_enc   bytea,            -- the IMAP password or the Graph client secret, sealed to this row (secrets.ts)
  created_at   timestamptz not null default now()
);
create unique index mail_servers_name on mail_servers (workspace_id, lower(name));
alter table mail_servers enable row level security;

create table mail_handlers (
  id            uuid primary key default uuid_v7(),
  workspace_id  uuid not null references workspaces on delete cascade,
  server_id     uuid not null references mail_servers on delete restrict,
  name          text not null,
  kind          text not null check (kind in ('create_or_comment', 'comment_non_quoted', 'comment_entire', 'create_each', 'comment_before_marker')),
  enabled       boolean not null default true,
  delay_minutes integer not null default 1 check (delay_minutes between 1 and 1440),
  params        jsonb not null default '{}',
  last_run_at   timestamptz,
  last_result   jsonb,
  created_at    timestamptz not null default now()
);
create unique index mail_handlers_name on mail_handlers (workspace_id, lower(name));
alter table mail_handlers enable row level security;

-- an email that created a work item: a reply to it (In-Reply-To, References) comments on that item
create table mail_message_ids (
  message_id text primary key,
  issue_id   uuid not null references issues on delete cascade,
  created_at timestamptz not null default now()
);
create index on mail_message_ids (issue_id);
alter table mail_message_ids enable row level security;
