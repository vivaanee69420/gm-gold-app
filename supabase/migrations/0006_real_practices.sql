-- Replace the design-time placeholder practices (Sidcup, Bexley, ...) with the real
-- GM Dental group sites, keyed by their true Dentally site uuids (= Dental Os
-- practices.pms_site_id). Placeholders are deactivated, not deleted — dev data
-- may reference them and the app only ever lists active practices.

update practices set active = false
where name in ('Sidcup','Bexley','Bromley','Dartford','Orpington','Sevenoaks')
  and dentally_site_id is null;

insert into practices (name, dentally_site_id, active)
select v.name, v.site_id, true
from (values
  ('Ashford',      'f5792c95-ab93-4579-afde-dd5680d02086'),
  ('Barnet',       '6d4e5747-352c-424a-9733-6f92d78847b0'),
  ('Bexleyheath',  'cd54e48f-ba2a-49b1-b08b-756cdcefe246'),
  ('Rochester',    '52ae4391-8434-4382-ab28-48a425e665cc'),
  ('Warwick Lodge', null)
) as v(name, site_id)
where not exists (select 1 from practices p where p.name = v.name);
