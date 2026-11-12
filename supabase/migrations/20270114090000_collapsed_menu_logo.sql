-- Spec 0719: a logo for the collapsed menu, beside the logo and favicon (spec 0702)
alter table look_and_feel add column mark bytea check (octet_length(mark) <= 65536);
alter table look_and_feel add column mark_type text check (mark_type in ('image/png', 'image/jpeg', 'image/webp'));
