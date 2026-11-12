-- Filter subscriptions sent only when the results changed (spec 0604 R7): the switch, and per recipient a fingerprint
-- of what their last email held (each person's results are what they can see)
alter table filter_subscriptions add column only_when_changed boolean not null default false;
create table filter_subscription_sent (
  subscription_id uuid not null references filter_subscriptions on delete cascade,
  user_id         uuid not null references users on delete cascade,
  fingerprint     text not null,
  sent_at         timestamptz not null default now(),
  primary key (subscription_id, user_id)
);
alter table filter_subscription_sent enable row level security;
