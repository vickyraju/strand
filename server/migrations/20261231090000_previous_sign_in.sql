-- Spec 0603: JQL's lastLogin() is the sign-in before this one.
alter table users add column previous_sign_in_at timestamptz;
