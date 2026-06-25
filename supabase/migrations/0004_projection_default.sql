-- Default MCP + app to upcoming 2027 projection (open inventory).
update settings set value = 1 where key = 'projection_2027_enabled';
insert into settings(key, value) values ('projection_2027_enabled', 1)
on conflict (key) do update set value = 1;
