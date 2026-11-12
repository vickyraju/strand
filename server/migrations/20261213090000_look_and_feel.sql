-- Spec 0702: look and feel, as Jira's: the site title, logo, favicon and brand colour. One row for the whole system
-- (the login page shows it, before anyone signs in).
create table look_and_feel (
  id           boolean primary key default true check (id),
  site_title   text not null default 'Jira Build POC' check (length(site_title) between 1 and 60),
  show_title   boolean not null default true,
  brand_color  text not null default '#368727' check (brand_color ~ '^#[0-9A-Fa-f]{6}$'),
  logo         bytea check (octet_length(logo) <= 262144),
  logo_type    text check (logo_type in ('image/png', 'image/jpeg', 'image/webp')),
  favicon      bytea check (octet_length(favicon) <= 65536),
  favicon_type text check (favicon_type in ('image/png', 'image/jpeg', 'image/webp')),
  updated_at   timestamptz not null default now(),
  updated_by   uuid references users on delete set null
);
insert into look_and_feel default values;
alter table look_and_feel enable row level security;
