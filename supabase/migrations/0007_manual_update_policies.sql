-- Allow prototype UI to edit reference data (team scores, tier CPMs) from Manual Updates tab.
create policy "write teams" on teams for update using (true) with check (true);
create policy "write tiers" on tiers for update using (true) with check (true);
